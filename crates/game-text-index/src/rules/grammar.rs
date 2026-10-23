//! Unreal's format compiler, inverse argument edit, and compile rich-text validator.
use super::regex::{units, view};
use super::value::{Value, value};
use crate::join_policy::js_space;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Argument {
    pub name: String,
    pub start: i64,
    pub end: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Form {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Modifier {
    pub name: String,
    pub argument: Option<String>,
    pub forms: Vec<Form>,
    pub start: usize,
    pub end: usize,
    pub depth: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Issue {
    pub code: String,
    pub modifier: Option<String>,
    pub argument: Option<String>,
    pub forms: Vec<String>,
    pub position: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pattern {
    pub compiled: Option<bool>,
    pub arguments: Vec<Argument>,
    pub modifiers: Vec<Modifier>,
    pub issues: Vec<Issue>,
}

fn issue(
    code: &str,
    name: Option<&str>,
    argument: Option<&str>,
    forms: Vec<String>,
    position: usize,
) -> Issue {
    Issue {
        code: code.into(),
        modifier: name.map(str::to_owned),
        argument: argument.map(str::to_owned),
        forms,
        position,
    }
}
fn space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js_space)
}
fn skip_space(text: &[u16], index: &mut usize) {
    while text.get(*index).is_some_and(|unit| space(*unit)) {
        *index += 1;
    }
}
fn digit(unit: u16) -> Option<u32> {
    char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(16))
}

fn quoted(text: &[u16], start: usize) -> Option<(String, usize)> {
    let mut value = Vec::new();
    let mut index = start + 1;
    while let Some(unit) = text.get(index).copied() {
        if unit == 34 {
            return Some((view(&value), index + 1));
        }
        if matches!(unit, 10 | 13) {
            return None;
        }
        if unit != 92 {
            value.push(unit);
            index += 1;
            continue;
        }
        index += 1;
        let escape = *text.get(index)?;
        match escape {
            110 => value.push(10),
            114 => value.push(13),
            116 => value.push(9),
            120 | 117 | 85 => {
                let maximum = match escape {
                    117 => 4,
                    85 => 8,
                    _ => text.len(),
                };
                let mut end = index + 1;
                let mut code = 0u64;
                while end - index - 1 < maximum
                    && let Some(next) = text.get(end).and_then(|unit| digit(*unit))
                {
                    code = code.saturating_mul(16).saturating_add(u64::from(next));
                    end += 1;
                }
                if end == index + 1 {
                    value.extend_from_slice(&[92, escape]);
                } else {
                    if escape == 85 && code <= 0x10ffff {
                        if let Some(c) = char::from_u32(code as u32) {
                            value.extend_from_slice(c.encode_utf16(&mut [0; 2]));
                        } else {
                            value.push(code as u16);
                        }
                    } else {
                        value.push(code as u16);
                    }
                    index = end - 1;
                }
            }
            _ => {
                let mut end = index;
                let mut code = 0u16;
                while end - index < 3 && text.get(end).is_some_and(|unit| (48..=55).contains(unit))
                {
                    code = code * 8 + text[end] - 48;
                    end += 1;
                }
                if end > index {
                    value.push(code);
                    index = end - 1;
                } else {
                    if ![92, 34, 39].contains(&escape) {
                        value.push(92);
                    }
                    value.push(escape);
                }
            }
        }
        index += 1;
    }
    None
}

fn modifier_end(text: &[u16], start: usize) -> Option<usize> {
    let mut in_quote = false;
    let mut slashes = 0;
    for (index, unit) in text.iter().copied().enumerate().skip(start) {
        if unit == 41 && !in_quote {
            return Some(index);
        }
        if unit == 34 && (!in_quote || slashes % 2 == 0) {
            in_quote = !in_quote;
        }
        slashes = if unit == 92 { slashes + 1 } else { 0 };
    }
    None
}

fn modifier_forms(text: &[u16], keyed: bool) -> Option<Vec<Form>> {
    let mut forms: Vec<Form> = Vec::new();
    let mut index = 0;
    skip_space(text, &mut index);
    while index < text.len() {
        let mut name = forms.len().to_string();
        if keyed {
            let start = index;
            // Plural category names are letters/numbers/underscore, just as Unreal's lexer reads them.
            while text.get(index).is_some_and(|unit| {
                *unit == 95 || char::from_u32(u32::from(*unit)).is_some_and(char::is_alphanumeric)
            }) {
                index += 1;
            }
            if start == index {
                return None;
            }
            name = view(&text[start..index]);
            skip_space(text, &mut index);
            if text.get(index) != Some(&61) {
                return None;
            }
            index += 1;
            skip_space(text, &mut index);
        }
        let (value, end) = if text.get(index) == Some(&34) {
            quoted(text, index)?
        } else {
            let end = (index..text.len())
                .find(|i| text[*i] == 44)
                .unwrap_or(text.len());
            (view(&text[index..end]), end)
        };
        if value.is_empty() {
            return None;
        }
        index = end;
        skip_space(text, &mut index);
        if index < text.len() {
            if text[index] != 44 {
                return None;
            }
            index += 1;
        }
        if let Some(previous) = forms.iter().position(|form| form.name == name) {
            forms.remove(previous);
        }
        forms.push(Form { name, value });
        skip_space(text, &mut index);
    }
    Some(forms)
}

pub fn plural_forms(culture: &str, ordinal: bool) -> Option<Vec<String>> {
    let language = culture
        .split(['_', '-'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    let cardinal = super::plural_tables::CARDINAL
        .iter()
        .find(|(_, languages)| languages.split(' ').any(|item| item == language))?;
    let forms = if ordinal {
        super::plural_tables::ORDINAL
            .iter()
            .find(|(_, languages)| languages.split(' ').any(|item| item == language))
            .map_or(&["other"][..], |(forms, _)| *forms)
    } else {
        cardinal.0
    };
    Some(forms.iter().map(|form| (*form).to_owned()).collect())
}

pub fn format_pattern(text: &str, culture: &str) -> Pattern {
    validate_pattern(parse_pattern(text), culture)
}
pub(super) fn parse_pattern(text: &str) -> Pattern {
    if text.len() <= 1_000_000
        && !text
            .bytes()
            .any(|byte| matches!(byte, b'{' | b'}' | b'`' | b'|'))
    {
        return Pattern {
            compiled: Some(true),
            arguments: Vec::new(),
            modifiers: Vec::new(),
            issues: Vec::new(),
        };
    }
    parse(text, 0)
}
pub(super) fn validate_pattern(mut pattern: Pattern, culture: &str) -> Pattern {
    let mut issues = Vec::new();
    for item in pattern.issues {
        if item.code != "__culture" {
            issues.push(item);
            continue;
        }
        let name = item.modifier.as_deref().unwrap_or("");
        if let Some(required) = plural_forms(culture, name == "ordinal") {
            if required.len() == 1 {
                issues.push(issue(
                    "redundant_modifier",
                    Some(name),
                    item.argument.as_deref(),
                    Vec::new(),
                    item.position,
                ));
            }
            let missing = required
                .iter()
                .filter(|form| !item.forms.contains(form))
                .cloned()
                .collect::<Vec<_>>();
            let unused = item
                .forms
                .iter()
                .filter(|form| {
                    ["zero", "one", "two", "few", "many", "other"].contains(&form.as_str())
                        && !required.contains(form)
                })
                .cloned()
                .collect::<Vec<_>>();
            if !missing.is_empty() {
                issues.push(issue(
                    "missing_form",
                    Some(name),
                    item.argument.as_deref(),
                    missing,
                    item.position,
                ));
            }
            if required.len() > 1 && !unused.is_empty() {
                issues.push(issue(
                    "unused_form",
                    Some(name),
                    item.argument.as_deref(),
                    unused,
                    item.position,
                ));
            }
        } else {
            issues.push(issue(
                "unsupported_culture",
                Some(name),
                item.argument.as_deref(),
                Vec::new(),
                item.position,
            ));
        }
    }
    pattern.issues = issues;
    pattern
}
fn parse(text: &str, depth: usize) -> Pattern {
    let text = units(text);
    let mut result = Pattern {
        compiled: Some(true),
        arguments: Vec::new(),
        modifiers: Vec::new(),
        issues: Vec::new(),
    };
    if depth > 16 || text.len() > 1_000_000 {
        result.compiled = None;
        result
            .issues
            .push(issue("syntax_limit", None, None, Vec::new(), 0));
        return result;
    }
    let mut previous: Option<String> = None;
    let mut failed = false;
    let mut index = 0;
    while index < text.len() {
        if text[index] == 96
            && text
                .get(index + 1)
                .is_some_and(|unit| [96, 123, 125, 124].contains(unit))
        {
            index += 2;
            previous = None;
            continue;
        }
        if text[index] == 123
            && let Some(end) = (index + 1..text.len()).find(|i| text[*i] == 125)
            && end > index + 1
        {
            let name = view(&text[index + 1..end]);
            previous = Some(name.clone());
            result.arguments.push(Argument {
                name,
                start: index as i64,
                end: end as i64 + 1,
            });
            index = end + 1;
            continue;
        }
        let prefix = ["plural", "ordinal", "gender", "hpp"]
            .into_iter()
            .find(|name| {
                text[index] == 124
                    && text[index + 1..]
                        .iter()
                        .copied()
                        .take(name.len() + 1)
                        .eq(name.bytes().map(u16::from).chain([40]))
            });
        if let Some(name) = prefix {
            let start = index + name.len() + 2;
            let end = modifier_end(&text, start);
            let forms = end.and_then(|end| {
                modifier_forms(&text[start..end], name == "plural" || name == "ordinal")
            });
            if let (Some(end), Some(forms)) = (end, forms) {
                let arity = matches!(name, "plural" | "ordinal")
                    || if name == "gender" {
                        forms.len() == 2 || forms.len() == 3
                    } else {
                        forms.len() == 2
                    };
                if arity {
                    let children = if name == "hpp" {
                        Vec::new()
                    } else {
                        forms
                            .iter()
                            .map(|form| parse(&form.value, depth + 1))
                            .collect::<Vec<_>>()
                    };
                    let required = if name == "gender" {
                        &children[..2]
                    } else {
                        &children[..]
                    };
                    if !required.iter().any(|child| child.compiled == Some(false)) {
                        result.modifiers.push(Modifier {
                            name: name.into(),
                            argument: previous.clone(),
                            forms: forms.clone(),
                            start: index,
                            end: end + 1,
                            depth,
                        });
                        if previous.is_none() {
                            failed = true;
                            result.issues.push(issue(
                                "unexpected_modifier",
                                Some(name),
                                None,
                                Vec::new(),
                                index,
                            ));
                        }
                        for (child_index, child) in children.into_iter().enumerate() {
                            if matches!(name, "plural" | "ordinal")
                                && !["zero", "one", "two", "few", "many", "other"]
                                    .contains(&forms[child_index].name.as_str())
                            {
                                continue;
                            }
                            result
                                .arguments
                                .extend(child.arguments.into_iter().map(|argument| Argument {
                                    start: -1,
                                    end: -1,
                                    ..argument
                                }));
                            result.modifiers.extend(child.modifiers);
                            result.issues.extend(child.issues);
                        }
                        if matches!(name, "plural" | "ordinal") {
                            result.issues.push(issue(
                                "__culture",
                                Some(name),
                                previous.as_deref(),
                                forms.iter().map(|form| form.name.clone()).collect(),
                                index,
                            ));
                        }
                        index = end + 1;
                        previous = None;
                        continue;
                    }
                }
            }
            result.issues.push(issue(
                "malformed_modifier",
                Some(name),
                previous.as_deref(),
                Vec::new(),
                index,
            ));
        }
        previous = None;
        index += 1;
        while index < text.len() && ![123, 96].contains(&text[index]) {
            index += 1;
        }
    }
    result.compiled = if failed {
        Some(false)
    } else if result
        .issues
        .iter()
        .any(|issue| issue.code == "syntax_limit")
    {
        None
    } else {
        Some(true)
    };
    if failed {
        result.arguments.clear();
    }
    result
}

pub fn rename_argument(text: &str, from: &str, to: &str, culture: &str) -> Option<String> {
    let parsed = format_pattern(text, culture);
    if parsed.compiled != Some(true) {
        return None;
    }
    let mut replacements = parsed
        .arguments
        .iter()
        .filter(|argument| argument.name == from && argument.start >= 0)
        .map(|argument| {
            (
                argument.start as usize,
                argument.end as usize,
                format!("{{{to}}}"),
            )
        })
        .collect::<Vec<_>>();
    for modifier in parsed
        .modifiers
        .iter()
        .filter(|modifier| modifier.depth == 0 && modifier.name != "hpp")
    {
        let forms = modifier
            .forms
            .iter()
            .map(|form| rename_argument(&form.value, from, to, culture))
            .collect::<Option<Vec<_>>>()?;
        if forms
            .iter()
            .zip(&modifier.forms)
            .all(|(renamed, form)| *renamed == form.value)
        {
            continue;
        }
        let values = forms
            .iter()
            .zip(&modifier.forms)
            .map(|(renamed, form)| {
                let quoted = crate::wtf8::Wtf8Buf::from_view(renamed).json_string();
                Some(if matches!(modifier.name.as_str(), "plural" | "ordinal") {
                    format!("{}={quoted}", form.name)
                } else {
                    quoted
                })
            })
            .collect::<Option<Vec<_>>>()?;
        replacements.push((
            modifier.start,
            modifier.end,
            format!("|{}({})", modifier.name, values.join(",")),
        ));
    }
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    let mut result = units(text);
    for (start, end, replacement) in replacements {
        result.splice(start..end, units(&replacement));
    }
    Some(view(&result))
}

pub fn rich_text_counts(text: &str) -> Value {
    let (mut opening, mut closing) = (0, 0);
    let mut start = None;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'<' {
            start = Some(index);
        } else if byte == b'>'
            && let Some(begin) = start
        {
            let body = &text[begin + 1..index];
            if body == "/" {
                closing += 1;
            } else if !body.ends_with('/') && body != "br" {
                opening += 1;
            }
            start = None;
        }
    }
    value!({"opening":opening,"closing":closing})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn names(text: &str) -> Vec<String> {
        let mut names = format_pattern(text, "en")
            .arguments
            .into_iter()
            .map(|arg| arg.name)
            .collect::<Vec<_>>();
        names.sort_by(|a, b| super::super::text::code_unit_compare(a, b));
        names.dedup();
        names
    }
    #[test]
    fn format_grammar_ports_existing_lexing_and_nested_forms() {
        assert_eq!(
            names("`{literal`} {Name} {name} {0} {a b} ``{Again} `{ignored} {"),
            ["0", "Again", "Name", "a b", "name"]
        );
        assert_eq!(names("{} `x{Kept} {a{b}"), ["Kept", "a{b"]);
        assert!(
            format_pattern("{N}`|plural(one=x,other=y)", "en")
                .modifiers
                .is_empty()
        );
        assert_eq!(
            plural_forms("fr-FR", false),
            Some(vec!["one".into(), "other".into()])
        );
        assert_eq!(
            plural_forms("ru", false),
            Some(vec![
                "few".into(),
                "many".into(),
                "one".into(),
                "other".into()
            ])
        );
        assert_eq!(
            plural_forms("ar", false),
            Some(vec![
                "few".into(),
                "many".into(),
                "one".into(),
                "other".into(),
                "two".into(),
                "zero".into()
            ])
        );
        assert_eq!(plural_forms("ja", true), Some(vec!["other".into()]));
        assert!(names("{A}|gender(He,She)|gender(He,She)").is_empty());
        assert_eq!(names("{N}|plural(one=x,other=y,studio={Ignored})"), ["N"]);
        assert_eq!(
            names(r#"{Count}|plural(one="{Owner}, \"quoted\"",other="{Owner} and {Other}")"#),
            ["Count", "Other", "Owner"]
        );
        let pattern = format_pattern(
            "{N}|plural(one=\"{G}|gender(He,She)\",other=\"{Owner} has \\x32 items\")",
            "en",
        );
        assert_eq!(
            pattern
                .modifiers
                .iter()
                .map(|modifier| modifier.name.as_str())
                .collect::<Vec<_>>(),
            ["plural", "gender"]
        );
        assert_eq!(pattern.modifiers[0].forms[1].value, "{Owner} has 2 items");
        assert!(pattern.issues.is_empty());
        assert_eq!(
            format_pattern("{G}|gender(He,She,\"|gender(He,She)\")", "en").compiled,
            Some(true)
        );
        assert_eq!(
            format_pattern(r#"{N}|plural(one="\q",other="\x")"#, "en").modifiers[0]
                .forms
                .iter()
                .map(|form| form.value.as_str())
                .collect::<Vec<_>>(),
            ["\\q", "\\x"]
        );
    }
    #[test]
    fn format_grammar_ports_existing_diagnostics_and_limits() {
        for (text, code) in [
            ("{N}|plural(one=x)", "missing_form"),
            ("{N}|plural(one=x,few=f,other=y)", "unused_form"),
            ("|plural(one=x,other=y)", "unexpected_modifier"),
        ] {
            assert!(
                format_pattern(text, "en")
                    .issues
                    .iter()
                    .any(|issue| issue.code == code)
            );
        }
        assert!(
            format_pattern("{N}|ordinal(other=x)", "de")
                .issues
                .iter()
                .any(|issue| issue.code == "redundant_modifier")
        );
        for text in [
            "{N}|plural(one=x,other=)",
            "{N}|gender(He)",
            "{N}|hpp(one)",
            "{N}|plural(one=x",
        ] {
            assert!(
                format_pattern(text, "en")
                    .issues
                    .iter()
                    .any(|issue| issue.code == "malformed_modifier")
            );
        }
        for text in [
            "{G}|gender(He,She)",
            "{G}|gender(He,She,They)",
            "{Name}|hpp(은,는)",
            "{N}|plural(one=a,one=b,other=c)",
        ] {
            assert!(format_pattern(text, "en").issues.is_empty());
        }
        assert_eq!(
            format_pattern("{N}|plural(one=a,one=b,other=c)", "en").modifiers[0].forms[0].value,
            "b"
        );
        assert!(
            format_pattern("{N}|plural(one=x,other=y)", "private-culture")
                .issues
                .iter()
                .any(|issue| issue.code == "unsupported_culture")
        );
        assert_eq!(
            format_pattern(&"x".repeat(1_000_001), "en").issues[0].code,
            "syntax_limit"
        );
        assert!(
            format_pattern("{N}|studio(value={Other})", "en")
                .modifiers
                .is_empty()
        );
        assert_eq!(names("{N}|studio(value={Other})"), ["N", "Other"]);
        assert!(
            format_pattern("text|plural(one=x,other=y)", "en")
                .issues
                .is_empty()
        );
        assert!(
            format_pattern("{N} |plural(one=x,other=y)", "en")
                .modifiers
                .is_empty()
        );
    }
}
