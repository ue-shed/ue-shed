//! One committed generation read as a whole: its base snapshot and, when it has one, the delta
//! over it. Every read merges the base's live rows (those the delta does not hide) with the
//! delta's rows in path order; the two never share a path.

use super::*;

static NO_TOMBSTONES: Tombstones = Tombstones {
    base: None,
    packages: 0,
    maps: 0,
    ids: Vec::new(),
};

/// Orders `a` followed by `a_joint` against `b` followed by `b_joint`, without building either.
fn cmp_joined(a: &str, a_joint: u8, b: &str, b_joint: u8) -> std::cmp::Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let common = a.len().min(b.len());
    a[..common].cmp(&b[..common]).then_with(|| {
        // One is a prefix of the other: compare what follows it, the joint for the shorter.
        let (rest_a, rest_b) = (&a[common..], &b[common..]);
        let next_a = rest_a.first().copied().unwrap_or(a_joint);
        let next_b = rest_b.first().copied().unwrap_or(b_joint);
        next_a
            .cmp(&next_b)
            .then_with(|| (rest_a.len() + 1).cmp(&(rest_b.len() + 1)))
    })
}

/// Which snapshot of a generation a row is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum Segment {
    Base,
    Delta,
}

pub(super) struct Committed {
    pub(super) base: Snapshot,
    pub(super) delta: Option<Snapshot>,
    /// Set once the delta's tombstone counts were checked against the base rows they hide.
    tombstones_checked: OnceCell<()>,
}

impl Committed {
    /// A generation's snapshots, opened with `check` and checked against each other.
    pub(super) fn open(
        directory: &Path,
        manifest: &Manifest,
        check: SnapshotCheck,
    ) -> Result<Self, CatalogError> {
        let base = Snapshot::open(&directory.join(&manifest.physical_snapshot), check)?;
        let delta = manifest
            .delta_snapshot
            .as_ref()
            .map(|name| Snapshot::open(&directory.join(name), check))
            .transpose()?;
        Self::new(base, delta)
    }

    pub(super) fn new(base: Snapshot, delta: Option<Snapshot>) -> Result<Self, CatalogError> {
        if base.is_delta() {
            return Err(corrupt("a base snapshot holds tombstones"));
        }
        if let Some(delta) = &delta {
            let hidden = &delta.tombstones;
            if hidden.base != Some(base.fingerprint()) {
                return Err(corrupt("a delta does not belong to its base"));
            }
            if hidden
                .ids
                .last()
                .is_some_and(|last| *last as usize >= base.row_count)
                || hidden.packages > base.header.packages
                || hidden.maps > base.header.maps
            {
                return Err(corrupt("a delta hides rows its base does not hold"));
            }
        }
        Ok(Self {
            base,
            delta,
            tombstones_checked: OnceCell::new(),
        })
    }

    /// Releases each snapshot's decoded inventory chunks once more than `retained` are decoded.
    pub(super) fn release_rows_over(&mut self, retained: usize) {
        self.base.release_chunks_over(retained);
        if let Some(delta) = &mut self.delta {
            delta.release_chunks_over(retained);
        }
    }

    /// The base rows the delta hides.
    pub(super) fn hidden(&self) -> &Tombstones {
        self.delta
            .as_ref()
            .map_or(&NO_TOMBSTONES, |delta| &delta.tombstones)
    }

    /// Handles name base rows by id and delta rows after them.
    pub(super) fn handle_count(&self) -> usize {
        self.base.row_count + self.delta.as_ref().map_or(0, |delta| delta.row_count)
    }

    /// Entries the generation holds.
    pub(super) fn live_count(&self) -> usize {
        self.handle_count() - self.hidden().ids.len()
    }

    /// The generation's package and map counts, from the snapshot headers.
    pub(super) fn counts(&self) -> Option<(u64, u64)> {
        let hidden = self.hidden();
        let (delta_packages, delta_maps) = self
            .delta
            .as_ref()
            .map_or((0, 0), |delta| (delta.header.packages, delta.header.maps));
        Some((
            self.base
                .header
                .packages
                .checked_sub(hidden.packages)?
                .checked_add(delta_packages)?,
            self.base
                .header
                .maps
                .checked_sub(hidden.maps)?
                .checked_add(delta_maps)?,
        ))
    }

    pub(super) fn segment(&self, segment: Segment) -> Result<&Snapshot, CatalogError> {
        match segment {
            Segment::Base => Ok(&self.base),
            Segment::Delta => self
                .delta
                .as_ref()
                .ok_or_else(|| corrupt("a row names a missing delta")),
        }
    }

