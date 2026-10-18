//! Policy-independent native summary counters, persisted with each immutable joined revision.
use crate::join_columns::{column, layer};
use crate::store::Store;
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) const RAW_FIELDS: [&str; 7] = [
    "visible",
    "signals",
    "origins",
    "editing",
    "notes",
    "member_start",
    "member_end",
];
const LABELS: [&str; 9] = [
    "all",
    "shared",
    "duplicate_source",
    "long",
    "unresolved",
    "conflicting",
    "editable",
    "readOnly",
    "withoutNotes",
];
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Coverage {
    discovered: u64,
    inspected: u64,
    partial: u64,
    failed: u64,
    unsupported: u64,
    missing: u64,
    diagnostics: u64,
    excluded: u64,
    resolved: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_rows_update_every_counter_and_undo_exactly() -> Result<()> {
        let before = [1, 1 | 2, 1 | 4, 3, 0, 0, 2];
        let after = [1, 4 | 8 | 16, 2, 1, 1, 0, 2];
        let mut state = SummaryState {
            version: 1,
            coverage: Coverage::default(),
            units: 1,
            occurrences: 2,
            totals: contribution(before)?,
        };
        let original = state.response()?;
        state.replace(before, after)?;
        let changed = state.response()?;
        assert_eq!(changed["review"]["duplicateSource"], 0);
        assert_eq!(changed["review"]["conflicting"], 1);
        assert_eq!(changed["sources"]["dataTable"], 1);
        assert_eq!(changed["counts"]["readOnly"], 0);
        assert_eq!(changed["counts"]["withoutNotes"], 0);
        state.replace(after, before)?;
        assert_eq!(state.response()?, original);
        assert!(state.replace([1, 31, 7, 3, 0, 0, 2], after).is_err());
        assert!(contribution([1, 0, 0, 0, 0, 2, 1]).is_err());
        assert!(contribution([2, 0, 0, 0, 0, 0, 1]).is_err());
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SummaryState {
    version: u32,
    coverage: Coverage,
    units: u64,
    occurrences: u64,
    totals: [u64; 14],
}

pub(crate) fn contribution(values: [u32; 7]) -> Result<[u64; 14]> {
    let [visible, flags, origins, editing, notes, start, end] = values;
    require(visible <= 1 && end >= start, "summary raw row bounds")?;
    let mut totals = [0; 14];
    if visible == 0 {
        return Ok(totals);
    }
    totals[0] = 1;
    for bit in 0..5 {
        totals[bit + 1] = u64::from(flags & (1 << bit) != 0);
    }
    totals[6] = u64::from(editing & 1 != 0);
    totals[7] = u64::from(editing & 2 != 0);
    totals[8] = u64::from(notes == 0);
    for bit in 0..3 {
        totals[9 + bit] = u64::from(origins & (1 << bit) != 0);
    }
    totals[12] = u64::from(origins.count_ones() > 1);
    totals[13] = u64::from(end - start);
    Ok(totals)
}

impl SummaryState {
    pub(crate) fn build(
        store: &Store,
        names: &[String],
        units: usize,
        occurrences: usize,
        mut row: impl FnMut(usize) -> Result<[u32; 7]>,
    ) -> Result<Self> {
        let mut coverage = Coverage::default();
        let first_ids = store.root["segments"]
            .as_array()
            .ok_or("summary dictionary segments")?
            .iter()
            .filter(|segment| segment["count"].as_u64().unwrap_or(0) > 0)
            .map(|segment| {
                Ok(u32::try_from(
                    segment["start"].as_u64().ok_or("summary segment start")?,
                )?)
            })
            .collect::<Result<std::collections::BTreeSet<_>>>()?;
        let empty =
            crate::store::dictionary_selected_strings(&store.directory, &store.root, &first_ids)?
                .into_iter()
                .filter_map(|(id, value)| value.is_empty().then_some(id))
                .collect::<std::collections::BTreeSet<_>>();
        for name in names {
            let (mut reader, record) = layer(store, name)?.ok_or("summary package shard")?;
            let mut get = |field: &str| column(&mut reader, &record, field);
            let statuses = get("package.status")?;
            let histories = get("package.gap0")?;
            let missing = get("package.gather_missing")?;
            let starts = get("package.gap_start")?;
            let missing_starts = get("package.missing_start")?;
            let reasons = get("gap.reason")?;
            require(
                histories.len() == statuses.len()
                    && missing.len() == statuses.len()
                    && starts.len() == statuses.len() + 1
                    && missing_starts.len() == statuses.len() + 1,
                "summary package lengths",
            )?;
            coverage.discovered += statuses.len() as u64;
            for (index, status) in statuses.iter().enumerate() {
                if *status < 2 {
                    coverage.inspected += 1;
                }
                match status {
                    0 => {}
                    1 => {
                        coverage.partial += 1;
                        coverage.diagnostics += 1;
                        coverage.unsupported += u64::from(histories[index]);
                        coverage.missing += u64::from(missing[index]);
                        coverage.diagnostics += u64::from(
                            missing_starts[index + 1]
                                .checked_sub(missing_starts[index])
                                .ok_or("summary missing ranges")?,
                        );
                        let range = starts[index] as usize..starts[index + 1] as usize;
                        coverage.diagnostics += reasons
                            .get(range)
                            .ok_or("summary gap range")?
                            .iter()
                            .filter(|reason| **reason == 0)
                            .count() as u64;
                    }
                    2 => {
                        coverage.excluded += 1;
                        coverage.diagnostics += 1;
                    }
                    3 => {
                        coverage.failed += 1;
                        coverage.diagnostics += 1;
                    }
                    _ => return Err("summary package status".into()),
                }
            }
            let identities = get("occurrence.identity")?;
            let keys = get("occurrence.key")?;
            require(identities.len() == keys.len(), "summary identity lengths")?;
            coverage.resolved += identities
                .iter()
                .zip(keys)
                .filter(|(identity, key)| **identity < 2 && !empty.contains(key))
                .count() as u64;
        }
        let mut state = Self {
            version: 1,
            coverage,
            units: units as u64,
            occurrences: occurrences as u64,
            totals: [0; 14],
        };
        for index in 0..units {
            let values = contribution(row(index)?)?;
            for (total, value) in state.totals.iter_mut().zip(values) {
                *total += value;
            }
        }
        state.validate()?;
        Ok(state)
    }
    pub(crate) fn parse(value: &Value) -> Result<Self> {
        let state: Self = serde_json::from_value(value.clone())?;
        state.validate()?;
        Ok(state)
    }
    fn validate(&self) -> Result<()> {
        require(
            self.version == 1
                && self.coverage.resolved <= self.occurrences
                && self.totals[0] <= self.units
                && self.totals[13] <= self.occurrences
                && self.totals[1..13]
                    .iter()
                    .all(|count| *count <= self.totals[0]),
            "invalid persisted summary counters",
        )
    }
    pub(crate) fn replace(&mut self, before: [u32; 7], after: [u32; 7]) -> Result<()> {
        for ((total, before), after) in self
            .totals
            .iter_mut()
            .zip(contribution(before)?)
            .zip(contribution(after)?)
        {
            *total = total
                .checked_sub(before)
                .and_then(|value| value.checked_add(after))
                .ok_or("summary counter overflow")?;
        }
        self.validate()
    }
    pub(crate) fn response(&self) -> Result<Value> {
        self.validate()?;
        let c = &self.coverage;
        let mut coverage = json!({"discoveredPackages":c.discovered,"inspectedPackages":c.inspected,
            "partialPackages":c.partial,"failedPackages":c.failed,"textUnits":self.units,"textOccurrences":self.occurrences,
            "resolvedOccurrences":c.resolved,"unresolvedOccurrences":self.occurrences-c.resolved,"unsupportedTextProperties":c.unsupported});
        if c.missing > 0 {
            coverage["missingGatherableText"] = json!(c.missing);
        }
        let mut counts = serde_json::Map::new();
        for (index, label) in LABELS.iter().enumerate() {
            counts.insert((*label).into(), json!(self.totals[index]));
        }
        counts.insert("origins".into(), json!({"string_table":self.totals[9],"data_table":self.totals[10],"asset":self.totals[11],"cpp":0,"other_source":0}));
        Ok(
            json!({"schemaVersion":1,"status":if c.partial>0 || c.failed>0 {"partial"} else {"complete"},
            "diagnosticCount":c.diagnostics,"notGatherablePackages":c.excluded,"coverage":coverage,
            "searchable":{"textUnits":self.totals[0],"textOccurrences":self.totals[13]},
            "review":{"all":self.totals[0],"shared":self.totals[1],"duplicateSource":self.totals[2],"long":self.totals[3],"unresolved":self.totals[4],"conflicting":self.totals[5]},
            "sources":{"assetProperty":self.totals[11],"dataTable":self.totals[10],"stringTable":self.totals[9],"mixed":self.totals[12]},"counts":counts}),
        )
    }
}
