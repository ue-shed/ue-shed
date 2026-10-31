use super::{Format, JsonRow, Limits, Options, Text, columns, json, po};
use memchr::{memchr, memchr2};
use std::borrow::Cow;

pub(super) fn parse(
    bytes: &[u8],
    file: &str,
    options: &Options,
    limits: &Limits,
) -> Option<columns::LocalLayer> {
    if bytes.len() as u64 > limits.max_file_bytes {
        return None;
    }
    let text = if options.format != Format::Po && bytes.starts_with(&[255, 254]) {
        let (pairs, tail) = bytes[2..].as_chunks::<2>();
        if !tail.is_empty() {
            return None;
        }
        let units = pairs
            .iter()
            .map(|b| u16::from_le_bytes(*b))
            .collect::<Vec<_>>();
        Cow::Owned(String::from_utf16(&units).ok()?)
    } else {
        Cow::Borrowed(
            std::str::from_utf8(bytes.strip_prefix(&[239, 187, 191]).unwrap_or(bytes)).ok()?,
        )
    };
    // Reserved scalar views require the reference decoder.
    if memchr(0xf3, text.as_bytes()).is_some() {
        return None;
    }
    if options.format == Format::Po {
        let document = po::parse_po(&text, file, options, limits).ok()?;
        columns::build_po(document, None, file, options, limits, true).ok()
    } else {
        let document = Parser {
            text: &text,
            at: 0,
            depth: 0,
            format: options.format,
            limits,
            nodes: Vec::new(),
            rows: Vec::new(),
            node_bytes: 0,
        }
        .document()?;
        columns::build_json(document, None, file, options, limits, true).ok()
    }
}