    /// The base snapshot; the first call checks the delta's tombstone counts against the rows
    /// they hide.
    pub(super) fn base(&self) -> Result<&Snapshot, CatalogError> {
        if self.tombstones_checked.get().is_none() {
            let hidden = self.hidden();
            self.base
                .load_chunks(hidden.ids.iter().map(|id| *id as usize))?;
            let (mut packages, mut maps) = (0, 0);
            for id in &hidden.ids {
                let entry = self.base.entry(*id as usize)?;
                packages += u64::from(entry.kind == EntryKind::Package);
                maps += u64::from(entry.is_map);
            }
            if packages != hidden.packages || maps != hidden.maps {
                return Err(corrupt("tombstone counts do not match the base"));
            }
            let _ = self.tombstones_checked.set(());
        }
        Ok(&self.base)
    }

    /// A segment's snapshot, the base read as [`Committed::base`] reads it.
    pub(super) fn rows(&self, segment: Segment) -> Result<&Snapshot, CatalogError> {
        match segment {
            Segment::Base => self.base(),
            Segment::Delta => self.segment(Segment::Delta),
        }
    }

    /// The live row at exactly `path`.
    pub(super) fn row_at(&self, path: &str) -> Result<Option<(Segment, usize)>, CatalogError> {
        if let Some(delta) = &self.delta
            && let Some(id) = delta.id_at(path)?
        {
            return Ok(Some((Segment::Delta, id)));
        }
        Ok(self
            .base()?
            .id_at(path)?
            .filter(|id| !self.hidden().hides(*id))
            .map(|id| (Segment::Base, id)))
    }

    /// Every live package path whose bundle stem is exactly `stem`, regardless of package
    /// extension casing (for example `.uasset`, `.UASSET`, `.UMap`).
    pub(super) fn live_packages_with_stem(&self, stem: &str) -> Result<Vec<String>, CatalogError> {
        let mut paths = Vec::new();
        let base = self.base()?;
        let hidden = self.hidden();
        let mut collect = |snapshot: &Snapshot,
                           hidden: Option<&Tombstones>|
         -> Result<(), CatalogError> {
            let mut id = snapshot.before_joined(0..snapshot.row_count, stem, b'.')?;
            while id < snapshot.row_count {
                let path = snapshot.path(id)?;
                if !shares_stem(path, stem) {
                    break;
                }
                if hidden.is_none_or(|hidden| !hidden.hides(id)) && bundle_stem(path) == Some(stem)
                {
                    let (path, entry) = snapshot.row(id)?;
                    if entry.kind == EntryKind::Package {
                        paths.push(path.to_owned());
                    }
                }
                id += 1;
            }
            Ok(())
        };
        collect(base, Some(hidden))?;
        if let Some(delta) = &self.delta {
            collect(delta, None)?;
        }
        Ok(paths)
    }

    /// The handle of a row.
    pub(super) fn handle(&self, segment: Segment, id: usize) -> Result<u32, CatalogError> {
        let handle = match segment {
            Segment::Base => id,
            Segment::Delta => self.base.row_count + id,
        };
        u32::try_from(handle).map_err(|_| corrupt("Catalog count exceeds u32"))
    }

    /// The row a handle names.
    pub(super) fn row_of(&self, handle: u32) -> (Segment, usize) {
        let handle = handle as usize;
        if handle < self.base.row_count {
            (Segment::Base, handle)
        } else {
            (Segment::Delta, handle - self.base.row_count)
        }
    }

    /// Up to `limit` rows matching an inventory, map or posting query after `cursor`, in path
    /// order across both segments.
    pub(super) fn page_ids(
        &self,
        kind: &QueryKind,
        cursor: &str,
        limit: usize,
    ) -> Result<Vec<(Segment, usize)>, CatalogError> {
        let base_rows = self.base()?;
        let after = base_rows.after(cursor)?;
        let Some(delta) = &self.delta else {
            return Ok(self
                .base
                .matches(kind, after, limit)?
                .into_iter()
                .map(|id| (Segment::Base, id))
                .collect());
        };
        let hidden = self.hidden();
        // Hidden rows from `after` on may take places in the base's first matches.
        let hidden_after = hidden.ids.len() - hidden.before(after);
        let base = self
            .base
            .matches(kind, after, limit.saturating_add(hidden_after))?
            .into_iter()
            .filter(|id| !hidden.hides(*id))
            .take(limit)
            .collect::<Vec<_>>();
        let ours = delta.matches(kind, delta.after(cursor)?, limit)?;
        // The merge compares the paths of both lists' rows.
        base_rows.load_chunks(base.iter().copied())?;
        delta.load_chunks(ours.iter().copied())?;
        let mut merged = Vec::with_capacity(limit.min(base.len() + ours.len()));
        let (mut base, mut ours) = (base.into_iter().peekable(), ours.into_iter().peekable());
        while merged.len() < limit {
            let next = match (base.peek(), ours.peek()) {
                (Some(b), Some(d)) => {
                    if delta.path(*d)? < base_rows.path(*b)? {
                        ours.next().map(|id| (Segment::Delta, id))
                    } else {
                        base.next().map(|id| (Segment::Base, id))
                    }
                }
                (Some(_), None) => base.next().map(|id| (Segment::Base, id)),
                (None, Some(_)) => ours.next().map(|id| (Segment::Delta, id)),
                (None, None) => break,
            };
            merged.extend(next);
        }
        Ok(merged)
    }

