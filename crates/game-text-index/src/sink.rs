//! Sinks (Phase 4 §8): the engine encodes exported rows in their file format and writes them to
//! a file, or streams them as `text` frames, so the host never builds the document.
use crate::engine::Reply;
use crate::join_policy::js_space;
use crate::{Error, ErrorCode, Result, require};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
#[cfg(test)]
use ts_rs::TS;

/// The formats a sink encodes, each byte-identical to the host writer it replaces.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(rename = "SinkFormat"))]
#[serde(rename_all = "camelCase")]
pub enum Format {
    /// Browse's CSV: a row per saved place of each selected unit with searchable source.
    CorpusCsv,
    /// A corpus report's units, as `JSON.stringify(document, null, "\t")` writes them inside
    /// the sink's envelope.
    CorpusJson,
    /// The all-languages CSV: a row per line, and per culture its shipped translation and state.
    CultureLinesCsv,
    /// `loc check`'s findings: the elements of the report's `findings` array, as the CLI prints
    /// them. The host writes the report around them.
    FindingJson,
}

/// Where a request's exported rows go, and in what format: a file, or `text` frames when `file`
/// is absent.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Sink {
    pub format: Format,
    /// An absolute path. The file is written beside it and moved into place when complete.
    #[cfg_attr(test, ts(optional))]
    pub file: Option<String>,
    /// Fail with `exists` rather than replace a file already at `file`.
    #[cfg_attr(test, ts(optional))]
    pub exclusive: Option<bool>,
    /// For a JSON array format, the document around the array.
    #[cfg_attr(test, ts(optional))]
    pub envelope: Option<Envelope>,
}

/// A JSON document around a sink's array: the text before it, the text after it, and the
/// array's depth, the tabs before its closing bracket.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub before: String,
    pub after: String,
    #[cfg_attr(test, ts(type = "number"))]
    pub depth: usize,
}

/// Writes a JSON array's elements inside an envelope, as `JSON.stringify(document, null, "\t")`
/// writes them: `[]` when empty, else each element on its own line one tab deeper.
pub(crate) struct JsonArray<'s, 'a> {
    sink: &'s mut SinkWriter<'a>,
    depth: usize,
    after: &'s str,
    out: Vec<u8>,
}

impl<'s, 'a> JsonArray<'s, 'a> {
    pub fn open(sink: &'s mut SinkWriter<'a>, envelope: &'s Envelope) -> Result<Self> {
        sink.write(envelope.before.as_bytes())?;
        sink.write(b"[")?;
        Ok(Self {
            sink,
            depth: envelope.depth,
            after: &envelope.after,
            out: Vec::new(),
        })
    }

    pub fn push(&mut self, element: &serde_json::Value) -> Result<()> {
        self.out.clear();
        if self.sink.rows() > 0 {
            self.out.push(b',');
        }
        self.out.push(b'\n');
        self.out.resize(self.out.len() + self.depth + 1, b'\t');
        pretty_json(element, self.depth + 1, &mut self.out);
        self.sink.write(&self.out)?;
        self.sink.row();
        Ok(())
    }

    pub fn close(self) -> Result<()> {
        if self.sink.rows() > 0 {
            self.sink.write(b"\n")?;
            self.sink.write(&vec![b'\t'; self.depth])?;
        }
        self.sink.write(b"]")?;
        self.sink.write(self.after.as_bytes())
    }
}

/// What a sink wrote: the request's part.
#[derive(Clone, Copy, Debug, Serialize)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct SinkSummary {
    /// Rows written, not counting a header.
    pub rows: u32,
    #[cfg_attr(test, ts(type = "number"))]
    pub bytes: u64,
}

/// The bytes one `text` frame carries.
const TEXT_FRAME: usize = 1 << 20;

enum Target<'a> {
    File {
        writer: BufWriter<File>,
        partial: PathBuf,
        path: PathBuf,
        exclusive: bool,
    },
    Stream(&'a mut dyn Reply),
    /// The sink finished.
    Done,
}

/// Writes encoded rows to a sink's file, or in `text` frames that each wait for a credit.
pub struct SinkWriter<'a> {
    target: Target<'a>,
    buffer: Vec<u8>,
    rows: u32,
    bytes: u64,
}

