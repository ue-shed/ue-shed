use super::{Diagnostic, Format, JsonRow, Limits, Parsed, Text, failure};
use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Value,
    Node,
    Children,
    Nodes,
}
#[derive(Clone, Copy, PartialEq)]
enum State {
    Key,
    Colon,
    Value,
    Comma,
    First,
}
struct Frame {
    array: bool,
    mode: Mode,
    node: usize,
    value: Value,
    state: State,
    key: String,
    bytes: usize,
    namespace_seen: bool,
}
struct Node {
    parent: Option<usize>,
    name: String,
}
#[derive(Deserialize)]
struct Key {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "Path")]
    path: String,
    #[serde(rename = "Optional")]
    optional: Option<bool>,
    #[serde(rename = "MetaData")]
    metadata: Option<Map<String, Value>>,
    #[serde(rename = "DevNotes")]
    dev_notes: Option<String>,
}
#[derive(Deserialize)]
struct ManifestChild {
    #[serde(rename = "Source")]
    source: Text,
    #[serde(rename = "Keys")]
    keys: Vec<Key>,
}
#[derive(Deserialize)]
struct ArchiveChild {
    #[serde(rename = "Source")]
    source: Text,
    #[serde(rename = "Translation")]
    translation: Text,
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "Optional")]
    optional: Option<bool>,
    #[serde(rename = "MetaData")]
    metadata: Option<Map<String, Value>>,
}
fn optional_valid(value: &Value, name: &str, valid: impl FnOnce(&Value) -> bool) -> bool {
    value.get(name).is_none_or(valid)
}
fn key_valid(value: &Value, manifest: bool) -> bool {
    value.get("Key").is_some_and(Value::is_string)
        && (!manifest || value.get("Path").is_some_and(Value::is_string))
        && optional_valid(value, "Optional", Value::is_boolean)
        && optional_valid(value, "MetaData", Value::is_object)
        && (!manifest || optional_valid(value, "DevNotes", Value::is_string))
}
fn escaped_surrogates(text: &str, format: Format, file: &str, base: usize) -> Parsed<()> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            i += 1;
            continue;
        }
        if bytes.get(i + 1) == Some(&b'u')
            && let Some(hex) = text.get(i + 2..i + 6)
            && let Ok(unit) = u16::from_str_radix(hex, 16)
        {
            if (0xd800..=0xdfff).contains(&unit) {
                let next = text
                    .get(i + 6..i + 12)
                    .and_then(|s| s.strip_prefix("\\u"))
                    .and_then(|hex| u16::from_str_radix(hex, 16).ok());
                if unit <= 0xdbff && next.is_some_and(|n| (0xdc00..=0xdfff).contains(&n)) {
                    i += 12;
                    continue;
                }
                // packages/localization/src/unreal-json.ts:5-33: Unreal rejects lone escapes.
                let offset = base + text[..i].encode_utf16().count();
                let mut error = failure(
                    file,
                    if format == Format::Manifest {
                        "malformed_manifest"
                    } else {
                        "malformed_archive"
                    },
                    "",
                );
                error.message = format!(
                    "{file} at character offset {offset}: escaped unpaired UTF-16 surrogate; Unreal Engine 5.7 and 5.8 cannot load this file either."
                );
                error.recovery =
                    "Repair the escaped surrogate or regenerate the file through Unreal.".into();
                return Err(error);
            }
            i += 6;
        } else {
            i += 2;
        }
    }
    Ok(())
}

include!("json_lex.rs");