    /// A row's path.
    pub(super) fn path(&self, segment: Segment, id: usize) -> Result<&str, CatalogError> {
        self.rows(segment)?.path(id)
    }

    /// Decodes the chunks of `rows` in each segment, in parallel where they are spread.
    pub(super) fn load_rows(&self, rows: &[(Segment, usize)]) -> Result<(), CatalogError> {
        for segment in [Segment::Base, Segment::Delta] {
            let mut ids = rows
                .iter()
                .filter(|(row_segment, _)| *row_segment == segment)
                .map(|(_, id)| *id)
                .peekable();
            if ids.peek().is_some() {
                self.rows(segment)?.load_chunks(ids)?;
            }
        }
        Ok(())
    }

    /// The bundle signatures of the packages at `rows` (a page, in path order): each package's
    /// own stamp, then each live sidecar's with its stem, whichever segment holds it. Sidecars in
    /// the package's own segment are its neighbours; the other segment is searched only within
    /// the run of rows the page's stems can reach.
    pub(super) fn bundle_signatures(
        &self,
        rows: &[(Segment, usize)],
    ) -> Result<Vec<String>, CatalogError> {
        let base = self.base()?;
        self.load_rows(rows)?;
        let Some(delta) = &self.delta else {
            return rows
                .iter()
                .map(|(_, id)| base.bundle_signature(*id))
                .collect();
        };
        let hidden = self.hidden();
        let stems = rows
            .iter()
            .map(|(segment, id)| {
                let path = if *segment == Segment::Base {
                    base
                } else {
                    delta
                }
                .path(*id)?;
                Ok(path.rsplit_once('.').map_or(path, |(stem, _)| stem))
            })
            .collect::<Result<Vec<_>, CatalogError>>()?;
        // Every sidecar of the page's packages sorts at or after the least `stem.` and before the
        // greatest `stem/`, so only that run of the other segment can hold one.
        let lowest = stems
            .iter()
            .min_by(|a, b| cmp_joined(a, b'.', b, b'.'))
            .copied();
        let highest = stems
            .iter()
            .max_by(|a, b| cmp_joined(a, b'/', b, b'/'))
            .copied();
        let window = |rows: &Snapshot| -> Result<std::ops::Range<usize>, CatalogError> {
            Ok(match (lowest, highest) {
                (Some(lowest), Some(highest)) => {
                    let start = rows.before_joined(0..rows.row_count, lowest, b'.')?;
                    start..rows.before_joined(start..rows.row_count, highest, b'/')?
                }
                _ => 0..0,
            })
        };
        let (base_window, delta_window) = (window(base)?, window(delta)?);
        let mut signatures = Vec::with_capacity(rows.len());
        for ((segment, id), stem) in rows.iter().zip(stems) {
            let (own, own_hidden, other, other_hidden, other_window) = match segment {
                Segment::Base => (base, Some(hidden), delta, None, &delta_window),
                Segment::Delta => (delta, None, base, Some(hidden), &base_window),
            };
            let entry = own.entry(*id)?;
            let mut parts = [Some((entry.size, entry.modified_nanos)), None, None, None];
            own.neighbour_parts(*id, stem, own_hidden, &mut parts)?;
            if !other_window.is_empty() {
                let start = other.before_joined(other_window.clone(), stem, b'.')?;
                other.run_parts(start, stem, other_hidden, &mut parts)?;
            }
            signatures.push(bundle_signature(parts));
        }
        Ok(signatures)
    }

