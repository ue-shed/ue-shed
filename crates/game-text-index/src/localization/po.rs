use super::{Diagnostic, Limits, Options, Parsed, PoRow, failure, identity, js_space, trim};
use indexmap::IndexMap;

fn malformed(file: &str, line: usize) -> Diagnostic {
    failure(file, "malformed_po", &format!(" at line {line}"))
}
fn decode(value: &str) -> String {
    // packages/localization/src/po.ts:28-36: replacement order includes literal backslashes.
    value
        .replace("\\t", "\t")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\\"", "\"")
        .replace("\\\\", "\\")
}
fn quoted(value: &str, file: &str, line: usize) -> Parsed<String> {
    if !value.starts_with('"') {
        return Err(malformed(file, line));
    }
    let mut chars = value[1..].char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                if chars.next().is_none() {
                    return Err(malformed(file, line));
                }
            }
            '"' => {
                if !trim(&value[i + 2..]).is_empty() {
                    return Err(malformed(file, line));
                }
                return Ok(value[1..i + 1].into());
            }
            _ => {}
        }
    }
    Err(malformed(file, line))
}
#[derive(Clone)]
struct Field {
    name: String,
    index: Option<u64>,
    raw: String,
    line: usize,
}

fn block(lines: &[(&str, &str)], offset: usize, file: &str) -> Parsed<Option<(bool, PoRow)>> {
    let mut fields = Vec::<Field>::new();
    let mut row = PoRow {
        initial_identity: identity(""),
        msgid: String::new(),
        msgctxt: None,
        msgid_plural: None,
        msgstr: IndexMap::new(),
        translator_comments: Vec::new(),
        extracted_comments: Vec::new(),
        reference_comments: Vec::new(),
        flags: Vec::new(),
        previous_msgid_lines: Vec::new(),
        identity: None,
    };
    let mut current = None;
    for (index, (raw, _)) in lines.iter().enumerate() {
        let line = offset + index + 1;
        let text = trim(raw);
        if text.is_empty() {
            current = None;
            continue;
        }
        if let Some(comment) = text.strip_prefix('#') {
            current = None;
            if let Some(comment) = text.strip_prefix("#.") {
                row.extracted_comments
                    .push(comment.trim_start_matches(js_space).into());
            } else if let Some(comment) = text.strip_prefix("#:") {
                row.reference_comments
                    .push(comment.trim_start_matches(js_space).into());
            } else if let Some(comment) = text.strip_prefix("#,") {
                row.flags.extend(
                    comment
                        .split(',')
                        .map(trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from),
                );
            } else if text.starts_with("#|") {
                row.previous_msgid_lines.push((*raw).into());
            } else if text == "#" || text.starts_with("# ") {
                row.translator_comments
                    .push(comment.strip_prefix(' ').unwrap_or(comment).into());
            }
            continue;
        }
        if text.starts_with('"') {
            let i: usize = current.ok_or_else(|| malformed(file, line))?;
            fields[i].raw.push_str(&quoted(text, file, line)?);
            continue;
        }
        let name_end = text
            .find(|c: char| c == '[' || js_space(c))
            .unwrap_or(text.len());
        let name = &text[..name_end];
        if !matches!(name, "msgctxt" | "msgid_plural" | "msgid" | "msgstr") {
            return Err(malformed(file, line));
        }
        let mut rest = &text[name_end..];
        let mut field_index = None;
        if rest.starts_with('[') {
            let end = rest.find(']').ok_or_else(|| malformed(file, line))?;
            let digits = &rest[1..end];
            if name != "msgstr" || digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit())
            {
                return Err(malformed(file, line));
            }
            let number = digits.parse::<u64>().map_err(|_| malformed(file, line))?;
            if number > 9_007_199_254_740_991 {
                return Err(malformed(file, line));
            }
            field_index = Some(number);
            rest = &rest[end + 1..];
        }
        if !rest.starts_with(js_space) {
            return Err(malformed(file, line));
        }
        if fields
            .iter()
            .any(|f| f.name == name && f.index.unwrap_or(0) == field_index.unwrap_or(0))
        {
            return Err(malformed(file, line));
        }
        fields.push(Field {
            name: name.into(),
            index: field_index,
            raw: quoted(rest.trim_start_matches(js_space), file, line)?,
            line,
        });
        current = Some(fields.len() - 1);
    }
    if fields.is_empty() {
        return Ok(None);
    }
    let id = fields.iter().find(|f| f.name == "msgid");
    if id.is_none() || !fields.iter().any(|f| f.name == "msgstr") {
        return Err(malformed(file, fields[0].line));
    }
    let id = id.ok_or_else(|| malformed(file, offset + 1))?;
    row.msgid = decode(&id.raw);
    for field in &fields {
        match field.name.as_str() {
            "msgctxt" => row.msgctxt = Some(decode(&field.raw)),
            "msgid_plural" => row.msgid_plural = Some(decode(&field.raw)),
            "msgstr" => {
                row.msgstr
                    .insert(field.index.unwrap_or(0), decode(&field.raw));
            }
            _ => {}
        }
    }
    let header = id.raw.is_empty() && row.msgctxt.is_none() && row.msgid_plural.is_none();
    Ok(Some((header, row)))
}
fn starts_keyword(text: &str, names: &[&str]) -> bool {
    names.iter().any(|name| {
        text.strip_prefix(name)
            .is_some_and(|rest| rest.starts_with(js_space))
    })
}
fn translation(text: &str) -> bool {
    if starts_keyword(text, &["msgstr"]) {
        return true;
    }
    text.strip_prefix("msgstr[")
        .and_then(|v| v.split_once(']'))
        .is_some_and(|(digits, rest)| {
            !digits.is_empty()
                && digits.bytes().all(|c| c.is_ascii_digit())
                && rest.starts_with(js_space)
        })
}
fn crowdin(header: &str) -> bool {
    // packages/localization/src/po.ts:378: the header marker is case insensitive and multiline.
    std::iter::once(0)
        .chain(header.char_indices().filter_map(|(i, c)| {
            matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}').then_some(i + c.len_utf8())
        }))
        .any(|i| {
            let line = &header[i..];
            if !line
                .get(..20)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("X-Crowdin-SourceKey:"))
            {
                return false;
            }
            let rest = line[20..].trim_start_matches(js_space);
            if !rest
                .get(..6)
                .is_some_and(|word| word.eq_ignore_ascii_case("msgstr"))
            {
                return false;
            }
            rest[6..]
                .chars()
                .take_while(|c| !matches!(c, '\r' | '\n' | '\u{2028}' | '\u{2029}'))
                .all(js_space)
        })
}

