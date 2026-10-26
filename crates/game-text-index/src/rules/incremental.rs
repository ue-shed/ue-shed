//! What an evaluation keeps for the next one, and which rows that one must evaluate again.
//!
//! A row's findings depend on its own line and on the rows it shares a group or a corpus count
//! with. Every cross-row node (`groupCount`, `groupRank`, `groupTake`, `groupTally`,
//! `existsOther`, `corpusCount`) records each row's groups, so the next evaluation can tell which
//! groups changed and evaluate their members, and copy every other row's findings.
use super::columns::Bits;
use super::compiler::NodeId;
use rustc_hash::FxHashSet;
use std::collections::HashMap;
use std::hash::Hasher;

/// A single-group row outside the node's groups: outside `among`, or with a null key.
pub(crate) const NO_GROUP: u32 = u32::MAX;
/// A row whose key or `among` failed; it reports a diagnostic, so a change to it is a change.
pub(crate) const FAILED_GROUP: u32 = u32::MAX - 1;
/// The key a failed row stands in.
const FAILED_KEY: u64 = u64::MAX;

/// One cross-row node's groups over its subject's rows.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct NodeGroups {
    pub node: NodeId,
    /// Each row's groups: `groups[starts[row]..starts[row + 1]]`, for `existsOther` keyed by
    /// site; without `starts`, `groups[row]` alone, `NO_GROUP` for none.
    pub starts: Option<Vec<u32>>,
    pub groups: Vec<u32>,
    /// Each group's key hash.
    pub hashes: Vec<u64>,
    /// `corpusCount`: each key's hash and how many corpus rows have it.
    pub table: Option<Vec<(u64, i64)>>,
    /// False for a `corpusCount` whose key reads a lambda's element: only its table is known,
    /// so a changed table means evaluating every row.
    pub keyed: bool,
    /// A full evaluation's node that no rule evaluated: no finding read it, so it has no groups
    /// and a later evaluation has no old groups to compare.
    pub unreached: bool,
}
impl NodeGroups {
    /// The row's group numbers.
    pub fn row(&self, row: usize) -> &[u32] {
        match &self.starts {
            Some(starts) => match (starts.get(row), starts.get(row + 1)) {
                (Some(start), Some(end)) => &self.groups[*start as usize..*end as usize],
                _ => &[],
            },
            None => match self.groups.get(row) {
                Some(&NO_GROUP) | None => &[],
                Some(_) => std::slice::from_ref(&self.groups[row]),
            },
        }
    }
    /// The row's key hashes, one per group: a row's groups are distinct, and so are their keys.
    pub(crate) fn keys(&self, row: usize) -> impl Iterator<Item = u64> + '_ {
        self.row(row).iter().filter_map(|group| match *group {
            FAILED_GROUP => Some(FAILED_KEY),
            group => self.hashes.get(group as usize).copied(),
        })
    }
    fn has_key(&self, row: usize, key: u64) -> bool {
        self.keys(row).any(|own| own == key)
    }
    /// Whether the row has the same keys here and in `other`.
    fn same_keys(&self, other: &Self, row: usize) -> bool {
        let (here, there) = (self.row(row), other.row(row));
        here.len() == there.len() && self.keys(row).all(|key| other.has_key(row, key))
    }
    /// Whether both hold the same keys on every row, and the same corpus table.
    #[cfg(test)]
    pub(crate) fn same_rows(&self, other: &Self) -> bool {
        let rows = |groups: &Self| {
            groups
                .starts
                .as_ref()
                .map_or(groups.groups.len(), |starts| starts.len().saturating_sub(1))
        };
        self.node == other.node
            && self.keyed == other.keyed
            && self.table == other.table
            && rows(self) == rows(other)
            && (0..rows(self)).all(|row| self.same_keys(other, row))
    }
    /// The rows' groups renumbered through `map`, from each current row to the row it was, or
    /// `NO_GROUP` for a row that is new.
    pub fn renumbered(&self, map: &[u32]) -> Self {
        let mut output = Self {
            node: self.node,
            hashes: self.hashes.clone(),
            table: self.table.clone(),
            keyed: self.keyed,
            unreached: self.unreached,
            ..Self::default()
        };
        match &self.starts {
            None => {
                output.groups = map
                    .iter()
                    .map(|old| match *old {
                        NO_GROUP => NO_GROUP,
                        old => self.groups.get(old as usize).copied().unwrap_or(NO_GROUP),
                    })
                    .collect();
            }
            Some(_) => {
                let mut starts = Vec::with_capacity(map.len() + 1);
                starts.push(0);
                for old in map {
                    if *old != NO_GROUP {
                        output.groups.extend_from_slice(self.row(*old as usize));
                    }
                    starts.push(output.groups.len() as u32);
                }
                output.starts = Some(starts);
            }
        }
        output
    }
}

