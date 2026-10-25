//! Explicit bulk exports stream directly from the native snapshot to a caller-owned file.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::SearchRequest;
use crate::{Result, require};
use serde_json::{Value, json};
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::{Arc, atomic::AtomicBool};

fn value(output: &mut impl Write, value: &Value) -> Result<()> {
    #[cfg(feature = "benchmark-timings")]
    let encoding = crate::benchmark_timings::Span::new("bulkEncode");
    let text = crate::wtf8::view_json(value)?;
    #[cfg(feature = "benchmark-timings")]
    drop(encoding);
    #[cfg(feature = "benchmark-timings")]
    let _write = crate::benchmark_timings::Span::new("bulkBufferedWrite");
    output.write_all(text.as_bytes())?;
    Ok(())
}
fn separator(output: &mut impl Write, first: &mut bool) -> Result<()> {
    if !*first {
        output.write_all(b",")?;
    }
    *first = false;
    Ok(())
}
impl EngineQuery {
    pub fn export_localization_focus_to_path(
        &self,
        payload: &str,
        path: &Path,
        cancelled: &AtomicBool,
    ) -> Result<u64> {
        // Full provenance is an explicit bulk read, independent of the bounded interactive detail.
        let text = self.localization_focus_json(payload, cancelled)?;
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        let mut output = BufWriter::new(file);
        let result = (|| -> Result<u64> {
            checkpoint(cancelled)?;
            output.write_all(text.as_bytes())?;
            output.flush()?;
            Ok(output.get_ref().metadata()?.len())
        })();
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }
    pub fn export_localization_to_path(
        &self,
        request: &SearchRequest,
        path: &Path,
        include_invisible: bool,
        fields: Option<&[&str]>,
        cancelled: &AtomicBool,
    ) -> Result<u64> {
        require(
            include_invisible || request.localization.is_some(),
            crate::engine_types::invalid("Localization export requires a selected target."),
        )?;
        let rows = if include_invisible {
            Projection::open(self, cancelled)?.order.clone()
        } else {
            self.matching(request, cancelled)?
        };
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        let mut output = BufWriter::new(file);
        let result = (|| -> Result<u64> {
            output.write_all(b"[")?;
            let mut first = true;
            let scope = self.culture_scope(request.localization.as_ref())?;
            let findings = self.request_findings(request, cancelled)?;
            for row in rows.iter() {
                checkpoint(cancelled)?;
                separator(&mut output, &mut first)?;
                let line = match fields {
                    Some(fields) => self.localization_line_fields(
                        *row as usize,
                        fields,
                        &scope,
                        findings.as_deref(),
                        cancelled,
                    )?,
                    None => self.localization_line(*row as usize, cancelled)?,
                };
                value(&mut output, &line)?;
            }
            output.write_all(b"]")?;
            #[cfg(feature = "benchmark-timings")]
            let _flush = crate::benchmark_timings::Span::new("bulkFlush");
            output.flush()?;
            Ok(output.get_ref().metadata()?.len())
        })();
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }
    pub fn export_to_path(
        &self,
        request: &SearchRequest,
        path: &Path,
        include_invisible: bool,
        units: Option<&[String]>,
        cancelled: &AtomicBool,
    ) -> Result<u64> {
        request.validate()?;
        checkpoint(cancelled)?;
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        let mut output = BufWriter::new(file);
        let result = self
            .write_corpus(request, &mut output, include_invisible, units, cancelled)
            .and_then(|()| {
                output.flush()?;
                Ok(output.get_ref().metadata()?.len())
            });
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }
    fn package_coordinates(&self) -> Result<Vec<usize>> {
        let mut starts = vec![0usize];
        for shard in 0..self.package_count() {
            let length = self.package_column(shard, "package.status")?.len();
            starts.push(
                starts
                    .last()
                    .copied()
                    .unwrap_or(0)
                    .checked_add(length)
                    .ok_or("Package count overflow.")?,
            );
        }
        Ok(starts)
    }
    pub(crate) fn package_file(&self, shard: usize, row: usize) -> Result<String> {
        let paths = self.package_column(shard, "package.path")?;
        let id = *paths.get(row).ok_or("Package row outside paths.")?;
        let path = self.reader.string(id)?;
        let project = self.reader.meta["input"]["projectRoot"]
            .as_str()
            .ok_or("Missing project identity.")?;
        Ok(crate::join_policy::relative_package(project, &path))
    }
    fn write_corpus(
        &self,
        request: &SearchRequest,
        output: &mut impl Write,
        include_invisible: bool,
        units: Option<&[String]>,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let matched = if include_invisible || units.is_some() {
            Arc::from([])
        } else {
            self.matching(request, cancelled)?
        };
        let p = Projection::open(self, cancelled)?;
        let mut chosen = vec![include_invisible; p.raw.visible.len()];
        if let Some(units) = units {
            for unit in units {
                checkpoint(cancelled)?;
                if let Some(row) = self.find_id("raw", unit)? {
                    chosen[row] = true;
                }
            }
        } else if request.localization.is_some() {
            let raw = self.column("slice", "raw")?;
            require(
                raw.len() == p.slice.visible.len(),
                "Invalid export slice projection.",
            )?;
            for (index, row) in matched.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let row = *row as usize;
                for sr in p.starts[row] as usize..p.starts[row + 1] as usize {
                    *chosen
                        .get_mut(raw[sr] as usize)
                        .ok_or("Export unit outside corpus.")? = true;
                }
            }
        } else {
            for row in matched.iter() {
                chosen[*row as usize] = true;
            }
        }
        let summary = self.summary(cancelled)?;
        // With a findings layer each unit lists its rules, and the file their labels once.
        let findings = match &request.findings {
            Some(selection) => {
                let every = self.culture_scope(None)?;
                Some(self.finding_rows(selection, false, &every, cancelled)?)
            }
            None => None,
        };
        output.write_all(b"{\"schemaVersion\":1,\"status\":")?;
        value(output, &summary["status"])?;
        output.write_all(b",\"coverage\":")?;
        value(output, &summary["coverage"])?;
        if let Some(findings) = &findings {
            output.write_all(b",\"findingRules\":")?;
            value(
                output,
                &serde_json::json!(
                    findings
                        .rules
                        .iter()
                        .map(|rule| serde_json::json!({"id":rule.id,"label":rule.label}))
                        .collect::<Vec<_>>()
                ),
            )?;
        }
        output.write_all(b",\"units\":[")?;
        let mut first = true;
        for (index, row) in p.raw.order.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            if !chosen[row] {
                continue;
            }
            separator(output, &mut first)?;
            let presentation = self.presentation("raw", row)?;
            output.write_all(b"{\"id\":")?;
            value(output, &presentation["id"])?;
            output.write_all(b",\"identity\":")?;
            value(output, &presentation["identity"])?;
            output.write_all(b",\"source\":")?;
            value(output, &presentation["source"])?;
            output.write_all(b",\"reviewSignals\":")?;
            value(output, &presentation["reviewSignals"])?;
            if let Some(findings) = &findings {
                let mut listed = serde_json::json!({});
                crate::engine_search::list_findings(&mut listed, findings, row);
                output.write_all(b",\"findings\":")?;
                value(output, &listed["findings"])?;
                output.write_all(b",\"findingsOmitted\":")?;
                value(output, &listed["findingsOmitted"])?;
            }
            output.write_all(b",\"occurrences\":[")?;
            let mut first_occurrence = true;
            for member in p.raw.members(row) {
                checkpoint(cancelled)?;
                separator(output, &mut first_occurrence)?;
                value(output, &self.occurrence(*member as usize, cancelled)?)?;
            }
            output.write_all(b"]}")?;
        }
        let lists = self.package_lists(cancelled)?;
        let (coverage, diagnostics) = (&lists.0, &lists.1);
        output.write_all(b"],\"packageCoverage\":[")?;
        let mut first = true;
        for item in coverage {
            separator(output, &mut first)?;
            value(output, item)?;
        }
        output.write_all(b"],\"diagnostics\":[")?;
        let mut first = true;
        for diagnostic in diagnostics {
            separator(output, &mut first)?;
            value(output, diagnostic)?;
        }
        output.write_all(b"]}")?;
        checkpoint(cancelled)?;
        Ok(())
    }

    /// Package coverage, excluded packages last, and diagnostics, failures first: the corpus's
    /// package lists in export order. A reader's generation never changes, so they are read once.
    fn package_lists(&self, cancelled: &AtomicBool) -> Result<Arc<(Vec<Value>, Vec<Value>)>> {
        self.package_lists
            .get_or_try(|| Ok(Arc::new(self.read_package_lists(cancelled)?)))
    }
    fn read_package_lists(&self, cancelled: &AtomicBool) -> Result<(Vec<Value>, Vec<Value>)> {
        let order = self.reader.column("query.package.order")?;
        let starts = self.package_coordinates()?;
        let locate = |global: u32| -> Result<(usize, usize)> {
            let shard = starts
                .partition_point(|start| *start <= global as usize)
                .checked_sub(1)
                .ok_or("Package order precedes corpus.")?;
            require(
                shard + 1 < starts.len() && (global as usize) < starts[shard + 1],
                "Package order exceeds corpus.",
            )?;
            Ok((shard, global as usize - starts[shard]))
        };
        // Each package's file, its path decoded once with the others in dictionary order: a
        // lookup per package decoded a whole dictionary block and missed the block cache.
        let mut path_ids = Vec::with_capacity(order.len());
        for global in order.iter() {
            let (shard, row) = locate(*global)?;
            let paths = self.package_column(shard, "package.path")?;
            path_ids.push(*paths.get(row).ok_or("Package row outside paths.")?);
        }
        let project = self.reader.meta["input"]["projectRoot"]
            .as_str()
            .ok_or("Missing project identity.")?
            .to_owned();
        let files = self
            .reader
            .strings_batch(&path_ids)?
            .iter()
            .map(|path| crate::join_policy::relative_package(&project, path))
            .collect::<Vec<_>>();
        let mut coverage = Vec::new();
        for excluded in [false, true] {
            for (index, global) in order.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let (shard, row) = locate(*global)?;
                let status = self.package_value(shard, "package.status", row)?;
                if (status == 2) != excluded {
                    continue;
                }
                let status = ["complete", "partial", "not_gatherable", "failed"]
                    .get(status as usize)
                    .ok_or("Unknown exported package status.")?;
                coverage.push(json!({"packageFile":files[index],"status":status}));
            }
        }
        let mut diagnostics = Vec::new();
        for wanted in [3, 1, 2] {
            for (index, global) in order.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let (shard, row) = locate(*global)?;
                if self.package_value(shard, "package.status", row)? != wanted {
                    continue;
                }
                let path = files[index].clone();
                match wanted {
                    1 => diagnostics.extend(self.package_diagnostics(
                        shard,
                        row,
                        &path,
                        usize::MAX,
                        cancelled,
                    )?),
                    2 => diagnostics.push(
                        json!({"code":"package_not_gatherable","packageFile":path,"message":"Excluded because Unreal does not gather this package. Its text payload was not inspected."}),
                    ),
                    3 => {
                        let id = self.package_value(shard, "package.error", row)?;
                        let text = self.reader.string(id)?;
                        let error = crate::json_value::parse_stored(&text)?;
                        require(
                            error["message"].is_string(),
                            "Missing package failure message.",
                        )?;
                        diagnostics.push(
                            json!({"code":"package_inspection_failed","packageFile":path,"message":error["message"]}),
                        );
                    }
                    _ => return Err("Invalid export diagnostic status.".into()),
                }
            }
        }
        Ok((coverage, diagnostics))
    }
    /// The corpus without its units: status, coverage, package coverage and diagnostics.
    pub fn export_corpus_header_to_path(&self, path: &Path, cancelled: &AtomicBool) -> Result<u64> {
        let summary = self.summary(cancelled)?;
        let lists = self.package_lists(cancelled)?;
        let (coverage, diagnostics) = (&lists.0, &lists.1);
        let header = json!({"schemaVersion":1,"status":summary["status"],"coverage":summary["coverage"],"units":[],"packageCoverage":coverage,"diagnostics":diagnostics});
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        let mut output = BufWriter::new(file);
        let result = (|| -> Result<u64> {
            value(&mut output, &header)?;
            output.flush()?;
            Ok(output.get_ref().metadata()?.len())
        })();
        drop(output);
        if result.is_err() {
            let _ = std::fs::remove_file(path);
        }
        result
    }
    /// The corpus header as a report shows it: coverage, the count of every diagnostic code and
    /// package state, and the first `preview` diagnostics and incomplete packages. The whole
    /// header lists every package: 67 MB for a project of 166,699 packages.
    pub fn corpus_report_header(&self, preview: usize, cancelled: &AtomicBool) -> Result<Value> {
        let summary = self.summary(cancelled)?;
        let lists = self.package_lists(cancelled)?;
        let (coverage, diagnostics) = (&lists.0, &lists.1);
        let increment = |counts: &mut serde_json::Map<String, Value>, key: &str| {
            let count = counts.get(key).and_then(Value::as_u64).unwrap_or(0);
            counts.insert(key.into(), json!(count + 1));
        };
        // Codes that are absent count zero; the optional ones appear only when present.
        let mut diagnostic_counts = serde_json::Map::new();
        for code in [
            "package_inspection_failed",
            "package_partially_decoded",
            "unsupported_text_history",
        ] {
            diagnostic_counts.insert(code.into(), json!(0));
        }
        for diagnostic in diagnostics {
            let code = diagnostic["code"]
                .as_str()
                .ok_or("Diagnostic without a code.")?;
            increment(&mut diagnostic_counts, code);
        }
        let mut counts = serde_json::Map::new();
        for status in ["complete", "partial", "failed"] {
            counts.insert(status.into(), json!(0));
        }
        let mut packages = Vec::new();
        let mut omitted = 0usize;
        for item in coverage {
            checkpoint(cancelled)?;
            let status = item["status"].as_str().ok_or("Package without a status.")?;
            increment(&mut counts, status);
            if status == "complete" {
                continue;
            }
            if packages.len() < preview {
                packages.push(json!({"packageFile":item["packageFile"],"status":status}));
            } else {
                omitted += 1;
            }
        }
        Ok(json!({
            "coverage": summary["coverage"],
            "diagnostics": diagnostics.iter().take(preview).collect::<Vec<_>>(),
            "diagnosticCount": diagnostics.len(),
            "diagnosticCounts": diagnostic_counts,
            "diagnosticsOmitted": diagnostics.len().saturating_sub(preview),
            "packageCoverage": {"counts": counts, "packages": packages, "omitted": omitted}
        }))
    }
    /// SHA-256 over the whole corpus as `sha256-canonical-json-utf8-v1`: the corpus that
    /// `readCorpus` returns, encoded with its schema's fields, object keys in code unit order
    /// and strings escaped as JSON.stringify escapes them. Equal corpora have equal fingerprints
    /// on every machine; it is a baseline's corpus generation.
    pub fn corpus_fingerprint(&self, cancelled: &AtomicBool) -> Result<String> {
        use sha2::Digest;
        if let Some(fingerprint) = self.fingerprint.get() {
            return Ok(fingerprint);
        }
        let summary = self.summary(cancelled)?;
        let lists = self.package_lists(cancelled)?;
        let (coverage, diagnostics) = (&lists.0, &lists.1);
        let mut hash = Canonical(sha2::Sha256::new());
        let keep = |value: &Value, keys: &[&str]| -> Value {
            let mut kept = serde_json::Map::new();
            for key in keys {
                if let Some(field) = value.get(*key) {
                    kept.insert((*key).into(), field.clone());
                }
            }
            Value::Object(kept)
        };
        hash.raw("{\"coverage\":");
        hash.value(&keep(
            &summary["coverage"],
            &[
                "discoveredPackages",
                "inspectedPackages",
                "partialPackages",
                "failedPackages",
                "textUnits",
                "textOccurrences",
                "resolvedOccurrences",
                "unresolvedOccurrences",
                "unsupportedTextProperties",
                "missingGatherableText",
            ],
        ))?;
        hash.raw(",\"diagnostics\":[");
        for (index, diagnostic) in diagnostics.iter().enumerate() {
            if index > 0 {
                hash.raw(",");
            }
            hash.value(&keep(
                diagnostic,
                &[
                    "code",
                    "message",
                    "packageFile",
                    "objectPath",
                    "propertyPath",
                    "coverageGapCounts",
                ],
            ))?;
        }
        hash.raw("],\"packageCoverage\":[");
        for (index, item) in coverage.iter().enumerate() {
            if index > 0 {
                hash.raw(",");
            }
            hash.value(item)?;
        }
        hash.raw("],\"schemaVersion\":1,\"status\":");
        hash.value(&summary["status"])?;
        hash.raw(",\"units\":[");
        let p = Projection::open(self, cancelled)?;
        for (index, row) in p.raw.order.iter().enumerate() {
            checkpoint(cancelled)?;
            if index > 0 {
                hash.raw(",");
            }
            let row = *row as usize;
            let presentation = self.presentation("raw", row)?;
            let mut occurrences = Vec::new();
            for member in p.raw.members(row) {
                occurrences.push(self.occurrence(*member as usize, cancelled)?);
            }
            hash.value(&json!({"id":presentation["id"],"identity":presentation["identity"],"source":presentation["source"],"occurrences":occurrences}))?;
        }
        hash.raw("]}");
        checkpoint(cancelled)?;
        let fingerprint: String = hash
            .0
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(self.fingerprint.store(fingerprint))
    }
}

