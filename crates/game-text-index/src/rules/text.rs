use super::grammar::rich_text_counts;
use super::regex::{units, view};
use super::value::{Value, value};
use crate::join_policy::{js_space, trim};
use crate::{Error, ErrorCode, Result};
#[cfg(test)]
use serde_json::json;
use std::collections::BTreeMap;

// Byte ranges are over the reversible scalar view. ASCII syntax bytes never split a scalar.
#[derive(Clone, Copy, Debug)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Copy)]
struct Tag {
    range: TextRange,
    name_end: usize,
}
fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}
fn first_name(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}
fn spaces(text: &str, mut at: usize) -> usize {
    for c in text[at..].chars() {
        if !js_space(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}
fn tag_at(text: &str, start: usize) -> Option<Tag> {
    let bytes = text.as_bytes();
    let mut at = start + 1;
    if !first_name(*bytes.get(at)?) {
        return None;
    }
    at += 1;
    while bytes.get(at).copied().is_some_and(word) {
        at += 1;
    }
    let name_end = at;
    loop {
        let next = spaces(text, at);
        if bytes.get(next) == Some(&b'>') {
            return Some(Tag {
                range: TextRange {
                    start,
                    end: next + 1,
                },
                name_end,
            });
        }
        if bytes.get(next..next + 2) == Some(b"/>") {
            return Some(Tag {
                range: TextRange {
                    start,
                    end: next + 2,
                },
                name_end,
            });
        }
        if next == at || !bytes.get(next).copied().is_some_and(word) {
            return None;
        }
        at = next;
        while bytes.get(at).copied().is_some_and(word) {
            at += 1;
        }
        at = spaces(text, at);
        if bytes.get(at) != Some(&b'=') {
            return None;
        }
        at = spaces(text, at + 1);
        let quote = *bytes.get(at)?;
        if quote != b'\"' && quote != b'\'' {
            return None;
        }
        at += 1;
        at += bytes[at..].iter().position(|byte| *byte == quote)?;
        at += 1;
    }
}
fn tags(text: &str) -> impl Iterator<Item = Tag> + '_ {
    let mut at = 0;
    std::iter::from_fn(move || {
        while let Some(next) = text.as_bytes()[at..].iter().position(|byte| *byte == b'<') {
            let start = at + next;
            at = start + 1;
            if let Some(tag) = tag_at(text, start) {
                at = tag.range.end;
                return Some(tag);
            }
        }
        None
    })
}
fn modifier_at(text: &str, start: usize) -> Option<usize> {
    let tail = &text[start..];
    let prefix = ["|plural(", "|ordinal(", "|gender(", "|hpp("]
        .into_iter()
        .find(|prefix| tail.starts_with(prefix))?;
    let mut chars = text[start + prefix.len()..].char_indices();
    let mut quoted = false;
    while let Some((offset, c)) = chars.next() {
        if quoted && c == '\\' {
            let (_, escaped) = chars.next()?;
            if matches!(escaped, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
                return None;
            }
        } else if c == '\"' {
            quoted = !quoted;
        } else if !quoted && c == '(' {
            return None;
        } else if !quoted && c == ')' {
            return Some(start + prefix.len() + offset + 1);
        }
    }
    None
}
pub fn replace_ranges(text: &str, ranges: &[TextRange], replacement: &str) -> Result<String> {
    let mut output = String::with_capacity(text.len());
    let mut offset = 0;
    for range in ranges {
        if range.start < offset || range.end > text.len() {
            return Err("Invalid match range.".into());
        }
        output.push_str(&text[offset..range.start]);
        output.push_str(replacement);
        offset = range.end;
    }
    output.push_str(&text[offset..]);
    Ok(output)
}
fn strip<'a>(text: &'a str, kind: u8, replacement: &str) -> Result<std::borrow::Cow<'a, str>> {
    let mut ranges = Vec::new();
    if kind == b'<' {
        ranges.extend(tags(text).map(|tag| tag.range));
    } else {
        let bytes = text.as_bytes();
        let mut at = 0;
        while let Some(next) = bytes[at..].iter().position(|byte| *byte == kind) {
            let start = at + next;
            at = start + 1;
            let end = match kind {
                b'/' => text[start..]
                    .starts_with("/>")
                    .then_some(start + 2)
                    .filter(|_| start > 0 && bytes[start - 1] == b'<'),
                b'|' => modifier_at(text, start),
                b'{' => bytes[at..]
                    .iter()
                    .position(|byte| matches!(*byte, b'{' | b'}'))
                    .filter(|offset| bytes[at + *offset] == b'}')
                    .map(|offset| at + offset + 1),
                _ => None,
            };
            if let Some(end) = end {
                ranges.push(TextRange {
                    start: if kind == b'/' { start - 1 } else { start },
                    end,
                });
                at = end;
            }
        }
    }
    if ranges.is_empty() {
        Ok(std::borrow::Cow::Borrowed(text))
    } else {
        replace_ranges(text, &ranges, replacement).map(std::borrow::Cow::Owned)
    }
}

