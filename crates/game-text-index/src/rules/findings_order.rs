//! The findings layer's numbering, flags and orders (layer version 4). Findings are numbered in
//! one sequence across rules, in rule order and each rule's position order, so comparing two
//! numbers compares (rule, position). The orders are the hosts' report orders, computed once
//! when the layer is built, so reads page through them without sorting.
use super::HostCollator;
use super::replies::RuleMetadata;
use crate::Result;
use rayon::prelude::*;
use std::cmp::Ordering;

/// The finding carries a suggested change.
pub(crate) const CHANGE: u32 = 1;
/// The suggested change is one hosts accept: bounded, on a line with an identity.
pub(crate) const FIXABLE: u32 = 2;
/// Hidden where source findings list the same text.
pub(crate) const SHADOWED: u32 = 4;
/// Its line has no identity, so review can't accept it.
pub(crate) const KEYLESS: u32 = 8;
/// No line, unit or culture.
pub(crate) const NONE: u32 = u32::MAX;

/// What ordering reads of one finding.
#[derive(Default)]
pub(super) struct Facts {
    pub rule: u32,
    /// The line row of a line finding.
    pub line: u32,
    /// The raw unit row of a source finding.
    pub unit: u32,
    pub culture: u32,
    pub flags: u32,
    /// `JSON.stringify(actual)`, as the report compares it.
    pub actual: String,
    /// A source finding's source text and the rank of its first place among its unit's places.
    pub source: String,
    pub first_rank: u32,
}

pub(super) struct Orders {
    /// Line findings on join lines, in the `loc check` report order.
    pub report: Vec<u32>,
    /// Line findings on join lines, by line in report line order, then rule and position.
    pub line: Vec<u32>,
    /// Source findings: rules by ID, units in ID order, then each unit's order for the rule.
    pub source: Vec<u32>,
    /// Diagnostics on join lines, by line in report line order, then as stored.
    pub diagnostics: Vec<u32>,
}

/// Each value's rank under the collator; values that compare equal share a rank.
fn ranks(values: &[&str], collator: &HostCollator) -> Vec<u32> {
    let mut order = (0..values.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| collator.compare(values[*a], values[*b]));
    let mut result = vec![0; values.len()];
    let mut rank = 0;
    for (index, value) in order.iter().enumerate() {
        if index > 0
            && collator.compare(values[order[index - 1]], values[*value]) != Ordering::Equal
        {
            rank += 1;
        }
        result[*value] = rank;
    }
    result
}

pub(super) struct OrderInput<'a> {
    pub facts: &'a [Facts],
    pub rules: &'a [RuleMetadata],
    pub cultures: &'a [String],
    /// Each line row's position in the join, or `NONE` outside it.
    pub join: &'a [u32],
    /// Each raw unit row's rank in ID order.
    pub unit_ranks: &'a [u32],
    /// The packed ID of every line a finding or diagnostic names.
    pub line_id: &'a dyn Fn(u32) -> Result<String>,
    pub diagnostic_lines: &'a [u32],
    pub collator: &'a HostCollator,
}

