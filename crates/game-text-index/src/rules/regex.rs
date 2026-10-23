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
            // JS character escapes the backtracking engine has no syntax for: NUL and `\cX`.
            let control = chars
                .get(index + 2)
                .filter(|letter| escape == 'c' && letter.is_ascii_alphabetic());
            if escape == '0' || control.is_some() {
                let point = control.map_or(0, |letter| u32::from(*letter) % 32);
                output.push_str(&format!("\\x{{{point:x}}}"));
                index += if control.is_some() { 3 } else { 2 };
                continue;
            }
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
        // JS `[]` is a class that matches nothing: one character wide, and quantifiable.
        if !class && chars.get(index..index + 2) == Some(&['[', ']']) {
            output.push_str(r"[^\x{0}-\x{10ffff}]");
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
            r#"["", "a A 0 _", "é K ſ k s", "中１ 1", "a\nb\r\n", "ababa", "😀x𐀀", "x\ud800y\udfff", "\ud800\udc00", "\u00a0\ufeff\u0085", "a\u2028b\u2029", "ac", "bbc", "aab", "ad bcd xd", "ababa abc", "x\u0000y"]"#,
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
            "(?<=(?:a|bc))d",
            "(?<=a{2}?)b",
            "(?<=(a|b))c",
            "(?<=([]|a))b",
            "a[]?b",
            "[]{0}a",
            "a|[]+",
            "\\0|\\cJ|\\cj",
            "[\\0\\cJ]",
            "(?<=a{02,2})b",
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

    /// The rule file admits only patterns the engine compiles, keeps realistic lookbehinds,
    /// and rejects the ones outside the dialect.
    #[test]
    fn the_rule_file_admits_only_patterns_the_engine_compiles() -> Result<()> {
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
            r"(?<=(a|bc))d",
            r"(?<=(?:a|bc))d",
            r"(?<=(?:(?:a|bc)))d",
            r"(?<=x(?:a|bc))d",
            r"(?<=(?:a|bc)x)d",
            r"(?<=a|b(?:c|de))f",
            r"(?<=(a|b))c",
            r"(?<=(?:ab|cd))e",
            r"(?<=a{2}?)b",
            r"(?<=a{2,2}?)b",
            r"(?<=[ab]{2})c",
            r"(?<=a|b+)c",
            r"(?<=(?:😀|a))b",
            r"(?<=x(?:😀|a))b",
            r"(?<=x(?:😀|a))b",
            r"(?<=(?:a|bc)|d)e",
            r"(?<=a|(?:b|cd))e",
            r"(?<=(?<n>a|bc))d",
            r"(?<=a(?=b+)|cd)e",
            r"(?<=(?:a|bc){2})d",
            r"(?<=(?:a|b){2})d",
            r"(?<=\b(?:a|b))c",
            r"(?<=(?:a|bc)(?=x))d",
            r"(?<=a(?:b|c)|de)f",
            r"(?<=a(?:b|cd)|e)f",
            r"(?<=(?:(?:a|b)|c))d",
            r"(?<=(?:(?:a|bb)|c))d",
            r"(?<=.|ab)c",
            r"(?<=\d|ab)c",
            r"(?<=^|a)b",
            r"(?<=a|$)b",
            r"(?<=(?:a|)b)c",
            r"(?<=a|)b",
            r"(?<=(?:)|a)b",
            r"(?<=[\]|]x|y)z",
            r"(?<=\x41|\u{42}c)d",
            r"(?<=a{02,2})b",
            r"(?<=a{2,02})b",
            r"(?<=a{002})b",
            r"(?<=a{2,3})b",
            r"(?<=a{0})b",
            r"(?<=(a{0}|b{00}))c",
            r"(?<=([]|a))b",
            r"(?<=(?:[]|a))b",
            r"(?<=[]|a)b",
            r"(?<=x(?:[]|[]))b",
            r"(?<=([^]|a))b",
            r"(?<=[^]{2})b",
            r"(?<=x[])b",
            r"(?<=[]{2}a)b",
            r"(?<=[]{1}a)b",
            r"(?<=[]{0}a)b",
            r"(?<=[]?a)b",
            r"[]{2}(?<=a)b",
            r"(?<=\0)a",
            r"(?<=\cJ|\n)a",
        ];
        // Realistic lookbehinds the dialect keeps, and ones outside it.
        let accepted = [
            r"(?<=a)b",
            r"(?<=a|bc)d",
            r"(?<=(?:a|bc))d",
            r"(?<=(?:)(?:a|bc))d",
            r"(?<=(?:a|bc)(?:))d",
            r"(?<=a{2}?)b",
            r"(?<=a{02,2})b",
            r"(?<=([]|a))b",
            r"(?<=(a|b))c",
            r"(?<=\p{L})b",
            r"(?<=😀|a)b",
            r"(?<=x(?:😀|a))b",
            r"(?<=\bx)y",
            r"(?<=(?=a+)a)b",
            r"(?<!a|bb)c",
            r"(?<=\0)a",
        ];
        let rejected = [
            r"(?<=a+)b",
            r"(?<=a{1,2})b",
            r"(?<=(a|bc))d",
            r"(?<=(a)\1)b",
            r"(?<=a|b+)c",
        ];
        let all = patterns
            .iter()
            .chain(&accepted)
            .chain(&rejected)
            .collect::<Vec<_>>();
        let verdicts = authoring_verdicts(&all)?;
        for (pattern, authored) in all.iter().zip(&verdicts) {
            require(
                authored.is_some(),
                format!("JavaScript rejects {pattern:?}."),
            )?;
            // Everything the rule file admits must compile in the engine.
            if *authored == Some(true) {
                assert!(JsRegex::new(pattern, true).is_ok(), "pattern {pattern:?}");
            }
        }
        let start = patterns.len();
        for (pattern, authored) in accepted.iter().zip(&verdicts[start..]) {
            assert_eq!(*authored, Some(true), "pattern {pattern:?}");
        }
        for (pattern, authored) in rejected.iter().zip(&verdicts[start + accepted.len()..]) {
            assert_eq!(*authored, Some(false), "pattern {pattern:?}");
        }
        Ok(())
    }

    /// The authoring check's verdict on each pattern, or `None` where JavaScript rejects it.
    fn authoring_verdicts(patterns: &[impl AsRef<str>]) -> Result<Vec<Option<bool>>> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .ok_or("Missing repository root.")?;
        let mut child = Command::new("node")
            .args([
                "--import",
                "tsx",
                "--input-type=module",
                "-e",
                "import {engineRunsPattern} from './packages/game-text/src/rule-regex.ts'; let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', v => s += v); process.stdin.on('end', () => process.stdout.write(JSON.stringify(JSON.parse(s).map(p => { try { new RegExp(p, 'u'); } catch { return null; } return engineRunsPattern(p); }))));",
            ])
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let patterns = patterns.iter().map(AsRef::as_ref).collect::<Vec<_>>();
        child
            .stdin
            .take()
            .ok_or("Missing Node stdin.")?
            .write_all(serde_json::to_string(&patterns)?.as_bytes())?;
        let output = child.wait_with_output()?;
        require(
            output.status.success(),
            std::str::from_utf8(&output.stderr)?,
        )?;
        let verdicts = crate::json_value::parse(std::str::from_utf8(&output.stdout)?)?;
        Ok(verdicts
            .as_array()
            .ok_or("Missing verdicts.")?
            .iter()
            .map(serde_json::Value::as_bool)
            .collect())
    }

    /// Lookbehinds generated from the constructs that decide their width, seeded so a failure
    /// reproduces: every one the rule file admits must compile in the engine.
    #[test]
    fn the_engine_compiles_every_generated_lookbehind_the_rule_file_admits() -> Result<()> {
        const PIECES: [&str; 24] = [
            "a", "bc", "(?:)", "^", "$", r"\b", "[]", "[^]", ".", "😀", "a{2}", "a{0}", "a?", "a+",
            "a{1,2}", "(?=x+)", "(?!y)", "(?<=z)", r"\1", "(?:a|)", "(a)", "[ab]", r"\k<n>",
            "(?<n>)",
        ];
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = |bound: usize| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state % bound as u64) as usize
        };
        fn expression(next: &mut impl FnMut(usize) -> usize, depth: usize) -> String {
            let branches = 1 + next(3);
            (0..branches)
                .map(|_| {
                    (0..next(4))
                        .map(|_| {
                            if depth < 2 && next(4) == 0 {
                                let body = expression(next, depth + 1);
                                let group = ["(?:", "(", "(?<n>"][next(3)];
                                let repeat = ["", "", "{2}", "?", "{1}"][next(5)];
                                format!("{group}{body}){repeat}")
                            } else {
                                PIECES[next(PIECES.len())].to_owned()
                            }
                        })
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("|")
        }
        let patterns = (0..6000)
            .map(|_| {
                let prefix = ["", "(a)", "x"][next(3)];
                let behind = ["(?<=", "(?<!"][next(2)];
                format!("{prefix}{behind}{})d", expression(&mut next, 0))
            })
            .collect::<Vec<_>>();
        let verdicts = authoring_verdicts(&patterns)?;
        let admitted = patterns
            .iter()
            .zip(verdicts)
            .filter(|(_, authored)| *authored == Some(true))
            .map(|(pattern, _)| pattern)
            .collect::<Vec<_>>();
        // The generator must exercise the dialect, not only patterns outside it.
        assert!(
            admitted.len() > 1000,
            "only {} patterns admitted",
            admitted.len()
        );
        let failures = admitted
            .iter()
            .filter(|pattern| JsRegex::new(pattern, true).is_err())
            .map(|pattern| format!("{pattern:?}"))
            .collect::<Vec<_>>();
        assert!(
            failures.is_empty(),
            "{} admitted patterns the engine cannot compile:\n{}",
            failures.len(),
            failures[..failures.len().min(40)].join("\n")
        );
        Ok(())
    }
}
