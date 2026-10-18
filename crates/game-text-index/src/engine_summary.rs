//! Native summary over persisted coverage, without hydrating corpus objects.
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_types::SearchRequest;
use crate::{Result, require};
use serde_json::json;
use std::sync::atomic::AtomicBool;

impl EngineQuery {
    pub fn summary(&mut self, cancelled: &AtomicBool) -> Result<serde_json::Value> {
        checkpoint(cancelled)?;
        if let Some(summary) = &self.summary_cache {
            return Ok(summary.clone());
        }
        let mut discovered = 0usize;
        let mut inspected = 0usize;
        let mut partial = 0usize;
        let mut failed = 0usize;
        let mut unsupported = 0u64;
        let mut missing = 0u64;
        let mut diagnostics = 0usize;
        let mut excluded = 0usize;
        let mut resolved = 0usize;
        let empty_ids = self.reader.empty_string_ids()?;
        for shard in 0..self.package_count() {
            checkpoint(cancelled)?;
            let statuses = self.package_column(shard, "package.status")?;
            let histories = self.package_column(shard, "package.gap0")?;
            let gather_missing = self.package_column(shard, "package.gather_missing")?;
            let gap_starts = self.package_column(shard, "package.gap_start")?;
            let missing_starts = self.package_column(shard, "package.missing_start")?;
            let gap_reasons = self.package_column(shard, "gap.reason")?;
            require(
                histories.len() == statuses.len()
                    && gather_missing.len() == statuses.len()
                    && gap_starts.len() == statuses.len() + 1
                    && missing_starts.len() == statuses.len() + 1,
                "Invalid package summary columns.",
            )?;
            discovered += statuses.len();
            for (row, status) in statuses.iter().enumerate() {
                if row & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                if *status < 2 {
                    inspected += 1;
                }
                match status {
                    0 => {}
                    1 => {
                        partial += 1;
                        diagnostics += 1;
                        unsupported += u64::from(histories[row]);
                        missing += u64::from(gather_missing[row]);
                        diagnostics += missing_starts[row + 1]
                            .checked_sub(missing_starts[row])
                            .ok_or("Invalid missing gather range.")?
                            as usize;
                        let reasons = gap_reasons
                            .get(gap_starts[row] as usize..gap_starts[row + 1] as usize)
                            .ok_or("Invalid summary gap range.")?;
                        diagnostics += reasons.iter().filter(|reason| **reason == 0).count();
                    }
                    2 => {
                        excluded += 1;
                        diagnostics += 1;
                    }
                    3 => {
                        failed += 1;
                        diagnostics += 1;
                    }
                    _ => return Err("Unknown package status.".into()),
                }
            }
            let identities = self.package_column(shard, "occurrence.identity")?;
            let keys = self.package_column(shard, "occurrence.key")?;
            require(
                identities.len() == keys.len(),
                "Invalid occurrence summary columns.",
            )?;
            for (index, (identity, key)) in identities.iter().zip(keys.iter()).enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                if *identity < 2 && !empty_ids.contains(key) {
                    resolved += 1;
                }
            }
        }
        let p = Projection::open(self, cancelled)?;
        let occurrences = p.raw.members.len();
        require(
            resolved <= occurrences,
            "Resolved occurrence count exceeds corpus.",
        )?;
        let mut coverage = json!({"discoveredPackages":discovered,"inspectedPackages":inspected,"partialPackages":partial,"failedPackages":failed,"textUnits":p.raw.visible.len(),"textOccurrences":occurrences,"resolvedOccurrences":resolved,"unresolvedOccurrences":occurrences-resolved,"unsupportedTextProperties":unsupported});
        if missing > 0 {
            coverage["missingGatherableText"] = json!(missing);
        }
        let request: SearchRequest =
            serde_json::from_value(json!({"query":"","capability":"all","pageSize":1}))?;
        let matched = self.matching(&request, cancelled)?;
        let counts = self.search_counts(&request, &matched, cancelled)?;
        let mut visible_occurrences = 0usize;
        let mut asset = 0usize;
        let mut table = 0usize;
        let mut string_table = 0usize;
        let mut mixed = 0usize;
        for (index, row) in p.raw.order.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            if p.raw.visible[row] == 0 {
                continue;
            }
            visible_occurrences += p.raw.members(row).len();
            let mask = p.raw.origins[row];
            asset += usize::from(mask & 4 != 0);
            table += usize::from(mask & 2 != 0);
            string_table += usize::from(mask & 1 != 0);
            mixed += usize::from(mask.count_ones() > 1);
        }
        Ok(
            json!({"schemaVersion":1,"status":if partial>0 || failed>0 {"partial"} else {"complete"},"diagnosticCount":diagnostics,"notGatherablePackages":excluded,"coverage":coverage,"searchable":{"textUnits":counts["all"],"textOccurrences":visible_occurrences},"review":{"all":counts["all"],"shared":counts["shared"],"duplicateSource":counts["duplicate_source"],"long":counts["long"],"unresolved":counts["unresolved"],"conflicting":counts["conflicting"]},"sources":{"assetProperty":asset,"dataTable":table,"stringTable":string_table,"mixed":mixed},"counts":counts}),
        )
    }
}