/// A group key's hash: of its key text (`Evaluator::key`), so it doesn't depend on the arena's
/// string numbering. Equal keys hash equally; unequal keys almost never do, and when they do the
/// closure only evaluates more rows.
pub(crate) fn key_hash(text: &str) -> u64 {
    let mut hasher = rustc_hash::FxHasher::default();
    hasher.write(text.as_bytes());
    hasher.write_u8(0xff);
    match hasher.finish() {
        FAILED_KEY => FAILED_KEY - 1,
        hash => hash,
    }
}

/// One subject's part of an incremental evaluation.
pub(crate) struct SubjectDelta {
    /// The rows whose lines changed.
    pub changed: Bits,
    /// The previous evaluation's groups, renumbered to this evaluation's rows. A row the
    /// previous evaluation didn't have has no groups; it is in `changed`.
    pub previous: HashMap<NodeId, NodeGroups>,
    /// The key hashes of the previous rows that a changed line no longer has.
    pub removed: HashMap<NodeId, Vec<u64>>,
    /// `line_culture`: each row's line, so a line's rows are evaluated together.
    pub lines: Option<std::sync::Arc<[u32]>>,
    /// Above this many rows, evaluate every row.
    pub limit: usize,
}

/// The rows to evaluate again: the changed rows, every member of a group a changed row was or is
/// in, every row whose groups changed, and every row whose `corpusCount` key changed its count,
/// widened to whole lines for `line_culture`, until nothing more joins. `None` when that is
/// more than `delta.limit` rows, a node has no previous groups, or an unkeyed corpus count's
/// table changed.
pub(crate) fn closure(len: usize, delta: &SubjectDelta, current: &[NodeGroups]) -> Option<Bits> {
    let mut nodes = Vec::new();
    for groups in current {
        let previous = delta.previous.get(&groups.node)?;
        // Keys that a row joined or left, or whose corpus count changed, affect their groups
        // whichever rows are evaluated.
        let mut affected = FxHashSet::default();
        if let (Some(old_table), Some(new_table)) = (&previous.table, &groups.table) {
            let old = old_table.iter().copied().collect::<HashMap<_, _>>();
            let new = new_table.iter().copied().collect::<HashMap<_, _>>();
            // Two keys of one hash would share a count here and could hide a change.
            if old.len() != old_table.len() || new.len() != new_table.len() {
                return None;
            }
            for (key, count) in &new {
                if old.get(key) != Some(count) {
                    affected.insert(*key);
                }
            }
            for key in old.keys() {
                if !new.contains_key(key) {
                    affected.insert(*key);
                }
            }
            if !groups.keyed && !affected.is_empty() {
                return None;
            }
        }
        if !groups.keyed {
            continue;
        }
        if let Some(keys) = delta.removed.get(&groups.node) {
            affected.extend(keys);
        }
        // A row whose groups changed affects them. Before, an unreached node's groups held no
        // finding: a row outside the closure doesn't reach it now either.
        if !previous.unreached {
            for row in 0..len {
                if !previous.same_keys(groups, row) {
                    affected.extend(previous.keys(row).filter(|key| !groups.has_key(row, *key)));
                    affected.extend(groups.keys(row).filter(|key| !previous.has_key(row, *key)));
                }
            }
        }
        nodes.push((previous, groups, affected, FxHashSet::default()));
    }
    let mut selected = delta.changed.clone();
    loop {
        let before = selected.count();
        for (previous, groups, affected, scanned) in &mut nodes {
            for row in selected.ones() {
                affected.extend(previous.keys(row as usize).chain(groups.keys(row as usize)));
            }
            // A node's rows are scanned again only for keys it hasn't scanned for.
            if affected.iter().all(|key| scanned.contains(key)) {
                continue;
            }
            for row in 0..len {
                if previous
                    .keys(row)
                    .chain(groups.keys(row))
                    .any(|key| affected.contains(&key))
                {
                    selected.set(row);
                }
            }
            scanned.clone_from(affected);
        }
        if let Some(lines) = &delta.lines {
            let touched = selected
                .ones()
                .map(|row| lines[row as usize])
                .collect::<FxHashSet<_>>();
            for (row, line) in lines.iter().enumerate() {
                if touched.contains(line) {
                    selected.set(row);
                }
            }
        }
        if selected.count() > delta.limit {
            return None;
        }
        if selected.count() == before {
            return Some(selected);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn groups(node: NodeId, keys: &[Option<&str>]) -> NodeGroups {
        let mut hashes = Vec::new();
        let mut index = HashMap::new();
        let groups = keys
            .iter()
            .map(|key| match key {
                None => NO_GROUP,
                Some(key) => *index.entry(key_hash(key)).or_insert_with(|| {
                    hashes.push(key_hash(key));
                    (hashes.len() - 1) as u32
                }),
            })
            .collect();
        NodeGroups {
            node,
            groups,
            hashes,
            keyed: true,
            ..NodeGroups::default()
        }
    }
    fn sited(node: NodeId, rows: &[&[&str]]) -> NodeGroups {
        let mut output = NodeGroups {
            node,
            starts: Some(vec![0]),
            keyed: true,
            ..NodeGroups::default()
        };
        for keys in rows {
            for key in *keys {
                let hash = key_hash(key);
                let group = match output.hashes.iter().position(|known| *known == hash) {
                    Some(group) => group,
                    None => {
                        output.hashes.push(hash);
                        output.hashes.len() - 1
                    }
                };
                output.groups.push(group as u32);
            }
            let end = output.groups.len() as u32;
            output.starts.as_mut().unwrap().push(end);
        }
        output
    }
    fn delta(changed: &[usize], previous: NodeGroups, len: usize) -> SubjectDelta {
        let mut bits = Bits::new(len);
        for row in changed {
            bits.set(*row);
        }
        SubjectDelta {
            changed: bits,
            previous: HashMap::from([(previous.node, previous)]),
            removed: HashMap::new(),
            lines: None,
            limit: len,
        }
    }
    fn rows(selected: Option<Bits>) -> Vec<u32> {
        selected.unwrap().ones().collect()
    }

    #[test]
    fn a_changed_row_brings_its_old_and_new_groups() {
        let old = groups(1, &[Some("a"), Some("a"), Some("b"), Some("b"), None]);
        let new = groups(1, &[Some("b"), Some("a"), Some("b"), Some("b"), None]);
        assert_eq!(
            rows(closure(5, &delta(&[0], old, 5), &[new])),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn a_row_whose_group_changed_through_another_aggregate_brings_its_groups() {
        // Row 3 left `among` without changing its line.
        let old = groups(1, &[Some("a"), Some("c"), Some("c"), Some("c"), Some("d")]);
        let new = groups(1, &[Some("a"), Some("c"), Some("c"), None, Some("d")]);
        assert_eq!(
            rows(closure(5, &delta(&[0], old, 5), &[new])),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn a_changed_corpus_count_brings_every_row_with_that_key() {
        let mut old = groups(2, &[Some("x"), Some("y"), Some("x")]);
        let mut new = old.clone();
        old.table = Some(vec![(key_hash("x"), 1), (key_hash("y"), 4)]);
        new.table = Some(vec![(key_hash("x"), 2), (key_hash("y"), 4)]);
        assert_eq!(
            rows(closure(3, &delta(&[], old.clone(), 3), &[new.clone()])),
            vec![0, 2]
        );
        // Without row keys, a changed table can't be followed; an unchanged one needs nothing.
        new.keyed = false;
        assert!(closure(3, &delta(&[], old.clone(), 3), std::slice::from_ref(&new)).is_none());
        new.table.clone_from(&old.table);
        assert_eq!(rows(closure(3, &delta(&[1], old, 3), &[new])), vec![1]);
    }

    #[test]
    fn an_unreached_node_brings_only_the_changed_rows_groups() {
        // No rule read the node before, so `b`'s rows held no finding of it and still don't.
        let old = NodeGroups {
            node: 1,
            unreached: true,
            ..NodeGroups::default()
        };
        let new = groups(1, &[Some("a"), Some("a"), Some("b"), None]);
        assert_eq!(rows(closure(4, &delta(&[0], old, 4), &[new])), vec![0, 1]);
    }

    #[test]
    fn colliding_corpus_keys_evaluate_every_row() {
        // Two keys of one hash: their counts can't be told apart, so neither can a change.
        let mut old = groups(2, &[Some("x"), Some("y")]);
        let mut new = old.clone();
        old.table = Some(vec![(7, 1), (7, 10)]);
        new.table = Some(vec![(7, 2), (7, 10)]);
        assert!(closure(2, &delta(&[], old, 2), &[new]).is_none());
    }

    #[test]
    fn a_removed_row_brings_the_groups_it_left() {
        // The changed line lost the row that shared `a` with row 2; its other row is in `b`.
        let old = groups(1, &[Some("b"), Some("c"), Some("a")]);
        let new = old.clone();
        let mut input = delta(&[0], old, 3);
        assert_eq!(
            rows(closure(3, &input, std::slice::from_ref(&new))),
            vec![0]
        );
        input.removed.insert(1, vec![key_hash("a")]);
        assert_eq!(rows(closure(3, &input, &[new])), vec![0, 2]);
    }

    #[test]
    fn rows_keyed_by_site_bring_every_group_they_were_or_are_in() {
        let old = sited(3, &[&["a", "b"], &["b"], &["c"], &["a"], &["d"]]);
        let new = sited(3, &[&["a", "c"], &["b"], &["c"], &["a"], &["d"]]);
        // Row 0's line is unchanged, but it left `b` and joined `c`, and evaluating it brings `a`.
        assert_eq!(
            rows(closure(5, &delta(&[], old, 5), &[new])),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn renumbering_follows_rows_with_one_group_or_several() {
        let single = groups(1, &[Some("a"), None, Some("b")]);
        let moved = single.renumbered(&[2, NO_GROUP, 0, 1]);
        assert_eq!(moved.groups, vec![1, NO_GROUP, 0, NO_GROUP]);
        let several = sited(1, &[&["a", "b"], &[], &["c"]]);
        let moved = several.renumbered(&[2, 0, NO_GROUP]);
        assert_eq!(moved.starts, Some(vec![0, 1, 3, 3]));
        assert_eq!(moved.groups, vec![2, 0, 1]);
    }

    #[test]
    fn line_culture_rows_widen_to_whole_lines_and_a_large_closure_gives_up() {
        let old = groups(1, &[Some("a"), None, None, Some("b")]);
        let new = old.clone();
        let mut input = delta(&[0], old, 4);
        input.lines = Some(vec![0, 0, 1, 1].into());
        assert_eq!(
            rows(closure(4, &input, std::slice::from_ref(&new))),
            vec![0, 1]
        );
        input.limit = 1;
        assert!(closure(4, &input, &[new]).is_none());
    }
}
