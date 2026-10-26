use super::{Format, Limits, Options, Parsed, failure};
use crate::snapshot::{Entry, u32_bytes};
use crate::wtf8::Wtf8Buf;
use rustc_hash::FxHashMap;
use serde_json::{Map, Value, json};
use std::sync::Arc;

pub const FIELDS: [&str; 12] = [
    "namespace",
    "key",
    "source",
    "translation",
    "path",
    "notes",
    "metadata",
    "source-extra",
    "translation-extra",
    "po-extra",
    "options",
    "ordinal",
];
pub const DOMAINS: [&str; 10] = [
    "identity",
    "identity",
    "source",
    "translation",
    "paths",
    "comments",
    "comments",
    "comments",
    "comments",
    "comments",
];

#[derive(Clone)]
pub struct LocalColumn {
    pub entry: Entry,
    pub bytes: Arc<Vec<u8>>,
}
#[derive(Clone)]
pub struct LocalLayer {
    pub columns: Vec<LocalColumn>,
}
impl LocalLayer {
    fn add(&mut self, name: &str, kind: u32, domain: &str, strings: u32, bytes: Vec<u8>) {
        self.columns.push(LocalColumn {
            entry: Entry {
                name: name.into(),
                kind,
                domain: domain.into(),
                strings,
                codec: 0,
                offset: 0,
                stored: bytes.len() as u32,
                raw: bytes.len() as u32,
                count: if matches!(kind, 2 | 3) {
                    bytes.len() as u32 / 4
                } else {
                    0
                },
                crc: 0,
            },
            bytes: Arc::new(bytes),
        });
    }
}
fn key_index(value: &str) -> Option<u32> {
    let n = value.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == value).then_some(n)
}
pub(super) fn stringify(value: &Value) -> String {
    match value {
        Value::Object(members) => {
            let mut keys = members.keys().collect::<Vec<_>>();
            keys.sort_by_key(|key| key_index(key).map_or((1, 0), |index| (0, index)));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        Wtf8Buf::from_view(key).json_string(),
                        stringify(&members[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::String(text) => Wtf8Buf::from_view(text).json_string(),
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()).map_or_else(
            || "null".into(),
            |n| ryu_js::Buffer::new().format_finite(n).into(),
        ),
        _ => value.to_string(),
    }
}
fn extra(value: &Map<String, Value>) -> String {
    if value.is_empty() {
        String::new()
    } else {
        Wtf8Buf::from_utf8(&stringify(&Value::Object(value.clone()))).into_view()
    }
}

struct Table {
    values: Vec<Vec<u8>>,
    ids: FxHashMap<String, u32>,
    bytes: usize,
    count: u32,
    blocks: Vec<Vec<u8>>,
    starts: Vec<u32>,
    identity: bool,
    identity_bytes: usize,
}
impl Table {
    fn new(identity: bool) -> Self {
        Self {
            values: Vec::new(),
            ids: FxHashMap::default(),
            bytes: 8,
            count: 0,
            blocks: Vec::new(),
            starts: Vec::new(),
            identity,
            identity_bytes: 0,
        }
    }
    fn flush(&mut self) {
        if self.values.is_empty() {
            return;
        }
        self.starts.push(self.count - self.values.len() as u32);
        // Input strings were checked on insertion, so block encoding cannot exceed its bounds.
        self.blocks.push(encode_block(&self.values));
        self.values.clear();
        if !self.identity {
            self.ids.clear();
        }
        self.bytes = 8;
    }
    fn add(&mut self, value: &str, file: &str, limits: &Limits) -> Parsed<u32> {
        if !self.identity && value.is_empty() && self.count > 0 {
            return Ok(0);
        }
        if let Some(id) = self.ids.get(value) {
            return Ok(*id);
        }
        let bytes = Wtf8Buf::from_view(value).into_bytes();
        if bytes.len() > 1024 * 1024 {
            return Err(failure(file, "limit_exceeded", ""));
        }
        if self.identity {
            self.identity_bytes +=
                bytes.len() + 128 + Wtf8Buf::from_view(value).to_utf16().len() * 2;
            if self.identity_bytes > limits.max_identity_bytes {
                return Err(failure(file, "limit_exceeded", ""));
            }
        } else if self.bytes + bytes.len() + 4 > 256 * 1024 {
            self.flush();
        }
        let id = self.count;
        self.count += 1;
        self.bytes += bytes.len() + 4;
        self.values.push(bytes);
        self.ids.insert(value.into(), id);
        Ok(id)
    }
    fn finish(mut self, domain: &str, output: &mut LocalLayer) {
        if self.identity {
            let values = std::mem::take(&mut self.values);
            let mut bytes = 8;
            for value in values {
                if !self.values.is_empty() && bytes + value.len() + 4 > 256 * 1024 {
                    self.starts.push(
                        self.starts
                            .last()
                            .map_or(0, |_| self.count - self.values.len() as u32),
                    );
                    self.blocks.push(encode_block(&self.values));
                    self.values.clear();
                    bytes = 8;
                }
                bytes += value.len() + 4;
                self.values.push(value);
            }
            // Rebuild starts from the encoded block counts; identity retains global deduplication.
            if !self.values.is_empty() {
                self.blocks.push(encode_block(&self.values));
            }
            self.starts.clear();
            let mut start = 0;
            for block in &self.blocks {
                self.starts.push(start);
                start += u32::from_le_bytes([block[0], block[1], block[2], block[3]]);
            }
        } else {
            self.flush();
        }
        for (i, block) in self.blocks.into_iter().enumerate() {
            output.add(&format!("{domain}.b{i}"), 4, domain, self.count, block);
        }
        output.add(
            &format!("{domain}.starts"),
            2,
            "",
            0,
            u32_bytes(&self.starts),
        );
    }
}
fn encode_block(values: &[Vec<u8>]) -> Vec<u8> {
    let mut output = Vec::new();
    output.extend_from_slice(&(values.len() as u32).to_le_bytes());
    let mut offset = 0u32;
    output.extend_from_slice(&offset.to_le_bytes());
    for value in values {
        offset += value.len() as u32;
        output.extend_from_slice(&offset.to_le_bytes());
    }
    for value in values {
        output.extend_from_slice(value);
    }
    output
}

struct Builder<'a> {
    file: &'a str,
    limits: &'a Limits,
    tables: [Table; 5],
    columns: [Vec<u32>; 12],
    path_prefix: String,
}
impl Builder<'_> {
    fn id(&mut self, value: &str) -> Parsed<u32> {
        self.tables[0].add(value, self.file, self.limits)
    }
    fn put(&mut self, field: usize, value: &str) -> Parsed<()> {
        let mut value = value;
        let row = self.columns[0].len() - 1;
        if field == 4 && !value.is_empty() {
            if Wtf8Buf::from_view(value).as_bytes().len() > 1024 * 1024 {
                return Err(failure(self.file, "limit_exceeded", ""));
            }
            if self.path_prefix.is_empty() {
                self.path_prefix = value[..value.rfind('/').map_or(0, |i| i + 1)].into();
            }
            if !self.path_prefix.is_empty()
                && let Some(suffix) = value.strip_prefix(&self.path_prefix)
            {
                value = suffix;
                self.columns[10][row] |= 1024;
            }
        }
        let table = match field {
            2 => 1,
            3 => 2,
            4 => 3,
            _ => 4,
        };
        self.columns[field][row] = self.tables[table].add(value, self.file, self.limits)?;
        Ok(())
    }
    fn row(&mut self) {
        for col in &mut self.columns {
            col.push(0);
        }
    }
}

