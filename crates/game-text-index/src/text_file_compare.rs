//! Two revisions of one localization file: which keys came, went, moved and changed (Plan 061).
//!
//! Both files are read with the localization import's parsers. Entries pair by identity, then by
//! occurrence of a repeated identity. An entry removed under one key and added under another with
//! the same source text is a rekey when that text is the only one of its kind among both the
//! removed and the added. Changes keep the newer file's order, each removed entry placed before
//! the next entry that followed it in the older file.
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::localization::{Format, Limits, Options, parse_json, parse_po};
use crate::package_text_contract::{PageRequest, PointChangeCounts, PointChangeKind};
use crate::point_compare::MAX_PAGE;
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};

/// One side of the comparison: a revision of the file, fetched to disk by the host.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileSide {
    /// The file on disk.
    #[cfg_attr(test, ts(type = "string"))]
    pub file: PathBuf,
    /// The name it is reported under, such as its depot path and revision.
    pub path: String,
}

/// Two revisions of one localization file. A side is absent when the file was added or deleted.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompareTextFilesRequest {
    pub options: Options,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub before: Option<TextFileSide>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub after: Option<TextFileSide>,
    pub changes: PageRequest,
}

/// What a compared field holds. Hosts label them.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum TextFileFieldName {
    Source,
    /// A PO entry's `msgid_plural`.
    SourcePlural,
    Translation,
    /// A manifest context's path.
    Path,
    /// A PO entry's extracted comments, where Unreal writes the key and its notes.
    Notes,
    /// A PO entry's translator comments.
    Comments,
    /// A PO entry's reference comments.
    References,
    Flags,
}

/// One field of an entry, on each side that has it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileField {
    pub name: TextFileFieldName,
    /// The PO plural form of a translation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub form: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub after: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileKey {
    pub namespace: String,
    pub key: String,
}

/// One entry that differs between the revisions, with every field it has on either side, the
/// source first.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileChange {
    pub kind: PointChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub before: Option<TextFileKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub after: Option<TextFileKey>,
    pub fields: Vec<TextFileField>,
}

/// A page of the changes between two revisions, with the counts of all of them.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextFileComparison {
    pub format: Format,
    /// The PO dialect read from the newer side, such as "Crowdin".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub po_format: Option<String>,
    pub counts: PointChangeCounts,
    /// Changes in all pages.
    pub total: u32,
    pub changes: Vec<TextFileChange>,
    /// Whether the comparison was kept from the previous request for the same revisions.
    pub kept: bool,
    pub stage_seconds: BTreeMap<String, f64>,
}

/// An entry as it is compared: its identity, and its non-empty fields in field order.
struct Row {
    key: TextFileKey,
    fields: BTreeMap<(TextFileFieldName, Option<u32>), String>,
}
impl Row {
    fn source(&self) -> Option<&str> {
        self.fields
            .get(&(TextFileFieldName::Source, None))
            .map(String::as_str)
    }
}

struct Compared {
    po_format: Option<String>,
    counts: PointChangeCounts,
    changes: Vec<TextFileChange>,
    stage_seconds: BTreeMap<String, f64>,
}

/// Comparisons kept, so a later page reads no file again. A changelist's review pages through a
/// few files at once.
const KEPT: usize = 8;

/// The latest comparisons and the revisions they were made of, most recent last.
static LATEST: Mutex<Vec<(String, Arc<Compared>)>> = Mutex::new(Vec::new());

pub fn validate(request: &CompareTextFilesRequest) -> Result<()> {
    require(
        request.before.is_some() || request.after.is_some(),
        Error::new(ErrorCode::InvalidInput, "neither side of a file comparison"),
    )?;
    require(
        request.changes.limit <= MAX_PAGE,
        Error::new(ErrorCode::InvalidInput, "a page above its bound"),
    )
}