/// Canonical JSON written straight into a digest: sorted keys, JavaScript string escapes.
struct Canonical(sha2::Sha256);
impl Canonical {
    fn raw(&mut self, text: &str) {
        sha2::Digest::update(&mut self.0, text.as_bytes());
    }
    fn string(&mut self, text: &str) {
        let mut escaped = String::with_capacity(text.len() + 2);
        escaped.push('"');
        let units = crate::wtf8::Wtf8Buf::from_view(text).to_utf16();
        for unit in char::decode_utf16(units.iter().copied()) {
            match unit {
                Ok('"') => escaped.push_str("\\\""),
                Ok('\\') => escaped.push_str("\\\\"),
                Ok('\u{8}') => escaped.push_str("\\b"),
                Ok('\t') => escaped.push_str("\\t"),
                Ok('\n') => escaped.push_str("\\n"),
                Ok('\u{c}') => escaped.push_str("\\f"),
                Ok('\r') => escaped.push_str("\\r"),
                Ok(character) if (character as u32) < 0x20 => {
                    escaped.push_str(&format!("\\u{:04x}", character as u32));
                }
                Ok(character) => escaped.push(character),
                Err(lone) => escaped.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate())),
            }
        }
        escaped.push('"');
        self.raw(&escaped);
    }
    fn value(&mut self, value: &Value) -> Result<()> {
        match value {
            Value::Null => self.raw("null"),
            Value::Bool(value) => self.raw(if *value { "true" } else { "false" }),
            Value::Number(number) => {
                require(
                    number.is_u64() || number.is_i64(),
                    "Corpus numbers are integers.",
                )?;
                self.raw(&number.to_string());
            }
            Value::String(text) => self.string(text),
            Value::Array(values) => {
                self.raw("[");
                for (index, item) in values.iter().enumerate() {
                    if index > 0 {
                        self.raw(",");
                    }
                    self.value(item)?;
                }
                self.raw("]");
            }
            Value::Object(fields) => {
                let mut keys = fields.keys().collect::<Vec<_>>();
                keys.sort_by(|left, right| crate::join::ordinal(left, right));
                self.raw("{");
                for (index, key) in keys.into_iter().enumerate() {
                    if index > 0 {
                        self.raw(",");
                    }
                    self.string(key);
                    self.raw(":");
                    self.value(&fields[key])?;
                }
                self.raw("}");
            }
        }
        Ok(())
    }
}