pub fn parse_columns(
    text: &str,
    file: &str,
    options: &Options,
    limits: &Limits,
) -> Parsed<LocalLayer> {
    let mut b = Builder {
        file,
        limits,
        tables: [
            Table::new(true),
            Table::new(false),
            Table::new(false),
            Table::new(false),
            Table::new(false),
        ],
        columns: std::array::from_fn(|_| Vec::new()),
        path_prefix: String::new(),
    };
    for table in &mut b.tables[1..] {
        table.add("", file, limits)?;
    }
    let mut po_format = options.po_format.clone().unwrap_or_else(|| "Unreal".into());
    if options.format == Format::Po {
        let document = super::parse_po(text, file, options, limits)?;
        po_format = document.format;
        let keyed = po_format == "Crowdin"
            && options
                .collapse_mode
                .as_deref()
                .unwrap_or("IdenticalTextIdAndSource")
                == "IdenticalTextIdAndSource";
        for (i, entry) in document.rows.iter().enumerate() {
            b.row();
            let id = entry.initial_identity.clone();
            b.columns[0][i] = b.id(&id.namespace)?;
            b.columns[1][i] = b.id(&id.key)?;
            b.columns[10][i] = if entry.identity.is_none() { 16 } else { 0 };
            b.columns[11][i] = i as u32;
            b.put(2, &entry.msgid)?;
            if entry.msgstr.get(&0) == Some(&entry.msgid) {
                b.columns[10][i] |= 128;
            } else {
                b.put(3, entry.msgstr.get(&0).map_or("", String::as_str))?;
            }
            let mut extras = Map::new();
            if let Some(plural) = &entry.msgid_plural {
                extras.insert("msgidPlural".into(), json!(plural));
            }
            let mut extracted = entry.extracted_comments.as_slice();
            if options.po_format.is_some() && extracted.first() == Some(&format!("Key: {}", id.key))
            {
                b.columns[10][i] |= 256;
                extracted = &extracted[1..];
            }
            for (name, values) in [
                ("extractedComments", extracted),
                ("translatorComments", entry.translator_comments.as_slice()),
                ("flags", entry.flags.as_slice()),
                ("previousMsgidLines", entry.previous_msgid_lines.as_slice()),
            ] {
                if !values.is_empty() {
                    extras.insert(name.into(), json!(values));
                }
            }
            if let Some(path) = entry.reference_comments.first() {
                b.columns[10][i] |= 512;
                b.put(4, path)?;
                if entry.reference_comments.len() > 1 {
                    extras.insert(
                        "referenceComments".into(),
                        json!(&entry.reference_comments[1..]),
                    );
                }
            }
            let translations = entry
                .msgstr
                .iter()
                .filter(|(key, _)| **key != 0)
                .map(|(key, value)| (key.to_string(), json!(value)))
                .collect::<Map<_, _>>();
            if !translations.is_empty() {
                extras.insert("msgstr".into(), Value::Object(translations));
            }
            if entry.msgstr.contains_key(&0) {
                b.columns[10][i] |= 64;
            }
            if let Some(context) = &entry.msgctxt {
                let canonical =
                    if keyed || context.contains('\\') || context.matches(',').count() != 1 {
                        format!(
                            "{},{}",
                            id.namespace.replace(',', "\\,"),
                            id.key.replace(',', "\\,")
                        )
                    } else {
                        context.clone()
                    };
                if options.po_format.is_some() && context == &canonical {
                    b.columns[10][i] |= 32;
                } else {
                    extras.insert("msgctxt".into(), json!(context));
                }
            }
            b.put(9, &extra(&extras))?;
        }
        for (i, entry) in document.rows.iter().enumerate() {
            if entry
                .identity
                .as_ref()
                .is_some_and(|id| *id != entry.initial_identity)
            {
                let id = entry
                    .identity
                    .as_ref()
                    .ok_or_else(|| failure(file, "invalid_schema", ""))?;
                b.columns[0][i] = b.id(&id.namespace)?;
                b.columns[1][i] = b.id(&id.key)?;
            }
        }
    } else {
        let document = super::parse_json(text, file, options.format, limits)?;
        for (i, entry) in document.rows.iter().enumerate() {
            b.row();
            b.columns[1][i] = b.id(&entry.key)?;
            b.columns[11][i] = entry.ordinal as u32;
            b.put(2, &entry.source.text)?;
            b.put(7, &extra(&entry.source.extra))?;
            if let Some(path) = &entry.path {
                b.put(4, path)?;
            }
            if let Some(notes) = &entry.dev_notes {
                b.put(5, notes)?;
                b.columns[10][i] |= 4;
            }
            if let Some(metadata) = &entry.metadata {
                b.put(
                    6,
                    &Wtf8Buf::from_utf8(&stringify(&Value::Object(metadata.clone()))).into_view(),
                )?;
                b.columns[10][i] |= 8;
            }
            if let Some(optional) = entry.optional {
                b.columns[10][i] |= if optional { 3 } else { 1 };
            }
            if let Some(translation) = &entry.translation {
                if translation.text == entry.source.text {
                    b.columns[10][i] |= 128;
                } else {
                    b.put(3, &translation.text)?;
                }
                b.put(8, &extra(&translation.extra))?;
            }
        }
        for namespace in &document.namespaces {
            b.id(namespace)?;
        }
        for (i, entry) in document.rows.iter().enumerate() {
            b.columns[0][i] = b.id(&entry.namespace)?;
        }
    }
    if b.tables[0].count == 0 {
        b.id("")?;
    }
    let count = b.columns[0].len();
    let identities = &b.tables[0].ids;
    let mut keys = vec![Vec::<u16>::new(); identities.len()];
    for (text, id) in identities {
        keys[*id as usize] = Wtf8Buf::from_view(text).to_utf16();
    }
    let mut order = (0..count).collect::<Vec<_>>();
    order.sort_by(|a, z| {
        keys[b.columns[0][*a] as usize]
            .cmp(&keys[b.columns[0][*z] as usize])
            .then_with(|| keys[b.columns[1][*a] as usize].cmp(&keys[b.columns[1][*z] as usize]))
            .then_with(|| b.columns[11][*a].cmp(&b.columns[11][*z]))
    });
    let mut output = LocalLayer {
        columns: Vec::new(),
    };
    for (i, field) in FIELDS.iter().enumerate() {
        let values = order
            .iter()
            .map(|row| b.columns[i][*row])
            .collect::<Vec<_>>();
        let domain = DOMAINS.get(i).copied().unwrap_or("");
        let table = match domain {
            "identity" => 0,
            "source" => 1,
            "translation" => 2,
            "paths" => 3,
            _ => 4,
        };
        output.add(
            &format!("entry.{field}"),
            if domain.is_empty() { 2 } else { 3 },
            domain,
            if domain.is_empty() {
                0
            } else {
                b.tables[table].count
            },
            u32_bytes(&values),
        );
    }
    let [identity, source, translation, paths, comments] = b.tables;
    for (domain, table) in [
        ("source", source),
        ("translation", translation),
        ("paths", paths),
        ("comments", comments),
        ("identity", identity),
    ] {
        table.finish(domain, &mut output);
    }
    let format = match options.format {
        Format::Manifest => "manifest",
        Format::Archive => "archive",
        Format::Po => "po",
    };
    let has_source = po_format != "Crowdin"
        || options
            .collapse_mode
            .as_deref()
            .unwrap_or("IdenticalTextIdAndSource")
            != "IdenticalTextIdAndSource";
    let metadata = json!({"format":format,"count":count,"poFormat":po_format,"pathPrefix":b.path_prefix,"hasSourceText":has_source});
    output.add(
        "file.meta",
        0,
        "",
        0,
        serde_json::to_vec(&metadata).map_err(|_| failure(file, "invalid_schema", ""))?,
    );
    Ok(output)
}
