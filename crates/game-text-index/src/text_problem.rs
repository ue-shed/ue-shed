//! Which problems a line or unit has, from the shared table `text_problem_rules.rs` that
//! `textProblems` also reads. A name the table uses outside `STATES`, `REASONS` or `SIGNALS`
//! fails the build.
use crate::engine_types::{REASONS, SIGNALS, STATES};
use crate::text_problem_rules::{
    FINDING_SIGNALS, PROBLEM_FACTS, PROBLEM_REASONS, PROBLEM_SIGNALS, PROBLEM_STATES, PROBLEM_WORK,
};
pub(crate) use crate::text_problem_rules::{PROBLEM_LABELS, PROBLEMS};

const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
const fn position(name: &str, vocabulary: &[&str]) -> u32 {
    let mut i = 0;
    while i < vocabulary.len() {
        if same(name, vocabulary[i]) {
            return i as u32;
        }
        i += 1;
    }
    panic!("The text-problem table names a value outside its vocabulary.")
}
const fn names(values: &[&str], vocabulary: &[&str]) -> u32 {
    let mut bits = 0;
    let mut i = 0;
    while i < values.len() {
        bits |= 1 << position(values[i], vocabulary);
        i += 1;
    }
    bits
}
const fn masks(lists: [&[&str]; PROBLEMS.len()], vocabulary: &[&str]) -> [u32; PROBLEMS.len()] {
    let mut result = [0; PROBLEMS.len()];
    let mut i = 0;
    while i < lists.len() {
        result[i] = names(lists[i], vocabulary);
        i += 1;
    }
    result
}
const fn problem(name: &str) -> u32 {
    1 << position(name, &PROBLEMS)
}

pub(crate) const KEY_CHANGED: u32 = problem("key_changed");
pub(crate) const FINDING: u32 = problem("finding");
pub(crate) const UP_TO_DATE: u32 = problem("up_to_date");
/// Problems that leave a line work before it ships.
pub(crate) const WORK: u32 = {
    let mut bits = 0;
    let mut i = 0;
    while i < PROBLEM_WORK.len() {
        if PROBLEM_WORK[i] {
            bits |= 1 << i;
        }
        i += 1;
    }
    bits
};
const STATE_MASKS: [u32; PROBLEMS.len()] = masks(PROBLEM_STATES, &STATES);
const FACT_MASKS: [u32; PROBLEMS.len()] = masks(PROBLEM_FACTS, &STATES);
const REASON_MASKS: [u32; PROBLEMS.len()] = masks(PROBLEM_REASONS, &REASONS);
const SIGNAL_MASKS: [u32; PROBLEMS.len()] = masks(PROBLEM_SIGNALS, &SIGNALS);

/// The problems one culture's mark raises: its state index, and its fact and reason bits.
pub(crate) fn culture(state: u32, facts: u32, reasons: u32) -> u32 {
    let state = 1u32.checked_shl(state).unwrap_or(0);
    let mut bits = 0;
    for problem in 0..PROBLEMS.len() {
        if state & STATE_MASKS[problem]
            | facts & FACT_MASKS[problem]
            | reasons & REASON_MASKS[problem]
            != 0
        {
            bits |= 1 << problem;
        }
    }
    bits
}

/// The review signals that make a line a finding when a request names none.
pub(crate) const DEFAULT_FINDINGS: u32 = SIGNAL_MASKS[position("finding", &PROBLEMS) as usize];
/// The review signals a request can count as findings by naming them in a `finding` clause.
const NAMEABLE_FINDINGS: u32 = names(&FINDING_SIGNALS, &SIGNALS);

/// The findings a request counts: the defaults, and every finding its `is` clauses or lens name.
pub(crate) fn counted_findings<'a>(named: impl IntoIterator<Item = &'a str>) -> u32 {
    named
        .into_iter()
        .filter_map(|name| SIGNALS.iter().position(|signal| *signal == name))
        .fold(DEFAULT_FINDINGS, |bits, index| {
            bits | (1 << index) & NAMEABLE_FINDINGS
        })
}

/// The problems review signals raise; `counted` are the signals that make a finding.
pub(crate) fn signals(signals: u32, counted: u32) -> u32 {
    let mut bits = if signals & counted != 0 { FINDING } else { 0 };
    for (problem, mask) in SIGNAL_MASKS.iter().enumerate() {
        if signals & mask != 0 && 1 << problem != FINDING {
            bits |= 1 << problem;
        }
    }
    bits
}

/// `bits`, or up to date when it has no problem.
pub(crate) fn settle(bits: u32) -> u32 {
    if bits == 0 { UP_TO_DATE } else { bits }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_table_maps_states_facts_reasons_and_signals() {
        let state = |name| position(name, &STATES);
        assert_eq!(
            culture(state("not_found"), 0, 0),
            problem("changed_since_gather")
        );
        assert_eq!(culture(state("unknown"), 0, 0), problem("unchecked"));
        assert_eq!(culture(state("not_synced"), 0, 0), problem("translation"));
        assert_eq!(
            culture(state("translated"), 1 << state("not_synced"), 0),
            problem("translation")
        );
        assert_eq!(
            culture(
                state("unknown"),
                0,
                1 << position("conflicting_source", &REASONS)
            ),
            problem("conflicting_source") | problem("unchecked")
        );
        for name in ["translated", "gathered_only", "outside_target"] {
            assert_eq!(culture(state(name), 0, 0), 0, "{name}");
        }
        let signal = |name| 1 << position(name, &SIGNALS);
        let defaults = counted_findings([]);
        assert_eq!(signals(signal("long"), defaults), 0);
        assert_eq!(signals(signal("shared"), defaults), FINDING);
        assert_eq!(
            signals(signal("conflicting"), defaults),
            problem("conflicting_source")
        );
        let named = counted_findings(["long", "conflicting", "unknown"]);
        assert_eq!(named, defaults | signal("long"));
        assert_eq!(signals(signal("long"), named), FINDING);
        assert_eq!(settle(0), UP_TO_DATE);
        assert_eq!(WORK, 0b11111);
        assert_eq!(PROBLEMS.len(), PROBLEM_LABELS.len());
    }
}
