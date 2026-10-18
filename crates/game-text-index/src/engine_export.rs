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
    output.write_all(crate::wtf8::view_json(value)?.as_bytes())?;
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
        &mut self,
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
        &mut self,
        request: &SearchRequest,
        path: &Path,
        cancelled: &AtomicBool,
    ) -> Result<u64> {
        require(
            request.localization.is_some(),
            crate::engine_types::invalid("Localization export requires a selected target."),
        )?;
        let rows = self.matching(request, cancelled)?;
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        let mut output = BufWriter::new(file);
        let result = (|| -> Result<u64> {
            output.write_all(b"[")?;
            let mut first = true;
            for row in rows.iter() {
                checkpoint(cancelled)?;
                separator(&mut output, &mut first)?;
                value(
                    &mut output,
                    &self.localization_line(*row as usize, cancelled)?,
                )?;
            }
            output.write_all(b"]")?;
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
        &mut self,
        request: &SearchRequest,
        path: &Path,
        include_invisible: bool,
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
            .write_corpus(request, &mut output, include_invisible, cancelled)
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
    fn package_coordinates(&mut self) -> Result<Vec<usize>> {
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
    pub(crate) fn package_file(&mut self, shard: usize, row: usize) -> Result<String> {
        let paths = self.package_column(shard, "package.path")?;
        let id = *paths.get(row).ok_or("Package row outside paths.")?;
        let path = self.reader.string(id)?;
        let project = self.reader.meta["input"]["projectRoot"]
            .as_str()
            .ok_or("Missing project identity.")?;
        Ok(crate::join_policy::relative_package(project, &path))
    }
    fn write_corpus(
        &mut self,
        request: &SearchRequest,
        output: &mut impl Write,
        include_invisible: bool,
        cancelled: &AtomicBool,
    ) -> Result<()> {
        let matched = if include_invisible {
            Arc::from([])
        } else {
            self.matching(request, cancelled)?
        };
        let p = Projection::open(self, cancelled)?;
        let mut chosen = vec![include_invisible; p.raw.visible.len()];
        if request.localization.is_some() {
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
        output.write_all(b"{\"schemaVersion\":1,\"status\":")?;
        value(output, &summary["status"])?;
        output.write_all(b",\"coverage\":")?;
        value(output, &summary["coverage"])?;
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
            output.write_all(b",\"occurrences\":[")?;
            let mut first_occurrence = true;
            for member in p.raw.members(row) {
                checkpoint(cancelled)?;
                separator(output, &mut first_occurrence)?;
                value(output, &self.occurrence(*member as usize, cancelled)?)?;
            }
            output.write_all(b"]}")?;
        }
        output.write_all(b"],\"packageCoverage\":[")?;
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
        let mut first = true;
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
                separator(output, &mut first)?;
                value(
                    output,
                    &json!({"packageFile":self.package_file(shard,row)?,"status":status}),
                )?;
            }
        }
        output.write_all(b"],\"diagnostics\":[")?;
        let mut first = true;
        for wanted in [3, 1, 2] {
            for (index, global) in order.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let (shard, row) = locate(*global)?;
                if self.package_value(shard, "package.status", row)? != wanted {
                    continue;
                }
                let path = self.package_file(shard, row)?;
                let diagnostics = match wanted {
                    1 => self.package_diagnostics(shard, row, &path, usize::MAX, cancelled)?,
                    2 => vec![
                        json!({"code":"package_not_gatherable","packageFile":path,"message":"Excluded because Unreal does not gather this package. Its text payload was not inspected."}),
                    ],
                    3 => {
                        let id = self.package_value(shard, "package.error", row)?;
                        let text = self.reader.string(id)?;
                        let error = crate::json_value::parse(&text)?;
                        require(
                            error["message"].is_string(),
                            "Missing package failure message.",
                        )?;
                        vec![
                            json!({"code":"package_inspection_failed","packageFile":path,"message":error["message"]}),
                        ]
                    }
                    _ => return Err("Invalid export diagnostic status.".into()),
                };
                for diagnostic in diagnostics {
                    separator(output, &mut first)?;
                    value(output, &diagnostic)?;
                }
            }
        }
        output.write_all(b"]}")?;
        checkpoint(cancelled)?;
        Ok(())
    }
}