    /// The decoded records of `rows` (in any order), each handed to `visit` with its position in
    /// `rows`, its segment and id, and the segment's shared strings.
    pub(super) fn records(
        &self,
        rows: &[(Segment, usize)],
        mut visit: impl FnMut(
            usize,
            Segment,
            usize,
            Option<HeaderView<'_>>,
            &Snapshot,
        ) -> Result<(), CatalogError>,
    ) -> Result<(), CatalogError> {
        for segment in [Segment::Base, Segment::Delta] {
            // A page lists each segment's rows in path order, which is their id order.
            let (mut positions, mut ids) = (Vec::new(), Vec::with_capacity(rows.len()));
            for (position, (row_segment, id)) in rows.iter().enumerate() {
                if *row_segment == segment {
                    positions.push(position);
                    ids.push(*id);
                }
            }
            if ids.is_empty() {
                continue;
            }
            if !ids.is_sorted() {
                let mut pairs = ids.into_iter().zip(positions).collect::<Vec<_>>();
                pairs.sort_unstable();
                (ids, positions) = pairs.into_iter().unzip();
            }
            let snapshot = self.rows(segment)?;
            let mut next = 0;
            snapshot.records(&ids, |id, header| {
                let position = positions
                    .get(next)
                    .filter(|_| ids.get(next) == Some(&id))
                    .copied()
                    .ok_or_else(|| corrupt("records arrived out of order"))?;
                next += 1;
                visit(position, segment, id, header, snapshot)
            })?;
        }
        Ok(())
    }

    /// Distinct live packages matching any of `filters`.
    pub(super) fn count(&self, filters: &[QueryKind]) -> Result<u64, CatalogError> {
        // Every filter matches only packages, so an inventory filter matches every live one.
        if filters
            .iter()
            .any(|filter| matches!(filter, QueryKind::Inventory))
        {
            return self
                .counts()
                .map(|(packages, _)| packages)
                .ok_or_else(|| corrupt("tombstone counts exceed the base"));
        }
        self.base()?;
        let hidden = self.hidden();
        let mut count = 0;
        for (snapshot, hides) in std::iter::once((&self.base, true))
            .chain(self.delta.as_ref().map(|delta| (delta, false)))
        {
            // One byte per row bounds union memory independently of match count.
            let mut matched = vec![false; snapshot.row_count];
            for filter in filters {
                for id in snapshot.matches(filter, 0, snapshot.row_count)? {
                    if !matched[id] && !(hides && hidden.hides(id)) {
                        matched[id] = true;
                        count += 1;
                    }
                }
            }
        }
        Ok(count)
    }

    /// The position of a row in the generation's path order.
    fn rank(&self, segment: Segment, id: usize) -> Result<u32, CatalogError> {
        let hidden = self.hidden();
        let rank = match (&self.delta, segment) {
            (None, _) => id,
            (Some(delta), Segment::Base) => {
                let path = self.base()?.path(id)?;
                id - hidden.before(id) + delta.before(path)?
            }
            (Some(_), Segment::Delta) => {
                let path = self.path(Segment::Delta, id)?;
                let before = self.base()?.before(path)?;
                id + before - hidden.before(before)
            }
        };
        u32::try_from(rank).map_err(|_| corrupt("Catalog count exceeds u32"))
    }

    pub(super) fn node(&self, segment: Segment, id: usize) -> Result<MergedNode, CatalogError> {
        Ok(MergedNode {
            rank: self.rank(segment, id)?,
            segment,
            id: u32::try_from(id).map_err(|_| corrupt("Catalog count exceeds u32"))?,
        })
    }
}

/// A package in a merged generation; nodes order by `rank`, their path order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) struct MergedNode {
    rank: u32,
    segment: Segment,
    id: u32,
}

/// One committed generation read as a dependency graph.
pub(super) struct MergedGraph<'a> {
    pub(super) committed: &'a Committed,
    pub(super) mounts: Vec<MountPoint>,
}

impl MergedGraph<'_> {
    fn nodes(
        &self,
        segment: Segment,
        ids: impl IntoIterator<Item = usize>,
    ) -> Result<Vec<MergedNode>, CatalogError> {
        let hidden = self.committed.hidden();
        ids.into_iter()
            .filter(|id| segment == Segment::Delta || !hidden.hides(*id))
            .map(|id| self.committed.node(segment, id))
            .collect()
    }
}