struct Node {
    parent: Option<usize>,
    name: String,
}
struct Key {
    key: String,
    path: String,
    optional: Option<bool>,
    dev_notes: Option<String>,
}
struct Parser<'a> {
    text: &'a str,
    at: usize,
    depth: usize,
    format: Format,
    limits: &'a Limits,
    nodes: Vec<Node>,
    rows: Vec<(usize, JsonRow)>,
    node_bytes: usize,
}
impl<'a> Parser<'a> {
    fn space(&mut self) {
        while self
            .text
            .as_bytes()
            .get(self.at)
            .is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n'))
        {
            self.at += 1;
        }
    }
    fn take(&mut self, byte: u8) -> bool {
        self.space();
        if self.text.as_bytes().get(self.at) == Some(&byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn open(&mut self, byte: u8) -> Option<()> {
        if !self.take(byte) {
            return None;
        }
        self.depth += 1;
        (self.depth <= self.limits.max_depth).then_some(())
    }
    fn next(&mut self, first: &mut bool, end: u8) -> Option<bool> {
        if self.take(end) {
            self.depth -= 1;
            return Some(false);
        }
        if !*first && !self.take(b',') {
            return None;
        }
        *first = false;
        Some(true)
    }
    fn member(&mut self, first: &mut bool) -> Option<Option<Cow<'a, str>>> {
        if !self.next(first, b'}')? {
            return Some(None);
        }
        let key = self.string()?;
        self.take(b':').then_some(Some(key))
    }
    fn string(&mut self) -> Option<Cow<'a, str>> {
        if !self.take(b'"') {
            return None;
        }
        let start = self.at;
        let mut segment = start;
        let mut owned: Option<String> = None;
        loop {
            let stop = self.at + memchr2(b'"', b'\\', &self.text.as_bytes()[self.at..])?;
            if self.text.as_bytes()[self.at..stop]
                .iter()
                .any(|b| *b < 0x20)
                || (stop + 2 - start).checked_mul(2)? > self.limits.max_record_bytes
            {
                return None;
            }
            self.at = stop + 1;
            if self.text.as_bytes()[stop] == b'"' {
                return Some(match owned {
                    Some(mut text) => {
                        text.push_str(&self.text[segment..stop]);
                        Cow::Owned(text)
                    }
                    None => Cow::Borrowed(&self.text[start..stop]),
                });
            }
            let out = owned.get_or_insert_with(String::new);
            out.push_str(&self.text[segment..stop]);
            let escape = *self.text.as_bytes().get(self.at)?;
            self.at += 1;
            out.push(match escape {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => {
                    let hex = self.text.get(self.at..self.at + 4)?;
                    if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return None;
                    }
                    let unit = u16::from_str_radix(hex, 16).ok()?;
                    self.at += 4;
                    char::from_u32(u32::from(unit))?
                }
                _ => return None,
            });
            segment = self.at;
        }
    }
    fn boolean(&mut self) -> Option<bool> {
        self.space();
        for (token, value) in [("true", true), ("false", false)] {
            if self.text[self.at..].starts_with(token) {
                self.at += token.len();
                return Some(value);
            }
        }
        None
    }
    fn text(&mut self) -> Option<Text> {
        self.open(b'{')?;
        let mut first = true;
        if self.member(&mut first)?? != "Text" {
            return None;
        }
        let text = self.string()?.into_owned();
        if self.member(&mut first)?.is_some() {
            return None;
        }
        Some(Text {
            text,
            extra: Default::default(),
        })
    }
    fn key(&mut self) -> Option<Key> {
        self.open(b'{')?;
        let mut first = true;
        let mut seen = 0;
        let (mut key, mut path, mut optional, mut dev_notes) = (None, None, None, None);
        while let Some(name) = self.member(&mut first)? {
            let bit = match name.as_ref() {
                "Key" => {
                    key = Some(self.string()?.into_owned());
                    1
                }
                "Path" => {
                    path = Some(self.string()?.into_owned());
                    2
                }
                "Optional" => {
                    optional = Some(self.boolean()?);
                    4
                }
                "DevNotes" => {
                    dev_notes = Some(self.string()?.into_owned());
                    8
                }
                _ => return None,
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        Some(Key {
            key: key?,
            path: path?,
            optional,
            dev_notes,
        })
    }
    fn record(&mut self, node: usize) -> Option<()> {
        self.space();
        let start = self.at;
        self.open(b'{')?;
        let mut first = true;
        let mut seen = 0;
        let (mut source, mut translation, mut key, mut optional, mut keys) =
            (None, None, None, None, None);
        while let Some(name) = self.member(&mut first)? {
            let bit = match name.as_ref() {
                "Source" => {
                    source = Some(self.text()?);
                    1
                }
                "Translation" if self.format == Format::Archive => {
                    translation = Some(self.text()?);
                    2
                }
                "Key" if self.format == Format::Archive => {
                    key = Some(self.string()?.into_owned());
                    4
                }
                "Optional" if self.format == Format::Archive => {
                    optional = Some(self.boolean()?);
                    8
                }
                "Keys" if self.format == Format::Manifest => {
                    self.open(b'[')?;
                    let mut values = Vec::new();
                    let mut first = true;
                    while self.next(&mut first, b']')? {
                        values.push(self.key()?);
                        if values.len() >= self.limits.max_entries
                            || (self.at - start).checked_mul(2)? > self.limits.max_record_bytes
                        {
                            return None;
                        }
                    }
                    keys = Some(values);
                    16
                }
                _ => return None,
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        if (self.at - start).checked_mul(2)? > self.limits.max_record_bytes {
            return None;
        }
        let source = source?;
        if self.format == Format::Manifest {
            for key in keys? {
                self.row(
                    node,
                    JsonRow {
                        ordinal: 0,
                        namespace: String::new(),
                        key: key.key,
                        source: source.clone(),
                        translation: None,
                        path: Some(key.path),
                        optional: key.optional,
                        metadata: None,
                        dev_notes: key.dev_notes,
                    },
                )?;
            }
        } else {
            self.row(
                node,
                JsonRow {
                    ordinal: 0,
                    namespace: String::new(),
                    key: key?,
                    source,
                    translation: Some(translation?),
                    path: None,
                    optional,
                    metadata: None,
                    dev_notes: None,
                },
            )?;
        }
        Some(())
    }
    fn row(&mut self, node: usize, row: JsonRow) -> Option<()> {
        self.rows.push((node, row));
        (self.rows.len() < self.limits.max_entries).then_some(())
    }
    fn node(&mut self, parent: Option<usize>, nesting: usize) -> Option<()> {
        if nesting > 16 {
            return None;
        }
        self.open(b'{')?;
        let node = self.nodes.len();
        self.nodes.push(Node {
            parent,
            name: String::new(),
        });
        self.node_bytes = self.node_bytes.checked_add(128)?;
        if self.nodes.len() >= self.limits.max_entries
            || self.node_bytes > self.limits.max_identity_bytes
        {
            return None;
        }
        let mut first = true;
        let mut seen = 0;
        while let Some(name) = self.member(&mut first)? {
            let bit = match name.as_ref() {
                "FormatVersion" if parent.is_none() => {
                    let version = if self.format == Format::Manifest {
                        b'1'
                    } else {
                        b'2'
                    };
                    if !self.take(version) {
                        return None;
                    }
                    1
                }
                "Namespace" => {
                    let name = self.string()?.into_owned();
                    self.node_bytes = self.node_bytes.checked_add(name.len().checked_mul(5)?)?;
                    if self.node_bytes > self.limits.max_identity_bytes {
                        return None;
                    }
                    self.nodes[node].name = name;
                    2
                }
                "Children" => {
                    self.open(b'[')?;
                    let mut first = true;
                    while self.next(&mut first, b']')? {
                        self.record(node)?;
                    }
                    4
                }
                "Subnamespaces" => {
                    self.open(b'[')?;
                    let mut first = true;
                    while self.next(&mut first, b']')? {
                        self.node(Some(node), nesting + 1)?;
                    }
                    8
                }
                _ => return None,
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        (seen & 2 != 0 && (parent.is_some() || seen & 1 != 0)).then_some(())
    }
    fn document(mut self) -> Option<json::JsonDocument> {
        self.node(None, 1)?;
        self.space();
        if self.at != self.text.len() {
            return None;
        }
        let mut namespaces = Vec::<String>::with_capacity(self.nodes.len());
        let mut resolved = 0usize;
        for node in self.nodes {
            let parent = node.parent.map_or("", |n| namespaces[n].as_str());
            let namespace = if parent.is_empty() {
                node.name
            } else {
                format!("{parent}.{}", node.name)
            };
            resolved = resolved.checked_add(128 + namespace.len().checked_mul(5)?)?;
            if resolved > self.limits.max_identity_bytes {
                return None;
            }
            namespaces.push(namespace);
        }
        let mut order = (0..self.rows.len()).collect::<Vec<_>>();
        order.sort_by_key(|i| self.rows[*i].0);
        for (ordinal, i) in order.into_iter().enumerate() {
            self.rows[i].1.ordinal = ordinal;
        }
        Some(json::JsonDocument {
            rows: self
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
}