struct Parser<'a> {
    lex_token: String,
    lex_units: usize,
    lex_quoted: bool,
    lex_escaped: bool,
    lex_record: Option<Record>,
    file: &'a str,
    format: Format,
    limits: &'a Limits,
    frames: Vec<Frame>,
    nodes: Vec<Node>,
    root_done: bool,
    version: Option<Value>,
    invalid: bool,
    node_bytes: usize,
    offset: usize,
    invalid_child: Option<usize>,
    rows: Vec<(usize, JsonRow)>,
}
impl Parser<'_> {
    fn error(&self, code: &str) -> Diagnostic {
        failure(
            self.file,
            code,
            &format!(" at character offset {}", self.offset),
        )
    }
    fn child(&mut self, value: Value, node: usize) -> Parsed<()> {
        let valid = if self.format == Format::Manifest {
            value
                .get("Source")
                .and_then(|v| v.get("Text"))
                .is_some_and(Value::is_string)
                && value
                    .get("Keys")
                    .and_then(Value::as_array)
                    .is_some_and(|keys| keys.iter().all(|v| key_valid(v, true)))
        } else {
            key_valid(&value, false)
                && value
                    .get("Source")
                    .and_then(|v| v.get("Text"))
                    .is_some_and(Value::is_string)
                && value
                    .get("Translation")
                    .and_then(|v| v.get("Text"))
                    .is_some_and(Value::is_string)
        };
        if !valid {
            self.invalid_child.get_or_insert(self.offset);
            return Ok(());
        }
        if self.format == Format::Manifest {
            let child: ManifestChild =
                serde_json::from_value(value).map_err(|_| self.error("invalid_schema"))?;
            for key in child.keys {
                self.push(
                    node,
                    JsonRow {
                        ordinal: 0,
                        namespace: String::new(),
                        key: key.key,
                        source: child.source.clone(),
                        translation: None,
                        path: Some(key.path),
                        optional: key.optional,
                        metadata: key.metadata,
                        dev_notes: key.dev_notes,
                    },
                )?;
            }
        } else {
            let child: ArchiveChild =
                serde_json::from_value(value).map_err(|_| self.error("invalid_schema"))?;
            self.push(
                node,
                JsonRow {
                    ordinal: 0,
                    namespace: String::new(),
                    key: child.key,
                    source: child.source,
                    translation: Some(child.translation),
                    path: None,
                    optional: child.optional,
                    metadata: child.metadata,
                    dev_notes: None,
                },
            )?;
        }
        Ok(())
    }
    fn push(&mut self, node: usize, row: JsonRow) -> Parsed<()> {
        if self.rows.len() >= self.limits.max_entries {
            return Err(failure(self.file, "limit_exceeded", ""));
        }
        self.rows.push((node, row));
        Ok(())
    }
    fn accept(&mut self, value: Value) -> Parsed<()> {
        if self.frames.len() > self.limits.max_depth {
            return Err(self.error("limit_exceeded"));
        }
        let Some(frame) = self.frames.last_mut() else {
            if self.root_done {
                return Err(self.error("malformed_json"));
            }
            self.root_done = true;
            return Ok(());
        };
        if frame.state != State::Value && !(frame.array && frame.state == State::First) {
            return Err(self.error("malformed_json"));
        }
        let (mode, node) = (frame.mode, frame.node);
        match mode {
            Mode::Children => {}
            Mode::Node => match frame.key.as_str() {
                "Namespace" => {
                    if let Some(value) = value.as_str() {
                        let old = self.nodes[node].name.encode_utf16().count() * 5;
                        self.node_bytes = self.node_bytes + value.encode_utf16().count() * 5 - old;
                        if self.node_bytes > self.limits.max_identity_bytes {
                            return Err(self.error("limit_exceeded"));
                        }
                        self.nodes[node].name = value.into();
                    } else {
                        self.invalid = true;
                    }
                }
                "FormatVersion" if node == 0 => self.version = Some(value.clone()),
                "Children" | "Subnamespaces" => {
                    if !value.is_array() {
                        self.invalid = true;
                    }
                }
                _ => {}
            },
            Mode::Nodes => self.invalid = true,
            Mode::Value => match &mut frame.value {
                Value::Array(values) => values.push(value.clone()),
                Value::Object(values) => {
                    values.insert(frame.key.clone(), value.clone());
                }
                _ => {}
            },
        }
        frame.state = State::Comma;
        if mode == Mode::Children {
            self.child(value, node)?;
        }
        Ok(())
    }
    fn emit(&mut self, value: Value, punctuation: u8) -> Parsed<()> {
        if matches!(punctuation, b'{' | b'[') {
            let frame = self.frames.last();
            if frame
                .is_some_and(|f| f.state != State::Value && !(f.array && f.state == State::First))
                || (frame.is_none() && self.root_done)
            {
                return Err(self.error("malformed_json"));
            }
            if self.frames.len() > self.limits.max_depth {
                return Err(self.error("limit_exceeded"));
            }
            let mut mode = Mode::Value;
            let mut node = frame.map_or(0, |f| f.node);
            if frame.is_none_or(|f| f.mode == Mode::Nodes) {
                if punctuation != b'{' {
                    self.invalid = true;
                } else {
                    mode = Mode::Node;
                    node = self.nodes.len();
                    self.node_bytes += 128;
                    if node >= self.limits.max_entries
                        || self.node_bytes > self.limits.max_identity_bytes
                    {
                        return Err(self.error("limit_exceeded"));
                    }
                    self.nodes.push(Node {
                        parent: frame.map(|f| f.node),
                        name: String::new(),
                    });
                }
            } else if frame.is_some_and(|f| {
                f.mode == Mode::Node && matches!(f.key.as_str(), "Children" | "Subnamespaces")
            }) {
                if punctuation != b'[' {
                    self.invalid = true;
                } else {
                    mode = if frame.is_some_and(|f| f.key == "Children") {
                        Mode::Children
                    } else {
                        Mode::Nodes
                    };
                }
            }
            self.frames.push(Frame {
                array: punctuation == b'[',
                mode,
                node,
                value: if punctuation == b'[' {
                    Value::Array(Vec::new())
                } else {
                    Value::Object(Map::new())
                },
                state: State::First,
                key: String::new(),
                bytes: 0,
                namespace_seen: false,
            });
            return Ok(());
        }
        if matches!(punctuation, b'}' | b']') {
            if self.frames.last().is_none_or(|f| {
                f.array != (punctuation == b']') || !matches!(f.state, State::First | State::Comma)
            }) {
                return Err(self.error("malformed_json"));
            }
            let frame = self
                .frames
                .pop()
                .ok_or_else(|| self.error("malformed_json"))?;
            if frame.mode == Mode::Node && !frame.namespace_seen {
                self.invalid = true;
            }
            if frame.mode == Mode::Node && self.frames.last().is_some_and(|p| p.mode == Mode::Nodes)
            {
                if let Some(parent) = self.frames.last_mut() {
                    parent.state = State::Comma;
                }
            } else {
                self.accept(if frame.mode == Mode::Node {
                    Value::Null
                } else {
                    frame.value
                })?;
            }
            return Ok(());
        }
        if punctuation == b',' {
            if self.frames.last().is_none_or(|f| f.state != State::Comma) {
                return Err(self.error("malformed_json"));
            }
            if let Some(frame) = self.frames.last_mut() {
                frame.state = if frame.array {
                    State::Value
                } else {
                    State::Key
                };
            }
        } else if punctuation == b':' {
            if self.frames.last().is_none_or(|f| f.state != State::Colon) {
                return Err(self.error("malformed_json"));
            }
            if let Some(frame) = self.frames.last_mut() {
                frame.state = State::Value;
            }
        } else if self
            .frames
            .last()
            .is_some_and(|f| !f.array && matches!(f.state, State::Key | State::First))
        {
            let key = value.as_str().ok_or_else(|| self.error("malformed_json"))?;
            if let Some(frame) = self.frames.last_mut() {
                frame.key = key.into();
                frame.state = State::Colon;
                if frame.mode == Mode::Node && key == "Namespace" {
                    frame.namespace_seen = true;
                }
            }
        } else {
            self.accept(value)?;
        }
        Ok(())
    }
    fn token(&mut self, text: &str, base: usize) -> Parsed<Value> {
        let value = crate::json_value::parse(text).map_err(|_| self.error("malformed_json"))?;
        escaped_surrogates(text, self.format, self.file, base)?;
        Ok(value)
    }
}

