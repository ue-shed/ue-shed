//! Pure scalar kernels over interned atoms, shared by selection and list evaluation. Kernels
//! read the arena and return what they built as an `Out`; the evaluator interns it.
use super::columns::{Arena, Atom, Bits, StrId, Structured};
use super::compiler::{MatchOperator, MatcherKind, Op, Role};
use super::out::{Out, out};
use super::{HostCollator, grammar, regex as js_regex, text};
use crate::{Error, ErrorCode, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A term list's bare alternation, then the same terms with their boundaries.
type TermExpressions = (js_regex::JsRegex, js_regex::JsRegex);
/// A `findAll` needle list, prepared once per list: each needle's text, UTF-16 units and
/// length, and which first bytes can start a match.
struct Needles {
    texts: Vec<String>,
    units: Vec<Vec<u16>>,
    /// No needle holds an escaped lone surrogate, so plain UTF-8 sources match bytewise.
    plain: bool,
    first: [bool; 256],
}
impl Needles {
    fn new(arena: &Arena, list: &[Atom]) -> Result<Self> {
        let texts = list
            .iter()
            .map(|value| Ok(string(arena, *value)?.to_owned()))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self::from_texts(texts))
    }
    fn from_texts(texts: Vec<String>) -> Self {
        let units = texts.iter().map(|text| js_regex::units(text)).collect();
        let mut first = [false; 256];
        for text in &texts {
            if let Some(byte) = text.as_bytes().first() {
                first[usize::from(*byte)] = true;
            }
        }
        Self {
            plain: texts.iter().all(|text| !text.as_bytes().contains(&0xf3)),
            texts,
            units,
            first,
        }
    }
    /// Non-overlapping occurrences, left to right, the earliest-listed needle winning where
    /// several match at one position; offsets in UTF-16 units.
    fn find_all(&self, source: &str) -> Vec<js_regex::Match> {
        let mut found = Vec::new();
        if self.plain && !source.as_bytes().contains(&0xf3) {
            // Neither side has a lone surrogate, so a match starts and ends on whole characters
            // and the source is scanned as UTF-8, counting UTF-16 units as it goes.
            let bytes = source.as_bytes();
            let (mut offset, mut unit) = (0, 0);
            while offset < bytes.len() {
                if self.first[usize::from(bytes[offset])]
                    && let Some(index) = self.texts.iter().position(|text| {
                        !text.is_empty() && bytes[offset..].starts_with(text.as_bytes())
                    })
                {
                    let length = self.units[index].len();
                    found.push(js_regex::Match {
                        text: self.texts[index].clone(),
                        start: unit,
                        end: unit + length,
                    });
                    offset += self.texts[index].len();
                    unit += length;
                    continue;
                }
                let width = match bytes[offset] {
                    0x00..=0x7f => 1,
                    0xc0..=0xdf => 2,
                    0xe0..=0xef => 3,
                    _ => 4,
                };
                offset += width;
                unit += if width == 4 { 2 } else { 1 };
            }
            return found;
        }
        let source = js_regex::units(source);
        let mut offset = 0;
        while offset < source.len() {
            if let Some(index) = self
                .units
                .iter()
                .position(|needle| !needle.is_empty() && source[offset..].starts_with(needle))
            {
                let needle = &self.units[index];
                found.push(js_regex::Match {
                    text: js_regex::view(needle),
                    start: offset,
                    end: offset + needle.len(),
                });
                offset += needle.len();
            } else {
                offset += 1;
            }
        }
        found
    }
}
pub struct Kernel<'a> {
    pub collator: &'a HostCollator,
    pub roles: HashMap<String, Role>,
    patterns: Mutex<HashMap<(String, bool), Arc<js_regex::JsRegex>>>,
    terms: Mutex<HashMap<(Atom, Atom, Atom), Arc<TermExpressions>>>,
    classes: Mutex<HashMap<Atom, Arc<text::CharacterClass>>>,
    /// Read on every call from every worker, so readers must not block one another.
    needles: std::sync::RwLock<HashMap<Atom, Arc<Needles>>>,
    roles_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
    paths_mask: Arc<Mutex<HashMap<StrId, Arc<Bits>>>>,
}
fn optional_text(arena: &Arena, atom: Atom) -> Option<&str> {
    if let Atom::Str(id) = atom {
        Some(arena.text(id))
    } else {
        None
    }
}
fn string(arena: &Arena, atom: Atom) -> Result<&str> {
    optional_text(arena, atom)
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Rule operation requires a string."))
}
fn list(arena: &Arena, atom: Atom) -> Result<&[Atom]> {
    arena
        .elements(atom)
        .ok()
        .flatten()
        .ok_or_else(|| Error::new(ErrorCode::InvalidInput, "Rule operation requires a list."))
}
fn number(atom: Atom) -> Result<f64> {
    match atom {
        Atom::Int(value) => Ok(value as f64),
        Atom::Num(value) => Ok(f64::from_bits(value)),
        _ => Err(Error::new(
            ErrorCode::InvalidInput,
            "Rule operation requires a number.",
        )),
    }
}
/// A non-negative integer; floating-point numbers do not count.
fn count(atom: Atom) -> Option<u64> {
    if let Atom::Int(value) = atom {
        value.try_into().ok()
    } else {
        None
    }
}
/// A `regexReplace` replacement for one match: `$&` is the match and `$$` a dollar sign; any other
/// `$` is literal, as in JavaScript.
fn js_replacement(replacement: &str, matched: &str) -> String {
    let mut output = String::with_capacity(replacement.len());
    let mut characters = replacement.chars().peekable();
    while let Some(character) = characters.next() {
        match (character, characters.peek()) {
            ('$', Some('&')) => {
                characters.next();
                output.push_str(matched);
            }
            ('$', Some('$')) => {
                characters.next();
                output.push('$');
            }
            _ => output.push(character),
        }
    }
    output
}
fn atoms(values: &[Atom]) -> Out {
    Out::List(values.iter().copied().map(Out::Atom).collect())
}
fn role_matches(arena: &Arena, location: Atom, role: &Role) -> bool {
    let field = |name| optional_text(arena, arena.get_path(location, name));
    let kind = field("kind");
    role.scopes.iter().any(|scope| {
        scope.matchers.iter().all(|matcher| {
            let actual = match matcher.kind {
                MatcherKind::LocationKind => kind,
                MatcherKind::ObjectPath => field("objectPath"),
                MatcherKind::Row if kind == Some("data_table_cell") => field("row"),
                MatcherKind::PropertyPath if kind != Some("string_table_entry") => {
                    field("propertyPath")
                }
                MatcherKind::StringTableEntry if kind == Some("string_table_entry") => {
                    field("entryKey")
                }
                MatcherKind::ClassPath if kind == Some("asset_property") => field("classPath"),
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
fn path_has_prefix(arena: &Arena, location: Atom, prefix: &str) -> bool {
    optional_text(arena, arena.get_path(location, "objectPath"))
        .is_some_and(|path| path.starts_with(prefix))
}
impl<'a> Kernel<'a> {
    pub fn new(collator: &'a HostCollator, roles: &HashMap<String, Role>, arena: &Arena) -> Self {
        Self {
            collator,
            roles: roles.clone(),
            patterns: Mutex::default(),
            classes: Mutex::default(),
            needles: std::sync::RwLock::default(),
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
    ) -> Result<Vec<js_regex::Match>> {
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
    fn class(&self, arena: &Arena, class: Atom) -> Result<Arc<text::CharacterClass>> {
        let mut classes = self
            .classes
            .lock()
            .map_err(|_| "Character-class cache was poisoned.")?;
        if let Some(compiled) = classes.get(&class) {
            return Ok(Arc::clone(compiled));
        }
        let compiled = Arc::new(text::CharacterClass::compile(arena, class)?);
        classes.insert(class, Arc::clone(&compiled));
        Ok(compiled)
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
                let location = arena.occurrence(row as u32, "location");
                let matches = if role {
                    self.roles
                        .get(name)
                        .is_some_and(|role| role_matches(arena, location, role))
                } else {
                    path_has_prefix(arena, location, name)
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
    fn term_list_matches(&self, arena: &Arena, inputs: &[Atom]) -> Result<Out> {
        let terms = list(arena, inputs[1])?;
        if terms.is_empty() {
            return Ok(Out::List(Vec::new()));
        }
        let key = (inputs[1], inputs[2], inputs[3]);
        let expressions = {
            let mut cache = self.terms.lock().map_err(|_| "Term cache was poisoned.")?;
            if let Some(expressions) = cache.get(&key) {
                Arc::clone(expressions)
            } else {
                let alternation = terms
                    .iter()
                    .map(|term| {
                        optional_text(arena, *term)
                            .map(::regex::escape)
                            .ok_or_else(|| "Invalid term.".into())
                    })
                    .collect::<Result<Vec<_>>>()?
                    .join("|");
                let flags = optional_text(arena, inputs[3]).ok_or("Missing term flags.")?;
                let pattern = js_regex::term_pattern(&format!("(?:{alternation})"), flags).replace(
                    &::regex::escape(&format!("(?:{alternation})")),
                    &format!("(?:{alternation})"),
                );
                let sensitive = inputs[2].boolean();
                let expressions = Arc::new((
                    js_regex::JsRegex::new(&format!("(?:{alternation})"), sensitive)?,
                    js_regex::JsRegex::new(&pattern, sensitive)?,
                ));
                cache.insert(key, Arc::clone(&expressions));
                expressions
            }
        };
        let source = optional_text(arena, inputs[0]).ok_or("Missing term source.")?;
        // Boundaries only remove matches: a text without a bare term match has none.
        if expressions.0.matches(source, Some(1))?.is_empty() {
            return Ok(Out::List(Vec::new()));
        }
        Ok(expressions.1.matches(source, None)?.into())
    }
    pub fn run(&self, arena: &Arena, op: &Op, inputs: &[Atom]) -> Result<Out> {
        let a = inputs.first().copied().unwrap_or_default();
        let b = inputs.get(1).copied().unwrap_or_default();
        let c = inputs.get(2).copied().unwrap_or_default();
        // Constructors keep their null inputs; every other kernel is null when an input is,
        // except an omitted slice end.
        match op {
            Op::List => return Ok(atoms(inputs)),
            Op::Object(keys) => {
                let mut fields: Vec<(Arc<str>, Out)> = Vec::with_capacity(keys.len());
                for (name, value) in keys.iter().zip(inputs) {
                    if *value == Atom::Null {
                        continue;
                    }
                    if let Some(field) = fields.iter_mut().find(|(key, _)| key == name) {
                        field.1 = Out::Atom(*value);
                    } else {
                        fields.push((Arc::clone(name), Out::Atom(*value)));
                    }
                }
                return Ok(Out::Fields(fields));
            }
            _ => {}
        }
        if inputs
            .iter()
            .enumerate()
            .any(|(index, value)| *value == Atom::Null && !(*op == Op::Slice && index == 2))
        {
            return Ok(Out::NULL);
        }
        if matches!(op, Op::MatchesRole | Op::PathHasPrefix)
            && let (Atom::Val(id), Atom::Str(key)) = (a, b)
            && let Structured::Occurrence(row) = arena.values[id.0 as usize]
        {
            return Ok(self
                .occurrence_mask(arena, key, *op == Op::MatchesRole)?
                .get(row as usize)
                .into());
        }
        // Cheap operators (comparison, arithmetic, `get`, `count`, `first`) run in `vector`.
        Ok(match op {
            Op::Utf16Length => out!(text::utf16_length(string(arena, a)?)),
            Op::CodePoints => out!(text::points(string(arena, a)?).count()),
            Op::VisibleLength => out!(text::visible_length(string(arena, a)?)?),
            Op::VisibleWords => out!(text::visible_words(string(arena, a)?)?),
            Op::InteriorLineBreaks => out!(text::interior_line_breaks(string(arena, a)?)),
            // A text these leave unchanged is the input atom, not a new string to intern.
            Op::Trim => {
                let text = string(arena, a)?;
                let trimmed = crate::join_policy::trim(text);
                if trimmed.len() == text.len() {
                    Out::Atom(a)
                } else {
                    out!(trimmed)
                }
            }
            Op::Lower => {
                let text = string(arena, a)?;
                let lower = text.to_lowercase();
                if lower == text {
                    Out::Atom(a)
                } else {
                    out!(lower)
                }
            }
            Op::NormalizeLineEndings => {
                let text = string(arena, a)?;
                if text.contains('\r') {
                    out!(text.replace("\r\n", "\n").replace('\r', "\n"))
                } else {
                    Out::Atom(a)
                }
            }
            Op::Slice => {
                let source = js_regex::units(string(arena, a)?);
                let len = source.len() as i64;
                let bound = |atom: Atom, default| {
                    let Atom::Int(value) = atom else {
                        return default as usize;
                    };
                    (if value < 0 {
                        (len + value).max(0)
                    } else {
                        value.min(len)
                    }) as usize
                };
                let start = bound(b, 0);
                let end = bound(c, len).max(start);
                out!(js_regex::view(&source[start..end]))
            }
            Op::Concat => out!(
                inputs
                    .iter()
                    .map(|atom| string(arena, *atom))
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            Op::StartsWith => out!(
                js_regex::units(string(arena, a)?).starts_with(&js_regex::units(string(arena, b)?))
            ),
            Op::EndsWith => out!(
                js_regex::units(string(arena, a)?).ends_with(&js_regex::units(string(arena, b)?))
            ),
            Op::Contains => {
                let source = js_regex::units(string(arena, a)?);
                let needle = js_regex::units(string(arena, b)?);
                out!(needle.is_empty() || source.windows(needle.len()).any(|part| part == needle))
            }
            Op::CountOccurrences => {
                let source = js_regex::units(string(arena, a)?);
                let needle = js_regex::units(string(arena, b)?);
                let mut count = 0usize;
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
                out!(count)
            }
            Op::FindAll => {
                let source = string(arena, a)?;
                let cached = self
                    .needles
                    .read()
                    .map_err(|_| "Needle cache was poisoned.")?
                    .get(&b)
                    .cloned();
                let needles = if let Some(prepared) = cached {
                    prepared
                } else {
                    let prepared = Arc::new(Needles::new(arena, list(arena, b)?)?);
                    self.needles
                        .write()
                        .map_err(|_| "Needle cache was poisoned.")?
                        .entry(b)
                        .or_insert(prepared)
                        .clone()
                };
                out!(needles.find_all(source))
            }
            Op::AnyChar
            | Op::AllChars
            | Op::RemoveClass
            | Op::TrimClass
            | Op::LeadingClass
            | Op::TrailingClass
            | Op::Runs => {
                let class = self.class(arena, b)?;
                let points = text::code_points(string(arena, a)?);
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
                    Op::AnyChar => out!(points.iter().any(|point| class.contains(*point))),
                    Op::AllChars => out!(points.iter().all(|point| class.contains(*point))),
                    Op::RemoveClass => out!(text::from_points(
                        points.into_iter().filter(|point| !class.contains(*point))
                    )),
                    Op::LeadingClass => out!(text::from_points(points[..start].iter().copied())),
                    Op::TrailingClass => out!(text::from_points(points[end..].iter().copied())),
                    Op::TrimClass => {
                        let side = string(arena, c)?;
                        let begin = if side == "end" { 0 } else { start };
                        let end = if side == "start" {
                            points.len()
                        } else {
                            end.max(begin)
                        };
                        out!(text::from_points(points[begin..end].iter().copied()))
                    }
                    _ => {
                        let mut runs = 0usize;
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
                        out!(runs)
                    }
                }
            }
            Op::RegexMatches => out!(self.regex_matches(
                string(arena, a)?,
                string(arena, b)?,
                arena.get_path(c, "caseSensitive") != Atom::Bool(false),
                count(arena.get_path(c, "cap")).map(|cap| cap as usize)
            )?),
            Op::RegexTest => out!(
                !self
                    .regex_matches(
                        string(arena, a)?,
                        string(arena, b)?,
                        !string(arena, c)?.contains('i'),
                        Some(1)
                    )?
                    .is_empty()
            ),
            Op::TermMatches => out!(self.regex_matches(
                string(arena, a)?,
                &js_regex::term_pattern(string(arena, b)?, "lmn"),
                c.boolean(),
                None
            )?),
            Op::TermListMatches => self.term_list_matches(arena, inputs)?,
            // Every match replaced, as JavaScript's `replace` with a global regex; the replacement
            // understands `$&` (the match) and `$$` (a dollar sign).
            Op::RegexReplace => {
                let source = string(arena, a)?;
                let found = self.regex_matches(source, string(arena, b)?, true, None)?;
                if found.is_empty() {
                    Out::Atom(a)
                } else {
                    let replacement = string(arena, c)?;
                    let units = js_regex::units(source);
                    let mut output = Vec::with_capacity(units.len());
                    let mut last = 0;
                    for found in &found {
                        output.extend_from_slice(&units[last..found.start]);
                        output.extend(js_regex::units(&js_replacement(replacement, &found.text)));
                        last = found.end;
                    }
                    output.extend_from_slice(&units[last..]);
                    out!(js_regex::view(&output))
                }
            }
            Op::MaxOf => {
                let mut largest = None::<i64>;
                for value in list(arena, a)? {
                    // Arithmetic yields floating-point numbers, whole ones included.
                    let value = match *value {
                        Atom::Int(value) => value,
                        Atom::Num(bits)
                            if f64::from_bits(bits).fract() == 0.0
                                && f64::from_bits(bits).abs() < i64::MAX as f64 =>
                        {
                            f64::from_bits(bits) as i64
                        }
                        _ => return Err("maxOf requires whole numbers.".into()),
                    };
                    largest = Some(largest.map_or(value, |largest| largest.max(value)));
                }
                largest.map_or(Out::NULL, |value| Out::Atom(Atom::Int(value)))
            }
            Op::Flatten => {
                let mut flattened = Vec::new();
                for value in list(arena, a)? {
                    flattened.extend_from_slice(list(arena, *value)?);
                }
                atoms(&flattened)
            }
            Op::Distinct => {
                let mut distinct = Vec::<Atom>::new();
                for value in list(arena, a)? {
                    if !distinct.iter().any(|seen| arena.equal(*seen, *value)) {
                        distinct.push(*value);
                    }
                }
                atoms(&distinct)
            }
            Op::Take => {
                let values = list(arena, a)?;
                atoms(&values[..values.len().min(number(b)? as usize)])
            }
            Op::Drop => {
                let values = list(arena, a)?;
                atoms(&values[values.len().min(number(b)? as usize)..])
            }
            Op::ConcatLists => {
                let mut joined = Vec::new();
                for value in inputs {
                    joined.extend_from_slice(list(arena, *value)?);
                }
                atoms(&joined)
            }
            Op::Minus => {
                let removed = list(arena, b).unwrap_or(&[]);
                Out::List(
                    list(arena, a)?
                        .iter()
                        .filter(|value| !removed.iter().any(|other| arena.equal(*other, **value)))
                        .map(|value| Out::Atom(*value))
                        .collect(),
                )
            }
            Op::Zip => Out::List(
                list(arena, a)?
                    .iter()
                    .zip(list(arena, b)?)
                    .map(|(a, b)| atoms(&[*a, *b]))
                    .collect(),
            ),
            Op::SortByStart => {
                let mut values = list(arena, a)?.to_vec();
                values.sort_by_key(|value| count(arena.get_path(*value, "start")).unwrap_or(0));
                atoms(&values)
            }
            Op::MatchesRole => out!(
                self.roles
                    .get(string(arena, b)?)
                    .is_some_and(|role| role_matches(arena, arena.get_path(a, "location"), role))
            ),
            Op::PathHasPrefix => out!(path_has_prefix(
                arena,
                arena.get_path(a, "location"),
                optional_text(arena, b).unwrap_or("")
            )),
            Op::FormatPattern => out!(grammar::format_pattern(
                string(arena, a)?,
                string(arena, b)?
            )),
            Op::FormatArgumentNames | Op::FormatArgumentOrder => {
                let arguments = arena
                    .elements(arena.get_path(a, "arguments"))
                    .ok()
                    .flatten()
                    .ok_or("Missing format arguments.")?;
                let mut names = Vec::<Atom>::new();
                for argument in arguments {
                    let name = arena.get_path(*argument, "name");
                    if !names.iter().any(|seen| arena.equal(*seen, name)) {
                        names.push(name);
                    }
                }
                if *op == Op::FormatArgumentNames {
                    names.sort_by(|a, b| {
                        text::code_unit_compare(
                            optional_text(arena, *a).unwrap_or(""),
                            optional_text(arena, *b).unwrap_or(""),
                        )
                    });
                }
                atoms(&names)
            }
            Op::FormatModifiers => {
                let mut modifiers = arena
                    .elements(arena.get_path(a, "modifiers"))
                    .ok()
                    .flatten()
                    .ok_or("Missing format modifiers.")?
                    .iter()
                    .map(|modifier| {
                        (
                            arena.get_path(*modifier, "argument"),
                            arena.get_path(*modifier, "name"),
                        )
                    })
                    .collect::<Vec<_>>();
                let text = |atom| optional_text(arena, atom).unwrap_or("");
                modifiers.sort_by(|a, b| {
                    self.collator
                        .compare(text(a.0), text(b.0))
                        .then_with(|| self.collator.compare(text(a.1), text(b.1)))
                });
                Out::List(
                    modifiers
                        .into_iter()
                        .map(|(argument, name)| out!({"argument": argument, "name": name}))
                        .collect(),
                )
            }
            Op::FormatRenameArgument => out!(grammar::rename_argument(
                string(arena, a)?,
                string(arena, b)?,
                string(arena, c)?,
                string(arena, inputs[3])?
            )),
            Op::RichTextCounts => out!(grammar::rich_text_counts(string(arena, a)?)),
            Op::RichTextValid => out!(text::rich_valid(string(arena, a)?, string(arena, b)?)),
            Op::RichTextTagBalance => out!(text::rich_balance(string(arena, a)?)?),
            Op::CompareRichTextTags => {
                out!(text::compare_tags(string(arena, a)?, string(arena, b)?)?)
            }
            Op::WithoutOptionalArgumentTags => {
                let arguments = list(arena, b)?
                    .iter()
                    .filter_map(|value| optional_text(arena, *value))
                    .collect::<Vec<_>>();
                let text = string(arena, a)?;
                let without = text::without_optional_tags(text, &arguments)?;
                if without.len() == text.len() {
                    Out::Atom(a)
                } else {
                    out!(without)
                }
            }
            Op::UnrealWhitespace => out!(text::unreal_whitespace(string(arena, a)?)),
            Op::UnrealUnsafeWhitespace => out!(text::unsafe_whitespace(string(arena, a)?)),
            Op::FormatBraceBalance => out!(text::brace_balance(string(arena, a)?)),
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("{} is not a scalar kernel.", op.name()),
                ));
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Needles, js_regex};

    /// The UTF-16 scan `findAll` used before needles were prepared, kept as the reference.
    fn reference(source: &str, needles: &[String]) -> Vec<js_regex::Match> {
        let source = js_regex::units(source);
        let needles = needles
            .iter()
            .map(|needle| js_regex::units(needle))
            .collect::<Vec<_>>();
        let mut found = Vec::new();
        let mut offset = 0;
        while offset < source.len() {
            if let Some(needle) = needles
                .iter()
                .find(|needle| !needle.is_empty() && source[offset..].starts_with(needle))
            {
                found.push(js_regex::Match {
                    text: js_regex::view(needle),
                    start: offset,
                    end: offset + needle.len(),
                });
                offset += needle.len();
            } else {
                offset += 1;
            }
        }
        found
    }

    #[test]
    fn prepared_needles_find_what_the_utf16_scan_finds() {
        // Units: ASCII, a backslash pair, multi-byte, an astral pair, and lone surrogates.
        const UNITS: [&[u16]; 9] = [
            &[0x61],
            &[0x62],
            &[0x5c],
            &[0x6e],
            &[0xe9],
            &[0x4e2d],
            &[0xd83d, 0xde00],
            &[0xd800],
            &[0xde00],
        ];
        let needle_lists = [
            vec!["\n", "\r", "\t"],
            vec!["a", "ab", "b"],
            vec!["ab", "a", ""],
            vec!["é中", "中", "😀"],
            vec![],
            vec![""],
        ];
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        let mut lists = needle_lists
            .iter()
            .map(|list| {
                list.iter()
                    .map(|needle| (*needle).to_owned())
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        // Needles holding a lone surrogate take the UTF-16 path.
        lists.push(vec![js_regex::view(&[0xd800]), "a".into()]);
        lists.push(vec![js_regex::view(&[0xde00, 0x61])]);
        for _ in 0..4000 {
            let units = (0..next(24))
                .flat_map(|_| UNITS[next(UNITS.len())].iter().copied())
                .collect::<Vec<_>>();
            let source = js_regex::view(&units);
            for needles in &lists {
                assert_eq!(
                    Needles::from_texts(needles.clone()).find_all(&source),
                    reference(&source, needles),
                    "source {units:x?}, needles {needles:?}"
                );
            }
        }
    }
}