/// Compares two revisions of a localization file and returns the requested page of changes.
pub fn compare(request: &CompareTextFilesRequest) -> Result<TextFileComparison> {
    let _span = crate::scan_timings::Span::new("text_files.compare");
    validate(request)?;
    let identity = revisions(request)?;
    let kept = LATEST.lock().ok().and_then(|mut latest| {
        let index = latest.iter().position(|(key, _)| *key == identity)?;
        let kept = latest.remove(index);
        let compared = kept.1.clone();
        latest.push(kept);
        Some(compared)
    });
    let (compared, kept) = match kept {
        Some(compared) => (compared, true),
        None => {
            let compared = Arc::new(compare_files(request)?);
            if let Ok(mut latest) = LATEST.lock() {
                latest.push((identity, compared.clone()));
                if latest.len() > KEPT {
                    latest.remove(0);
                }
            }
            (compared, false)
        }
    };
    Ok(TextFileComparison {
        format: request.options.format,
        po_format: compared.po_format.clone(),
        counts: compared.counts.clone(),
        total: compared.changes.len() as u32,
        changes: compared
            .changes
            .iter()
            .skip(request.changes.offset as usize)
            .take(request.changes.limit as usize)
            .cloned()
            .collect(),
        kept,
        stage_seconds: compared.stage_seconds.clone(),
    })
}

/// What names the revisions: the options, and each side's name, file, size and modification time.
fn revisions(request: &CompareTextFilesRequest) -> Result<String> {
    let mut parts = vec![serde_json::to_string(&request.options)?];
    for side in [&request.before, &request.after] {
        parts.push(match side {
            None => "-".into(),
            Some(side) => {
                let metadata = fs::metadata(&side.file)?;
                let modified = metadata
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |time| time.as_nanos());
                format!(
                    "{}|{}|{}|{}",
                    side.path,
                    side.file.display(),
                    metadata.len(),
                    modified
                )
            }
        });
    }
    Ok(parts.join("\0"))
}

fn compare_files(request: &CompareTextFilesRequest) -> Result<Compared> {
    let mut stage_seconds = BTreeMap::new();
    let started = Instant::now();
    let bytes = [&request.before, &request.after].map(|side| {
        side.as_ref()
            .map(|side| fs::read(&side.file).map(|bytes| (side, bytes)))
    });
    let [before, after] = bytes;
    let (before, after) = (before.transpose()?, after.transpose()?);
    stage_seconds.insert("text_files.read".into(), started.elapsed().as_secs_f64());
    let started = Instant::now();
    let parse = |side: Option<(&TextFileSide, Vec<u8>)>| -> Result<(Vec<Row>, Option<String>)> {
        side.map_or(Ok((Vec::new(), None)), |(side, bytes)| {
            rows(&bytes, side, &request.options)
        })
    };
    // Each file can be hundreds of megabytes, and parsing is the whole cost: one thread each.
    let (before, after) = std::thread::scope(|scope| {
        let before = scope.spawn(|| parse(before));
        let after = parse(after);
        (before.join(), after)
    });
    let before = before
        .map_err(|_| Error::new(ErrorCode::Internal, "the older file's parse panicked"))??
        .0;
    let (after, po_format) = after?;
    stage_seconds.insert("text_files.parse".into(), started.elapsed().as_secs_f64());
    let started = Instant::now();
    let (counts, changes) = diff(&before, &after);
    stage_seconds.insert("text_files.diff".into(), started.elapsed().as_secs_f64());
    Ok(Compared {
        po_format,
        counts,
        changes,
        stage_seconds,
    })
}

/// Decodes a localization file as the import does: PO is always UTF-8; JSON is UTF-16
/// little-endian with its BOM, or UTF-8.
fn decode(bytes: &[u8], side: &TextFileSide, format: Format) -> Result<String> {
    if format != Format::Po
        && let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe])
    {
        require(
            rest.len() % 2 == 0,
            format!("{} is not UTF-16", side.path).as_str(),
        )?;
        let units = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        return Ok(String::from_utf16(&units).map_err(|_| format!("{} is not UTF-16", side.path))?);
    }
    let rest = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    Ok(std::str::from_utf8(rest)
        .map_err(|_| format!("{} is not UTF-8", side.path))?
        .to_owned())
}