impl DependencyGraph for MergedGraph<'_> {
    type Node = MergedNode;

    fn mount_points(&self) -> &[MountPoint] {
        &self.mounts
    }

    fn package_at(
        &self,
        relative_path: &str,
        ignore_case: bool,
    ) -> Result<Option<MergedNode>, CatalogError> {
        let committed = self.committed;
        if let Some((segment, id)) = committed.row_at(relative_path)?
            && committed.rows(segment)?.entry(id)?.kind == EntryKind::Package
        {
            return committed.node(segment, id).map(Some);
        }
        if !ignore_case {
            return Ok(None);
        }
        let hidden = committed.hidden();
        let mut best: Option<(Segment, usize)> = None;
        for segment in [Segment::Base, Segment::Delta] {
            if segment == Segment::Delta && committed.delta.is_none() {
                continue;
            }
            let rows = committed.rows(segment)?;
            let found = rows
                .package_ids_ignoring_case(relative_path)?
                .into_iter()
                .find(|id| segment == Segment::Delta || !hidden.hides(*id));
            if let Some(id) = found {
                let better = match best {
                    None => true,
                    Some((other, other_id)) => {
                        rows.path(id)? < committed.rows(other)?.path(other_id)?
                    }
                };
                if better {
                    best = Some((segment, id));
                }
            }
        }
        best.map(|(segment, id)| committed.node(segment, id))
            .transpose()
    }

    fn package_path(&self, node: &MergedNode) -> String {
        self.committed
            .path(node.segment, node.id as usize)
            .map(str::to_owned)
            .unwrap_or_default()
    }

    fn evidence(&self, nodes: &[MergedNode]) -> Result<Vec<Option<HeaderEvidence>>, CatalogError> {
        let mut evidence = vec![None; nodes.len()];
        for segment in [Segment::Base, Segment::Delta] {
            let mut ids = nodes
                .iter()
                .enumerate()
                .filter(|(_, node)| node.segment == segment)
                .map(|(position, node)| (node.id as usize, position))
                .collect::<Vec<_>>();
            if ids.is_empty() {
                continue;
            }
            ids.sort_unstable();
            let sorted = ids.iter().map(|(id, _)| *id).collect::<Vec<_>>();
            let headers = self.committed.rows(segment)?.headers(&sorted)?;
            for ((_, position), header) in ids.into_iter().zip(headers) {
                evidence[position] = header;
            }
        }
        Ok(evidence)
    }

    fn referrers(&self, package_names: &[String]) -> Result<Vec<MergedNode>, CatalogError> {
        let mut nodes = self.nodes(Segment::Base, self.committed.base.referrers(package_names)?)?;
        if let Some(delta) = &self.committed.delta {
            nodes.extend(self.nodes(Segment::Delta, delta.referrers(package_names)?)?);
        }
        Ok(nodes)
    }

    fn class_members(
        &self,
        classes: &[String],
    ) -> Result<std::collections::HashSet<MergedNode>, CatalogError> {
        let mut members = std::collections::HashSet::new();
        for segment in [Segment::Base, Segment::Delta] {
            if segment == Segment::Delta && self.committed.delta.is_none() {
                continue;
            }
            let snapshot = self.committed.segment(segment)?;
            let mut last = LastBlock::default();
            let mut ids = Vec::new();
            for class in classes {
                if let Some(id) = snapshot.string_id(class)?
                    && let Some(index) = snapshot.posting_index(CLASS_POSTINGS, id)?
                {
                    ids.extend(snapshot.posting_ids_reusing(&mut last, index)?);
                }
            }
            members.extend(self.nodes(segment, ids)?);
        }
        Ok(members)
    }
}

/// A base row found by a lookup: its id, path and entry.
pub(super) type FoundRow = (usize, String, InventoryEntry);

impl Snapshot {
    /// The rows whose paths start with `prefix`, in path order; only their chunks are decoded.
    pub(super) fn rows_with_prefix(&self, prefix: &str) -> Result<Vec<FoundRow>, CatalogError> {
        let mut found = Vec::new();
        let mut id = self.before(prefix)?;
        while id < self.row_count {
            let (path, entry) = self.row(id)?;
            if !path.starts_with(prefix) {
                break;
            }
            found.push((id, path.to_owned(), entry.clone()));
            id += 1;
        }
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joined_comparisons_order_as_the_built_strings_do() {
        let values = [
            "", "A", "A.", "A-", "A.b", "A/", "A0", "AB", "A.uasset", "B", "Ab",
        ];
        for a in values {
            for b in values {
                for (left, right) in [(b'.', b'.'), (b'/', b'/'), (b'.', b'/'), (b'/', b'.')] {
                    let built =
                        format!("{a}{}", left as char).cmp(&format!("{b}{}", right as char));
                    assert_eq!(cmp_joined(a, left, b, right), built, "{a:?} {b:?}");
                }
                for joint in *b"./" {
                    let built = format!("{b}{}", joint as char);
                    assert_eq!(
                        path_before_joined(a, b, joint),
                        a < built.as_str(),
                        "{a:?} {b:?}"
                    );
                }
            }
        }
    }
}
