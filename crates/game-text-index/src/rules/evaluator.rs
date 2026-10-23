use super::HostCollator;
use super::compiler::{CompiledRule, NodeId, Program, Subject};
use super::{grammar, regex as js_regex, text};
use crate::{Error, ErrorCode, Result};
use serde_json::{Value, json};
use std::collections::HashMap;

type ValueId = u32;
#[derive(Default)]
pub struct Relation {
    pub subject: Option<Subject>,
    pub fields: HashMap<String, Vec<Value>>,
    pub occurrences: Vec<Vec<Value>>,
}
impl Relation {
    pub fn len(&self) -> usize {
        self.fields.values().next().map_or(0, Vec::len)
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
pub trait SubjectRows {
    fn subject(&self) -> Subject;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
    fn field(&mut self, row: usize, name: &str) -> Result<Value>;
    fn occurrences(&mut self, row: usize) -> Result<Vec<Value>>;
}
impl SubjectRows for Relation {
    fn subject(&self) -> Subject {
        self.subject.unwrap_or(Subject::Line)
    }
    fn len(&self) -> usize {
        self.len()
    }
    fn field(&mut self, row: usize, name: &str) -> Result<Value> {
        self.fields
            .get(name)
            .and_then(|values| values.get(row))
            .cloned()
            .ok_or_else(|| {
                Error::new(
                    ErrorCode::InvalidInput,
                    format!("Missing subject field {name}."),
                )
            })
    }
    fn occurrences(&mut self, row: usize) -> Result<Vec<Value>> {
        Ok(self.occurrences.get(row).cloned().unwrap_or_default())
    }
}
#[derive(Clone, Debug)]
pub struct Emission {
    pub rule: usize,
    pub row: usize,
    pub subject: Subject,
    pub actual: Value,
    pub expectation: Value,
    pub fix: Value,
    pub extra: Value,
    pub translation_origin: Value,
    pub recovery: String,
    pub affected: Vec<Value>,
}
pub struct Evaluation {
    pub findings: Vec<Emission>,
    pub diagnostics: Vec<(Subject, usize, String)>,
    pub masks: HashMap<usize, Vec<u64>>,
}
#[derive(Default)]
struct Pool {
    values: Vec<Value>,
    ids: HashMap<String, ValueId>,
}
impl Pool {
    fn intern(&mut self, value: Value) -> Result<ValueId> {
        let key = serde_json::to_string(&value)?;
        if let Some(id) = self.ids.get(&key) {
            return Ok(*id);
        }
        let id = u32::try_from(self.values.len())?;
        self.values.push(value);
        self.ids.insert(key, id);
        Ok(id)
    }
    fn get(&self, id: ValueId) -> &Value {
        &self.values[id as usize]
    }
}
struct Evaluator<'a> {
    program: &'a Program,
    relation: &'a mut dyn SubjectRows,
    collator: &'a HostCollator,
    pool: Pool,
    fields: HashMap<String, HashMap<usize, ValueId>>,
    occurrences: HashMap<usize, ValueId>,
    cache: Vec<HashMap<Vec<ValueId>, ValueId>>,
    patterns: HashMap<(String, bool), js_regex::JsRegex>,
    classes: HashMap<ValueId, text::CharacterClass>,
    variables: HashMap<String, ValueId>,
    findings: HashMap<(String, usize), Vec<Emission>>,
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
impl<'a> Evaluator<'a> {
    fn new(
        program: &'a Program,
        relation: &'a mut dyn SubjectRows,
        collator: &'a HostCollator,
    ) -> Result<Self> {
        let mut pool = Pool::default();
        pool.intern(Value::Null)?;
        Ok(Self {
            program,
            relation,
            collator,
            pool,
            fields: HashMap::new(),
            occurrences: HashMap::new(),
            cache: (0..program.nodes.len()).map(|_| HashMap::new()).collect(),
            patterns: HashMap::new(),
            classes: HashMap::new(),
            variables: HashMap::new(),
            findings: HashMap::new(),
        })
    }
    fn field_id(&mut self, name: &str, row: usize) -> Result<ValueId> {
        if let Some(id) = self.fields.get(name).and_then(|values| values.get(&row)) {
            return Ok(*id);
        }
        let value = self.relation.field(row, name)?;
        let id = self.pool.intern(value)?;
        self.fields.entry(name.into()).or_default().insert(row, id);
        Ok(id)
    }
    fn value(&mut self, node: NodeId, row: usize) -> Result<Value> {
        let id = self.evaluate(node, row)?;
        Ok(self.pool.get(id).clone())
    }
    fn bound(&mut self, node: NodeId, row: usize, name: &str, value: Value) -> Result<Value> {
        let id = self.pool.intern(value)?;
        let previous = self.variables.insert(name.into(), id);
        let result = self.value(node, row);
        if let Some(previous) = previous {
            self.variables.insert(name.into(), previous);
        } else {
            self.variables.remove(name);
        }
        result
    }
    fn evaluate(&mut self, id: NodeId, row: usize) -> Result<ValueId> {
        let node = &self.program.nodes[id];
        let name = node.value.as_str().unwrap_or("");
        match node.op.as_str() {
            "lit" => return self.pool.intern(node.value.clone()),
            "field" => return self.field_id(name, row),
            "var" => {
                return self.variables.get(name).copied().ok_or_else(|| {
                    Error::new(
                        ErrorCode::InvalidInput,
                        format!("Unbound expression variable {name}."),
                    )
                });
            }
            "occurrences" => {
                if let Some(id) = self.occurrences.get(&row) {
                    return Ok(*id);
                }
                let occurrences = self.relation.occurrences(row)?;
                let id = self.pool.intern(json!(occurrences))?;
                self.occurrences.insert(row, id);
                return Ok(id);
            }
            "finding" | "findingField" => {
                let reference = if node.op == "finding" {
                    name
                } else {
                    node.value[0].as_str().unwrap_or("")
                };
                let found = self
                    .findings
                    .get(&(reference.to_owned(), row))
                    .and_then(|values| values.first());
                let value = if node.op == "finding" {
                    json!(found.is_some())
                } else {
                    found.map_or(Value::Null, |found| deep_get(&json!({"actual":found.actual,"expectation":found.expectation,"fix":found.fix,"extra":found.extra}), node.value[1].as_str().unwrap_or("")))
                };
                return self.pool.intern(value);
            }
            "and" | "or" => {
                for arg in &node.args {
                    let value = self.value(*arg, row)?;
                    if boolean(&value) == (node.op == "or") {
                        return self.pool.intern(json!(node.op == "or"));
                    }
                }
                return self.pool.intern(json!(node.op == "and"));
            }
            "coalesce" => {
                for arg in &node.args {
                    let id = self.evaluate(*arg, row)?;
                    if !self.pool.get(id).is_null() {
                        return Ok(id);
                    }
                }
                return Ok(0);
            }
            "if" => {
                let condition = self.value(node.args[0], row)?;
                return self.evaluate(node.args[if boolean(&condition) { 1 } else { 2 }], row);
            }
            "filter" | "map" | "flatMap" | "any" | "all" => {
                let input = self.value(node.args[0], row)?;
                if input.is_null() {
                    return Ok(0);
                }
                let name = node.value.as_str().unwrap_or("item");
                let mut output = Vec::new();
                for value in list(&input)? {
                    let evaluated = self.bound(node.args[1], row, name, value.clone())?;
                    match node.op.as_str() {
                        "filter" if boolean(&evaluated) => output.push(value.clone()),
                        "map" => output.push(evaluated),
                        "flatMap" => {
                            if !evaluated.is_null() {
                                output.extend_from_slice(list(&evaluated)?);
                            }
                        }
                        "any" if boolean(&evaluated) => return self.pool.intern(json!(true)),
                        "all" if !boolean(&evaluated) => return self.pool.intern(json!(false)),
                        _ => {}
                    }
                }
                return self.pool.intern(if node.op == "any" {
                    json!(false)
                } else if node.op == "all" {
                    json!(true)
                } else {
                    json!(output)
                });
            }
            "sortCodeUnit" | "sortLocale" => {
                let input = self.value(node.args[0], row)?;
                if input.is_null() {
                    return Ok(0);
                }
                let mut values = Vec::new();
                for value in list(&input)? {
                    let key = if node.args.len() == 2 {
                        self.bound(node.args[1], row, "item", value.clone())?
                    } else {
                        value.clone()
                    };
                    values.push((value.clone(), key));
                }
                values.sort_by(|a, b| {
                    if node.op == "sortLocale" {
                        self.collator
                            .compare(a.1.as_str().unwrap_or(""), b.1.as_str().unwrap_or(""))
                    } else {
                        text::code_unit_compare(
                            a.1.as_str().unwrap_or(""),
                            b.1.as_str().unwrap_or(""),
                        )
                    }
                });
                return self.pool.intern(json!(
                    values
                        .into_iter()
                        .map(|(value, _)| value)
                        .collect::<Vec<_>>()
                ));
            }
            _ => {}
        }
        let inputs = node
            .args
            .iter()
            .map(|arg| self.evaluate(*arg, row))
            .collect::<Result<Vec<_>>>()?;
        if let Some(result) = self.cache[id].get(&inputs) {
            return Ok(*result);
        }
        let values = inputs
            .iter()
            .map(|id| self.pool.get(*id).clone())
            .collect::<Vec<_>>();
        let result = self.operation(&node.op, &node.value, &inputs, &values)?;
        let result = self.pool.intern(result)?;
        self.cache[id].insert(inputs, result);
        Ok(result)
    }
    fn regex_matches(
        &mut self,
        source: &str,
        pattern: &str,
        sensitive: bool,
        cap: Option<usize>,
    ) -> Result<Vec<Value>> {
        let key = (pattern.to_owned(), sensitive);
        if !self.patterns.contains_key(&key) {
            self.patterns
                .insert(key.clone(), js_regex::JsRegex::new(pattern, sensitive)?);
        }
        self.patterns
            .get(&key)
            .ok_or("Missing compiled regex.")?
            .matches(source, cap)
    }
    fn operation(
        &mut self,
        op: &str,
        extra: &Value,
        inputs: &[ValueId],
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
            "list" => json!(values),
            "object" => {
                let mut object = serde_json::Map::new();
                for (name, value) in list(extra)?.iter().zip(values) {
                    if !value.is_null() {
                        object.insert(string(name)?.into(), value.clone());
                    }
                }
                Value::Object(object)
            }
            "get" => deep_get(a, string(b)?),
            "isNull" => json!(a.is_null()),
            "not" => json!(!boolean(a)),
            "eq" => json!(a == b),
            "ne" => json!(a != b),
            "lt" | "le" | "gt" | "ge" => {
                let order = if a.is_string() && b.is_string() {
                    text::code_unit_compare(string(a)?, string(b)?)
                } else {
                    number(a)?
                        .partial_cmp(&number(b)?)
                        .ok_or("Invalid numeric comparison.")?
                };
                json!(match op {
                    "lt" => order.is_lt(),
                    "le" => order.is_le(),
                    "gt" => order.is_gt(),
                    _ => order.is_ge(),
                })
            }
            "in" => json!(list(b)?.contains(a)),
            "add" => json!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .sum::<f64>()
            ),
            "mul" => json!(
                values
                    .iter()
                    .map(number)
                    .collect::<Result<Vec<_>>>()?
                    .iter()
                    .product::<f64>()
            ),
            "sub" => json!(number(a)? - number(b)?),
            "div" => json!(number(a)? / number(b)?),
            "min" | "max" => {
                let numbers = values.iter().map(number).collect::<Result<Vec<_>>>()?;
                json!(
                    numbers
                        .into_iter()
                        .reduce(if op == "min" { f64::min } else { f64::max })
                )
            }
            "round" => {
                let factor = 10f64.powf(number(b)?);
                json!((number(a)? * factor + 0.5).floor() / factor)
            }
            "utf16Length" => json!(js_regex::units(string(a)?).len()),
            "codePoints" => json!(text::code_points(string(a)?).len()),
            "visibleLength" => json!(text::visible_length(string(a)?)?),
            "visibleWords" => json!(text::visible_words(string(a)?)?),
            "interiorLineBreaks" => json!(text::interior_line_breaks(string(a)?)),
            "trim" => json!(crate::join_policy::trim(string(a)?)),
            "lower" => json!(string(a)?.to_lowercase()),
            "normalizeLineEndings" => json!(string(a)?.replace("\r\n", "\n").replace('\r', "\n")),
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
                json!(js_regex::view(&source[start..end]))
            }
            "concat" => json!(
                values
                    .iter()
                    .map(string)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            "startsWith" => {
                json!(js_regex::units(string(a)?).starts_with(&js_regex::units(string(b)?)))
            }
            "endsWith" => {
                json!(js_regex::units(string(a)?).ends_with(&js_regex::units(string(b)?)))
            }
            "contains" => {
                let source = js_regex::units(string(a)?);
                let needle = js_regex::units(string(b)?);
                json!(needle.is_empty() || source.windows(needle.len()).any(|part| part == needle))
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
                json!(count)
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
                        found.push(json!({"match":js_regex::view(needle),"start":offset,"end":offset + needle.len()}));
                        offset += needle.len();
                    } else {
                        offset += 1;
                    }
                }
                json!(found)
            }
            "anyChar" | "allChars" | "removeClass" | "trimClass" | "leadingClass"
            | "trailingClass" | "runs" => {
                let class_id = inputs[1];
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    self.classes.entry(class_id)
                {
                    entry.insert(text::CharacterClass::compile(b)?);
                }
                let class = self
                    .classes
                    .get(&class_id)
                    .ok_or("Missing character class.")?;
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
                    "anyChar" => json!(points.iter().any(|point| class.contains(*point))),
                    "allChars" => json!(points.iter().all(|point| class.contains(*point))),
                    "removeClass" => json!(text::from_points(
                        points.into_iter().filter(|point| !class.contains(*point))
                    )),
                    "leadingClass" => json!(text::from_points(points[..start].iter().copied())),
                    "trailingClass" => json!(text::from_points(points[end..].iter().copied())),
                    "trimClass" => {
                        let side = string(c)?;
                        let begin = if side == "end" { 0 } else { start };
                        let end = if side == "start" {
                            points.len()
                        } else {
                            end.max(begin)
                        };
                        json!(text::from_points(points[begin..end].iter().copied()))
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
                        json!(runs)
                    }
                }
            }
            "regexMatches" => json!(self.regex_matches(
                string(a)?,
                string(b)?,
                c["caseSensitive"].as_bool().unwrap_or(true),
                c["cap"].as_u64().map(|cap| cap as usize)
            )?),
            "regexTest" => json!(
                !self
                    .regex_matches(string(a)?, string(b)?, !string(c)?.contains('i'), Some(1))?
                    .is_empty()
            ),
            "termMatches" => json!(self.regex_matches(
                string(a)?,
                &js_regex::term_pattern(string(b)?, "lmn"),
                boolean(c),
                None
            )?),
            "termListMatches" => {
                let terms = list(b)?;
                if terms.is_empty() {
                    json!([])
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
                    json!(self.regex_matches(string(a)?, &pattern, boolean(c), None)?)
                }
            }
            "count" => json!(list(a)?.len()),
            "flatten" => json!(
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
                json!(result)
            }
            "first" => list(a)?.first().cloned().unwrap_or(Value::Null),
            "take" => json!(
                list(a)?
                    .iter()
                    .take(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "drop" => json!(
                list(a)?
                    .iter()
                    .skip(number(b)? as usize)
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "concatLists" => json!(
                values
                    .iter()
                    .map(list)
                    .collect::<Result<Vec<_>>>()?
                    .concat()
            ),
            "minus" => json!(
                list(a)?
                    .iter()
                    .filter(|value| !list(b).unwrap_or(&[]).contains(value))
                    .cloned()
                    .collect::<Vec<_>>()
            ),
            "zip" => json!(
                list(a)?
                    .iter()
                    .zip(list(b)?)
                    .map(|(a, b)| json!([a, b]))
                    .collect::<Vec<_>>()
            ),
            "sortByStart" => {
                let mut values = list(a)?.to_vec();
                values.sort_by_key(|value| value["start"].as_u64().unwrap_or(0));
                json!(values)
            }
            "matchesRole" => json!(
                self.program
                    .roles
                    .get(string(b)?)
                    .is_some_and(|role| role_matches(a, role))
            ),
            "pathHasPrefix" => json!(
                a["location"]["objectPath"]
                    .as_str()
                    .is_some_and(|path| path.starts_with(b.as_str().unwrap_or("")))
            ),
            "formatPattern" => {
                serde_json::to_value(grammar::format_pattern(string(a)?, string(b)?))?
            }
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
                json!(names)
            }
            "formatModifiers" => {
                let mut modifiers = a["modifiers"]
                    .as_array()
                    .ok_or("Missing format modifiers.")?
                    .iter()
                    .map(
                        |modifier| json!({"argument":modifier["argument"],"name":modifier["name"]}),
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
                json!(modifiers)
            }
            "formatIssues" => a["issues"].clone(),
            "formatCompiled" => a["compiled"].clone(),
            "formatRenameArgument" => {
                grammar::rename_argument(string(a)?, string(b)?, string(c)?, string(&values[3])?)
                    .map_or(Value::Null, Value::String)
            }
            "richTextCounts" => grammar::rich_text_counts(string(a)?),
            "richTextValid" => json!(text::rich_valid(string(a)?, string(b)?)),
            "richTextTagBalance" => text::rich_balance(string(a)?)?,
            "compareRichTextTags" => text::compare_tags(string(a)?, string(b)?)?,
            "withoutOptionalArgumentTags" => {
                json!(text::without_optional_tags(string(a)?, list(b)?)?)
            }
            "unrealWhitespace" => text::unreal_whitespace(string(a)?),
            "unrealUnsafeWhitespace" => json!(text::unsafe_whitespace(string(a)?)),
            "formatBraceBalance" => text::brace_balance(string(a)?),
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    format!("Unknown evaluator operation {op}."),
                ));
            }
        })
    }
    fn in_scope(&mut self, rule: &CompiledRule, row: usize) -> Result<bool> {
        let Some(scope) = &rule.rule.scope else {
            return Ok(true);
        };
        if rule.rule.subject != Subject::UnitSource
            && let Some(cultures) = scope["cultures"].as_array()
        {
            let field = if rule.rule.subject == Subject::Line {
                "sourceCulture"
            } else {
                "culture"
            };
            let id = self.field_id(field, row)?;
            if !cultures.contains(self.pool.get(id)) {
                return Ok(false);
            }
        }
        if scope.get("roles").is_none() && scope.get("pathPrefixes").is_none() {
            return Ok(true);
        }
        Ok(self.relation.occurrences(row)?.iter().any(|occurrence| {
            let role = scope["roles"].as_array().is_none_or(|roles| {
                roles.iter().any(|id| {
                    id.as_str()
                        .and_then(|id| self.program.roles.get(id))
                        .is_some_and(|role| role_matches(occurrence, role))
                })
            });
            let path = scope["pathPrefixes"].as_array().is_none_or(|prefixes| {
                prefixes.iter().any(|prefix| {
                    occurrence["location"]["objectPath"]
                        .as_str()
                        .zip(prefix.as_str())
                        .is_some_and(|(path, prefix)| path.starts_with(prefix))
                })
            });
            role && path
        }))
    }
}

