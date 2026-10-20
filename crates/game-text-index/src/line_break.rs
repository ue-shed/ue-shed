//! Unreal-style word counts: the non-empty spans between UAX #14 line-break opportunities,
//! counted exactly as `localizationWordCount` counts them with the `linebreak` package. Text in
//! scripts that ICU breaks with dictionaries has no count, rather than a guessed one.
use crate::line_break_tables::{CLASS_STARTS, CLASS_VALUES, DICTIONARY_SCRIPTS, PAIRS};

// The package's UAX #14 classes, by its numbering.
const OP: u8 = 0;
const QU: u8 = 3;
const NS: u8 = 5;
const AL: u8 = 12;
const HL: u8 = 13;
const HY: u8 = 16;
const BA: u8 = 17;
const WJ: u8 = 22;
const RI: u8 = 28;
const ZWJ: u8 = 31;
const AI: u8 = 33;
const BK: u8 = 34;
const CJ: u8 = 35;
const CR: u8 = 36;
const LF: u8 = 37;
const NL: u8 = 38;
const SA: u8 = 39;
const SG: u8 = 40;
const SP: u8 = 41;
const XX: u8 = 42;
const _: () = assert!(OP == 0 && QU == 3);

fn class_of(code_point: u32) -> u8 {
    let run = CLASS_STARTS.partition_point(|start| *start <= code_point);
    CLASS_VALUES[run.saturating_sub(1)]
}
fn map_class(class: u8) -> u8 {
    match class {
        AI | SA | SG | XX => AL,
        CJ => NS,
        _ => class,
    }
}
fn map_first(class: u8) -> u8 {
    match class {
        LF | NL => BK,
        SP => WJ,
        _ => class,
    }
}

/// UTF-16 code units, as JavaScript strings hold them: a pair is one code point and a lone
/// surrogate is its own code unit.
struct Breaker<'a> {
    text: &'a [u16],
    position: usize,
    current: u8,
    next: u8,
    lb8a: bool,
    lb21a: bool,
    lb30a: u32,
}
impl Breaker<'_> {
    fn next_code_point(&mut self) -> u32 {
        let code = u32::from(self.text[self.position]);
        self.position += 1;
        if (0xd800..=0xdbff).contains(&code)
            && let Some(next) = self.text.get(self.position).map(|unit| u32::from(*unit))
            && (0xdc00..=0xdfff).contains(&next)
        {
            self.position += 1;
            return (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        }
        code
    }
    fn next_class(&mut self) -> u8 {
        map_class(class_of(self.next_code_point()))
    }
    fn simple_break(&mut self) -> Option<bool> {
        match self.next {
            SP => Some(false),
            BK | LF | NL => {
                self.current = BK;
                Some(false)
            }
            CR => {
                self.current = CR;
                Some(false)
            }
            _ => None,
        }
    }
    fn pair_break(&mut self, last: u8) -> bool {
        let mut should = false;
        match PAIRS[self.current as usize][self.next as usize] {
            0 => should = true,
            1 => should = last == SP,
            2 => {
                should = last == SP;
                if !should {
                    return false;
                }
            }
            3 if last != SP => return should,
            _ => {}
        }
        if self.lb8a {
            should = false;
        }
        if self.lb21a && (self.current == HY || self.current == BA) {
            should = false;
            self.lb21a = false;
        } else {
            self.lb21a = self.current == HL;
        }
        if self.current == RI {
            self.lb30a += 1;
            if self.lb30a == 2 && self.next == RI {
                should = true;
                self.lb30a = 0;
            }
        } else {
            self.lb30a = 0;
        }
        self.current = self.next;
        should
    }
}