pub struct JsonDocument {
    pub rows: Vec<JsonRow>,
    pub namespaces: Vec<String>,
}
pub fn parse_json(text: &str, file: &str, format: Format, limits: &Limits) -> Parsed<JsonDocument> {
    parse_json_chunks(&[text], file, format, limits)
}
pub fn parse_json_chunks(
    chunks: &[&str],
    file: &str,
    format: Format,
    limits: &Limits,
) -> Parsed<JsonDocument> {
    let mut p = Parser {
        file,
        format,
        limits,
        frames: Vec::new(),
        nodes: Vec::new(),
        root_done: false,
        version: None,
        invalid: false,
        node_bytes: 0,
        offset: 0,
        invalid_child: None,
        rows: Vec::new(),
        lex_token: String::new(),
        lex_units: 0,
        lex_quoted: false,
        lex_escaped: false,
        lex_record: None,
    };
    for chunk in chunks {
        p.feed(chunk)?;
    }
    if p.lex_quoted || p.lex_record.is_some() {
        return Err(p.error("malformed_json"));
    }
    if !p.lex_token.is_empty() {
        p.finish_token()?;
    }
    if !p.frames.is_empty() || !p.root_done {
        return Err(p.error("malformed_json"));
    }
    let version = p.version.as_ref().and_then(Value::as_f64);
    if version.is_none_or(|v| v.fract() != 0.0) {
        return Err(p.error("invalid_schema"));
    }
    if version != Some(if format == Format::Manifest { 1.0 } else { 2.0 }) {
        return Err(p.error("unsupported_version"));
    }
    if p.invalid {
        return Err(p.error("invalid_schema"));
    }
    let mut namespaces = Vec::<String>::new();
    let mut resolved = 0;
    for node in &p.nodes {
        let parent = node.parent.map_or("", |n| namespaces[n].as_str());
        let namespace = if parent.is_empty() {
            node.name.clone()
        } else {
            format!("{parent}.{}", node.name)
        };
        resolved += 128 + namespace.encode_utf16().count() * 5;
        if resolved > limits.max_identity_bytes {
            return Err(p.error("limit_exceeded"));
        }
        namespaces.push(namespace);
    }
    if let Some(offset) = p.invalid_child {
        p.offset = offset;
        return Err(p.error("invalid_schema"));
    }
    // packages/game-text/src/localization-columns.ts:486-493: physical rows retain preorder ordinals.
    let mut order = (0..p.rows.len()).collect::<Vec<_>>();
    order.sort_by_key(|i| p.rows[*i].0);
    for (ordinal, i) in order.into_iter().enumerate() {
        p.rows[i].1.ordinal = ordinal;
    }
    Ok(JsonDocument {
        rows: p
            .rows
            .into_iter()
            .map(|(node, mut row)| {
                row.namespace = namespaces[node].clone();
                row
            })
            .collect(),
        namespaces,
    })
}
