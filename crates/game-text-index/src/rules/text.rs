use super::grammar::rich_text_counts;
use super::regex::{JsRegex, units, view};
use crate::join_policy::{js_space, trim};
use crate::{Error, ErrorCode, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const TAG: &str = r#"<([A-Za-z_][\w.-]*)(?:\s+[\w.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*/?>"#;
const MODIFIER: &str = r#"\|(?:plural|ordinal|gender|hpp)\((?:"(?:[^"\\]|\\.)*"|[^()"])*\)"#;

pub fn code_unit_compare(a: &str, b: &str) -> std::cmp::Ordering {
    units(a).cmp(&units(b))
}
pub fn code_points(text: &str) -> Vec<u32> {
    std::char::decode_utf16(units(text))
        .map(|point| match point {
            Ok(c) => u32::from(c),
            Err(c) => u32::from(c.unpaired_surrogate()),
        })
        .collect()
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
            Value::String(name) if name == "jsSpace" => Self::JsSpace,
            Value::String(name) if name == "textCharWhitespace" => Self::TextSpace,
            Value::String(name) if name == "wide" => Self::Wide,
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

pub fn replace_ranges(text: &str, matches: &[Value], replacement: &str) -> Result<String> {
    let source = units(text);
    let mut output = Vec::new();
    let mut offset = 0;
    let replacement = units(replacement);
    for found in matches {
        let start = found["start"].as_u64().ok_or("Invalid match start.")? as usize;
        let end = found["end"].as_u64().ok_or("Invalid match end.")? as usize;
        if start < offset || end > source.len() {
            return Err("Invalid match range.".into());
        }
        output.extend_from_slice(&source[offset..start]);
        output.extend_from_slice(&replacement);
        offset = end;
    }
    output.extend_from_slice(&source[offset..]);
    Ok(view(&output))
}
fn replace(text: &str, pattern: &str, replacement: &str) -> Result<String> {
    replace_ranges(
        text,
        &JsRegex::new(pattern, true)?.matches(text, None)?,
        replacement,
    )
}

pub fn visible_length(text: &str) -> Result<usize> {
    let visible = replace(
        &replace(&replace(&replace(text, TAG, "")?, "</>", "")?, MODIFIER, "")?,
        r"\{[^{}]*\}",
        "",
    )?;
    let mut length = 0;
    let mut pending = false;
    for point in code_points(&visible) {
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
    let visible = replace(&replace(text, TAG, " ")?, "</>", " ")?;
    Ok(visible
        .split(js_space)
        .filter(|part| !part.is_empty())
        .count())
}
pub fn line_breaks(text: &str) -> usize {
    let text = units(text);
    let mut count = 0;
    let mut index = 0;
    while index < text.len() {
        if text[index] == 10 {
            count += 1;
        } else if text[index] == 13 {
            count += 1;
            if text.get(index + 1) == Some(&10) {
                index += 1;
            }
        }
        index += 1;
    }
    count
}
pub fn interior_line_breaks(text: &str) -> usize {
    line_breaks(trim(text))
}
pub fn unreal_whitespace(text: &str) -> Value {
    json!({"leading":text.chars().take_while(|c| text_space(*c)).collect::<String>(),"trailing":text.chars().rev().take_while(|c| text_space(*c)).collect::<String>().chars().rev().collect::<String>(),"lineBreaks":line_breaks(text)})
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
    for unit in units(text) {
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
    json!({"opening":opening,"closing":closing})
}

fn tag_names(text: &str) -> Result<Vec<String>> {
    Ok(JsRegex::new(TAG, true)?
        .matches(text, None)?
        .into_iter()
        .filter_map(|found| {
            found["match"].as_str().map(|matched| {
                matched[1..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || ['_', '.', '-'].contains(c))
                    .collect()
            })
        })
        .collect())
}
pub fn rich_valid(source: &str, translation: &str) -> bool {
    let actual = rich_text_counts(translation);
    let expected = rich_text_counts(source);
    actual["opening"] == actual["closing"] || actual == expected
}
pub fn rich_balance(text: &str) -> Result<Value> {
    let mut opening = 0;
    let cpp_scope = regex::Regex::new(r"[A-Za-z0-9_]::[A-Za-z0-9_]")?.is_match(text);
    for found in JsRegex::new(TAG, true)?.matches(text, None)? {
        let matched = found["match"].as_str().ok_or("Missing tag.")?;
        let tag = matched[1..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || ['_', '.', '-'].contains(c))
            .collect::<String>();
        let source = units(text);
        let start = found["start"].as_u64().ok_or("Missing tag start.")? as usize;
        let end = found["end"].as_u64().ok_or("Missing tag end.")? as usize;
        let identifier = start > 0
            && char::from_u32(u32::from(source[start - 1]))
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        let code = identifier
            && (source.get(end) == Some(&40)
                || source.get(end..end + 2) == Some(&[58, 58])
                || text.contains("->")
                || cpp_scope);
        if !matched.ends_with("/>") && tag.to_lowercase() != "br" && !code {
            opening += 1;
        }
    }
    opening += JsRegex::new(r"<\{[^{}<>]+\}>", true)?
        .matches(text, None)?
        .len();
    let closing = JsRegex::new("</>", true)?.matches(text, None)?.len();
    let xml_closings = JsRegex::new(r"</[A-Za-z_][\w.-]*\s*>", true)?
        .matches(text, None)?
        .into_iter()
        .map(|found| {
            found["match"].as_str().unwrap_or("")[2..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || ['_', '.', '-'].contains(c))
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    Ok(json!({"opening":opening,"closing":closing,"xmlClosings":xml_closings}))
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
                    changed.push(json!({"source":first(source),"translation":form}));
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
        json!({"sourceTags":unique(source),"translationTags":unique(translation),"missing":missing,"added":added,"changed":changed}),
    )
}
pub fn without_optional_tags(text: &str, arguments: &[Value]) -> Result<String> {
    let source = units(text);
    let mut output = Vec::new();
    let mut offset = 0;
    for found in JsRegex::new(r"<[A-Za-z_][\w.-]*>\{([^{}<>|]+)\}</>", true)?.matches(text, None)? {
        let matched = found["match"].as_str().ok_or("Missing optional wrapper.")?;
        let begin = matched.find("{").ok_or("Missing optional argument.")?;
        let end = matched.rfind("}").ok_or("Missing optional argument end.")?;
        let argument = &matched[begin + 1..end];
        if !arguments
            .iter()
            .any(|value| value.as_str() == Some(argument))
        {
            continue;
        }
        let start = found["start"].as_u64().ok_or("Missing wrapper start.")? as usize;
        output.extend_from_slice(&source[offset..start]);
        output.extend_from_slice(&units(&matched[begin..=end]));
        offset = found["end"].as_u64().ok_or("Missing wrapper end.")? as usize;
    }
    output.extend_from_slice(&source[offset..]);
    Ok(view(&output))
}

#[cfg(test)]
mod tests {
    use super::*;
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