pub struct PoDocument {
    pub rows: Vec<PoRow>,
    pub format: String,
}

pub fn parse_po(text: &str, file: &str, options: &Options, limits: &Limits) -> Parsed<PoDocument> {
    let mut rows = Vec::new();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut line = 0;
    let mut first = 0;
    let mut finished = false;
    let mut blank = false;
    let mut bytes = 0;
    let mut blocks = 0;
    let mut format = options.po_format.clone().unwrap_or_else(|| "Unreal".into());
    let mut header_seen = false;
    let mut unresolved = 0;
    let consume = |lines: &[(&str, &str)],
                   first: usize,
                   rows: &mut Vec<PoRow>,
                   format: &mut String,
                   header_seen: &mut bool,
                   unresolved: &mut usize|
     -> Parsed<()> {
        if let Some((header, mut row)) = block(lines, first, file)? {
            if header {
                if !*header_seen {
                    *header_seen = true;
                    *unresolved = rows.len();
                    if options.po_format.is_none()
                        && crowdin(row.msgstr.get(&0).map_or("", String::as_str))
                    {
                        *format = "Crowdin".into();
                    }
                }
            } else {
                if rows.len() >= limits.max_entries {
                    return Err(failure(file, "limit_exceeded", ""));
                }
                let keyed = format == "Crowdin"
                    && options
                        .collapse_mode
                        .as_deref()
                        .unwrap_or("IdenticalTextIdAndSource")
                        == "IdenticalTextIdAndSource";
                row.identity = if keyed {
                    Some(identity(&row.msgid))
                } else {
                    row.msgctxt.as_deref().map(identity)
                };
                row.initial_identity = row.identity.clone().unwrap_or_else(|| identity(""));
                rows.push(row);
            }
        }
        Ok(())
    };
    // packages/game-text/src/localization-stream.ts:391-467: CR/LF only, with trivia in blocks.
    while start < text.len() {
        let end = text[start..]
            .find(['\r', '\n'])
            .map_or(text.len(), |i| start + i);
        let mut next = if end < text.len() { end + 1 } else { end };
        if text.as_bytes().get(end) == Some(&b'\r') && text.as_bytes().get(next) == Some(&b'\n') {
            next += 1;
        }
        let raw = &text[start..end];
        let ending = &text[end..next];
        let t = trim(raw);
        if !t.is_empty()
            && (blank
                || (finished && (t.starts_with('#') || starts_keyword(t, &["msgctxt", "msgid"]))))
            && !lines.is_empty()
        {
            blocks += 1;
            if blocks > limits.max_entries {
                return Err(failure(
                    file,
                    "limit_exceeded",
                    &format!(" at line {}", first + 1),
                ));
            }
            consume(
                &lines,
                first,
                &mut rows,
                &mut format,
                &mut header_seen,
                &mut unresolved,
            )?;
            lines.clear();
            bytes = 0;
            first = line;
            finished = false;
        }
        lines.push((raw, ending));
        bytes += (raw.encode_utf16().count() + ending.len()) * 2;
        if bytes > limits.max_record_bytes {
            return Err(failure(
                file,
                "limit_exceeded",
                &format!(" at line {}", first + 1),
            ));
        }
        blank = t.is_empty();
        if translation(t) {
            finished = true;
        }
        line += 1;
        start = next;
    }
    if !lines.is_empty() {
        blocks += 1;
        if blocks > limits.max_entries {
            return Err(failure(
                file,
                "limit_exceeded",
                &format!(" at line {}", first + 1),
            ));
        }
        consume(
            &lines,
            first,
            &mut rows,
            &mut format,
            &mut header_seen,
            &mut unresolved,
        )?;
    }
    if options.po_format.is_none()
        && format == "Crowdin"
        && options
            .collapse_mode
            .as_deref()
            .unwrap_or("IdenticalTextIdAndSource")
            == "IdenticalTextIdAndSource"
    {
        for row in rows.iter_mut().take(unresolved) {
            row.identity = Some(identity(&row.msgid));
        }
    }
    Ok(PoDocument { rows, format })
}
