//! Authored localization input. Grammar and retained rows follow the TypeScript importer.
pub mod columns;
pub mod import;
mod json;
mod po;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationFormat"))]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Manifest,
    Archive,
    Po,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationOptions"))]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub format: Format,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub po_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapse_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationLimits"))]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    #[cfg_attr(test, ts(type = "number"))]
    pub max_file_bytes: u64,
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_files: usize,
    pub max_record_bytes: usize,
    pub max_identity_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_file_bytes: 16 * 1024 * 1024 * 1024,
            max_entries: 4_000_000,
            max_depth: 64,
            max_files: 2560,
            max_record_bytes: 4 * 1024 * 1024,
            max_identity_bytes: 512 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "LocalizationDiagnostic"))]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
    pub recovery: String,
    pub retry_safe: bool,
    pub next_step: String,
}
pub type Parsed<T> = std::result::Result<T, Diagnostic>;

pub fn failure(file: &str, code: &str, location: &str) -> Diagnostic {
    Diagnostic {
        code: code.into(),
        message: if code == "file_changed" {
            format!("{file}{location}: file changed during import; retry after writing finishes.")
        } else {
            format!("{file}{location}: localization import failed ({code}).")
        },
        recovery: match code {
            "limit_exceeded" => "Reduce the input or explicitly increase the localization reader limits.",
            "unsupported_version" => "Use a supported Unreal localization format or update the reader.",
            "file_missing" => "Restore the expected file or generate it through Unreal's localization pipeline.",
            "file_unreadable" => "Check file permissions and ensure the selected evidence is a regular file.",
            "directory_unreadable" => "Choose an existing readable project root and check directory permissions.",
            "unsafe_path" => "Configure evidence paths inside the selected project root without external symlinks.",
            "file_changed" => "Retry after localization processes finish writing the saved evidence.",
            "malformed_po" => "Repair the PO syntax with the translation tool, then read the file again.",
            _ => "Check the target configuration and regenerate its evidence through Unreal if needed."
        }.into(),
        retry_safe: true,
        next_step: if code == "file_changed" { "reconcile" } else { "fix_input" }.into(),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JsonRow {
    #[serde(skip)]
    pub ordinal: usize,
    pub namespace: String,
    pub key: String,
    pub source: Text,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<Text>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dev_notes: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Text {
    #[serde(rename = "Text")]
    pub text: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Identity {
    pub namespace: String,
    pub key: String,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PoRow {
    #[serde(skip)]
    pub initial_identity: Identity,
    pub msgid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msgctxt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msgid_plural: Option<String>,
    pub msgstr: IndexMap<u64, String>,
    pub translator_comments: Vec<String>,
    pub extracted_comments: Vec<String>,
    pub reference_comments: Vec<String>,
    pub flags: Vec<String>,
    pub previous_msgid_lines: Vec<String>,
    pub identity: Option<Identity>,
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(super) fn trim(text: &str) -> &str {
    text.trim_matches(js_space)
}
pub fn identity(value: &str) -> Identity {
    // packages/localization/src/po.ts:44-69: only unescaped commas split the identity.
    let mut escaped = false;
    let comma = value.char_indices().find_map(|(i, c)| {
        if escaped {
            escaped = false;
            return None;
        }
        if c == ',' {
            return Some(i);
        }
        if c == '\\' {
            escaped = true;
        }
        None
    });
    let (namespace, key) = comma.map_or((value, ""), |i| (&value[..i], &value[i + 1..]));
    Identity {
        namespace: namespace.replace("\\,", ","),
        key: key.replace("\\,", ","),
    }
}

pub use json::parse_json;
pub use po::parse_po;

pub fn parse_bytes(
    bytes: &[u8],
    file: &str,
    options: &Options,
    limits: &Limits,
) -> Parsed<columns::LocalLayer> {
    parse_bytes_with_chunk(bytes, file, options, limits, 256 * 1024)
}
fn parse_bytes_with_chunk(
    bytes: &[u8],
    file: &str,
    options: &Options,
    limits: &Limits,
    chunk_bytes: usize,
) -> Parsed<columns::LocalLayer> {
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err(failure(file, "limit_exceeded", ""));
    }
    // packages/game-text/src/localization-import.ts:447-465: PO is always UTF-8, even by BOM.
    let utf16 = options.format != Format::Po && bytes.starts_with(&[255, 254]);
    let prefix = if utf16 {
        2
    } else if bytes.starts_with(&[239, 187, 191]) {
        3
    } else {
        0
    };
    let mut pending = Vec::<u8>::new();
    let mut chunks = Vec::new();
    let mut decode = |value: &[u8], final_chunk: bool, size: usize| -> Parsed<()> {
        pending.extend_from_slice(value);
        let invalid = || failure(file, "invalid_encoding", &format!(" at byte offset {size}"));
        let (text, consumed) = if utf16 {
            let mut complete = pending.len() / 2 * 2;
            if complete >= 2
                && (0xd800..=0xdbff).contains(&u16::from_le_bytes([
                    pending[complete - 2],
                    pending[complete - 1],
                ]))
            {
                complete -= 2;
            }
            let units = pending[..complete]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes(*b))
                .collect::<Vec<_>>();
            (String::from_utf16(&units).map_err(|_| invalid())?, complete)
        } else {
            match std::str::from_utf8(&pending) {
                Ok(text) => (text.to_owned(), pending.len()),
                Err(error) if error.error_len().is_none() => (
                    std::str::from_utf8(&pending[..error.valid_up_to()])
                        .map_err(|_| invalid())?
                        .to_owned(),
                    error.valid_up_to(),
                ),
                Err(_) => return Err(invalid()),
            }
        };
        pending.drain(..consumed);
        if final_chunk && !pending.is_empty() {
            return Err(invalid());
        }
        chunks.push(if options.format == Format::Po {
            crate::wtf8::Wtf8Buf::from_utf8(&text).into_view()
        } else {
            text
        });
        Ok(())
    };
    let prefix_size = bytes.len().min(3);
    decode(
        &bytes[prefix..prefix_size],
        false,
        bytes
            .len()
            .min(prefix_size.div_ceil(chunk_bytes) * chunk_bytes),
    )?;
    for (i, chunk) in bytes.chunks(chunk_bytes).enumerate() {
        let start = i * chunk_bytes;
        if start + chunk.len() < prefix_size {
            continue;
        }
        let offset = prefix_size.saturating_sub(start);
        decode(
            &chunk[offset..],
            false,
            ((i + 1) * chunk_bytes).min(bytes.len()),
        )?;
    }
    decode(&[], true, bytes.len())?;
    columns::parse_columns(&chunks, file, options, limits)
}

#[cfg(test)]
mod tests;