/// The number of line-break spans in UTF-16 text, or `None` when it holds Thai, Lao, Khmer or
/// Myanmar text.
pub(crate) fn line_break_words(text: &[u16]) -> Option<u32> {
    if dictionary_script(text) {
        return None;
    }
    if text.is_empty() {
        return Some(0);
    }
    let mut breaker = Breaker {
        text,
        position: 0,
        current: 0,
        next: 0,
        lb8a: false,
        lb21a: false,
        lb30a: 0,
    };
    let first = breaker.next_class();
    breaker.current = map_first(first);
    breaker.next = first;
    breaker.lb8a = first == ZWJ;
    let mut words = 0u32;
    let mut previous = 0usize;
    let mut last_position = 0usize;
    let mut found = |position: usize, previous: &mut usize| {
        if position > *previous {
            words += 1;
        }
        *previous = position;
    };
    while breaker.position < text.len() {
        last_position = breaker.position;
        let last = breaker.next;
        breaker.next = breaker.next_class();
        if breaker.current == BK || (breaker.current == CR && breaker.next != LF) {
            breaker.current = map_first(map_class(breaker.next));
            found(last_position, &mut previous);
            continue;
        }
        let should = match breaker.simple_break() {
            Some(value) => value,
            None => breaker.pair_break(last),
        };
        breaker.lb8a = breaker.next == ZWJ;
        if should {
            found(last_position, &mut previous);
        }
    }
    if last_position < text.len() {
        found(text.len(), &mut previous);
    }
    Some(words)
}

fn dictionary_script(text: &[u16]) -> bool {
    char::decode_utf16(text.iter().copied()).any(|unit| {
        unit.is_ok_and(|character| {
            let code_point = u32::from(character);
            let range = DICTIONARY_SCRIPTS.partition_point(|(start, _)| *start <= code_point);
            range > 0 && code_point <= DICTIONARY_SCRIPTS[range - 1].1
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(text: &str) -> Option<u32> {
        line_break_words(&text.encode_utf16().collect::<Vec<_>>())
    }

    // Expected values are `localizationWordCount` results from the `linebreak` package.
    #[test]
    fn counts_spans_like_the_linebreak_package() {
        for (text, words) in [
            ("", 0),
            ("a", 1),
            (" ", 1),
            ("Hello world", 2),
            ("Hello  world ", 2),
            ("Press {Key} to jump!", 4),
            ("well-known e-mail", 4),
            ("line\nbreak", 2),
            ("line\r\nbreak", 2),
            ("\n\n", 2),
            ("日本語のテキスト", 8),
            ("👍🏽 ok", 2),
            ("🇩🇪🇫🇷", 2),
            ("a\u{200d}b c", 2),
            ("x\u{200b}y", 2),
            ("(quoted) [text]", 2),
            ("100% 3.14 $5", 3),
        ] {
            assert_eq!(count(text), Some(words), "{text:?}");
        }
    }

    #[test]
    fn dictionary_scripts_and_lone_surrogates() {
        assert_eq!(count("ภาษาไทย"), None);
        assert_eq!(count("ok ພາສາລາວ"), None);
        assert_eq!(count("ខ្មែរ"), None);
        assert_eq!(count("မြန်မာ"), None);
        assert_eq!(line_break_words(&[0xd800]), Some(1));
        assert_eq!(line_break_words(&[0x61, 0xdc00, 0x20, 0x62]), Some(2));
        assert_eq!(line_break_words(&[0xd83d, 0xde00, 0x20, 0xd83d]), Some(2));
    }
}

/// Compares every vector in `GAME_TEXT_LINE_BREAK_VECTORS`: a JSON array of `[units, words]`,
/// where `units` are UTF-16 code units and `words` is `localizationWordCount`'s count or null.
#[cfg(test)]
mod vectors {
    #[test]
    #[ignore = "needs vectors written by the linebreak package"]
    fn matches_the_linebreak_package_vectors() -> crate::Result<()> {
        let path = std::env::var("GAME_TEXT_LINE_BREAK_VECTORS")
            .map_err(|_| "Set GAME_TEXT_LINE_BREAK_VECTORS.")?;
        let vectors: Vec<(Vec<u16>, Option<u32>)> = serde_json::from_slice(&std::fs::read(path)?)?;
        let mismatches = vectors
            .iter()
            .filter(|(units, words)| super::line_break_words(units) != *words)
            .take(20)
            .collect::<Vec<_>>();
        assert!(mismatches.is_empty(), "{mismatches:?}");
        assert!(vectors.len() > 1000);
        Ok(())
    }
}