impl<'a> SinkWriter<'a> {
    pub fn open(sink: &Sink, reply: &'a mut dyn Reply) -> Result<Self> {
        let target = match &sink.file {
            None => Target::Stream(reply),
            Some(path) => {
                let path = PathBuf::from(path);
                require(
                    path.is_absolute() && path.file_name().is_some(),
                    crate::engine_types::invalid("A sink file is an absolute file path."),
                )?;
                let exclusive = sink.exclusive == Some(true);
                require(!exclusive || !path.exists(), exists(&path))?;
                let mut name = path.file_name().unwrap_or_default().to_owned();
                name.push(format!(".{}.partial", std::process::id()));
                let partial = path.with_file_name(name);
                let file = File::create(&partial).map_err(|source| {
                    Error::with_source(
                        ErrorCode::Io,
                        format!("The sink file {} could not be created.", path.display()),
                        source,
                    )
                })?;
                Target::File {
                    writer: BufWriter::with_capacity(TEXT_FRAME, file),
                    partial,
                    path,
                    exclusive,
                }
            }
        };
        Ok(Self {
            target,
            buffer: Vec::with_capacity(TEXT_FRAME),
            rows: 0,
            bytes: 0,
        })
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() >= TEXT_FRAME {
            self.flush()?;
        }
        Ok(())
    }

    /// Counts a written row.
    pub fn row(&mut self) {
        self.rows += 1;
    }

    /// Rows written so far.
    pub fn rows(&self) -> u32 {
        self.rows
    }

    fn flush(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        self.bytes += self.buffer.len() as u64;
        match &mut self.target {
            Target::File { writer, .. } => {
                writer.write_all(&self.buffer).map_err(written)?;
                self.buffer.clear();
            }
            Target::Stream(reply) => {
                let body = std::mem::replace(&mut self.buffer, Vec::with_capacity(TEXT_FRAME));
                reply.text(body)?;
            }
            Target::Done => return Err("A finished sink was written to.".into()),
        }
        Ok(())
    }

    /// Writes what is buffered and, for a file, moves it into place.
    pub fn finish(mut self) -> Result<SinkSummary> {
        self.flush()?;
        if let Target::File {
            writer,
            partial,
            path,
            exclusive,
        } = std::mem::replace(&mut self.target, Target::Done)
        {
            let placed = (|| {
                let file = writer
                    .into_inner()
                    .map_err(|error| written(error.into_error()))?;
                file.sync_all().map_err(written)?;
                drop(file);
                if exclusive {
                    // A link fails when the name is taken, where a rename would replace it.
                    std::fs::hard_link(&partial, &path).map_err(|source| {
                        if source.kind() == std::io::ErrorKind::AlreadyExists {
                            exists(&path)
                        } else {
                            written(source)
                        }
                    })
                } else {
                    std::fs::rename(&partial, &path).map_err(written)
                }
            })();
            let _ = std::fs::remove_file(&partial);
            placed?;
        }
        Ok(SinkSummary {
            rows: self.rows,
            bytes: self.bytes,
        })
    }
}

impl Drop for SinkWriter<'_> {
    /// A sink that didn't finish leaves no partial file behind.
    fn drop(&mut self) {
        if let Target::File { partial, .. } = &self.target {
            let _ = std::fs::remove_file(partial);
        }
    }
}

fn written(source: std::io::Error) -> Error {
    Error::with_source(ErrorCode::Io, "The sink file could not be written.", source)
}

fn exists(path: &std::path::Path) -> Error {
    Error::new(
        ErrorCode::Exists,
        format!("The sink file {} already exists.", path.display()),
    )
}

/// A host string as UTF-8: lone UTF-16 code units become U+FFFD, as `TextEncoder` writes them.
pub(crate) fn utf8(view: &str) -> std::borrow::Cow<'_, str> {
    if view.as_bytes().contains(&0xf3) {
        let units = crate::wtf8::Wtf8Buf::from_view(view).to_utf16();
        std::borrow::Cow::Owned(String::from_utf16_lossy(&units))
    } else {
        std::borrow::Cow::Borrowed(view)
    }
}

