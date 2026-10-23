//! JavaScript Unicode regex syntax over a reversible UTF-16 view.
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result};
use fancy_regex::{Regex, RegexBuilder};
use serde::Serialize;
#[cfg(test)]
use serde_json::json;

const JS_SPACE: &str =
    r"\x09-\x0d\x20\u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
const BACKTRACK_LIMIT: usize = 1_000_000;

pub fn units(view: &str) -> Vec<u16> {
    Wtf8Buf::from_view(view).to_utf16()
}
pub fn view(units: &[u16]) -> String {
    Wtf8Buf::from_utf16(units).into_view()
}

/// Lone surrogates occupy distinct private-use scalars while matching. A literal scalar in
/// U+10F800–10FFFF collides with this mapping, as documented by the expression contract.
fn regex_text(view: &str) -> (String, Vec<(usize, usize)>) {
    let units = units(view);
    let mut text = String::new();
    let mut positions = vec![(0, 0)];
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        let point = if (0xd800..=0xdbff).contains(&unit)
            && units
                .get(index + 1)
                .is_some_and(|next| (0xdc00..=0xdfff).contains(next))
        {
            index += 1;
            0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(units[index]) - 0xdc00)
        } else if (0xd800..=0xdfff).contains(&unit) {
            0x10f800 + u32::from(unit) - 0xd800
        } else {
            u32::from(unit)
        };
        if let Some(character) = char::from_u32(point) {
            text.push(character);
        }
        index += 1;
        positions.push((text.len(), index));
    }
    (text, positions)
}

fn word(case_sensitive: bool) -> &'static str {
    if case_sensitive {
        "A-Za-z0-9_"
    } else {
        "A-Za-z0-9_\u{17f}\u{212a}"
    }
}

fn unicode_escape(chars: &[char], index: usize) -> Option<(u32, usize)> {
    if chars.get(index) != Some(&'\\') || chars.get(index + 1) != Some(&'u') {
        return None;
    }
    if chars.get(index + 2) == Some(&'{') {
        let end = (index + 3..chars.len()).find(|i| chars[*i] == '}')?;
        let digits: String = chars[index + 3..end].iter().collect();
        return u32::from_str_radix(&digits, 16)
            .ok()
            .map(|point| (point, end + 1));
    }
    let digits: String = chars.get(index + 2..index + 6)?.iter().collect();
    u32::from_str_radix(&digits, 16)
        .ok()
        .map(|point| (point, index + 6))
}

