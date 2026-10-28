//! UTF-16 text that behaves like Unreal's `TCHAR` strings on Windows.
//!
//! The gather works on UTF-16 code units, so its quirks (a `\x` escape cast to one unit, a
//! surrogate half counted as a character) only reproduce on the same units. Unreal's
//! `StartsWith`, `EndsWith`, `Contains` and `ReplaceInline` ignore case unless told otherwise;
//! the case-insensitive helpers here fold ASCII only, as Unreal's string comparisons do.

pub(crate) type Wide = Vec<u16>;

pub(crate) const QUOTE: u16 = b'"' as u16;
pub(crate) const APOSTROPHE: u16 = b'\'' as u16;
pub(crate) const BACKSLASH: u16 = b'\\' as u16;
pub(crate) const OPEN: u16 = b'(' as u16;
pub(crate) const CLOSE: u16 = b')' as u16;
pub(crate) const COMMA: u16 = b',' as u16;

pub(crate) fn wide(text: &str) -> Wide {
    text.encode_utf16().collect()
}

pub(crate) fn narrow(text: &[u16]) -> String {
    String::from_utf16_lossy(text)
}

/// `FChar::IsWhitespace`: the C runtime's `iswspace`.
pub(crate) fn is_space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0D | 0x20)
        || (unit >= 0x80 && char::from_u32(u32::from(unit)).is_some_and(char::is_whitespace))
}

/// `FTextChar::IsWhitespace`: ICU's `u_isWhitespace`, which leaves out the no-break spaces.
pub(crate) fn is_text_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0D
            | 0x1C..=0x20
            | 0x1680
            | 0x2000..=0x2006
            | 0x2008..=0x200A
            | 0x2028
            | 0x2029
            | 0x205F
            | 0x3000
    )
}

pub(crate) fn is_oct_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'7')).contains(&unit)
}

pub(crate) fn is_hex_digit(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_hexdigit())
}

/// `FChar::IsAlnum`: the C runtime's `iswalnum`.
pub(crate) fn is_alnum(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(char::is_alphanumeric)
}

pub(crate) fn trim_start(text: &[u16]) -> &[u16] {
    let start = text
        .iter()
        .position(|&unit| !is_space(unit))
        .unwrap_or(text.len());
    &text[start..]
}

pub(crate) fn trim_end(text: &[u16]) -> &[u16] {
    let end = text
        .iter()
        .rposition(|&unit| !is_space(unit))
        .map_or(0, |at| at + 1);
    &text[..end]
}

pub(crate) fn trim(text: &[u16]) -> &[u16] {
    trim_end(trim_start(text))
}

/// `FString::TrimQuotes`: drops one leading and one trailing `"`, and reports whether either went.
pub(crate) fn trim_quotes(text: &[u16]) -> (&[u16], bool) {
    let mut start = 0;
    let mut count = text.len();
    let mut removed = false;
    if count > 0 {
        if text[0] == QUOTE {
            start = 1;
            count -= 1;
            removed = true;
        }
        if text.len() > 1 && text[text.len() - 1] == QUOTE {
            count -= 1;
            removed = true;
        }
    }
    (&text[start..start + count], removed)
}

fn fold(unit: u16) -> u16 {
    if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
        unit + 32
    } else {
        unit
    }
}

pub(crate) fn equals_ignore_case(left: &[u16], right: &[u16]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(&a, &b)| fold(a) == fold(b))
}

pub(crate) fn starts_with_ignore_case(text: &[u16], prefix: &[u16]) -> bool {
    text.len() >= prefix.len() && equals_ignore_case(&text[..prefix.len()], prefix)
}

pub(crate) fn ends_with_ignore_case(text: &[u16], suffix: &[u16]) -> bool {
    text.len() >= suffix.len() && equals_ignore_case(&text[text.len() - suffix.len()..], suffix)
}

pub(crate) fn find(text: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from > text.len() {
        return None;
    }
    text[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

pub(crate) fn find_unit(text: &[u16], unit: u16) -> Option<usize> {
    text.iter().position(|&candidate| candidate == unit)
}

pub(crate) fn contains(text: &[u16], needle: &[u16]) -> bool {
    find(text, needle, 0).is_some()
}

/// `FString::ReplaceInline`, left to right without overlap; `ignore_case` is Unreal's default.
pub(crate) fn replace(text: &[u16], from: &[u16], to: &[u16], ignore_case: bool) -> Wide {
    let mut out = Wide::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let hit = if ignore_case {
            starts_with_ignore_case(rest, from)
        } else {
            rest.starts_with(from)
        };
        if hit && !from.is_empty() {
            out.extend_from_slice(to);
            at += from.len();
        } else {
            out.push(text[at]);
            at += 1;
        }
    }
    out
}

/// The text up to its first NUL: Unreal walks lines as C strings.
pub(crate) fn until_nul(text: &[u16]) -> &[u16] {
    find_unit(text, 0).map_or(text, |end| &text[..end])
}

/// `FFileHelper::BufferToString`: UTF-16 with a byte order mark when the size is even, else
/// UTF-8 with an optional byte order mark. Invalid UTF-8 becomes `?` per byte.
pub(crate) fn decode(bytes: &[u8]) -> Wide {
    let even = bytes.len() >= 2 && bytes.len().is_multiple_of(2);
    if even && bytes[0] == 0xFF && bytes[1] == 0xFE {
        return bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
    }
    if even && bytes[0] == 0xFE && bytes[1] == 0xFF {
        return bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let mut out = Wide::with_capacity(body.len());
    let mut rest = body;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.extend(valid.encode_utf16());
                break;
            }
            Err(error) => {
                let (valid, after) = rest.split_at(error.valid_up_to());
                out.extend(String::from_utf8_lossy(valid).encode_utf16());
                out.push(u16::from(b'?'));
                rest = &after[1..];
            }
        }
    }
    out
}

/// `FString::ParseIntoArrayLines(Lines, false)`: splits on `\r\n`, `\r` and `\n`, keeping empty
/// lines so line numbers stay true.
pub(crate) fn split_lines(text: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut at = 0;
    while at < text.len() {
        let unit = text[at];
        if unit == 0x0D || unit == 0x0A {
            lines.push(&text[start..at]);
            at += if unit == 0x0D && text.get(at + 1) == Some(&0x0A) {
                2
            } else {
                1
            };
            start = at;
        } else {
            at += 1;
        }
    }
    lines.push(&text[start..]);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_every_encoding_unreal_reads() {
        let text = "Café ❄ 港";
        let mut utf16 = vec![0xFF, 0xFE];
        utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(text.as_bytes());
        for bytes in [text.as_bytes().to_vec(), bom, utf16] {
            assert_eq!(narrow(&decode(&bytes)), text);
        }
        assert_eq!(narrow(&decode(b"a\xFFb")), "a?b");
    }

    #[test]
    fn trims_quotes_like_unreal() {
        assert_eq!(trim_quotes(&wide("\"a\"")), (&wide("a")[..], true));
        assert_eq!(trim_quotes(&wide("\"")), (&wide("")[..], true));
        assert_eq!(trim_quotes(&wide("a")), (&wide("a")[..], false));
    }

    #[test]
    fn splits_lines_on_every_line_break() {
        let text = wide("a\r\nb\rc\n\nd");
        let lines: Vec<String> = split_lines(&text).into_iter().map(narrow).collect();
        assert_eq!(lines, ["a", "b", "c", "", "d"]);
    }
}
