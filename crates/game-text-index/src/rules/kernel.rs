//! Pure scalar kernels over typed values, shared by selection and list evaluation.
use super::columns::{Arena, Atom, Bits, StrId, Structured};
use super::compiler::{MatchOperator, MatcherKind, Op, Role};
use super::value::{Object, Value, value};
use super::{HostCollator, grammar, regex as js_regex, text};
use crate::{Error, ErrorCode, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Kernel<'a> {
    pub collator: &'a HostCollator,
    pub roles: HashMap<String, Role>,
    patterns: Mutex<HashMap<(String, bool), Arc<js_regex::JsRegex>>>,
    terms: Mutex<HashMap<(Atom, Atom, Atom), Arc<js_regex::JsRegex>>>,
    classes: Mutex<HashMap<Atom, Arc<text::CharacterClass>>>,
    roles_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
    paths_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
}
fn boolean(value: &Value) -> bool {
    value.as_bool() == Some(true)
}
fn string(value: &Value) -> Result<&str> {
    value
        .as_str()
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Rule operation requires a string."))
}
fn list(value: &Value) -> Result<&[Value]> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Rule operation requires a list."))
}
fn number(value: &Value) -> Result<f64> {
    value
        .as_f64()
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Rule operation requires a number."))
}
fn deep_get(value: &Value, path: &str) -> Value {
    let mut current = value;
    for key in path.split('.') {
        current = if current.is_array() {
            key.parse::<usize>()
                .ok()
                .and_then(|index| current.get(index))
                .unwrap_or(&Value::Null)
        } else {
            current.get(key).unwrap_or(&Value::Null)
        };
    }
    current.clone()
}
fn role_matches(location: &Value, role: &Role) -> bool {
    let kind = location["kind"].as_str();
    role.scopes.iter().any(|scope| {
        scope.matchers.iter().all(|matcher| {
            let actual = match matcher.kind {
                MatcherKind::LocationKind => kind,
                MatcherKind::ObjectPath => location["objectPath"].as_str(),
                MatcherKind::Row if kind == Some("data_table_cell") => location["row"].as_str(),
                MatcherKind::PropertyPath if kind != Some("string_table_entry") => {
                    location["propertyPath"].as_str()
                }
                MatcherKind::StringTableEntry if kind == Some("string_table_entry") => {
                    location["entryKey"].as_str()
                }
                MatcherKind::ClassPath if kind == Some("asset_property") => {
                    location["classPath"].as_str()
                }
                _ => None,
            };
            actual.is_some_and(|actual| {
                if matcher.kind == MatcherKind::LocationKind
                    || matcher.operator == Some(MatchOperator::Exact)
                {
                    actual == matcher.value
                } else {
                    actual.starts_with(&matcher.value)
                }
            })
        })
    })
}
impl<'a> Kernel<'a> {
    pub fn new(
        collator: &'a HostCollator,
        roles: &HashMap<String, Role>,
        arena: &Arena,
    ) -> Self {
        Self {
            collator,
            roles: roles.clone(),
            patterns: Mutex::default(),
            classes: Mutex::default(),
            terms: Mutex::default(),
            roles_mask: Arc::clone(&arena.roles_mask),
            paths_mask: Arc::clone(&arena.paths_mask),
        }
    }
    fn regex_matches(
        &self,
        source: &str,
        pattern: &str,
        sensitive: bool,
        cap: Option<usize>,
    ) -> Result<Vec<Value>> {
        let key = (pattern.to_owned(), sensitive);
        let expression = {
            let mut patterns = self
                .patterns
                .lock()
                .map_err(|_| "Regex cache was poisoned.")?;
            if let Some(expression) = patterns.get(&key) {
                Arc::clone(expression)
            } else {
                let expression = Arc::new(js_regex::JsRegex::new(pattern, sensitive)?);
                patterns.insert(key, Arc::clone(&expression));
                expression
            }
        };
        expression.matches(source, cap)
    }
    pub fn occurrence_mask(&self, arena: &Arena, key: StrId, role: bool) -> Result<Arc<Bits>> {
        let cache = if role {
            &self.roles_mask
        } else {
            &self.paths_mask
        };
        if let Some(mask) = cache
            .lock()
            .map_err(|_| "Occurrence cache was poisoned.")?
            .get(&key)
        {
            return Ok(Arc::clone(mask));
        }
        let name = arena.text(key);
        let mut measure = super::stages::Measure::start();
        let rows = (0..arena.occurrences.len.div_ceil(64)).collect::<Vec<_>>();
        let words = measure.parallel(&rows, |word| {
            let word = *word;
            let mut bits = 0;
            for row in word * 64..((word + 1) * 64).min(arena.occurrences.len) {
                let matches = if role {
                    self.roles
                        .get(name)
                        .is_some_and(|role| self.matches_occurrence(arena, row as u32, role))
                } else {
                    let location = arena.value(arena.occurrence(row as u32, "location"));
                    location["objectPath"]
                        .as_str()
                        .is_some_and(|path| path.starts_with(name))
                };
                if matches {
                    bits |= 1 << (row % 64);
                }
            }
            bits
        });
        arena.recorder.kernel(
            if role { "matchesRole" } else { "pathHasPrefix" },
            &measure,
            arena.occurrences.len,
            1,
            0,
        );
        let mask = Arc::new(Bits {
            words,
            len: arena.occurrences.len,
        });
        cache
            .lock()
            .map_err(|_| "Occurrence cache was poisoned.")?
            .insert(key, Arc::clone(&mask));
        Ok(mask)
    }
    fn matches_occurrence(&self, arena: &Arena, row: u32, role: &Role) -> bool {
        role_matches(&arena.value(arena.occurrence(row, "location")), role)
    }
    pub fn run(&self, arena: &Arena, op: &Op, inputs: &[Atom]) -> Result<Value> {
        if *op == Op::Get
            && let [value, Atom::Str(path)] = inputs
        {
            return Ok(arena.value(arena.get_path(*value, arena.text(*path))));
        }
        if *op == Op::IsNull {
            return Ok((inputs[0] == Atom::Null).into());
        }
        if *op == Op::Not {
            return Ok((!inputs[0].boolean()).into());
        }
        if matches!(op, Op::Eq | Op::Ne) {
            let equal = inputs[0] == inputs[1]
                || match (inputs[0], inputs[1]) {
                    (Atom::Str(a), Atom::Str(b)) => arena.text(a) == arena.text(b),
                    _ => arena.value(inputs[0]) == arena.value(inputs[1]),
                };
            return Ok((equal == (*op == Op::Eq)).into());
        }
        if *op == Op::Count {
            return Ok(arena.elements(inputs[0])?.map(<[Atom]>::len).into());
        }
        if *op == Op::First {
            return Ok(arena
                .elements(inputs[0])?
                .and_then(|values| values.first())
                .map_or(Value::Null, |value| arena.value(*value)));
        }
        if matches!(op, Op::MatchesRole | Op::PathHasPrefix)
            && let [Atom::Val(id), Atom::Str(key)] = inputs
            && let Structured::Occurrence(row) = arena.values[id.0 as usize]
        {
            return Ok(self
                .occurrence_mask(arena, *key, *op == Op::MatchesRole)?
                .get(row as usize)
                .into());
        }
        if *op == Op::TermListMatches && inputs.iter().all(|value| *value != Atom::Null) {
            let terms = arena.elements(inputs[1])?.ok_or("Missing term list.")?;
            if terms.is_empty() {
                return Ok(value!([]));
            }
            let key = (inputs[1], inputs[2], inputs[3]);
            let expression = {
                let mut cache = self.terms.lock().map_err(|_| "Term cache was poisoned.")?;
                if let Some(expression) = cache.get(&key) {
                    Arc::clone(expression)
                } else {
                    let alternation = terms
                        .iter()
                        .map(|value| {
                            if let Atom::Str(id) = value {
                                Ok(::regex::escape(arena.text(*id)))
                            } else {
                                Err("Invalid term.".into())
                            }
                        })
                        .collect::<Result<Vec<_>>>()?
                        .join("|");
                    let Atom::Str(flags) = inputs[3] else {
                        return Err("Missing term flags.".into());
                    };
                    let pattern =
                        js_regex::term_pattern(&format!("(?:{alternation})"), arena.text(flags))
                            .replace(
                                &::regex::escape(&format!("(?:{alternation})")),
                                &format!("(?:{alternation})"),
                            );
                    let expression =
                        Arc::new(js_regex::JsRegex::new(&pattern, inputs[2].boolean())?);
                    cache.insert(key, Arc::clone(&expression));
                    expression
                }
            };
            let Atom::Str(source) = inputs[0] else {
                return Err("Missing term source.".into());
            };
            return Ok(value!(expression.matches(arena.text(source), None)?));
        }
        let values = inputs
            .iter()
            .map(|atom| arena.value(*atom))
            .collect::<Vec<_>>();
        self.operation(op, inputs, &values)
    }
    fn operation(&self, op: &Op, inputs: &[Atom], values: &[Value]) -> Result<Value> {
        let a = values.first().unwrap_or(&Value::Null);
        let b = values.get(1).unwrap_or(&Value::Null);
        let c = values.get(2).unwrap_or(&Value::Null);
        if !matches!(
            op,
            Op::List | Op::Object(_) | Op::Eq | Op::Ne | Op::IsNull | Op::Not
        )
            && values
                .iter()
                .enumerate()
                .any(|(index, value)| value.is_null() && !(*op == Op::Slice && index == 2))
        {
            return Ok(Value::Null);
        }
        Ok(match op {
            Op::List => value!(values),
            Op::Object(keys) => {
                let mut object = Object::new();
                for (name, value) in keys.iter().zip(values) {
                    if !value.is_null() {
                        object.insert(name.to_string(), value.clone());
                    }
                }
                Value::object(object)
            }
            Op::Get => deep_get(a, string(b)?),
            Op::IsNull => value!(a.is_null()),
            Op::Not => value!(!boolean(a)),
            Op::Eq => value!(a == b),
            Op::Ne => value!(a != b),
            Op::Lt | Op::Le | Op::Gt | Op::Ge => {
                let order = if a.is_string() && b.is_string() {
                    text::code_unit_compare(string(a)?, string(b)?)
                } else {
                    number(a)?
                        .partial_cmp(&number(b)?)
                        .ok_or("Invalid numeric comparison.")?
                };
                value!(match op {
                    Op::Lt => order.is_lt(),
                    Op::Le => order.is_le(),
                    Op::Gt => order.is_gt(),
                    _ => order.is_ge(),
                })
            }
            Op::In => value!(list(b)?.contains(a)),
            Op::Add => value!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .sum::<f64>()
            ),
            Op::Mul => value!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .product::<f64>()
            ),
            Op::Sub => value!(number(a)? - number(b)?),
            Op::Div => value!(number(a)? / number(b)?),
            Op::Min | Op::Max => {
                let numbers = values.iter().map(number).collect::<Result<Vec<_>>>()?;
                value!(
                    numbers
                        .into_iter()
                        .reduce(if *op == Op::Min { f64::min } else { f64::max })
                )
            }
            Op::Round => {
                let factor = 10f64.powf(number(b)?);
                value!((number(a)? * factor + 0.5).floor() / factor)
            }
            Op::Utf16Length => value!(text::utf16_length(string(a)?)),
            Op::CodePoints => value!(text::points(string(a)?).count()),
            Op::VisibleLength => value!(text::visible_length(string(a)?)?),
            Op::VisibleWords => value!(text::visible_words(string(a)?)?),
            Op::InteriorLineBreaks => value!(text::interior_line_breaks(string(a)?)),
            Op::Trim => value!(crate::join_policy::trim(string(a)?)),
            Op::Lower => value!(string(a)?.to_lowercase()),
            Op::NormalizeLineEndings => value!(string(a)?.replace("\r\n", "\n").replace('\r', "\n")),
            Op::Slice => {
                let source = js_regex::units(string(a)?);
                let len = source.len() as i64;
                let bound = |number: &Value, default| {
                    number.as_i64().map_or(default, |value| {
                        if value < 0 {
                            (len + value).max(0)
                        } else {
                            value.min(len)
                        }
                    }) as usize
                };
                let start = bound(b, 0);
                let end = bound(c, len).max(start);
                value!(js_regex::view(&source[start..end]))
            }
            Op::Concat => value!(
                values
                    .iter()
                    .map(string)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            Op::StartsWith => {
                value!(js_regex::units(string(a)?).starts_with(&js_regex::units(string(b)?)))
            }
            Op::EndsWith => {
                value!(js_regex::units(string(a)?).ends_with(&js_regex::units(string(b)?)))
            }
            Op::Contains => {
                let source = js_regex::units(string(a)?);
                let needle = js_regex::units(string(b)?);
                value!(needle.is_empty() || source.windows(needle.len()).any(|part| part == needle))
            }
            Op::CountOccurrences => {
                let source = js_regex::units(string(a)?);
                let needle = js_regex::units(string(b)?);
                let mut count = 0;
                let mut offset = 0;
                if !needle.is_empty() {
                    while offset + needle.len() <= source.len() {
                        if source[offset..].starts_with(&needle) {
                            count += 1;
                            offset += needle.len();
                        } else {
                            offset += 1;
                        }
                    }
                }
                value!(count)
            }
            Op::FindAll => {
                let source = js_regex::units(string(a)?);
                let needles = list(b)?
                    .iter()
                    .map(|value| Ok(js_regex::units(string(value)?)))
                    .collect::<Result<Vec<_>>>()?;
                let mut found = Vec::new();
                let mut offset = 0;
                while offset < source.len() {
                    if let Some(needle) = needles
                        .iter()
                        .find(|needle| !needle.is_empty() && source[offset..].starts_with(needle))
                    {
                        found.push(value!({"match":js_regex::view(needle),"start":offset,"end":offset + needle.len()}));
                        offset += needle.len();
                    } else {
                        offset += 1;
                    }
                }
                value!(found)
            }
            Op::AnyChar
            | Op::AllChars
            | Op::RemoveClass
            | Op::TrimClass
            | Op::LeadingClass
            | Op::TrailingClass
            | Op::Runs => {
                let class_id = inputs[1];
                let class = {
                    let mut classes = self
                        .classes
                        .lock()
                        .map_err(|_| "Character-class cache was poisoned.")?;
                    if let Some(class) = classes.get(&class_id) {
                        Arc::clone(class)
                    } else {
                        let class = Arc::new(text::CharacterClass::compile(b)?);
                        classes.insert(class_id, Arc::clone(&class));
                        class
                    }
                };
                let points = text::code_points(string(a)?);
                let start = points
                    .iter()
                    .take_while(|point| class.contains(**point))
                    .count();
                let end = points.len()
                    - points
                        .iter()
                        .rev()
                        .take_while(|point| class.contains(**point))
                        .count();
                match op {
                    Op::AnyChar => value!(points.iter().any(|point| class.contains(*point))),
                    Op::AllChars => value!(points.iter().all(|point| class.contains(*point))),
                    Op::RemoveClass => value!(text::from_points(
                        points.into_iter().filter(|point| !class.contains(*point))
                    )),
                    Op::LeadingClass => value!(text::from_points(points[..start].iter().copied())),
                    Op::TrailingClass => value!(text::from_points(points[end..].iter().copied())),
                    Op::TrimClass => {
                        let side = string(c)?;
                        let begin = if side == "end" { 0 } else { start };
                        let end = if side == "start" {
                            points.len()
                        } else {
                            end.max(begin)
                        };
                        value!(text::from_points(points[begin..end].iter().copied()))
                    }
                    _ => {
                        let mut runs = 0;
                        let mut length = 0;
                        let minimum = number(c)? as usize;
                        for point in points.into_iter().chain([0x110000]) {
                            if class.contains(point) {
                                length += 1;
                            } else {
                                if length >= minimum && length > 0 {
                                    runs += 1;
                                }
                                length = 0;
                            }
                        }
                        value!(runs)
                    }
                }
            }
            Op::RegexMatches => value!(self.regex_matches(
                string(a)?,
                string(b)?,
                c["caseSensitive"].as_bool().unwrap_or(true),
                c["cap"].as_u64().map(|cap| cap as usize)
            )?),
            Op::RegexTest => value!(
                !self
                    .regex_matches(string(a)?, string(b)?, !string(c)?.contains('i'), Some(1))?
                    .is_empty()
            ),
            Op::TermMatches => value!(self.regex_matches(
                string(a)?,
                &js_regex::term_pattern(string(b)?, "lmn"),
                boolean(c),
                None
            )?),
            Op::TermListMatches => return Err("Term matcher requires typed inputs.".into()),
            Op::Count => value!(list(a)?.len()),
            Op::Flatten => value!(
                list(a)?
                    .iter()
                    .map(list)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            Op::Distinct => {
                let mut result = Vec::new();
                for value in list(a)? {
                    if !result.contains(value) {
                        result.push(value.clone());
                    }
                }
                value!(result)
            }
            Op::First => list(a)?.first().cloned().unwrap_or(Value::Null),
            Op::Take => value!(
                list(a)?
                    .iter()
                    .take(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            Op::Drop => value!(
                list(a)?
                    .iter()
                    .skip(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            Op::ConcatLists => value!(
                values
                    .iter()
                    .map(list)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            Op::Minus => value!(
                list(a)?
                    .iter()
                    .filter(|value| !list(b).unwrap_or(&[]).contains(value))
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            Op::Zip => value!(
                list(a)?
                    .iter()
                    .zip(list(b)?)
                    .map(|(a, b)| value!([a, b]))
                    .collect::<Vec<_>>()
            ),
            Op::SortByStart => {
                let mut values = list(a)?.to_vec();
                values.sort_by_key(|value| value["start"].as_u64().unwrap_or(0));
                value!(values)
            }
            Op::MatchesRole => value!(
                self.roles
                    .get(string(b)?)
                    .is_some_and(|role| role_matches(&a["location"], role))
            ),
            Op::PathHasPrefix => value!(
                a["location"]["objectPath"]
                    .as_str()
                    .is_some_and(|path| path.starts_with(b.as_str().unwrap_or("")))
            ),
            Op::FormatPattern => Value::from(grammar::format_pattern(string(a)?, string(b)?)),
            Op::FormatArgumentNames | Op::FormatArgumentOrder => {
                let mut names = Vec::new();
                for argument in a["arguments"]
                    .as_array()
                    .ok_or("Missing format arguments.")?
                {
                    let name = argument["name"].clone();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
                if *op == Op::FormatArgumentNames {
                    names.sort_by(|a, b| {
                        text::code_unit_compare(a.as_str().unwrap_or(""), b.as_str().unwrap_or(""))
                    });
                }
                value!(names)
            }
            Op::FormatModifiers => {
                let mut modifiers = a["modifiers"]
                    .as_array()
                    .ok_or("Missing format modifiers.")?
                    .iter()
                    .map(
                        |modifier| value!({"argument":modifier["argument"],"name":modifier["name"]}),
                    )
                    .collect::<Vec<_>>();
                modifiers.sort_by(|a, b| {
                    self.collator
                        .compare(
                            a["argument"].as_str().unwrap_or(""),
                            b["argument"].as_str().unwrap_or(""),
                        )
                        .then_with(|| {
                            self.collator.compare(
                                a["name"].as_str().unwrap_or(""),
                                b["name"].as_str().unwrap_or(""),
                            )
                        })
                });
                value!(modifiers)
            }
            Op::FormatIssues => a["issues"].clone(),
            Op::FormatCompiled => a["compiled"].clone(),
            Op::FormatRenameArgument => {
                grammar::rename_argument(string(a)?, string(b)?, string(c)?, string(&values[3])?)
                    .map_or(Value::Null, Value::string)
            }
            Op::RichTextCounts => grammar::rich_text_counts(string(a)?),
            Op::RichTextValid => value!(text::rich_valid(string(a)?, string(b)?)),
            Op::RichTextTagBalance => text::rich_balance(string(a)?)?,
            Op::CompareRichTextTags => text::compare_tags(string(a)?, string(b)?)?,
            Op::WithoutOptionalArgumentTags => {
                value!(text::without_optional_tags(string(a)?, list(b)?)?)
            }
            Op::UnrealWhitespace => text::unreal_whitespace(string(a)?),
            Op::UnrealUnsafeWhitespace => value!(text::unsafe_whitespace(string(a)?)),
            Op::FormatBraceBalance => text::brace_balance(string(a)?),
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("{} is not a scalar kernel.", op.name()),
                ));
            }
        })
    }
}