pub fn rewrite(pattern: &str, case_sensitive: bool) -> Result<String> {
    let (pattern, _) = regex_text(pattern);
    let chars: Vec<char> = pattern.chars().collect();
    let mut output = String::new();
    let mut index = 0;
    let mut class = false;
    while index < chars.len() {
        let character = chars[index];
        if character == '\\' {
            if let Some((mut point, mut end)) = unicode_escape(&chars, index) {
                if (0xd800..=0xdbff).contains(&point)
                    && let Some((next, next_end)) = unicode_escape(&chars, end)
                    && (0xdc00..=0xdfff).contains(&next)
                {
                    point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00;
                    end = next_end;
                }
                if (0xd800..=0xdfff).contains(&point) {
                    point = 0x10f800 + point - 0xd800;
                }
                output.push_str(&format!("\\x{{{point:x}}}"));
                index = end;
                continue;
            }
            let escape = *chars.get(index + 1).ok_or_else(|| {
                Error::new(
                    ErrorCode::InvalidInput,
                    "Incomplete regular-expression escape.",
                )
            })?;
            let value = match escape {
                'd' => Some("0-9".to_owned()),
                'w' => Some(word(case_sensitive).to_owned()),
                's' => Some(JS_SPACE.to_owned()),
                _ => None,
            };
            if let Some(value) = value {
                if class {
                    output.push_str(&value);
                } else {
                    output.push_str(&format!("[{value}]"));
                }
            } else if matches!(escape, 'D' | 'W' | 'S') {
                let value = match escape {
                    'D' => "0-9",
                    'W' => word(case_sensitive),
                    _ => JS_SPACE,
                };
                output.push_str(&format!("[^{value}]"));
            } else if !class && matches!(escape, 'b' | 'B') {
                let word = word(case_sensitive);
                output.push_str(&if escape == 'b' {
                    format!("(?:(?<![{word}])(?=[{word}])|(?<=[{word}])(?![{word}]))")
                } else {
                    format!("(?:(?<=[{word}])(?=[{word}])|(?<![{word}])(?![{word}]))")
                });
            } else if class && escape == 'b' {
                output.push_str(r"\x08");
            } else if escape == '/' {
                output.push('/');
            } else if !class && escape.is_ascii_digit() && escape != '0' {
                // JS matches a reference (numbered or named) to a group that has not participated
                // as empty; the backtracking engine fails it unless asked whether the group matched.
                let digits = chars[index + 1..]
                    .iter()
                    .take_while(|digit| digit.is_ascii_digit())
                    .collect::<String>();
                output.push_str(&format!(r"(?({digits})\{digits})"));
                index += 1 + digits.len();
                continue;
            } else if !class
                && escape == 'k'
                && chars.get(index + 2) == Some(&'<')
                && let Some(close) = (index + 3..chars.len()).find(|i| chars[*i] == '>')
            {
                let name = chars[index + 3..close].iter().collect::<String>();
                output.push_str(&format!(r"(?(<{name}>)\k<{name}>)"));
                index = close + 1;
                continue;
            } else {
                output.push('\\');
                output.push(escape);
            }
            index += 2;
            continue;
        }
        if !class && chars.get(index..index + 2) == Some(&['[', ']']) {
            output.push_str("(?!)");
            index += 2;
            continue;
        }
        if !class && chars.get(index..index + 3) == Some(&['[', '^', ']']) {
            output.push_str("(?s:.)");
            index += 3;
            continue;
        }
        match character {
            '[' => {
                class = true;
                output.push(character);
            }
            ']' => {
                class = false;
                output.push(character);
            }
            '.' if !class => output.push_str(r"[^\n\r\u{2028}\u{2029}]"),
            '^' if !class => output.push_str(r"\A"),
            '$' if !class => output.push_str(r"\z"),
            _ => output.push(character),
        }
        index += 1;
    }
    Ok(output)
}

pub struct JsRegex {
    inner: Regex,
}
impl JsRegex {
    pub fn new(pattern: &str, case_sensitive: bool) -> Result<Self> {
        let pattern = rewrite(pattern, case_sensitive)?;
        let inner = RegexBuilder::new(&pattern)
            .case_insensitive(!case_sensitive)
            .backtrack_limit(BACKTRACK_LIMIT)
            .build()
            .map_err(|cause| {
                Error::with_source(
                    ErrorCode::InvalidInput,
                    "Invalid rule regular expression.",
                    cause,
                )
            })?;
        Ok(Self { inner })
    }