pub struct Points<'a> {
    chars: std::str::Chars<'a>,
    pending: Option<u32>,
}
impl Points<'_> {
    fn read(&mut self) -> Option<u32> {
        if let Some(point) = self.pending.take() {
            return Some(point);
        }
        let c = self.chars.next()?;
        Some(if c == '\u{f0000}' {
            u32::from(self.chars.next()?)
        } else if ('\u{f0001}'..='\u{f0800}').contains(&c) {
            0xd800 + u32::from(c) - 0xf0001
        } else {
            u32::from(c)
        })
    }
}
impl Iterator for Points<'_> {
    type Item = u32;
    fn next(&mut self) -> Option<u32> {
        let point = self.read()?;
        if (0xd800..=0xdbff).contains(&point)
            && let Some(next) = self.read()
        {
            if (0xdc00..=0xdfff).contains(&next) {
                return Some(0x10000 + ((point - 0xd800) << 10) + next - 0xdc00);
            }
            self.pending = Some(next);
        }
        Some(point)
    }
}
pub fn points(text: &str) -> Points<'_> {
    Points {
        chars: text.chars(),
        pending: None,
    }
}
pub fn utf16_length(text: &str) -> usize {
    points(text)
        .map(|point| if point > 0xffff { 2 } else { 1 })
        .sum()
}

pub fn code_unit_compare(a: &str, b: &str) -> std::cmp::Ordering {
    units(a).cmp(&units(b))
}
pub fn code_points(text: &str) -> Vec<u32> {
    points(text).collect()
}
pub fn from_points(points: impl IntoIterator<Item = u32>) -> String {
    let mut output = Vec::new();
    for point in points {
        if point <= 0xffff {
            output.push(point as u16);
        } else if let Some(c) = char::from_u32(point) {
            output.extend_from_slice(c.encode_utf16(&mut [0; 2]));
        }
    }
    view(&output)
}
fn wide(point: u32) -> bool {
    matches!(point, 0x1100..=0x115f | 0x2e80..=0xa4cf | 0xac00..=0xd7a3 | 0xf900..=0xfaff | 0xfe30..=0xfe4f | 0xff00..=0xff60 | 0xffe0..=0xffe6 | 0x20000..=0x3fffd)
}
fn text_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | '\u{1c}'..=' ' | '\u{1680}' | '\u{2000}'..='\u{2006}' | '\u{2008}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{205f}' | '\u{3000}')
}

pub enum CharacterClass {
    JsSpace,
    TextSpace,
    Wide,
    Chars(Vec<u32>),
    Category(regex::Regex),
    Union(Vec<Self>),
}
impl CharacterClass {
    pub fn compile(value: &Value) -> Result<Self> {
        Ok(match value {
            Value::String(name) if name.as_ref() == "jsSpace" => Self::JsSpace,
            Value::String(name) if name.as_ref() == "textCharWhitespace" => Self::TextSpace,
            Value::String(name) if name.as_ref() == "wide" => Self::Wide,
            Value::Object(value) if value.contains_key("chars") => Self::Chars(code_points(
                value["chars"].as_str().ok_or("Invalid character list.")?,
            )),
            Value::Object(value) if value.contains_key("category") => {
                Self::Category(regex::Regex::new(&format!(
                    r"\A\p{{{}}}\z",
                    value["category"]
                        .as_str()
                        .ok_or("Invalid character category.")?
                ))?)
            }
            Value::Object(value) if value.contains_key("union") => Self::Union(
                value["union"]
                    .as_array()
                    .ok_or("Invalid character-class union.")?
                    .iter()
                    .map(Self::compile)
                    .collect::<Result<_>>()?,
            ),
            _ => {
                return Err(Error::new(
                    ErrorCode::InvalidInput,
                    "Invalid rule character class.",
                ));
            }
        })
    }
    pub fn contains(&self, point: u32) -> bool {
        match self {
            Self::JsSpace => char::from_u32(point).is_some_and(js_space),
            Self::TextSpace => char::from_u32(point).is_some_and(text_space),
            Self::Wide => wide(point),
            Self::Chars(chars) => chars.contains(&point),
            Self::Category(expression) => char::from_u32(point)
                .is_some_and(|c| expression.is_match(c.encode_utf8(&mut [0; 4]))),
            Self::Union(classes) => classes.iter().any(|class| class.contains(point)),
        }
    }
}

