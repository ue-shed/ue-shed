//! Pure scalar kernels over typed values, shared by selection and list evaluation.
use super::columns::{Arena, Atom, Bits, StrId, Structured};
use super::value::{Object, Value, value};
use super::{HostCollator, grammar, regex as js_regex, text};
use crate::{Error, ErrorCode, Result};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Kernel<'a> {
    pub collator: &'a HostCollator,
    pub roles: HashMap<String, Value>,
    patterns: Mutex<HashMap<(String, bool), Arc<js_regex::JsRegex>>>,
    classes: Mutex<HashMap<Atom, Arc<text::CharacterClass>>>,
    roles_mask: Mutex<HashMap<StrId, Arc<Bits>>>,
    paths_mask: Mutex<HashMap<StrId, Arc<Bits>>>,
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
fn role_matches(occurrence: &Value, role: &Value) -> bool {
    let Some(scopes) = role["scopes"].as_array() else {
        return false;
    };
    scopes.iter().any(|scope| {
        scope["matchers"].as_array().is_some_and(|matchers| {
            matchers.iter().all(|matcher| {
                let location = &occurrence["location"];
                let kind = matcher["kind"].as_str().unwrap_or("");
                let actual = match kind {
                    "location_kind" => location["kind"].as_str(),
                    "object_path" => location["objectPath"].as_str(),
                    "row" if location["kind"] == "data_table_cell" => location["row"].as_str(),
                    "property_path" if location["kind"] != "string_table_entry" => {
                        location["propertyPath"].as_str()
                    }
                    "string_table_entry" if location["kind"] == "string_table_entry" => {
                        location["entryKey"].as_str()
                    }
                    "class_path" if location["kind"] == "asset_property" => {
                        location["classPath"].as_str()
                    }
                    _ => None,
                };
                actual.is_some_and(|actual| {
                    let expected = matcher["value"].as_str().unwrap_or("");
                    if kind == "location_kind" || matcher["operator"] == "exact" {
                        actual == expected
                    } else {
                        actual.starts_with(expected)
                    }
                })
            })
        })
    })
}
impl<'a> Kernel<'a> {
    pub fn new(collator: &'a HostCollator, roles: &HashMap<String, serde_json::Value>) -> Self {
        Self {
            collator,
            roles: roles
                .iter()
                .map(|(name, role)| (name.clone(), Value::from_json(role)))
                .collect(),
            patterns: Mutex::default(),
            classes: Mutex::default(),
            roles_mask: Mutex::default(),
            paths_mask: Mutex::default(),
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
        let words = (0..arena.occurrences.len.div_ceil(64))
            .into_par_iter()
            .map(|word| {
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
            })
            .collect();
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
    fn matches_occurrence(&self, arena: &Arena, row: u32, role: &Value) -> bool {
        let occurrence = value!({"location":arena.value(arena.occurrence(row,"location"))});
        role_matches(&occurrence, role)
    }
    pub fn run(&self, arena: &Arena, op: &str, extra: &Value, inputs: &[Atom]) -> Result<Value> {
        if op == "get"
            && let [value, Atom::Str(path)] = inputs
        {
            return Ok(arena.value(arena.get_path(*value, arena.text(*path))));
        }
        if op == "isNull" {
            return Ok((inputs[0] == Atom::Null).into());
        }
        if op == "not" {
            return Ok((!inputs[0].boolean()).into());
        }
        if matches!(op, "eq" | "ne") {
            let equal = inputs[0] == inputs[1]
                || match (inputs[0], inputs[1]) {
                    (Atom::Str(a), Atom::Str(b)) => arena.text(a) == arena.text(b),
                    _ => arena.value(inputs[0]) == arena.value(inputs[1]),
                };
            return Ok((equal == (op == "eq")).into());
        }
        if op == "count" {
            return Ok(arena.elements(inputs[0])?.map(<[Atom]>::len).into());
        }
        if op == "first" {
            return Ok(arena
                .elements(inputs[0])?
                .and_then(|values| values.first())
                .map_or(Value::Null, |value| arena.value(*value)));
        }
        if matches!(op, "matchesRole" | "pathHasPrefix")
            && let [Atom::Val(id), Atom::Str(key)] = inputs
            && let Structured::Occurrence(row) = arena.values[id.0 as usize]
        {
            return Ok(self
                .occurrence_mask(arena, *key, op == "matchesRole")?
                .get(row as usize)
                .into());
        }
        let values = inputs
            .iter()
            .map(|atom| arena.value(*atom))
            .collect::<Vec<_>>();
        self.operation(op, extra, inputs, &values)
    }
    fn operation(
        &self,
        op: &str,
        extra: &Value,
        inputs: &[Atom],
        values: &[Value],
    ) -> Result<Value> {
        let a = values.first().unwrap_or(&Value::Null);
        let b = values.get(1).unwrap_or(&Value::Null);
        let c = values.get(2).unwrap_or(&Value::Null);
        if !["list", "object", "eq", "ne", "isNull", "not"].contains(&op)
            && values
                .iter()
                .enumerate()
                .any(|(index, value)| value.is_null() && !(op == "slice" && index == 2))
        {
            return Ok(Value::Null);
        }
        Ok(match op {
            "list" => value!(values),
            "object" => {
                let mut object = Object::new();
                for (name, value) in list(extra)?.iter().zip(values) {
                    if !value.is_null() {
                        object.insert(string(name)?.into(), value.clone());
                    }
                }
                Value::object(object)
            }
            "get" => deep_get(a, string(b)?),
            "isNull" => value!(a.is_null()),
            "not" => value!(!boolean(a)),
            "eq" => value!(a == b),
            "ne" => value!(a != b),
            "lt" | "le" | "gt" | "ge" => {
                let order = if a.is_string() && b.is_string() {
                    text::code_unit_compare(string(a)?, string(b)?)
                } else {
                    number(a)?
                        .partial_cmp(&number(b)?)
                        .ok_or("Invalid numeric comparison.")?
                };
                value!(match op {
                    "lt" => order.is_lt(),
                    "le" => order.is_le(),
                    "gt" => order.is_gt(),
                    _ => order.is_ge(),
                })
            }
            "in" => value!(list(b)?.contains(a)),
            "add" => value!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .sum::<f64>()
            ),
            "mul" => value!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .product::<f64>()
            ),
            "sub" => value!(number(a)? - number(b)?),
            "div" => value!(number(a)? / number(b)?),
            "min" | "max" => {
                let numbers = values.iter().map(number).collect::<Result<Vec<_>>>()?;
                value!(
                    numbers
                        .into_iter()
                        .reduce(if op == "min" { f64::min } else { f64::max })
                )
            }
            "round" => {
                let factor = 10f64.powf(number(b)?);
                value!((number(a)? * factor + 0.5).floor() / factor)
            }
            "utf16Length" => value!(js_regex::units(string(a)?).len()),
            "codePoints" => value!(text::code_points(string(a)?).len()),
            "visibleLength" => value!(text::visible_length(string(a)?)?),
            "visibleWords" => value!(text::visible_words(string(a)?)?),
            "interiorLineBreaks" => value!(text::interior_line_breaks(string(a)?)),
            "trim" => value!(crate::join_policy::trim(string(a)?)),
            "lower" => value!(string(a)?.to_lowercase()),
            "normalizeLineEndings" => value!(string(a)?.replace("\r\n", "\n").replace('\r', "\n")),
            "slice" => {
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
            "concat" => value!(
                values
                    .iter()
                    .map(string)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            "startsWith" => {
                value!(js_regex::units(string(a)?).starts_with(&js_regex::units(string(b)?)))
            }
            "endsWith" => {
                value!(js_regex::units(string(a)?).ends_with(&js_regex::units(string(b)?)))
            }
            "contains" => {
                let source = js_regex::units(string(a)?);
                let needle = js_regex::units(string(b)?);
                value!(needle.is_empty() || source.windows(needle.len()).any(|part| part == needle))
            }
            "countOccurrences" => {
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
            "findAll" => {
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
            "anyChar" | "allChars" | "removeClass" | "trimClass" | "leadingClass"
            | "trailingClass" | "runs" => {
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
                    "anyChar" => value!(points.iter().any(|point| class.contains(*point))),
                    "allChars" => value!(points.iter().all(|point| class.contains(*point))),
                    "removeClass" => value!(text::from_points(
                        points.into_iter().filter(|point| !class.contains(*point))
                    )),
                    "leadingClass" => value!(text::from_points(points[..start].iter().copied())),
                    "trailingClass" => value!(text::from_points(points[end..].iter().copied())),
                    "trimClass" => {
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
            "regexMatches" => value!(self.regex_matches(
                string(a)?,
                string(b)?,
                c["caseSensitive"].as_bool().unwrap_or(true),
                c["cap"].as_u64().map(|cap| cap as usize)
            )?),
            "regexTest" => value!(
                !self
                    .regex_matches(string(a)?, string(b)?, !string(c)?.contains('i'), Some(1))?
                    .is_empty()
            ),
            "termMatches" => value!(self.regex_matches(
                string(a)?,
                &js_regex::term_pattern(string(b)?, "lmn"),
                boolean(c),
                None
            )?),
            "termListMatches" => {
                let terms = list(b)?;
                if terms.is_empty() {
                    value!([])
                } else {
                    let alternation = terms
                        .iter()
                        .map(|value| Ok(::regex::escape(string(value)?)))
                        .collect::<Result<Vec<_>>>()?
                        .join("|");
                    let pattern =
                        js_regex::term_pattern(&format!("(?:{alternation})"), string(&values[3])?)
                            .replace(
                                &::regex::escape(&format!("(?:{alternation})")),
                                &format!("(?:{alternation})"),
                            );
                    value!(self.regex_matches(string(a)?, &pattern, boolean(c), None)?)
                }
            }
            "count" => value!(list(a)?.len()),
            "flatten" => value!(
                list(a)?
                    .iter()
                    .map(list)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            "distinct" => {
                let mut result = Vec::new();
                for value in list(a)? {
                    if !result.contains(value) {
                        result.push(value.clone());
                    }
                }
                value!(result)
            }
            "first" => list(a)?.first().cloned().unwrap_or(Value::Null),
            "take" => value!(
                list(a)?
                    .iter()
                    .take(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "drop" => value!(
                list(a)?
                    .iter()
                    .skip(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "concatLists" => value!(
                values
                    .iter()
                    .map(list)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            "minus" => value!(
                list(a)?
                    .iter()
                    .filter(|value| !list(b).unwrap_or(&[]).contains(value))
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "zip" => value!(
                list(a)?
                    .iter()
                    .zip(list(b)?)
                    .map(|(a, b)| value!([a, b]))
                    .collect::<Vec<_>>()
            ),
            "sortByStart" => {
                let mut values = list(a)?.to_vec();
                values.sort_by_key(|value| value["start"].as_u64().unwrap_or(0));
                value!(values)
            }
            "matchesRole" => value!(
                self.roles
                    .get(string(b)?)
                    .is_some_and(|role| role_matches(a, role))
            ),
            "pathHasPrefix" => value!(
                a["location"]["objectPath"]
                    .as_str()
                    .is_some_and(|path| path.starts_with(b.as_str().unwrap_or("")))
            ),
            "formatPattern" => Value::from(grammar::format_pattern(string(a)?, string(b)?)),
            "formatArgumentNames" | "formatArgumentOrder" => {
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
                if op == "formatArgumentNames" {
                    names.sort_by(|a, b| {
                        text::code_unit_compare(a.as_str().unwrap_or(""), b.as_str().unwrap_or(""))
                    });
                }
                value!(names)
            }
            "formatModifiers" => {
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
            "formatIssues" => a["issues"].clone(),
            "formatCompiled" => a["compiled"].clone(),
            "formatRenameArgument" => {
                grammar::rename_argument(string(a)?, string(b)?, string(c)?, string(&values[3])?)
                    .map_or(Value::Null, Value::string)
            }
            "richTextCounts" => grammar::rich_text_counts(string(a)?),
            "richTextValid" => value!(text::rich_valid(string(a)?, string(b)?)),
            "richTextTagBalance" => text::rich_balance(string(a)?)?,
            "compareRichTextTags" => text::compare_tags(string(a)?, string(b)?)?,
            "withoutOptionalArgumentTags" => {
                value!(text::without_optional_tags(string(a)?, list(b)?)?)
            }
            "unrealWhitespace" => text::unreal_whitespace(string(a)?),
            "unrealUnsafeWhitespace" => value!(text::unsafe_whitespace(string(a)?)),
            "formatBraceBalance" => text::brace_balance(string(a)?),
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("Unknown evaluator operation {op}."),
                ));
            }
        })
    }
}