    /// A budget error is returned to the caller, which emits the existing syntax_limit diagnostic.
    pub fn matches(&self, source: &str, cap: Option<usize>) -> Result<Vec<Match>> {
        let (text, positions) = regex_text(source);
        let source_units = units(source);
        let mut output = Vec::new();
        let mut offset = 0;
        while offset <= text.len() && cap.is_none_or(|cap| output.len() < cap) {
            let found = self.inner.find_from_pos(&text, offset).map_err(|cause| {
                Error::with_source(
                    ErrorCode::LimitExceeded,
                    "Rule regex exceeded its syntax limit.",
                    cause,
                )
            })?;
            // JS searches assertions at UTF-16 positions, even between a surrogate pair.
            // Unicode consuming matches still use scalars. Probe only empty matches at those
            // additional positions, before the scalar match the regex engine found.
            let stop = found.as_ref().map_or(text.len(), |found| found.start());
            let mut interior = None;
            for pair in positions.windows(2).filter(|pair| {
                pair[0].0 >= offset && pair[0].0 < stop && pair[1].1 == pair[0].1 + 2
            }) {
                let (begin, unit) = pair[0];
                let end = pair[1].0;
                let high = char::from_u32(0x10f800 + u32::from(source_units[unit]) - 0xd800)
                    .ok_or("Invalid high surrogate.")?;
                let low = char::from_u32(0x10f800 + u32::from(source_units[unit + 1]) - 0xd800)
                    .ok_or("Invalid low surrogate.")?;
                let split = format!("{}{high}{low}{}", &text[..begin], &text[end..]);
                let boundary = begin + high.len_utf8();
                let candidate = self
                    .inner
                    .find_from_pos(&split, boundary)
                    .map_err(|cause| {
                        Error::with_source(
                            ErrorCode::LimitExceeded,
                            "Rule regex exceeded its syntax limit.",
                            cause,
                        )
                    })?;
                if candidate.is_some_and(|candidate| {
                    candidate.start() == boundary && candidate.end() == boundary
                }) {
                    interior = Some((unit + 1, end));
                    break;
                }
            }
            if let Some((unit, next_offset)) = interior {
                output.push(Match {
                    text: String::new(),
                    start: unit,
                    end: unit,
                });
                offset = next_offset;
                continue;
            }
            let Some(found) = found else {
                break;
            };
            let start_index = positions
                .binary_search_by_key(&found.start(), |position| position.0)
                .map_err(|_| "Regex start is not a UTF-16 boundary.")?;
            let end_index = positions
                .binary_search_by_key(&found.end(), |position| position.0)
                .map_err(|_| "Regex end is not a UTF-16 boundary.")?;
            let start = positions[start_index].1;
            let end = positions[end_index].1;
            output.push(Match {
                text: view(&source_units[start..end]),
                start,
                end,
            });
            offset = if found.start() == found.end() {
                positions
                    .get(end_index + 1)
                    .map_or(text.len() + 1, |position| position.0)
            } else {
                found.end()
            };
        }
        Ok(output)
    }
}

/// A match in UTF-16 units, as JavaScript reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Match {
    #[serde(rename = "match")]
    pub text: String,
    pub start: usize,
    pub end: usize,
}