pub fn visible_length(text: &str) -> Result<usize> {
    let tags = strip(text, b'<', "")?;
    let closing = strip(&tags, b'/', "")?;
    let modifiers = strip(&closing, b'|', "")?;
    let visible = strip(&modifiers, b'{', "")?;
    let mut length = 0;
    let mut pending = false;
    for point in points(&visible) {
        if char::from_u32(point).is_some_and(js_space) {
            pending = length > 0;
            continue;
        }
        length += usize::from(pending) + if wide(point) { 2 } else { 1 };
        pending = false;
    }
    Ok(length)
}
pub fn visible_words(text: &str) -> Result<usize> {
    let tags = strip(text, b'<', " ")?;
    let visible = strip(&tags, b'/', " ")?;
    Ok(visible
        .split(js_space)
        .filter(|part| !part.is_empty())
        .count())
}
pub fn line_breaks(text: &str) -> usize {
    let mut previous = 0;
    text.bytes()
        .filter(|byte| {
            let found = *byte == b'\r' || (*byte == b'\n' && previous != b'\r');
            previous = *byte;
            found
        })
        .count()
}
pub fn interior_line_breaks(text: &str) -> usize {
    line_breaks(trim(text))
}
pub fn unreal_whitespace(text: &str) -> Value {
    value!({"leading":text.chars().take_while(|c| text_space(*c)).collect::<String>(),"trailing":text.chars().rev().take_while(|c| text_space(*c)).collect::<String>().chars().rev().collect::<String>(),"lineBreaks":line_breaks(text)})
}
pub fn unsafe_whitespace(text: &str) -> bool {
    [text.chars().next(), text.chars().next_back()]
        .into_iter()
        .flatten()
        .any(|c| c != '\r' && c != '\n' && text_space(c))
}
pub fn brace_balance(text: &str) -> Value {
    let mut opening = 0;
    let mut closing = 0;
    let mut escaped = false;
    for unit in points(text) {
        if escaped {
            escaped = false;
        } else if unit == 96 {
            escaped = true;
        } else if unit == 123 {
            opening += 1;
        } else if unit == 125 {
            closing += 1;
        }
    }
    value!({"opening":opening,"closing":closing})
}

fn tag_names(text: &str) -> Result<Vec<String>> {
    Ok(tags(text)
        .map(|tag| text[tag.range.start + 1..tag.name_end].to_owned())
        .collect())
}
pub fn rich_valid(source: &str, translation: &str) -> bool {
    let actual = rich_text_counts(translation);
    let expected = rich_text_counts(source);
    actual["opening"] == actual["closing"] || actual == expected
}
pub fn rich_balance(text: &str) -> Result<Value> {
    let bytes = text.as_bytes();
    let identifier = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let cpp_scope = bytes
        .windows(4)
        .any(|bytes| identifier(bytes[0]) && &bytes[1..3] == b"::" && identifier(bytes[3]));
    let mut opening = 0;
    for tag in tags(text) {
        let start = tag.range.start;
        let end = tag.range.end;
        let code = start > 0
            && identifier(bytes[start - 1])
            && (bytes.get(end) == Some(&b'(')
                || bytes.get(end..end + 2) == Some(b"::")
                || text.contains("->")
                || cpp_scope);
        if bytes.get(end - 2) != Some(&b'/')
            && !text[start + 1..tag.name_end].eq_ignore_ascii_case("br")
            && !code
        {
            opening += 1;
        }
    }
    let mut at = 0;
    while let Some(next) = text[at..].find("<{") {
        let start = at + next + 2;
        at = start;
        let end = bytes[start..]
            .iter()
            .position(|byte| matches!(*byte, b'{' | b'}' | b'<' | b'>'))
            .map(|offset| start + offset);
        if let Some(end) = end
            && end > start
            && bytes.get(end..end + 2) == Some(b"}>")
        {
            opening += 1;
            at = end + 2;
        }
    }
    let closing = text.match_indices("</>").count();
    let mut xml_closings = Vec::new();
    let mut at = 0;
    while let Some(next) = text[at..].find("</") {
        let start = at + next + 2;
        at = start;
        if !bytes.get(start).copied().is_some_and(first_name) {
            continue;
        }
        let mut end = start + 1;
        while bytes.get(end).copied().is_some_and(word) {
            end += 1;
        }
        let close = spaces(text, end);
        if bytes.get(close) == Some(&b'>') {
            xml_closings.push(text[start..end].to_owned());
            at = close + 1;
        }
    }
    Ok(value!({"opening":opening,"closing":closing,"xmlClosings":xml_closings}))
}