fn rows(
    bytes: &[u8],
    side: &TextFileSide,
    options: &Options,
) -> Result<(Vec<Row>, Option<String>)> {
    let text = decode(bytes, side, options.format)?;
    let limits = Limits::default();
    let failed = |diagnostic: crate::localization::Diagnostic| {
        Error::new(
            ErrorCode::InvalidInput,
            format!("{}: {}", side.path, diagnostic.message),
        )
    };
    let field = |fields: &mut BTreeMap<_, _>, name, form, value: String| {
        if !value.is_empty() {
            fields.insert((name, form), value);
        }
    };
    if options.format != Format::Po {
        let document = parse_json(&text, &side.path, options.format, &limits).map_err(failed)?;
        let rows = document
            .rows
            .into_iter()
            .map(|row| {
                let mut fields = BTreeMap::new();
                field(
                    &mut fields,
                    TextFileFieldName::Source,
                    None,
                    row.source.text,
                );
                if let Some(translation) = row.translation {
                    field(
                        &mut fields,
                        TextFileFieldName::Translation,
                        None,
                        translation.text,
                    );
                }
                if let Some(path) = row.path {
                    field(&mut fields, TextFileFieldName::Path, None, path);
                }
                Row {
                    key: TextFileKey {
                        namespace: row.namespace,
                        key: row.key,
                    },
                    fields,
                }
            })
            .collect();
        return Ok((rows, None));
    }
    // The PO parser reads WTF-8 views, as the import feeds it; text leaves as UTF-8.
    let view = Wtf8Buf::from_utf8(&text).into_view();
    let document = parse_po(&view, &side.path, options, &limits).map_err(failed)?;
    let shown = |value: String| {
        if value.as_bytes().contains(&0xf3) {
            String::from_utf8_lossy(Wtf8Buf::from_view(&value).as_bytes()).into_owned()
        } else {
            value
        }
    };
    let rows = document
        .rows
        .into_iter()
        .map(|row| {
            let key = match row.identity {
                Some(identity) => TextFileKey {
                    namespace: shown(identity.namespace),
                    key: shown(identity.key),
                },
                // Without a context, a PO entry is its msgid.
                None => TextFileKey {
                    namespace: String::new(),
                    key: shown(row.msgid.clone()),
                },
            };
            let plural = row.msgid_plural.is_some();
            let mut fields = BTreeMap::new();
            field(
                &mut fields,
                TextFileFieldName::Source,
                None,
                shown(row.msgid),
            );
            if let Some(source) = row.msgid_plural {
                field(
                    &mut fields,
                    TextFileFieldName::SourcePlural,
                    None,
                    shown(source),
                );
            }
            for (form, translation) in row.msgstr {
                let form = (plural || form > 0).then_some(form as u32);
                field(
                    &mut fields,
                    TextFileFieldName::Translation,
                    form,
                    shown(translation),
                );
            }
            for (name, lines) in [
                (TextFileFieldName::Notes, row.extracted_comments),
                (TextFileFieldName::Comments, row.translator_comments),
                (TextFileFieldName::References, row.reference_comments),
            ] {
                field(&mut fields, name, None, shown(lines.join("\n")));
            }
            field(
                &mut fields,
                TextFileFieldName::Flags,
                None,
                shown(row.flags.join(", ")),
            );
            Row { key, fields }
        })
        .collect();
    Ok((rows, Some(document.format)))
}

