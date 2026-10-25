//! Pure Game Text policy, mirrored from localization.ts, text-origin.ts and review-file.ts.
//! Kept separate from column mechanics so differential tests can exercise policy independently.
use crate::Result;
use regex::{Regex, RegexBuilder};
use serde_json::Value;

pub(crate) const ABSENT: u32 = u32::MAX;
pub(crate) fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
pub(crate) fn words(text: &str) -> u32 {
    text.split(js_space).filter(|s| !s.is_empty()).count() as u32
}
pub(crate) fn characters(text: &str) -> u32 {
    if !text
        .chars()
        .any(|c| ('\u{f0000}'..='\u{f0800}').contains(&c))
    {
        return text.encode_utf16().count() as u32;
    }
    crate::wtf8::Wtf8Buf::from_view(text).to_utf16().len() as u32
}
pub(crate) fn normalized(path: &str) -> String {
    let path = path.replace('\\', "/");
    path.strip_prefix("./").unwrap_or(&path).into()
}
pub(crate) fn strip_namespace(value: &str) -> &str {
    if value.ends_with(']')
        && let Some(start) = value.rfind('[')
    {
        return value[..start].trim_end_matches(js_space);
    }
    value
}
#[expect(
    clippy::expect_used,
    reason = "fmt::Write on an owned String cannot return an error"
)]
pub(crate) fn uri_component(value: &str) -> String {
    let mut result = String::new();
    for byte in crate::wtf8::Wtf8Buf::from_view(value)
        .as_bytes()
        .iter()
        .copied()
    {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut result, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    result
}
pub(crate) fn file_label(value: &str) -> String {
    let value = trim(value)
        .trim_start_matches(['\'', '"'])
        .trim_end_matches(['\'', '"']);
    let mut value = normalized(value);
    if value
        .get(..6)
        .is_some_and(|v| v.eq_ignore_ascii_case("/Game/"))
    {
        let rest = &value[6..];
        let end = rest.find(['.', ':']).unwrap_or(rest.len());
        return format!("Content/{}", &rest[..end]);
    }
    if value.ends_with(')')
        && let Some(start) = value.rfind('(')
        && value[start + 1..value.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_digit())
        && value.len() > start + 2
    {
        value.truncate(start);
    } else if let Some(start) = value.rfind(':')
        && !value[start + 1..].is_empty()
        && value[start + 1..].bytes().all(|b| b.is_ascii_digit())
    {
        value.truncate(start);
    }
    let lower = value.to_lowercase();
    for extension in [".uasset", ".umap", ".uexp", ".ubulk", ".uptnl"] {
        if lower.ends_with(extension) {
            value.truncate(value.len() - extension.len());
            break;
        }
    }
    value
}
pub(crate) fn folder(file: &str) -> &str {
    file.rsplit_once('/').map_or("", |(folder, _)| folder)
}
pub(crate) fn file_key(value: &str) -> String {
    file_label(value).to_lowercase()
}
pub(crate) fn manifest_package(value: &str) -> Option<String> {
    let value = normalized(value);
    if value.to_lowercase().starts_with("content/") {
        let lower = value.to_lowercase();
        for extension in [".uasset", ".umap"] {
            if let Some(index) = lower.find(extension) {
                let end = index + extension.len();
                if end == value.len()
                    || value
                        .as_bytes()
                        .get(end)
                        .is_some_and(|b| matches!(b, b'.' | b':'))
                {
                    return Some(value[..end].into());
                }
            }
        }
    }
    if let Some(rest) = value.strip_prefix("/Game/") {
        let end = rest.find(['.', ':']).unwrap_or(rest.len());
        if end > 0 {
            return Some(format!("Content/{}.uasset", &rest[..end]));
        }
    }
    None
}
pub(crate) fn origin(value: &str) -> u32 {
    let path = normalized(trim(value)).to_lowercase();
    // `\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl)(?:[:(]|$)` anywhere in the path, as hosts test it.
    if path.match_indices('.').any(|(start, _)| {
        let rest = &path.as_bytes()[start + 1..];
        ["c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "inl"]
            .iter()
            .any(|extension| {
                rest.starts_with(extension.as_bytes())
                    && matches!(rest.get(extension.len()), None | Some(b':' | b'('))
            })
    }) {
        3
    } else if path.starts_with('/') {
        2
    } else {
        4
    }
}
pub(crate) fn relative_package(project: &str, package: &str) -> String {
    fn parts(path: &str) -> Vec<String> {
        let mut result = Vec::new();
        for part in normalized(path).split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    result.pop();
                }
                _ => result.push(part.into()),
            }
        }
        result
    }
    let project_parts = parts(project);
    let absolute = package.starts_with(['/', '\\']) || package.as_bytes().get(1) == Some(&b':');
    let package_parts = parts(&if absolute {
        package.to_owned()
    } else {
        format!("{project}/{package}")
    });
    let mut same = 0;
    while same < project_parts.len()
        && same < package_parts.len()
        && if cfg!(windows) {
            project_parts[same].eq_ignore_ascii_case(&package_parts[same])
        } else {
            project_parts[same] == package_parts[same]
        }
    {
        same += 1;
    }
    let mut result = vec!["..".to_owned(); project_parts.len() - same];
    result.extend_from_slice(&package_parts[same..]);
    result.join(if cfg!(windows) { "\\" } else { "/" })
}
struct Pattern {
    expression: Regex,
    prefix: Option<String>,
    rating: i32,
}
impl Pattern {
    fn new(pattern: &str) -> Result<Self> {
        let pattern = normalized(pattern);
        let prefix = if pattern.is_empty() || pattern.find('*') == pattern.len().checked_sub(1) {
            Some(pattern[..pattern.len().saturating_sub(1)].to_lowercase())
        } else {
            None
        };
        let mut expression = String::from("^");
        for c in pattern.chars() {
            match c {
                '*' => expression.push_str(".*"),
                '?' => expression.push_str(".?"),
                _ => expression.push_str(&regex::escape(&c.to_string())),
            }
        }
        expression.push('$');
        Ok(Self {
            expression: RegexBuilder::new(&expression)
                .case_insensitive(true)
                .dot_matches_new_line(true)
                .build()?,
            prefix,
            rating: 100 - pattern.matches('/').count() as i32
                + pattern.matches(['?', '*']).count() as i32 * 1000,
        })
    }
}
struct Rule {
    filters: Vec<(Pattern, bool)>,
    filenames: Vec<Pattern>,
    classes: Vec<String>,
    derived: bool,
    uncertain: bool,
}
pub(crate) struct GatherPolicy {
    rules: Option<Vec<Rule>>,
}
fn strings(object: &Value, field: &str) -> Result<Vec<String>> {
    let Some(value) = object.get(field) else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or("invalid gather array")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "invalid gather string".into())
        })
        .collect()
}
impl GatherPolicy {
    pub(crate) fn from_target(target: &Value) -> Result<Self> {
        let configs = target["configs"]
            .as_array()
            .ok_or("target configs absent")?;
        let mut values = Vec::<(Vec<String>, Vec<String>, Vec<String>, Vec<String>, bool)>::new();
        for config in configs {
            let common = &config["common"];
            for step in config["steps"].as_array().ok_or("recipe steps absent")? {
                if step["commandletClass"] != "GatherTextFromAssets" {
                    continue;
                }
                let fields = &step["fields"];
                let select = |name: &str| -> Result<Vec<String>> {
                    let values = strings(fields, name)?;
                    if values.is_empty() {
                        strings(common, name)
                    } else {
                        Ok(values)
                    }
                };
                values.push((
                    select("IncludePathFilters")?,
                    select("ExcludePathFilters")?,
                    select("PackageFileNameFilters")?,
                    select("ExcludeClasses")?,
                    fields["ShouldExcludeDerivedClasses"]
                        .as_bool()
                        .or_else(|| common["ShouldExcludeDerivedClasses"].as_bool())
                        .unwrap_or(false),
                ));
            }
        }
        if values.is_empty() {
            let settings = &target["dashboard"]["settings"]["GatherFromPackages"];
            if settings.is_null() {
                return Ok(Self {
                    rules: if configs.is_empty() {
                        None
                    } else {
                        Some(Vec::new())
                    },
                });
            }
            if settings["IsEnabled"] == false {
                return Ok(Self {
                    rules: Some(Vec::new()),
                });
            }
            let paths = |field: &str| -> Result<Option<Vec<String>>> {
                let mut values = Vec::new();
                for path in settings[field].as_array().ok_or("dashboard paths absent")? {
                    if path["PathRoot"] == "Engine" {
                        return Ok(None);
                    }
                    values.push(
                        path["Pattern"]
                            .as_str()
                            .ok_or("dashboard pattern absent")?
                            .into(),
                    );
                }
                Ok(Some(values))
            };
            let (Some(includes), Some(excludes)) = (
                paths("IncludePathWildcards")?,
                paths("ExcludePathWildcards")?,
            ) else {
                return Ok(Self { rules: None });
            };
            let filenames = settings["FileExtensions"]
                .as_array()
                .ok_or("dashboard extensions absent")?
                .iter()
                .map(|extension| {
                    extension["Pattern"]
                        .as_str()
                        .map(|v| {
                            format!(
                                "*.{}",
                                v.strip_prefix("*.")
                                    .or_else(|| v.strip_prefix('.'))
                                    .unwrap_or(v)
                            )
                        })
                        .ok_or_else(|| "extension absent".into())
                })
                .collect::<Result<Vec<_>>>()?;
            values.push((
                includes,
                excludes,
                filenames,
                strings(settings, "ExcludeClasses")?,
                settings["ShouldExcludeDerivedClasses"]
                    .as_bool()
                    .unwrap_or(false),
            ));
        }
        let mut rules = Vec::new();
        for (includes, excludes, filenames, classes, derived) in values {
            let mut uncertain = false;
            let mut filters = Vec::new();
            for (patterns, included) in [(includes, true), (excludes, false)] {
                for pattern in patterns {
                    let upper = pattern.to_uppercase();
                    if upper.starts_with("%LOCENGINEROOT%") {
                        continue;
                    }
                    let pattern = if upper.starts_with("%LOCPROJECTROOT%") {
                        pattern[16..].trim_start_matches(['/', '\\']).to_owned()
                    } else {
                        pattern
                    };
                    let path = normalized(&pattern);
                    if path.contains('%')
                        || path.starts_with('/')
                        || path.as_bytes().get(1) == Some(&b':')
                        || path.split('/').any(|p| p == "..")
                    {
                        uncertain = true;
                        continue;
                    }
                    filters.push((Pattern::new(&path)?, included));
                }
            }
            filters.sort_by_key(|(p, included)| (p.rating, *included));
            rules.push(Rule {
                filters,
                filenames: filenames
                    .iter()
                    .map(|p| Pattern::new(p))
                    .collect::<Result<_>>()?,
                classes: classes.iter().map(|s| s.to_lowercase()).collect(),
                derived,
                uncertain,
            });
        }
        Ok(Self { rules: Some(rules) })
    }
    /// 0 outside, 1 inside, 2 settings unknown, 3 hierarchy unknown, 4 class unknown, 5 path unknown.
    pub(crate) fn coverage(&self, path: &str, class: &str, kind: u32) -> u32 {
        let path = normalized(path);
        if path.starts_with('/')
            || path.as_bytes().get(1) == Some(&b':')
            || path.split('/').any(|p| p == "..")
        {
            return 5;
        }
        let Some(rules) = &self.rules else {
            return 2;
        };
        let mut uncertain = 0;
        for rule in rules {
            if rule.uncertain {
                uncertain = 2;
                continue;
            }
            if !rule
                .filters
                .iter()
                .find(|(p, _)| {
                    p.prefix.as_ref().map_or_else(
                        || p.expression.is_match(&path),
                        |prefix| path.to_lowercase().starts_with(prefix),
                    )
                })
                .is_some_and(|(_, included)| *included)
            {
                continue;
            }
            if !rule
                .filenames
                .iter()
                .any(|p| p.expression.is_match(path.rsplit('/').next().unwrap_or("")))
            {
                continue;
            }
            if kind == 1 && !rule.classes.is_empty() {
                uncertain = 4;
                continue;
            }
            let class = match kind {
                1 => "/Script/Engine.DataTable",
                2 => "/Script/Engine.StringTable",
                _ => class,
            }
            .to_lowercase();
            if rule
                .classes
                .iter()
                .any(|v| v == &class || class.rsplit('.').next() == Some(v))
            {
                continue;
            }
            if rule.derived && !rule.classes.is_empty() {
                uncertain = 3;
                continue;
            }
            return 1;
        }
        uncertain
    }
}
