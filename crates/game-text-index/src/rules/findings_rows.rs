//! Browse's findings: each rule's rows in a search relation and culture scope, from a findings
//! layer, without the findings a review accepted or the Quality workspace hides as shadowed.
use super::findings::FindingsLayer;
use super::findings_order::{KEYLESS, NONE, SHADOWED};
use super::ir::Subject;
use crate::engine_match::{Projection, checkpoint};
use crate::engine_query::EngineQuery;
use crate::engine_rows::RowSet;
use crate::engine_types::FindingsSelection;
use crate::{Error, ErrorCode, Result, require};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// One rule as Browse lists it. Rules sharing an ID are one, which counts when any of them does.
pub(crate) struct FindingRule {
    pub id: String,
    pub label: String,
    pub counts: bool,
}

/// A layer's rows by rule, in one relation and culture scope.
pub(crate) struct FindingRows {
    /// What the rows depend on: the relation, layer, acceptance and culture scope.
    pub key: String,
    /// The layer's rules in program order.
    pub rules: Vec<FindingRule>,
    /// Each rule's rows.
    pub sets: Vec<RowSet>,
    /// The rows with a finding of a rule that counts: the `finding` problem.
    pub counted: RowSet,
}

impl FindingRows {
    pub fn rule(&self, id: &str) -> Option<usize> {
        self.rules.iter().position(|rule| rule.id == id)
    }

    /// The rules with a finding on the row, in program order.
    pub fn of(&self, row: usize) -> impl Iterator<Item = usize> + '_ {
        (0..self.sets.len()).filter(move |rule| self.sets[*rule].contains(row))
    }
}

impl EngineQuery {
    /// The layer, opened once and kept among the query's findings.
    fn take_layer(&mut self, key: &str) -> Result<FindingsLayer> {
        let layer = match self.findings.remove(key) {
            Some(layer) => layer,
            None => FindingsLayer::open(&self.configuration, key, &self.reader.joined_key)?,
        };
        require(
            layer.metadata.joined_key == self.reader.joined_key,
            Error::new(
                ErrorCode::StaleGeneration,
                "The findings belong to a different joined view.",
            ),
        )?;
        Ok(layer)
    }

    /// A layer's rows by rule: lines with `localized`, else raw units, with line findings in
    /// the cultures of `scope`. Each rule's set is kept in the atom cache.
    pub(crate) fn finding_rows(
        &mut self,
        selection: &FindingsSelection,
        localized: bool,
        scope: &[usize],
        cancelled: &AtomicBool,
    ) -> Result<Arc<FindingRows>> {
        let acceptance = match &selection.acceptance {
            Some(name) => {
                let acceptance = Arc::clone(self.acceptances.get(name).ok_or_else(|| {
                    Error::new(ErrorCode::InvalidInput, "The acceptance is not open.")
                })?);
                require(
                    acceptance.layer == selection.key,
                    Error::new(
                        ErrorCode::InvalidInput,
                        "The acceptance belongs to other findings.",
                    ),
                )?;
                Some(acceptance)
            }
            None => None,
        };
        let mut layer = self.take_layer(&selection.key)?;
        let built = self.build_finding_rows(
            &mut layer,
            selection,
            acceptance.as_deref(),
            localized,
            scope,
            cancelled,
        );
        self.findings.insert(selection.key.clone(), layer);
        built
    }