pub(super) fn orders(input: &OrderInput<'_>) -> Result<Orders> {
    let OrderInput {
        facts,
        rules,
        cultures,
        join,
        unit_ranks,
        line_id,
        diagnostic_lines,
        collator,
    } = input;
    let in_join = |line: u32| join.get(line as usize).is_some_and(|rank| *rank != NONE);
    // Report line order: line IDs with the host collator, ties in join order. Lines whose IDs
    // compare equal form one block, which the report interleaves by culture and check.
    let mut lines = facts
        .iter()
        .map(|facts| facts.line)
        .chain(diagnostic_lines.iter().copied())
        .filter(|line| *line != NONE && in_join(*line))
        .collect::<Vec<_>>();
    lines.par_sort_unstable();
    lines.dedup();
    let ids = lines
        .iter()
        .map(|line| line_id(*line))
        .collect::<Result<Vec<_>>>()?;
    let mut sorted = (0..lines.len()).collect::<Vec<_>>();
    sorted.par_sort_by(|a, b| {
        collator
            .compare(&ids[*a], &ids[*b])
            .then_with(|| join[lines[*a] as usize].cmp(&join[lines[*b] as usize]))
    });
    let line_count = join.len();
    let mut position = vec![NONE; line_count];
    let mut block = vec![NONE; line_count];
    let mut blocks = 0u32;
    for (index, at) in sorted.iter().enumerate() {
        if index > 0 && collator.compare(&ids[sorted[index - 1]], &ids[*at]) != Ordering::Equal {
            blocks += 1;
        }
        position[lines[*at] as usize] = u32::try_from(index)?;
        block[lines[*at] as usize] = blocks;
    }
    drop(ids);

    let culture_rank = ranks(
        &cultures.iter().map(String::as_str).collect::<Vec<_>>(),
        collator,
    );
    let kind_rank = ranks(
        &rules
            .iter()
            .map(|rule| rule.kind.as_str())
            .collect::<Vec<_>>(),
        collator,
    );
    let rule_rank = ranks(
        &rules
            .iter()
            .map(|rule| rule.rule_id.as_str())
            .collect::<Vec<_>>(),
        collator,
    );

    let mut by_block = vec![
        Vec::new();
        if lines.is_empty() {
            0
        } else {
            blocks as usize + 1
        }
    ];
    let mut line_findings = Vec::new();
    let mut source_findings = Vec::new();
    for (number, finding) in facts.iter().enumerate() {
        let number = u32::try_from(number)?;
        if finding.unit != NONE {
            source_findings.push(number);
        } else if finding.line != NONE && in_join(finding.line) {
            by_block[block[finding.line as usize] as usize].push(number);
            line_findings.push(number);
        }
    }
    // Within a block: culture, kind, rule ID and actual with the host collator, then the join
    // order of the lines, then rule and position, as the stable sorts of the report keep them.
    let report_key = |a: &u32, b: &u32| {
        let (x, y) = (&facts[*a as usize], &facts[*b as usize]);
        culture_rank[x.culture as usize]
            .cmp(&culture_rank[y.culture as usize])
            .then_with(|| kind_rank[x.rule as usize].cmp(&kind_rank[y.rule as usize]))
            .then_with(|| rule_rank[x.rule as usize].cmp(&rule_rank[y.rule as usize]))
            .then_with(|| collator.compare(&x.actual, &y.actual))
            .then_with(|| join[x.line as usize].cmp(&join[y.line as usize]))
            .then_with(|| a.cmp(b))
    };
    by_block
        .par_iter_mut()
        .for_each(|members| members.sort_by(report_key));
    let report = by_block.into_iter().flatten().collect();
    line_findings
        .par_sort_by_key(|number| (position[facts[*number as usize].line as usize], *number));

    // Source rules by ID with the host collator, ties in rule order.
    let mut source_rules = (0..rules.len()).collect::<Vec<_>>();
    source_rules.sort_by(|a, b| {
        collator
            .compare(&rules[*a].rule_id, &rules[*b].rule_id)
            .then(a.cmp(b))
    });
    let mut source_rank = vec![0u32; rules.len()];
    for (rank, rule) in source_rules.iter().enumerate() {
        source_rank[*rule] = u32::try_from(rank)?;
    }
    source_findings.par_sort_by(|a, b| {
        let (x, y) = (&facts[*a as usize], &facts[*b as usize]);
        source_rank[x.rule as usize]
            .cmp(&source_rank[y.rule as usize])
            .then_with(|| unit_ranks[x.unit as usize].cmp(&unit_ranks[y.unit as usize]))
            .then_with(|| collator.compare(&x.source, &y.source))
            .then_with(|| x.first_rank.cmp(&y.first_rank))
            .then_with(|| a.cmp(b))
    });

    let mut diagnostics = (0..u32::try_from(diagnostic_lines.len())?)
        .filter(|index| in_join(diagnostic_lines[*index as usize]))
        .collect::<Vec<_>>();
    diagnostics.sort_by_key(|index| (position[diagnostic_lines[*index as usize] as usize], *index));
    Ok(Orders {
        report,
        line: line_findings,
        source: source_findings,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::ir::{Family, Severity, Subject};

    fn rule(rule_id: &str, kind: &str, subject: Subject) -> RuleMetadata {
        RuleMetadata {
            id: rule_id.into(),
            rule_id: rule_id.into(),
            kind: kind.into(),
            label: rule_id.into(),
            subject,
            family: Family::Builtin,
            severity: Severity::Normal,
            role: None,
        }
    }

    fn line(rule: u32, line: u32, culture: u32, actual: &str) -> Facts {
        Facts {
            rule,
            line,
            unit: NONE,
            culture,
            actual: actual.into(),
            ..Facts::default()
        }
    }

    #[test]
    fn report_order_interleaves_equal_ids_and_source_order_is_rule_first() -> Result<()> {
        let collator = HostCollator::new("en")?;
        let rules = [
            rule("z.check", "whitespace", Subject::LineCulture),
            rule("a.check", "format_arguments", Subject::LineCulture),
            rule("b.source", "terminology", Subject::UnitSource),
            rule("a.source", "terminology", Subject::UnitSource),
        ];
        let cultures = ["fr".to_owned(), "de".to_owned()];
        // Lines 0 and 2 have IDs that compare equal; line 1 sorts first; line 3 is outside the join.
        let ids = ["line:\u{e9}", "line:a", "line:e\u{301}", "line:z"];
        let join = [1, 0, 2, NONE];
        let mut facts = vec![
            line(0, 0, 0, "{\"x\":2}"),
            line(0, 2, 1, "{\"x\":1}"),
            line(1, 0, 1, "{\"x\":1}"),
            line(1, 1, 0, "{}"),
            line(1, 3, 0, "{}"),
        ];
        for (rule, unit, source, first_rank) in [
            (2, 1, "b", 0),
            (3, 0, "a", 1),
            (2, 0, "a", 0),
            (3, 0, "a", 0),
        ] {
            facts.push(Facts {
                rule,
                line: NONE,
                unit,
                culture: NONE,
                source: source.into(),
                first_rank,
                ..Facts::default()
            });
        }
        let orders = orders(&OrderInput {
            facts: &facts,
            rules: &rules,
            cultures: &cultures,
            join: &join,
            unit_ranks: &[1, 0],
            line_id: &|line| Ok(ids[line as usize].to_owned()),
            diagnostic_lines: &[2, 1, 3, 0],
            collator: &collator,
        })?;
        // Line 1 first; then lines 0 and 2 as one block: de before fr, then kind
        // (format_arguments before whitespace).
        assert_eq!(orders.report, [3, 2, 1, 0]);
        assert_eq!(orders.line, [3, 0, 2, 1]);
        // a.source before b.source; units by rank (unit 1 first); then first rank.
        assert_eq!(orders.source, [8, 6, 5, 7]);
        assert_eq!(orders.diagnostics, [1, 3, 0]);
        Ok(())
    }
}