pub fn term_pattern(term: &str, boundary: &str) -> String {
    let class = if boundary == "lmnu" {
        r"\p{L}\p{M}\p{N}_"
    } else {
        r"\p{L}\p{M}\p{N}"
    };
    format!("(?<![{class}]){}(?![{class}])", regex::escape(term))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::require;
    use std::io::Write;
    use std::process::{Command, Stdio};

    #[test]
    fn javascript_regex_differential_including_lone_surrogates() -> Result<()> {
        let sources = crate::json_value::parse(
            r#"["", "a A 0 _", "é K ſ k s", "中１ 1", "a\nb\r\n", "ababa", "😀x𐀀", "x\ud800y\udfff", "\ud800\udc00", "\u00a0\ufeff\u0085", "a\u2028b\u2029", "ac", "bbc", "aab", "ad bcd xd", "ababa abc"]"#,
        )?;
        let patterns = [
            r"\d+",
            r"\D+",
            r"\w+",
            r"\W+",
            r"\s+",
            r"\S+",
            r"\b\w+\b",
            r"\B",
            ".",
            "^",
            "$",
            ".*?",
            "a*",
            "a|ab",
            "(?=a)",
            "(?<=a)b",
            "(?<=a|bc)d",
            "(?<=.|ab)c",
            "(?<=(?:ab){2})a",
            "(?<!a|bb)c",
            "(a)b\\1",
            "(a|(b))\\2c",
            "(a)?b\\1",
            "\\1(a)",
            "(a)|\\1b",
            "(?<x>a)|\\k<x>b",
            "[\\d_]+",
            "[^]",
            "[]",
            r"\uD800",
            r"[\uD800-\uDFFF]",
            r"\uD800\uDC00",
            r"\u{1F600}",
            r"\p{L}+",
            "k|s",
            "a(?=b)",
            "a(?!b)",
        ];
        for case_sensitive in [true, false] {
            let mut cases = Vec::new();
            for source in sources.as_array().ok_or("Missing inputs.")? {
                for pattern in patterns {
                    cases.push(json!({"source": source, "pattern": pattern, "caseSensitive":case_sensitive}));
                }
            }
            let mut child = Command::new("node").args(["-e", "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s).map(({source,pattern,caseSensitive})=>[...source.matchAll(new RegExp(pattern,caseSensitive?'gu':'giu'))].slice(0,16).map(m=>({match:m[0],start:m.index,end:m.index+m[0].length}))))));"])
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
            child
                .stdin
                .take()
                .ok_or("Missing Node stdin.")?
                .write_all(crate::wtf8::view_json(&json!(cases))?.as_bytes())?;
            let output = child.wait_with_output()?;
            require(output.status.success(), "Node regex pin failed.")?;
            let expected = crate::json_value::parse(std::str::from_utf8(&output.stdout)?)?;
            for (index, case) in cases.iter().enumerate() {
                let pattern = case["pattern"].as_str().ok_or("Missing pattern.")?;
                let source = case["source"].as_str().ok_or("Missing source.")?;
                let actual = JsRegex::new(pattern, case_sensitive)?.matches(source, Some(16))?;
                assert_eq!(
                    json!(actual),
                    expected[index],
                    "pattern {pattern:?}, source {source:?}, sensitive {case_sensitive}"
                );
            }
        }
        Ok(())
    }

    #[test]
    fn a_varying_lookbehind_is_rejected_when_compiled() {
        let error = JsRegex::new("(?<=a+)b", true).err();
        assert_eq!(error.map(|error| error.code), Some(ErrorCode::InvalidInput));
    }

    /// The rule editor rejects exactly the JavaScript patterns the engine cannot run.
    #[test]
    fn the_authoring_check_agrees_with_the_engine_compiler() -> Result<()> {
        let patterns = [
            r"(?<=a)b",
            r"(?<=.)b",
            r"(?<=[aé])b",
            r"(?<=\d)b",
            r"(?<=\p{L})b",
            r"(?<=a|bc)d",
            r"(?<=a{2})b",
            r"(?<=a{2,2})b",
            r"(?<=(?:ab){2})c",
            r"(?<=(a))b",
            r"(?<=(?<x>a))b",
            r"(?<=(?=a)a)b",
            r"(?<=(?!a)b)c",
            r"(?<=\bx)y",
            r"(?<=^)a",
            r"(?<=\u{1F600})b",
            r"(?<=[^)])b",
            r"(?<=[+*?])b",
            r"(?<=\+)b",
            r"(?<=\?)b",
            r"(?<=\{)b",
            r"(?<!a)b",
            r"(?<=a{1,2})b",
            r"(?<=a?)b",
            r"(?<=a*)b",
            r"(?<=a+)b",
            r"(?<=a{2,})b",
            r"(?<=a+?)b",
            r"(?<!a+)b",
            r"(?<=(a)\1)b",
            r"(?<=(?<x>a)\k<x>)b",
            r"(?<=(?:a|b)+)c",
            r"(?<=(?=a+)a)b",
            r"(?<=(?!(a)\1)b)c",
            r"(?<=(?=a)(?:a|bb)+)c",
            r"(?<=x(?<=a+))b",
            r"a+(?<=a)b",
            r"(a)\1(?<=a)",
            r"a?(?=b+)",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .ok_or("Missing repository root.")?;
        let output = Command::new("node")
            .args([
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                &format!(
                    "import {{engineRunsPattern}} from './packages/game-text/src/rule-regex.ts'; process.stdout.write(JSON.stringify({}.map(engineRunsPattern)));",
                    serde_json::to_string(&patterns[..])?
                ),
            ])
            .current_dir(root)
            .output()?;
        require(
            output.status.success(),
            std::str::from_utf8(&output.stderr)?,
        )?;
        let authored = crate::json_value::parse(std::str::from_utf8(&output.stdout)?)?;
        for (index, pattern) in patterns.iter().enumerate() {
            assert_eq!(
                authored[index].as_bool(),
                Some(JsRegex::new(pattern, true).is_ok()),
                "pattern {pattern:?}"
            );
        }
        Ok(())
    }
}