    fn build_finding_rows(
        &mut self,
        layer: &mut FindingsLayer,
        selection: &FindingsSelection,
        acceptance: Option<&super::Acceptance>,
        localized: bool,
        scope: &[usize],
        cancelled: &AtomicBool,
    ) -> Result<Arc<FindingRows>> {
        let source_only = selection.source_only == Some(true);
        let key = format!(
            "{}|findings|{}|{}|{source_only}|{scope:?}",
            if localized { "line" } else { "raw" },
            selection.key,
            selection.acceptance.as_deref().unwrap_or("")
        );
        let metadata = layer.metadata.rules.clone();
        let mut rules = Vec::<FindingRule>::new();
        // Each layer rule's Browse rule; `NONE` for a rule the selection leaves out.
        let mut merged = Vec::with_capacity(metadata.len());
        for rule in &metadata {
            if source_only && rule.subject != Subject::UnitSource {
                merged.push(NONE as usize);
                continue;
            }
            match rules.iter().position(|known| known.id == rule.rule_id) {
                Some(index) => {
                    rules[index].counts |= rule.counts;
                    merged.push(index);
                }
                None => {
                    merged.push(rules.len());
                    rules.push(FindingRule {
                        id: rule.rule_id.clone(),
                        label: rule.label.clone(),
                        counts: rule.counts,
                    });
                }
            }
        }
        let cached = (0..rules.len())
            .map(|rule| self.atoms.get(&format!("{key}|{rule}")))
            .collect::<Option<Vec<_>>>();
        if let (Some(sets), Some(counted)) = (cached, self.atoms.get(&format!("{key}|counted"))) {
            return Ok(Arc::new(FindingRows {
                key,
                rules,
                sets,
                counted,
            }));
        }
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchFindingRows");
        let p = Projection::open(self, cancelled)?;
        let len = if localized {
            p.source.len()
        } else {
            p.raw.visible.len()
        };
        let finding_rule = layer.column("f.rule")?;
        let finding_line = layer.column("f.line")?;
        // A source finding's raw unit row, already mapped from its subject row when stored.
        let finding_unit = layer.column("f.unit")?;
        let finding_culture = layer.column("f.culture")?;
        let finding_flags = layer.column("f.flags")?;
        // Each rule's first finding number, to find a source finding's saved places.
        let mut bases = vec![0usize];
        let mut places = Vec::with_capacity(metadata.len());
        for rule in 0..metadata.len() {
            let saved = layer.column(&format!("r{rule}.places"))?;
            bases.push(bases[rule] + saved.len());
            places.push(saved);
        }
        let count = finding_rule.len();
        require(
            [
                finding_line.len(),
                finding_unit.len(),
                finding_culture.len(),
                finding_flags.len(),
            ]
            .into_iter()
            .all(|value| value == count)
                && bases.last() == Some(&count),
            "Invalid finding column lengths.",
        )?;
        let accepted = acceptance.map(|acceptance| {
            acceptance
                .entries
                .iter()
                .filter_map(|(line, culture, rule)| {
                    rules
                        .iter()
                        .position(|known| known.id == *rule)
                        .map(|index| (*line, *culture, index))
                })
                .collect::<HashSet<_>>()
        });
        let shadow = metadata
            .iter()
            .any(|rule| rule.subject == Subject::UnitSource);
        let mut in_scope = vec![false; self.cultures.len()];
        for culture in scope {
            in_scope[*culture] = true;
        }
        // The visible slices of every unit with a source finding.
        let mut unit_slices = HashMap::<u32, Vec<u32>>::new();
        for number in 0..count {
            if finding_unit[number] != NONE {
                unit_slices.entry(finding_unit[number]).or_default();
            }
        }
        for (slice, unit) in p.slice_raw.iter().enumerate() {
            if p.slice.visible[slice] != 0
                && let Some(slices) = unit_slices.get_mut(unit)
            {
                slices.push(slice as u32);
            }
        }
        let mut rows = vec![Vec::<u32>::new(); rules.len()];
        for number in 0..count {
            if number & 4095 == 0 {
                checkpoint(cancelled)?;
            }
            let flags = finding_flags[number];
            if shadow && flags & SHADOWED != 0 {
                continue;
            }
            let rule = finding_rule[number] as usize;
            let index = *merged.get(rule).ok_or("Finding rule outside layer.")?;
            if index == NONE as usize {
                continue;
            }
            let (line, culture) = (finding_line[number], finding_culture[number]);
            if line != NONE {
                if culture != NONE && !in_scope.get(culture as usize).copied().unwrap_or(false) {
                    continue;
                }
                if flags & KEYLESS == 0
                    && accepted
                        .as_ref()
                        .is_some_and(|accepted| accepted.contains(&(line, culture, index)))
                {
                    continue;
                }
                let line = line as usize;
                if localized {
                    rows[index].push(line as u32);
                } else {
                    for slice in p.starts[line] as usize..p.starts[line + 1] as usize {
                        if p.slice.visible[slice] != 0 {
                            rows[index].push(p.slice_raw[slice]);
                        }
                    }
                }
                continue;
            }
            let unit = finding_unit[number];
            if !localized {
                rows[index].push(unit);
                continue;
            }
            // A source finding belongs to the lines holding one of its affected places.
            let slices = &unit_slices[&unit];
            let mut lines = slices
                .iter()
                .map(|slice| p.slice_line[*slice as usize])
                .collect::<Vec<_>>();
            lines.sort_unstable();
            lines.dedup();
            if lines.len() > 1 {
                let set = places[rule][number - bases[rule]];
                let affected = layer.place_set(set)?.into_iter().collect::<HashSet<_>>();
                lines.clear();
                for slice in slices {
                    for member in p.slice.members(*slice as usize) {
                        if affected.contains(&self.occurrence_id(*member as usize)?) {
                            lines.push(p.slice_line[*slice as usize]);
                            break;
                        }
                    }
                }
            }
            rows[index].extend(lines);
        }
        let sets = rows
            .iter()
            .map(|rows| RowSet::from_rows(len, rows))
            .collect::<Result<Vec<_>>>()?;
        let counted = RowSet::union(
            len,
            sets.iter()
                .zip(&rules)
                .filter(|(_, rule)| rule.counts)
                .map(|(set, _)| set),
        );
        for (rule, set) in sets.iter().enumerate() {
            self.atoms.insert(format!("{key}|{rule}"), set.clone());
        }
        self.atoms.insert(format!("{key}|counted"), counted.clone());
        Ok(Arc::new(FindingRows {
            key,
            rules,
            sets,
            counted,
        }))
    }
}
