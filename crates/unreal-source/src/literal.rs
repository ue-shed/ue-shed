//! What the gather does to an argument's characters: escapes, quotes, `TEXT()` and comments.

use crate::EngineLine;
use crate::wide::{
    APOSTROPHE, BACKSLASH, QUOTE, Wide, find_unit, is_hex_digit, is_oct_digit, replace,
    starts_with_ignore_case, trim, trim_end, trim_quotes, wide,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Escape {
    Idle,
    Octal,
    Hex,
    Utf16,
    Utf32,
}

/// `FCString::Strtoi` (a 32-bit `long`, saturating) cast to one UTF-16 unit.
fn parse_unit(digits: &[u16], radix: u32) -> u16 {
    let mut value: i64 = 0;
    for &digit in digits {
        let Some(number) = char::from_u32(u32::from(digit)).and_then(|c| c.to_digit(radix)) else {
            break;
        };
        value = (value * i64::from(radix) + i64::from(number)).min(i64::from(i32::MAX));
    }
    value as u16
}

fn parse_codepoint(digits: &[u16], radix: u32, wide_parse: bool) -> u32 {
    let mut value: u64 = 0;
    for &digit in digits {
        let Some(number) = char::from_u32(u32::from(digit)).and_then(|c| c.to_digit(radix)) else {
            break;
        };
        value = value
            .saturating_mul(u64::from(radix))
            .saturating_add(u64::from(number));
    }
    if wide_parse {
        value as u32
    } else {
        value.min(i32::MAX as u64) as u32
    }
}

/// `FTextChar::ConvertCodepointToString`: nothing for an invalid codepoint or a lone surrogate.
fn push_codepoint(out: &mut Wide, codepoint: u32) {
    if codepoint > 0x10FFFF || codepoint == 0xFFFE || codepoint == 0xFFFF {
        return;
    }
    if (0xD800..=0xDFFF).contains(&codepoint) {
        return;
    }
    if let Some(character) = char::from_u32(codepoint) {
        let mut units = [0u16; 2];
        out.extend_from_slice(character.encode_utf16(&mut units));
    }
}

fn flush(out: &mut Wide, state: Escape, digits: &[u16], empty_counts: bool) {
    if digits.is_empty() && !empty_counts {
        return;
    }
    match state {
        Escape::Octal => out.push(parse_unit(digits, 8)),
        Escape::Hex => out.push(parse_unit(digits, 16)),
        Escape::Utf16 => push_codepoint(out, parse_codepoint(digits, 16, false)),
        Escape::Utf32 => push_codepoint(out, parse_codepoint(digits, 16, true)),
        Escape::Idle => {}
    }
}

/// `UnescapeLiteralCharacterEscapeSequences` followed by `ReplaceEscapedCharWithChar`.
///
/// 5.x re-reads the character that ends a sequence and flushes a sequence cut off by the end of
/// the text. 4.27 appends that character as it is, flushes even an empty sequence (as a NUL),
/// and drops a sequence still open at the end.
pub(crate) fn unescape(text: &[u16], line: EngineLine) -> Wide {
    let legacy = line == EngineLine::Ue4_27;
    let at = |index: usize| text.get(index).copied().unwrap_or(0);
    let mut out = Wide::with_capacity(text.len());
    let mut state = Escape::Idle;
    let mut digits = Wide::new();
    let mut index = 0;
    loop {
        let current = at(index);
        if current == 0 && (legacy || state == Escape::Idle) {
            break;
        }
        match state {
            Escape::Idle => {
                let next = at(index + 1);
                if current == BACKSLASH && next != 0 {
                    if is_oct_digit(next) {
                        state = Escape::Octal;
                    } else if next == u16::from(b'x') {
                        index += 1;
                        state = Escape::Hex;
                    } else if next == u16::from(b'u') {
                        index += 1;
                        state = Escape::Utf16;
                    } else if next == u16::from(b'U') {
                        index += 1;
                        state = Escape::Utf32;
                    }
                }
                if state == Escape::Idle {
                    out.push(current);
                } else {
                    digits.clear();
                }
            }
            Escape::Octal | Escape::Hex | Escape::Utf16 | Escape::Utf32 => {
                let (is_digit, limit) = match state {
                    Escape::Octal => (is_oct_digit(current), 3),
                    Escape::Hex => (is_hex_digit(current), usize::MAX),
                    Escape::Utf16 => (is_hex_digit(current), 4),
                    _ => (is_hex_digit(current), 8),
                };
                if is_digit {
                    digits.push(current);
                    if digits.len() == limit {
                        flush(&mut out, state, &digits, false);
                        state = Escape::Idle;
                    }
                } else if legacy {
                    flush(&mut out, state, &digits, true);
                    state = Escape::Idle;
                    out.push(current);
                } else {
                    flush(&mut out, state, &digits, false);
                    state = Escape::Idle;
                    // Re-read this character: it may start the next sequence.
                    index -= 1;
                }
            }
        }
        index += 1;
    }
    replace_escaped_char_with_char(&out)
}

/// `FString::ReplaceEscapedCharWithChar`: one pass per sequence, in this order, ignoring case.
pub(crate) fn replace_escaped_char_with_char(text: &[u16]) -> Wide {
    let mut out = text.to_vec();
    for (from, to) in [
        ("\\\"", "\""),
        ("\\'", "'"),
        ("\\t", "\t"),
        ("\\r", "\r"),
        ("\\n", "\n"),
        ("\\\\", "\\"),
    ] {
        out = replace(&out, &wide(from), &wide(to), true);
    }
    out
}

/// `RemoveStringFromTextMacro`: the text inside `TEXT("…")`, or the argument without quotes.
/// `None` when a `TEXT` wrapper has no closed literal.
pub(crate) fn remove_string_from_text_macro(text: &[u16], line: EngineLine) -> Option<Wide> {
    let inner = if starts_with_ignore_case(text, &wide("TEXT")) {
        let open = find_unit(text, QUOTE)?;
        if open == text.len() - 1 {
            return None;
        }
        let close = find_unit(&text[open + 1..], QUOTE)? + open + 1;
        text[open + 1..close].to_vec()
    } else {
        trim_quotes(text).0.to_vec()
    };
    Some(unescape(&inner, line))
}

/// `PrepareArgument` for the auto-text arguments every descriptor uses: trim the end, drop the
/// quotes, unescape. Returns the text and whether it had quotes.
pub(crate) fn prepare_argument(argument: &[u16], line: EngineLine) -> (Wide, bool) {
    let (inner, had_quotes) = trim_quotes(trim_end(argument));
    (unescape(inner, line), had_quotes)
}

/// `StripCommentsFromToken`: removes `//` and `/* */` outside quotes. A block comment left open
/// carries into the file's comment state, as Unreal's does.
pub(crate) fn strip_comments(token: &[u16], within_block_comment: &mut bool) -> Wide {
    let at = |index: usize| token.get(index).copied().unwrap_or(0);
    let slash = u16::from(b'/');
    let star = u16::from(b'*');
    let mut out = Wide::with_capacity(token.len());
    let mut quote: u16 = 0;
    let mut ignore_next_quote = false;
    let mut index = 0;
    while index < token.len() && token[index] != 0 {
        let unit = token[index];
        if quote != 0 {
            out.push(unit);
            if !ignore_next_quote {
                if unit == BACKSLASH {
                    ignore_next_quote = true;
                    index += 1;
                    continue;
                }
                if unit == quote {
                    quote = 0;
                }
            }
            ignore_next_quote = false;
        } else {
            if unit == slash {
                if at(index + 1) == slash {
                    break;
                }
                if at(index + 1) == star {
                    *within_block_comment = true;
                    index += 2;
                    continue;
                }
            }
            if *within_block_comment {
                if unit == star && at(index + 1) == slash {
                    *within_block_comment = false;
                    index += 2;
                    continue;
                }
                index += 1;
                continue;
            }
            out.push(unit);
            if unit == QUOTE || unit == APOSTROPHE {
                quote = unit;
            }
        }
        index += 1;
    }
    trim(&out).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wide::narrow;

    fn run(text: &str, line: EngineLine) -> String {
        narrow(&unescape(&wide(text), line))
    }

    #[test]
    fn unescapes_like_the_compiler_and_then_like_unreal() {
        assert_eq!(run(r"Snow ❄ and été", EngineLine::Ue5_8), "Snow ❄ and été");
        assert_eq!(run(r"A\x41\x42", EngineLine::Ue5_8), "AAB");
        assert_eq!(run(r"\101\60", EngineLine::Ue5_8), "A0");
        assert_eq!(run(r"Tab\there \N", EngineLine::Ue5_8), "Tab\there \n");
        assert_eq!(run(r"\U0001F600", EngineLine::Ue5_8), "😀");
    }

    #[test]
    fn unescapes_like_4_27() {
        // The character after a sequence is kept as it is, and an open sequence is dropped.
        assert_eq!(run(r"\x41\x42", EngineLine::Ue4_27), "A\\x42");
        assert_eq!(run(r"end\x41", EngineLine::Ue4_27), "end");
    }

    #[test]
    fn strips_text_macros_and_quotes() {
        let strip = |text: &str| {
            remove_string_from_text_macro(&wide(text), EngineLine::Ue5_8).map(|w| narrow(&w))
        };
        assert_eq!(strip("TEXT(\"Harbor\")").as_deref(), Some("Harbor"));
        assert_eq!(strip("text(\"Harbor\")").as_deref(), Some("Harbor"));
        assert_eq!(strip("\"Harbor\"").as_deref(), Some("Harbor"));
        assert_eq!(strip("TEXT(\"Harbor").as_deref(), None);
    }

    #[test]
    fn strips_comments_outside_quotes() {
        let mut block = false;
        let stripped = strip_comments(
            &wide("LOCTEXT(\"a//b\", /* x */ \"c\") // done"),
            &mut block,
        );
        assert_eq!(narrow(&stripped), "LOCTEXT(\"a//b\",  \"c\")");
        assert!(!block);
        let stripped = strip_comments(&wide("LOCTEXT(\"a\", /* open"), &mut block);
        assert_eq!(narrow(&stripped), "LOCTEXT(\"a\",");
        assert!(block);
    }
}