/// `JSON.stringify(value, null, "\t")`, as nested `depth` tabs deep: members in a JavaScript
/// object's order, array indices first, and strings and numbers as JavaScript writes them.
pub(crate) fn pretty_json(value: &serde_json::Value, depth: usize, out: &mut Vec<u8>) {
    use serde_json::Value;
    let indent = |out: &mut Vec<u8>, depth: usize| {
        out.push(b'\n');
        out.resize(out.len() + depth, b'\t');
    };
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                indent(out, depth + 1);
                pretty_json(item, depth + 1, out);
            }
            indent(out, depth);
            out.push(b']');
        }
        Value::Object(members) if !members.is_empty() => {
            // An object's integer-like keys come first, ascending; the rest keep their order.
            let index = |key: &str| {
                (key == "0" || !key.starts_with('0'))
                    .then(|| key.parse::<u32>().ok())
                    .flatten()
                    .filter(|index| *index != u32::MAX && index.to_string() == key)
            };
            let mut keys = members.keys().collect::<Vec<_>>();
            keys.sort_by_key(|key| index(key).map_or((1, 0), |index| (0, index)));
            out.push(b'{');
            for (at, key) in keys.into_iter().enumerate() {
                if at > 0 {
                    out.push(b',');
                }
                indent(out, depth + 1);
                out.extend_from_slice(
                    crate::wtf8::Wtf8Buf::from_view(key)
                        .json_string()
                        .as_bytes(),
                );
                out.extend_from_slice(b": ");
                pretty_json(&members[key], depth + 1, out);
            }
            indent(out, depth);
            out.push(b'}');
        }
        _ => out.extend_from_slice(crate::rules::javascript_json(value, false).as_bytes()),
    }
}

/// One cell of a spreadsheet row.
pub(crate) enum Cell<'a> {
    Text(&'a str),
}

/// The spreadsheet CSV hosts export: a byte-order mark, every cell quoted, formula protection
/// before leading whitespace, and CRLF after every row.
pub(crate) struct Spreadsheet;
impl Spreadsheet {
    pub const BOM: &'static [u8] = "\u{feff}".as_bytes();

    pub fn row(out: &mut Vec<u8>, cells: &[Cell]) {
        for (index, cell) in cells.iter().enumerate() {
            if index > 0 {
                out.push(b',');
            }
            out.push(b'"');
            match cell {
                Cell::Text(text) => {
                    let text = utf8(text);
                    if text
                        .trim_start_matches(js_space)
                        .starts_with(['=', '+', '-', '@'])
                    {
                        out.push(b'\'');
                    }
                    for (at, part) in text.split('"').enumerate() {
                        if at > 0 {
                            out.extend_from_slice(b"\"\"");
                        }
                        out.extend_from_slice(part.as_bytes());
                    }
                }
            }
            out.push(b'"');
        }
        out.extend_from_slice(b"\r\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreadsheet_cells_are_quoted_protected_and_crlf_terminated() {
        let mut out = Vec::new();
        Spreadsheet::row(
            &mut out,
            &[
                Cell::Text("plain"),
                Cell::Text("say \"hi\""),
                Cell::Text(" \u{a0}=SUM(A1)"),
                Cell::Text("-1"),
                Cell::Text("a-b"),
            ],
        );
        assert_eq!(
            String::from_utf8_lossy(&out),
            "\"plain\",\"say \"\"hi\"\"\",\"' \u{a0}=SUM(A1)\",\"'-1\",\"a-b\"\r\n"
        );
        let lone = crate::wtf8::Wtf8Buf::from_utf16(&[0x61, 0xd800]).into_view();
        assert_eq!(utf8(&lone), "a\u{fffd}");
    }

    #[test]
    fn pretty_json_writes_what_javascripts_tab_indented_stringify_does() {
        let lone = crate::wtf8::Wtf8Buf::from_utf16(&[0x61, 0xd800]).into_view();
        let value = serde_json::json!({
            "b": [1, 0.1, 1e21, -0.0, "\u{2028}", lone],
            "10": {},
            "a": [],
            "2": {"x": null, "y": [true]},
            "01": false
        });
        let mut out = Vec::new();
        pretty_json(&value, 1, &mut out);
        assert_eq!(
            String::from_utf8_lossy(&out),
            "{\n\t\t\"2\": {\n\t\t\t\"x\": null,\n\t\t\t\"y\": [\n\t\t\t\ttrue\n\t\t\t]\n\t\t},\n\t\t\"10\": {},\n\t\t\"b\": [\n\t\t\t1,\n\t\t\t0.1,\n\t\t\t1e+21,\n\t\t\t0,\n\t\t\t\"\u{2028}\",\n\t\t\t\"a\\ud800\"\n\t\t],\n\t\t\"a\": [],\n\t\t\"01\": false\n\t}"
        );
    }
}