pub fn compare_tags(source: &str, translation: &str) -> Result<Value> {
    let source = tag_names(source)?;
    let translation = tag_names(translation)?;
    if source.is_empty() && translation.is_empty() {
        return Ok(Value::Null);
    }
    type Counts = BTreeMap<String, usize>;
    let mut groups = BTreeMap::<String, (Counts, Counts)>::new();
    for (side, values) in [(0, &source), (1, &translation)] {
        for name in values {
            let group = groups.entry(name.to_lowercase()).or_default();
            let counts = if side == 0 {
                &mut group.0
            } else {
                &mut group.1
            };
            *counts.entry(name.clone()).or_default() += 1;
        }
    }
    let (mut missing, mut added, mut changed) = (Vec::new(), Vec::new(), Vec::new());
    let first = |counts: &Counts| {
        let mut forms = counts.keys().cloned().collect::<Vec<_>>();
        forms.sort_by(|a, b| code_unit_compare(a, b));
        forms.into_iter().next().unwrap_or_default()
    };
    for (source, translation) in groups.values() {
        let source_count: usize = source.values().sum();
        let translation_count: usize = translation.values().sum();
        if source_count > translation_count {
            missing.push(first(source));
        }
        if translation_count > source_count {
            added.push(first(translation));
        }
        if source_count > 0 {
            for form in translation.keys() {
                if !source.contains_key(form) {
                    changed.push(value!({"source":first(source),"translation":form}));
                }
            }
        }
    }
    missing.sort_by(|a, b| code_unit_compare(a, b));
    added.sort_by(|a, b| code_unit_compare(a, b));
    changed.sort_by(|a, b| {
        code_unit_compare(
            a["source"].as_str().unwrap_or(""),
            b["source"].as_str().unwrap_or(""),
        )
        .then_with(|| {
            code_unit_compare(
                a["translation"].as_str().unwrap_or(""),
                b["translation"].as_str().unwrap_or(""),
            )
        })
    });
    let unique = |mut values: Vec<String>| {
        values.sort_by(|a, b| code_unit_compare(a, b));
        values.dedup();
        values
    };
    Ok(
        value!({"sourceTags":unique(source),"translationTags":unique(translation),"missing":missing,"added":added,"changed":changed}),
    )
}
pub fn without_optional_tags(text: &str, arguments: &[Value]) -> Result<String> {
    let bytes = text.as_bytes();
    let mut output = String::new();
    let mut offset = 0;
    let mut at = 0;
    while let Some(next) = text[at..].find('<') {
        let start = at + next;
        at = start + 1;
        if !bytes.get(at).copied().is_some_and(first_name) {
            continue;
        }
        let mut end = at + 1;
        while bytes.get(end).copied().is_some_and(word) {
            end += 1;
        }
        if bytes.get(end..end + 2) != Some(b">{") {
            continue;
        }
        let begin = end + 1;
        let content = begin + 1;
        let Some(stop) = bytes[content..]
            .iter()
            .position(|byte| matches!(*byte, b'{' | b'}' | b'<' | b'>' | b'|'))
            .map(|offset| content + offset)
        else {
            continue;
        };
        if stop == content || bytes.get(stop..stop + 4) != Some(b"}</>") {
            continue;
        }
        at = stop + 4;
        if !arguments
            .iter()
            .any(|value| value.as_str() == Some(&text[content..stop]))
        {
            continue;
        }
        output.push_str(&text[offset..start]);
        output.push_str(&text[begin..=stop]);
        offset = at;
    }
    output.push_str(&text[offset..]);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scanner_edges_preserve_escaping_nesting_braces_and_utf16() -> Result<()> {
        assert_eq!(
            tag_names("`<b a='{}'>x</><broken<Inner>y</><unclosed")?,
            ["b", "Inner"]
        );
        assert_eq!(visible_length("`<b a='{}'>x</> {outer{inner}}")?, 10);
        assert_eq!(visible_length("a|plural(one=\"x)\\\"y\",other=z)b")?, 2);
        assert_eq!(visible_words("a<b/>b</>c")?, 3);
        assert_eq!(
            without_optional_tags("<b>{Name}</><b>{Other}</>", &[value!("Name")])?,
            "{Name}<b>{Other}</>"
        );
        assert_eq!(
            rich_balance("<A><B></></></A> <{C}> <b a='{x}'>")?,
            json!({"opening":4,"closing":2,"xmlClosings":["A"]})
        );
        let text =
            crate::wtf8::Wtf8Buf::from_utf16(&[0xd800, 0x61, 0xdc00, 0xd83d, 0xde00]).into_view();
        assert_eq!(utf16_length(&text), 5);
        assert_eq!(points(&text).count(), 4);
        assert_eq!(visible_length(&text)?, 4);
        assert_eq!(
            line_breaks(
                "a\r\nb\rc\nd\r\n"
                    .replace("\\r", "\r")
                    .replace("\\n", "\n")
                    .as_str()
            ),
            4
        );
        assert_eq!(
            rich_text_counts("<unclosed<BR>\r\n</>"),
            json!({"opening":1,"closing":1})
        );
        Ok(())
    }
    #[test]
    fn visible_measures_and_line_breaks_keep_existing_tests() -> Result<()> {
        assert_eq!(
            visible_length("<b>Hi</> {Name}|plural(one=x,other=y)  there")?,
            8
        );
        assert_eq!(visible_length("  a\u{a0} \tb \n")?, 3);
        assert_eq!(visible_length("\u{20000}x")?, 3);
        assert_eq!(visible_words("<b>one</><b>two</>")?, 2);
        assert_eq!(
            interior_line_breaks("\r\n<PlayerName>{ParentLabel}</>，为什么？"),
            0
        );
        assert_eq!(interior_line_breaks("Tu madre.\r\n"), 0);
        assert_eq!(interior_line_breaks("Torn Pages\r\nA scrap\nof paper"), 2);
        Ok(())
    }
    #[test]
    fn rich_text_and_whitespace_keep_existing_tests() -> Result<()> {
        assert_eq!(
            rich_balance("<invalid requirement type>")?,
            json!({"opening":0,"closing":0,"xmlClosings":[]})
        );
        assert_eq!(
            rich_balance("GetWorld()->GetGameInstance()->GetSubsystem<UC_InputSubsystem>()")?["opening"],
            0
        );
        assert_eq!(
            rich_balance("<{playerColor}>{playerName}</>")?["opening"],
            1
        );
        assert_eq!(
            rich_text_counts("<broken<Tag>Text</>"),
            json!({"opening":1,"closing":1})
        );
        assert_eq!(rich_text_counts("<BR>"), json!({"opening":1,"closing":0}));
        assert!(!rich_valid("<Em>Hello</>", "<Em>Hallo"));
        assert!(rich_valid("<Em>Hello", "<Different>Hallo"));
        assert!(rich_valid("Hello", "</><Em>Hallo"));
        assert_eq!(
            unreal_whitespace(" \tText\r\n\n"),
            json!({"leading":" \t","trailing":"\r\n\n","lineBreaks":2})
        );
        assert!(unsafe_whitespace("Text\u{1c}"));
        for text in ["\r\nText\n", "Text\u{a0}", "Text\u{2007}", "Text\u{202f}"] {
            assert!(!unsafe_whitespace(text));
        }
        Ok(())
    }
}