/// Pairs the older and newer rows and lists what differs, in the newer file's order.
fn diff(before: &[Row], after: &[Row]) -> (PointChangeCounts, Vec<TextFileChange>) {
    // Identity, then occurrence: the nth row of a repeated key pairs with the nth.
    let mut seen = HashMap::<&TextFileKey, u32>::new();
    let mut older = HashMap::<(&TextFileKey, u32), usize>::with_capacity(before.len());
    for (index, row) in before.iter().enumerate() {
        let occurrence = seen.entry(&row.key).or_default();
        older.insert((&row.key, *occurrence), index);
        *occurrence += 1;
    }
    seen.clear();
    let mut pairs = vec![None::<usize>; after.len()];
    let mut paired = vec![false; before.len()];
    for (index, row) in after.iter().enumerate() {
        let occurrence = seen.entry(&row.key).or_default();
        if let Some(&old) = older.get(&(&row.key, *occurrence)) {
            pairs[index] = Some(old);
            paired[old] = true;
        }
        *occurrence += 1;
    }
    // A text removed under one key and added under another is a rekey when it is unique there.
    let mut removed = HashMap::<&str, (u32, usize)>::new();
    for (index, row) in before
        .iter()
        .enumerate()
        .filter(|(index, _)| !paired[*index])
    {
        if let Some(source) = row.source() {
            let entry = removed.entry(source).or_insert((0, index));
            entry.0 += 1;
        }
    }
    let mut added = HashMap::<&str, u32>::new();
    for (_, row) in after
        .iter()
        .enumerate()
        .filter(|(index, _)| pairs[*index].is_none())
    {
        if let Some(source) = row.source() {
            *added.entry(source).or_default() += 1;
        }
    }
    let mut rekeys = vec![false; after.len()];
    for (index, row) in after.iter().enumerate() {
        if pairs[index].is_some() {
            continue;
        }
        let Some(source) = row.source() else {
            continue;
        };
        if let (Some(&(1, old)), Some(1)) = (removed.get(source), added.get(source)) {
            pairs[index] = Some(old);
            paired[old] = true;
            rekeys[index] = true;
        }
    }
    let mut counts = PointChangeCounts {
        added: 0,
        removed: 0,
        rekeyed: 0,
        edited: 0,
        unchanged: 0,
    };
    let mut changes = Vec::new();
    let mut gone = (0..before.len()).filter(|index| !paired[*index]).peekable();
    let mut remove_before = |until: usize, counts: &mut PointChangeCounts, changes: &mut Vec<_>| {
        while let Some(index) = gone.next_if(|index| *index < until) {
            counts.removed += 1;
            changes.push(change(PointChangeKind::Removed, Some(&before[index]), None));
        }
    };
    for (index, row) in after.iter().enumerate() {
        match pairs[index] {
            None => {
                counts.added += 1;
                changes.push(change(PointChangeKind::Added, None, Some(row)));
            }
            Some(old) => {
                remove_before(old, &mut counts, &mut changes);
                if rekeys[index] {
                    counts.rekeyed += 1;
                    changes.push(change(
                        PointChangeKind::Rekeyed,
                        Some(&before[old]),
                        Some(row),
                    ));
                } else if before[old].fields != row.fields {
                    counts.edited += 1;
                    changes.push(change(
                        PointChangeKind::Edited,
                        Some(&before[old]),
                        Some(row),
                    ));
                } else {
                    counts.unchanged += 1;
                }
            }
        }
    }
    remove_before(usize::MAX, &mut counts, &mut changes);
    (counts, changes)
}

fn change(kind: PointChangeKind, before: Option<&Row>, after: Option<&Row>) -> TextFileChange {
    let mut fields = BTreeMap::<(TextFileFieldName, Option<u32>), TextFileField>::new();
    for (row, after_side) in [(before, false), (after, true)] {
        for ((name, form), value) in row.map(|row| &row.fields).into_iter().flatten() {
            let field = fields
                .entry((*name, *form))
                .or_insert_with(|| TextFileField {
                    name: *name,
                    form: *form,
                    before: None,
                    after: None,
                });
            if after_side {
                field.after = Some(value.clone());
            } else {
                field.before = Some(value.clone());
            }
        }
    }
    TextFileChange {
        kind,
        before: before.map(|row| row.key.clone()),
        after: after.map(|row| row.key.clone()),
        fields: fields.into_values().collect(),
    }
}

#[cfg(test)]
mod tests;