impl Program {
    /// Predicates run first over subject columns; evidence and places run only for selected rows.
    /// Scalar DAG nodes cache by input dictionary IDs, sharing work across rules and equal texts.
    pub fn evaluate(
        &self,
        relation: &mut dyn SubjectRows,
        collator: &HostCollator,
    ) -> Result<Evaluation> {
        let subject = relation.subject();
        let length = relation.len();
        let mut evaluator = Evaluator::new(self, relation, collator)?;
        let mut output = Evaluation {
            findings: Vec::new(),
            diagnostics: Vec::new(),
            masks: HashMap::new(),
        };
        for rule in self
            .rules
            .iter()
            .filter(|rule| rule.rule.subject == subject)
        {
            let mut mask = vec![0u64; length.div_ceil(64)];
            let mut candidates = Vec::new();
            for row in 0..length {
                if subject == Subject::Line {
                    let id = evaluator.field_id("sourceCulture", row)?;
                    if evaluator.pool.get(id).is_null() {
                        continue;
                    }
                }
                let items = if let Some(each) = rule.each {
                    match evaluator.value(each, row) {
                        Ok(Value::Array(items)) => items,
                        Ok(Value::Null) => Vec::new(),
                        Ok(_) => return Err("A rule each expression must return a list.".into()),
                        Err(error) if error.code == ErrorCode::LimitExceeded => {
                            output
                                .diagnostics
                                .push((subject, row, "syntax_limit".into()));
                            continue;
                        }
                        Err(error) => return Err(error),
                    }
                } else {
                    vec![Value::Null]
                };
                for item in items {
                    let variable = rule.rule.each_as.as_deref().unwrap_or("item");
                    let item_id = evaluator.pool.intern(item.clone())?;
                    evaluator.variables.insert(variable.into(), item_id);
                    match evaluator.value(rule.when, row) {
                        Ok(value) if boolean(&value) && evaluator.in_scope(rule, row)? => {
                            mask[row / 64] |= 1 << (row % 64);
                            candidates.push((row, item));
                        }
                        Ok(_) => {}
                        Err(error) if error.code == ErrorCode::LimitExceeded => {
                            output
                                .diagnostics
                                .push((subject, row, "syntax_limit".into()));
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            for (row, item) in candidates {
                let variable = rule.rule.each_as.as_deref().unwrap_or("item");
                let id = evaluator.pool.intern(item)?;
                evaluator.variables.insert(variable.into(), id);
                let actual = evaluator.value(rule.actual, row)?;
                let expectation = evaluator.value(rule.expectation, row)?;
                let mut optional = |node: Option<NodeId>| {
                    node.map_or(Ok(Value::Null), |node| evaluator.value(node, row))
                };
                let fix = optional(rule.fix)?;
                let extra = optional(rule.extra)?;
                let translation_origin = optional(rule.translation_origin)?;
                let affected = match rule.affected {
                    Some(node) => list(&evaluator.value(node, row)?)?.to_vec(),
                    None => evaluator.relation.occurrences(row)?,
                };
                let recovery = string(&evaluator.value(rule.recovery, row)?)?.to_owned();
                let finding = Emission {
                    rule: rule.ordinal,
                    row,
                    subject,
                    actual,
                    expectation,
                    fix,
                    extra,
                    translation_origin,
                    recovery,
                    affected,
                };
                evaluator
                    .findings
                    .entry((rule.rule.id.clone(), row))
                    .or_default()
                    .push(finding.clone());
                output.findings.push(finding);
            }
            output.masks.insert(rule.ordinal, mask);
        }
        output
            .findings
            .sort_by_key(|finding| (finding.rule, finding.row));
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule(id: &str, when: Value, actual: Value) -> Value {
        json!({"id":id,"kind":id,"label":id,"subject":"unit_source","family":"source","severity":"normal","when":when,"actual":actual,"expectation":{"object":{"review":true}},"recovery":"Review the saved text."})
    }
    #[test]
    fn evaluates_references_elements_nulls_and_roles_without_a_target() -> Result<()> {
        let mut dependent = rule(
            "dependent",
            json!({"finding":"first"}),
            json!({"object":{"source":{"field":"source"},"missing":null,"first":{"findingField":["first","actual.value"]}}}),
        );
        dependent["each"] = json!({"lit":["a","b"]});
        dependent["actual"]["object"]["element"] = json!({"var":"item"});
        let first = rule(
            "first",
            json!({"gt":[{"utf16Length":{"field":"source"}},2]}),
            json!({"object":{"value":2}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[dependent,first]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([(
                "source".into(),
                vec![json!("short"), json!("x"), json!("short")],
            )]),
            occurrences: vec![vec![]; 3],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(result.findings.len(), 6);
        assert_eq!(result.masks[&0], vec![5]);
        assert_eq!(
            result.findings[0].actual,
            json!({"source":"short","first":2,"element":"a"})
        );
        assert_eq!(result.findings[1].actual["element"], "b");
        assert!(result.diagnostics.is_empty());
        Ok(())
    }
    #[test]
    fn rejects_cycles_unknown_bindings_missing_parameters_and_invalid_types() -> Result<()> {
        for expression in [
            json!({"finding":"a"}),
            json!({"var":"missing"}),
            json!({"param":"missing"}),
            json!({"utf16Length":42}),
        ] {
            let rule = rule("a", expression, json!({"object":{}}));
            assert!(
                super::super::compile(&serde_json::to_string(
                    &json!({"schemaVersion":4,"roles":[],"rules":[rule]})
                )?)
                .is_err()
            );
        }
        Ok(())
    }
    #[test]
    fn source_terminology_preserves_both_boundary_sets_and_utf16_offsets() -> Result<()> {
        let rule = rule(
            "terms",
            json!(true),
            json!({"object":{"terms":{"termMatches":[{"field":"source"},"bad",false]},"placeholders":{"termListMatches":[{"field":"source"},{"lit":["bad"]},false,"lmnu"]}}}),
        );
        let program = super::super::compile(&serde_json::to_string(
            &json!({"schemaVersion":4,"roles":[],"rules":[rule]}),
        )?)?;
        let mut relation = Relation {
            subject: Some(Subject::UnitSource),
            fields: HashMap::from([("source".into(), vec![json!("😀 bad_bad BAD bád")])]),
            occurrences: vec![vec![]],
        };
        let result = program.evaluate(&mut relation, &HostCollator::new("en")?)?;
        assert_eq!(
            result.findings[0].actual["terms"],
            json!([{"match":"bad","start":3,"end":6},{"match":"bad","start":7,"end":10},{"match":"BAD","start":11,"end":14}])
        );
        assert_eq!(
            result.findings[0].actual["placeholders"],
            json!([{"match":"BAD","start":11,"end":14}])
        );
        Ok(())
    }
}
