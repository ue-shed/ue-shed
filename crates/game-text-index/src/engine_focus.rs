//! Native focus hydration. Only the requested occurrence page crosses the process boundary.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::{AUDIENCES, FocusRequest};
use crate::{Error, ErrorCode, Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

const AUDIENCE_REASONS: [&str; 8] = [
    "gather_table_editor_only",
    "gather_table_runtime",
    "developer_folder",
    "editor_namespace",
    "editor_object",
    "editor_property",
    "player_asset",
    "no_evidence",
];
const GAP_REASONS: [&str; 4] = [
    "unsupported_text_history",
    "legacy_container_element_without_type_information",
    "feature_unavailable_for_engine_version",
    "property_decoder_rejected",
];
const GAP_DESCRIPTIONS: [&str; 4] = [
    "with unsupported text histories",
    "container elements without type information",
    "unavailable for this engine version",
    "rejected by their decoder",
];
const COPY_KINDS: [&str; 4] = ["generated_class", "class_default", "skeleton", "instance"];
impl EngineQuery {
    pub(crate) fn package_row(&self, occurrence: usize) -> Result<(usize, usize)> {
        let (shard, row) = self.package_coordinate(occurrence)?;
        let starts = self.package_column(shard, "package.occurrence_start")?;
        let package = starts
            .partition_point(|start| *start as usize <= row)
            .checked_sub(1)
            .ok_or("Occurrence precedes package.")?;
        Ok((shard, package))
    }
    fn package_position(&self, occurrence: usize) -> Result<(usize, usize, String)> {
        let (shard, package) = self.package_row(occurrence)?;
        Ok((shard, package, self.package_file(shard, package)?))
    }
    pub(crate) fn occurrence_id(&self, occurrence: usize) -> Result<String> {
        let (_, _, package) = self.package_position(occurrence)?;
        let location = self.occurrence_location(occurrence)?;
        let object = location["objectPath"]
            .as_str()
            .ok_or("Missing occurrence object.")?;
        let suffix = match location["kind"].as_str() {
            Some("string_table_entry") => format!(
                "entry:{}",
                location["entryKey"].as_str().ok_or("Missing entry key.")?
            ),
            Some("data_table_cell") => format!(
                "row:{}:property:{}",
                location["row"].as_str().ok_or("Missing data row.")?,
                location["propertyPath"]
                    .as_str()
                    .ok_or("Missing data property.")?
            ),
            Some("asset_property") => format!(
                "property:{}",
                location["propertyPath"]
                    .as_str()
                    .ok_or("Missing property path.")?
            ),
            _ => return Err("Invalid occurrence location.".into()),
        };
        Ok(format!("occurrence:{object}:{suffix}:{package}"))
    }
    pub fn occurrence(&self, occurrence: usize, cancelled: &AtomicBool) -> Result<Value> {
        checkpoint(cancelled)?;
        let (shard, row) = self.package_coordinate(occurrence)?;
        let (_, _, package) = self.package_position(occurrence)?;
        let source_id = self.occurrence_value(occurrence, "source")?;
        let notes_id = self.occurrence_value(occurrence, "notes")?;
        let source = self.reader.string(source_id)?;
        let code = self.occurrence_value(occurrence, "audience")?;
        let audience = AUDIENCES
            .get((code & 3) as usize)
            .ok_or("Invalid occurrence audience.")?;
        let reason = AUDIENCE_REASONS
            .get(((code >> 2) & 15) as usize)
            .ok_or("Invalid occurrence audience reason.")?;
        let mut result = json!({"id":self.occurrence_id(occurrence)?,"packageFile":package,"source":source,"devNotes":self.reader.string(notes_id)?,"identity":self.occurrence_identity(occurrence)?,"location":self.occurrence_location(occurrence)?,"editCapability":if self.occurrence_value(occurrence,"editable")?!=0 {"source_editable"} else {"read_only"},"audience":audience,"audienceReason":reason});
        let rule = ((code >> 8) & 255) as usize;
        if rule > 0 {
            result["audienceRule"] = json!(
                self.audience_rules
                    .get(rule - 1)
                    .ok_or("The reader policy does not identify the stored audience rule.")?
            );
        }
        let flags = self.package_column(shard, "occurrence.copies")?;
        let copies = *flags.get(row).ok_or("Missing occurrence copy flags.")?;
        if copies != 0 {
            let count = (copies >> 2) as usize;
            require(
                count <= 10000,
                Error::new(
                    ErrorCode::LimitExceeded,
                    "Occurrence copies exceed a bounded focus response.",
                ),
            )?;
            let starts = self.copy_starts.get_or_try(shard, || {
                let mut starts = Vec::with_capacity(flags.len() + 1);
                let mut offset = 0usize;
                starts.push(offset);
                for (index, flags) in flags.iter().enumerate() {
                    if index & 255 == 0 {
                        checkpoint(cancelled)?;
                    }
                    offset = offset
                        .checked_add((flags >> 2) as usize)
                        .ok_or("Copy offset overflow.")?;
                    starts.push(offset);
                }
                Ok(starts.into())
            })?;
            let begin = *starts.get(row).ok_or("Missing copy offset.")?;
            let kinds = self.package_column(shard, "copy.kind")?;
            let objects = self.package_column(shard, "copy.object")?;
            let sources = self.package_column(shard, "copy.source")?;
            let mut values = Vec::new();
            for index in begin..begin + count {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                let code = *kinds.get(index).ok_or("Invalid copy row.")?;
                let object = self
                    .reader
                    .string(*objects.get(index).ok_or("Invalid copy object.")?)?;
                let source = if code & 4 != 0 {
                    source.clone()
                } else {
                    self.reader
                        .string(*sources.get(index).ok_or("Invalid copy source.")?)?
                };
                values.push(json!({"objectPath":object,"kind":COPY_KINDS[(code&3) as usize],"source":source}));
            }
            result["copies"] = json!(values);
        }
        Ok(result)
    }
    pub(crate) fn package_value(&self, shard: usize, field: &str, row: usize) -> Result<u32> {
        self.package_column(shard, field)?
            .get(row)
            .copied()
            .ok_or_else(|| "Package row outside column.".into())
    }
    pub(crate) fn package_diagnostics(
        &self,
        shard: usize,
        row: usize,
        file: &str,
        maximum: usize,
        cancelled: &AtomicBool,
    ) -> Result<Vec<Value>> {
        let mut result = Vec::new();
        if self.package_value(shard, "package.status", row)? != 1 {
            return Ok(result);
        }
        let mut counts = [0u32; 4];
        for (bit, count) in counts.iter_mut().enumerate() {
            *count = self.package_value(shard, &format!("package.gap{bit}"), row)?;
        }
        let total = counts.iter().map(|count| u64::from(*count)).sum::<u64>();
        let errors = self.package_value(shard, "package.decode_errors", row)?;
        let reason = if total == 0 {
            if errors > 0 {
                format!("{errors} decode error(s) limit this package's coverage.")
            } else {
                "The saved-package reader reported incomplete coverage for this package.".into()
            }
        } else {
            let descriptions = (0..4)
                .rev()
                .filter(|bit| counts[*bit] > 0)
                .map(|bit| format!("{} {}", counts[bit], GAP_DESCRIPTIONS[bit]))
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "{total} {} not decoded: {descriptions}.",
                if total == 1 {
                    "property was"
                } else {
                    "properties were"
                }
            )
        };
        let missing = self.package_value(shard, "package.gather_missing", row)?;
        let sites = self.package_value(shard, "package.gather_sites", row)?;
        let message = if self.package_value(shard, "package.gather", row)? == 1 && missing > 0 {
            format!(
                "{missing} of {sites} runtime text {} in this package's gather table {} not decoded. {reason}",
                if sites == 1 { "entry" } else { "entries" },
                if missing == 1 { "was" } else { "were" }
            )
        } else {
            reason
        };
        let mut partial =
            json!({"code":"package_partially_decoded","message":message,"packageFile":file});
        let gap_starts = self.package_column(shard, "package.gap_start")?;
        let begin = *gap_starts.get(row).ok_or("Missing gap start.")? as usize;
        let end = *gap_starts.get(row + 1).ok_or("Missing gap end.")? as usize;
        if total > 0 {
            partial["coverageGapCounts"] = Value::Object(
                GAP_REASONS
                    .iter()
                    .zip(counts)
                    .map(|(label, count)| (label.to_string(), json!(count)))
                    .collect(),
            );
            if begin < end {
                let object = self.package_value(shard, "gap.object", begin)?;
                let property = self.package_value(shard, "gap.property", begin)?;
                partial["objectPath"] = json!(self.reader.string(object)?);
                partial["propertyPath"] = json!(self.reader.string(property)?);
            }
        }
        result.push(partial);
        if missing > 0 && self.package_value(shard, "package.gather", row)? == 1 {
            let starts = self.package_column(shard, "package.missing_start")?;
            let begin = *starts.get(row).ok_or("Missing gather sample start.")? as usize;
            let end = *starts.get(row + 1).ok_or("Missing gather sample end.")? as usize;
            for index in begin..end {
                if result.len() >= maximum {
                    return Ok(result);
                }
                checkpoint(cancelled)?;
                let mut text = Vec::new();
                for field in ["source", "namespace", "key", "site"] {
                    let id = self.package_value(shard, &format!("missing.{field}"), index)?;
                    text.push(self.reader.string(id)?);
                }
                result.push(json!({"code":"gatherable_text_not_decoded","message":format!("\"{}\" is in this package's gather table (namespace \"{}\", key \"{}\") but was not decoded.",text[0],text[1],text[2]),"packageFile":file,"objectPath":text[3]}));
            }
        }
        for index in begin..end {
            if result.len() >= maximum {
                break;
            }
            checkpoint(cancelled)?;
            if self.package_value(shard, "gap.reason", index)? != 0 {
                continue;
            }
            let object = self.package_value(shard, "gap.object", index)?;
            let property = self.package_value(shard, "gap.property", index)?;
            result.push(json!({"code":"unsupported_text_history","message":"This FText history is visible but not decoded by the saved-package reader.","packageFile":file,"objectPath":self.reader.string(object)?,"propertyPath":self.reader.string(property)?}));
        }
        Ok(result)
    }
    pub fn focus(&self, request: &FocusRequest, cancelled: &AtomicBool) -> Result<Value> {
        request.validate()?;
        checkpoint(cancelled)?;
        let p = Projection::open(self, cancelled)?;
        let mut row = self.find_id("raw", &request.id)?;
        let mut line = None;
        let mut kind = "raw";
        let raws = self.column("slice", "raw")?;
        require(
            raws.len() == p.slice.visible.len(),
            "Invalid slice-to-unit projection.",
        )?;
        if let Some(selection) = &request.localization {
            if self.target["name"] != selection.target {
                return Ok(Value::Null);
            }
            let Some(candidate) = self.find_id("line", &selection.id)? else {
                return Ok(Value::Null);
            };
            line = Some(candidate);
            kind = "slice";
            let raw = row.take();
            if let Some(raw) = raw {
                for sr in p.starts[candidate] as usize..p.starts[candidate + 1] as usize {
                    if raws[sr] as usize == raw && p.slice.visible[sr] != 0 {
                        row = Some(sr);
                        break;
                    }
                }
            }
        } else if let Some(raw) = row {
            if p.raw.visible[raw] == 0 {
                return Ok(Value::Null);
            }
            line = self
                .unit_lines(cancelled)?
                .get(raw)
                .copied()
                .filter(|line| *line != u32::MAX)
                .map(|line| line as usize);
        }
        let Some(row) = row else {
            return Ok(Value::Null);
        };
        let members = if kind == "raw" {
            p.raw.members(row)
        } else {
            p.slice.members(row)
        };
        let mut after = 0;
        if let Some(cursor) = &request.occurrence_cursor {
            for (index, member) in members.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                if self.occurrence_id(*member as usize)? == *cursor {
                    after = index + 1;
                    break;
                }
            }
        }
        let end = members.len().min(after + request.page_size);
        let mut occurrences = Vec::new();
        for member in &members[after..end] {
            occurrences.push(self.occurrence(*member as usize, cancelled)?);
        }
        let mut diagnostics = Vec::new();
        let mut positions: HashMap<String, usize> = HashMap::new();
        let mut seen = HashSet::new();
        for (index, member) in members.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            if diagnostics.len() >= request.page_size {
                break;
            }
            let (shard, package) = self.package_row(*member as usize)?;
            if !seen.insert((shard, package)) {
                continue;
            }
            let file = self.package_file(shard, package)?;
            for diagnostic in
                self.package_diagnostics(shard, package, &file, request.page_size, cancelled)?
            {
                let key = format!(
                    "{}:{}:{}:{}",
                    diagnostic["code"], file, diagnostic["objectPath"], diagnostic["propertyPath"]
                );
                if let Some(position) = positions.get(&key) {
                    diagnostics[*position] = diagnostic;
                } else {
                    positions.insert(key, diagnostics.len());
                    diagnostics.push(diagnostic);
                }
            }
        }
        diagnostics.truncate(request.page_size);
        let mut result = json!({"diagnostics":diagnostics,"occurrences":occurrences,"totalOccurrences":members.len(),"unit":self.presentation(kind,row)?});
        if let Some(line) = line {
            result["localization"] = self.preview(line)?;
        }
        // The unit lists its line's problems and findings in a localization selection, in every
        // culture, else its own, as a search row has them.
        let every = self.culture_scope(None)?;
        let (localized, at) = if kind == "slice" {
            (true, line.ok_or("Missing focused line.")?)
        } else {
            (false, row)
        };
        let findings = match &request.findings {
            Some(selection) => Some(self.finding_rows(selection, localized, &every, cancelled)?),
            None => None,
        };
        let finding = findings
            .as_ref()
            .is_some_and(|findings| findings.counted.contains(at));
        result["unit"]["problems"] = json!(crate::engine_query::selected_bits(
            &crate::engine_types::PROBLEMS,
            p.row_problem(localized, at, &every, finding)
        ));
        if let Some(findings) = &findings {
            crate::engine_search::list_findings(&mut result["unit"], findings, at);
        }
        if end < members.len() {
            result["nextOccurrenceCursor"] = result["occurrences"]
                .as_array()
                .and_then(|rows| rows.last())
                .and_then(|row| row.get("id"))
                .cloned()
                .ok_or("Missing occurrence page cursor.")?;
        }
        Ok(result)
    }
    pub fn focus_json(&self, payload: &str, cancelled: &AtomicBool) -> Result<String> {
        let request = crate::engine_types::parse_focus_request(payload)?;
        crate::wtf8::view_json(&self.focus(&request, cancelled)?)
    }
}
