//! Compiled native predicates. Hot scans use numeric columns, without crossing into JavaScript.
use crate::engine_places::{Places, Prefix};
use crate::engine_query::EngineQuery;
use crate::engine_rows::RowSet;
use crate::engine_types::*;
use crate::engine_where::{At, Context, Test};
use crate::rules::FindingRows;
use crate::text_problem;
use crate::{Error, ErrorCode, Result, require};
use std::collections::HashSet;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub(crate) fn checkpoint(cancelled: &AtomicBool) -> Result<()> {
    require(
        !cancelled.load(Ordering::Relaxed),
        Error::new(ErrorCode::Cancelled, "Game Text query was cancelled."),
    )
}

type Column = Arc<[u32]>;

fn text_matches(value: &str, terms: &[String]) -> bool {
    let value = crate::wtf8::Wtf8Buf::from_view(value).to_utf16();
    terms.iter().all(|term| {
        let term = crate::wtf8::Wtf8Buf::from_view(term).to_utf16();
        term.is_empty() || value.windows(term.len()).any(|window| window == term)
    })
}
fn ranges(starts: &[u32], ends: &[u32], len: usize, count: usize) -> Result<()> {
    require(
        starts.len() == count
            && ends.len() == count
            && starts
                .iter()
                .zip(ends)
                .all(|(begin, end)| begin <= end && *end as usize <= len),
        "Invalid query ranges.",
    )
}
fn length(values: &[u32], count: usize) -> Result<()> {
    require(values.len() == count, "Inconsistent query column lengths.")
}

fn permutation(values: &[u32], count: usize, cancelled: &AtomicBool) -> Result<()> {
    length(values, count)?;
    let mut seen = vec![false; count];
    for (index, row) in values.iter().enumerate() {
        if index & 255 == 0 {
            checkpoint(cancelled)?;
        }
        let seen = seen
            .get_mut(*row as usize)
            .ok_or("Query order row outside projection.")?;
        require(!*seen, "Query order contains duplicate rows.")?;
        *seen = true;
    }
    Ok(())
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn query_orders_are_complete_permutations_and_validate_cancellation() -> Result<()> {
        let cancelled = AtomicBool::new(false);
        permutation(&[2, 0, 1], 3, &cancelled)?;
        for values in [&[0, 0, 2][..], &[0, 1][..], &[0, 1, 3][..]] {
            assert!(permutation(values, 3, &cancelled).is_err());
        }
        assert_eq!(
            permutation(&[0], 1, &AtomicBool::new(true))
                .err()
                .ok_or("Expected cancellation")?
                .code,
            ErrorCode::Cancelled
        );
        Ok(())
    }
}

pub(crate) struct Rows {
    pub visible: Column,
    pub signals: Column,
    pub origins: Column,
    pub editing: Column,
    pub notes: Column,
    pub audience: Column,
    pub identity: Column,
    namespace_defined: Vec<bool>,
    pub namespace: Column,
    pub member_start: Column,
    pub member_end: Column,
    pub members: Column,
    pub source_start: Column,
    pub source_end: Column,
    pub sources: Column,
    pub file_start: Column,
    pub file_end: Column,
    pub files: Column,
    pub order: Column,
}
impl Rows {
    fn open(query: &EngineQuery, kind: &str, cancelled: &AtomicBool) -> Result<Self> {
        let mut rows = Self {
            visible: query.column(kind, "visible")?,
            signals: query.column(kind, "signals")?,
            origins: query.column(kind, "origins")?,
            editing: query.column(kind, "editing")?,
            notes: query.column(kind, "notes")?,
            audience: query.column(kind, "audience")?,
            identity: query.column(kind, "identity")?,
            namespace_defined: Vec::new(),
            namespace: query.column(kind, "namespace")?,
            member_start: query.column(kind, "member_start")?,
            member_end: query.column(kind, "member_end")?,
            members: query.column(kind, "members")?,
            source_start: query.column(kind, "source_start")?,
            source_end: query.column(kind, "source_end")?,
            sources: query.column(kind, "sources")?,
            file_start: query.column(kind, "file_start")?,
            file_end: query.column(kind, "file_end")?,
            files: query.column(kind, "files")?,
            order: if kind == "raw" {
                query.column(kind, "order")?
            } else {
                Arc::from([])
            },
        };
        let count = rows.visible.len();
        for column in [
            &rows.signals,
            &rows.origins,
            &rows.editing,
            &rows.notes,
            &rows.audience,
            &rows.identity,
            &rows.namespace,
        ] {
            length(column, count)?;
        }
        ranges(
            &rows.member_start,
            &rows.member_end,
            rows.members.len(),
            count,
        )?;
        ranges(
            &rows.source_start,
            &rows.source_end,
            rows.sources.len(),
            count,
        )?;
        ranges(&rows.file_start, &rows.file_end, rows.files.len(), count)?;
        if kind == "raw" {
            permutation(&rows.order, count, cancelled)?;
        }
        // Saved resolved/String Table identities with an empty key are presented as unresolved.
        // Namespace predicates and groups must use that same interpretation, including old joins.
        let representatives = query.column(kind, "representative")?;
        length(&representatives, count)?;
        let keys = (0..query.package_count())
            .map(|shard| query.package_column(shard, "occurrence.key"))
            .collect::<Result<Vec<_>>>()?;
        let empty_ids = query.reader.empty_string_ids()?;
        for (row, member) in representatives.iter().enumerate() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let (shard, occurrence) = query.package_coordinate(*member as usize)?;
            let key = keys[shard]
                .get(occurrence)
                .ok_or("Namespace occurrence row")?;
            rows.namespace_defined
                .push(rows.identity[row] < 2 && !empty_ids.contains(key));
        }
        Ok(rows)
    }
    pub fn members(&self, row: usize) -> &[u32] {
        &self.members[self.member_start[row] as usize..self.member_end[row] as usize]
    }
    pub fn files(&self, row: usize) -> &[u32] {
        &self.files[self.file_start[row] as usize..self.file_end[row] as usize]
    }
    pub fn sources(&self, row: usize) -> &[u32] {
        &self.sources[self.source_start[row] as usize..self.source_end[row] as usize]
    }
    /// Whether a row's identity is resolved: saved with a namespace and a non-empty key.
    pub fn resolved(&self, row: usize) -> bool {
        self.namespace_defined[row]
    }
}

pub(crate) struct Culture {
    pub state: Column,
    pub facts: Column,
    pub reasons: Column,
    pub review: Column,
    pub review_record: Column,
}

pub(crate) struct Projection {
    empty_ids: Arc<std::collections::BTreeSet<u32>>,
    pub raw: Rows,
    pub slice: Rows,
    pub(crate) slice_raw: Column,
    pub(crate) slice_line: Column,
    pub starts: Column,
    pub order: Column,
    pub source: Column,
    pub source_visible: Column,
    pub notes: Column,
    pub origins: Column,
    pub editing: Column,
    pub audience: Column,
    pub key_change: Column,
    pub key: Column,
    pub namespace: Column,
    pub file_start: Column,
    pub file_end: Column,
    pub files: Column,
    pub manifest_start: Column,
    pub manifest_end: Column,
    pub manifest: Column,
    pub flags: Vec<u32>,
    pub saved_visible: Vec<bool>,
    pub cultures: Vec<Culture>,
}
impl Projection {
    /// Heap bytes of the projection's columns.
    pub(crate) fn bytes(&self) -> usize {
        let rows = |rows: &Rows| {
            [
                &rows.visible,
                &rows.signals,
                &rows.origins,
                &rows.editing,
                &rows.notes,
                &rows.audience,
                &rows.identity,
                &rows.namespace,
                &rows.member_start,
                &rows.member_end,
                &rows.members,
                &rows.source_start,
                &rows.source_end,
                &rows.sources,
                &rows.file_start,
                &rows.file_end,
                &rows.files,
                &rows.order,
            ]
            .iter()
            .map(|column| column.len() * 4)
            .sum::<usize>()
                + rows.namespace_defined.capacity()
        };
        rows(&self.raw)
            + rows(&self.slice)
            + [
                &self.slice_raw,
                &self.slice_line,
                &self.starts,
                &self.order,
                &self.source,
                &self.source_visible,
                &self.notes,
                &self.origins,
                &self.editing,
                &self.audience,
                &self.key_change,
                &self.key,
                &self.namespace,
                &self.file_start,
                &self.file_end,
                &self.files,
                &self.manifest_start,
                &self.manifest_end,
                &self.manifest,
            ]
            .iter()
            .map(|column| column.len() * 4)
            .sum::<usize>()
            + self.flags.capacity() * 4
            + self.saved_visible.capacity()
            + self
                .cultures
                .iter()
                .map(|culture| {
                    (culture.state.len()
                        + culture.facts.len()
                        + culture.reasons.len()
                        + culture.review.len()
                        + culture.review_record.len())
                        * 4
                })
                .sum::<usize>()
    }
    pub fn open(query: &EngineQuery, cancelled: &AtomicBool) -> Result<Arc<Self>> {
        if let Some(value) = query.projection.get() {
            return Ok(value);
        }
        checkpoint(cancelled)?;
        let raw = Rows::open(query, "raw", cancelled)?;
        let slice = Rows::open(query, "slice", cancelled)?;
        let slice_raw = query.column("slice", "raw")?;
        let slice_line = query.column("slice", "line")?;
        length(&slice_raw, slice.visible.len())?;
        length(&slice_line, slice.visible.len())?;
        for (index, row) in slice_raw.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            require(
                (*row as usize) < raw.visible.len(),
                "Slice points outside raw units.",
            )?;
        }
        let starts = query.column("line", "starts")?;
        let source = query.reader.column("line.source")?;
        let count = source.len();
        require(
            starts.len() == count + 1
                && starts.first() == Some(&0)
                && starts.last() == Some(&(slice.visible.len() as u32))
                && starts.windows(2).all(|pair| pair[0] <= pair[1]),
            "Invalid line slice ranges.",
        )?;
        let mut flags = vec![0; count];
        let mut saved_visible = vec![false; count];
        for row in 0..count {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            for sr in starts[row] as usize..starts[row + 1] as usize {
                require(
                    slice_line[sr] as usize == row,
                    "Slice belongs to a different localization line.",
                )?;
                if slice.visible[sr] != 0 {
                    flags[row] |= slice.signals[sr];
                    saved_visible[row] = true;
                }
            }
        }
        let mut cultures = Vec::new();
        for ci in 0..query.cultures.len() {
            cultures.push(Culture {
                state: query.reader.column(&format!("c{ci}.state"))?,
                facts: query.reader.column(&format!("c{ci}.facts"))?,
                reasons: query.reader.column(&format!("c{ci}.reasons"))?,
                review: query.reader.column(&format!("c{ci}.review"))?,
                review_record: query.reader.column(&format!("c{ci}.review_record"))?,
            });
        }
        let result = Arc::new(Self {
            empty_ids: query.reader.empty_string_ids()?,
            raw,
            slice,
            slice_raw,
            slice_line,
            starts,
            source,
            flags,
            saved_visible,
            cultures,
            order: query.column("line", "order")?,
            source_visible: query.reader.column("line.source_visible")?,
            notes: query.reader.column("line.notes")?,
            origins: query.reader.column("line.origins")?,
            editing: query.reader.column("line.editing")?,
            audience: query.reader.column("line.audience")?,
            key_change: query.reader.column("line.key_change")?,
            key: query.reader.column("line.key")?,
            namespace: query.reader.column("line.namespace")?,
            file_start: query.reader.column("line.file_start")?,
            file_end: query.reader.column("line.file_end")?,
            files: query.reader.column("facet.files")?,
            manifest_start: query.reader.column("line.manifest_start")?,
            manifest_end: query.reader.column("line.manifest_end")?,
            manifest: query.reader.column("manifest.rows")?,
        });
        for column in [
            &result.source_visible,
            &result.notes,
            &result.origins,
            &result.editing,
            &result.audience,
            &result.key_change,
            &result.key,
            &result.namespace,
        ] {
            length(column, count)?;
        }
        permutation(&result.order, count, cancelled)?;
        ranges(
            &result.file_start,
            &result.file_end,
            result.files.len(),
            count,
        )?;
        ranges(
            &result.manifest_start,
            &result.manifest_end,
            result.manifest.len(),
            count,
        )?;
        for culture in &result.cultures {
            for column in [
                &culture.state,
                &culture.facts,
                &culture.reasons,
                &culture.review,
                &culture.review_record,
            ] {
                length(column, count)?;
            }
            require(
                culture
                    .state
                    .iter()
                    .all(|state| (*state as usize) < STATES.len()),
                "Unknown stored localization state.",
            )?;
        }
        Ok(query.projection.store(result))
    }
    pub fn review(&self, query: &EngineQuery, row: usize, ci: usize) -> Result<u32> {
        let c = &self.cultures[ci];
        let flags = if c.review[row] == 2 {
            query.reader.meta["input"]["review"]["records"]
                .get(
                    c.review_record[row]
                        .checked_sub(1)
                        .ok_or("Invalid review record.")? as usize,
                )
                .and_then(|record| record["flags"].as_array())
                .ok_or("Missing review flags.")?
                .as_slice()
        } else {
            &[]
        };
        let has = |value: &str| flags.iter().any(|flag| flag.as_str() == Some(value));
        let reviewable = matches!(c.state[row], 0 | 2 | 3);
        Ok(if has("reviewed") {
            1
        } else if reviewable {
            2
        } else {
            0
        } | if reviewable && !has("proofread") {
            4
        } else {
            0
        } | if c.review[row] == 3 { 8 } else { 0 }
            | if has("machine_translated") { 16 } else { 0 })
    }
    /// A line's problems in the cultures of `scope`, as `textProblems` reports them, with
    /// `finding` when a rule that counts has a finding on it.
    pub fn problem(&self, row: usize, scope: &[usize], finding: bool) -> u32 {
        let key_change = self.key_change[row];
        let mut bits = if key_change > 0 && key_change & 1 == 0 {
            text_problem::KEY_CHANGED
        } else {
            0
        } | text_problem::signals(self.flags[row])
            | if finding { text_problem::FINDING } else { 0 };
        for ci in scope {
            let c = &self.cultures[*ci];
            bits |= text_problem::culture(c.state[row], c.facts[row], c.reasons[row]);
        }
        text_problem::settle(bits)
    }
}

/// Rows whose gathered identity is one of a translation-key clause's values.
/// The lines with one of some translation keys, and the saved units with a slice of one.
#[derive(Default)]
pub(crate) struct TranslationRows {
    pub lines: HashSet<u32>,
    pub raw: HashSet<u32>,
}

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Raw,
    Slice,
    Line,
}
impl Projection {
    pub(crate) fn rows(&self, kind: Kind) -> &Rows {
        if matches!(kind, Kind::Raw) {
            &self.raw
        } else {
            &self.slice
        }
    }
    pub fn each_file(
        &self,
        kind: Kind,
        row: usize,
        visit: &mut impl FnMut(u32) -> Result<bool>,
    ) -> Result<bool> {
        if matches!(kind, Kind::Line) {
            if self.starts[row] != self.starts[row + 1] {
                for sr in self.starts[row] as usize..self.starts[row + 1] as usize {
                    if self.slice.visible[sr] != 0 {
                        for file in self.slice.files(sr) {
                            if visit(*file)? {
                                return Ok(true);
                            }
                        }
                    }
                }
            } else {
                for file in &self.files[self.file_start[row] as usize..self.file_end[row] as usize]
                {
                    if visit(*file)? {
                        return Ok(true);
                    }
                }
            }
        } else {
            for file in self.rows(kind).files(row) {
                if visit(*file)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    pub(crate) fn has_file(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        wanted: &HashSet<u32>,
    ) -> Result<bool> {
        self.each_file(kind, row, &mut |file| {
            Ok(wanted.contains(&places.asset(file)?))
        })
    }
    pub(crate) fn path_matches(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        prefix: &Prefix,
    ) -> Result<bool> {
        if matches!(kind, Kind::Line) {
            for sr in self.starts[row] as usize..self.starts[row + 1] as usize {
                if self.slice.visible[sr] != 0
                    && self.path_matches(places, Kind::Slice, sr, prefix)?
                {
                    return Ok(true);
                }
            }
            for entry in
                &self.manifest[self.manifest_start[row] as usize..self.manifest_end[row] as usize]
            {
                if places.manifest_matches(*entry, prefix)? {
                    return Ok(true);
                }
            }
        } else {
            for member in self.rows(kind).members(row) {
                let object = *places
                    .objects
                    .get(*member as usize)
                    .ok_or("Occurrence object outside index.")?;
                let package = *places
                    .packages
                    .get(*member as usize)
                    .ok_or("Occurrence package outside index.")?;
                if places.path_matches(object, prefix)? || places.path_matches(package, prefix)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
    /// Lines are keyed by gathered identity, so a key selects lines by their own namespace and
    /// key. A saved unit has a key when one of its slices belongs to such a line.
    pub(crate) fn translation_rows(
        &self,
        query: &EngineQuery,
        places: &Places,
        keys: &[(String, String)],
        cancelled: &AtomicBool,
    ) -> Result<TranslationRows> {
        // A resolved line's ID ends with its identity's JSON, so keys compare as bytes rather
        // than decoding every key string in a namespace.
        let mut wanted = std::collections::HashMap::<u32, Vec<Vec<u8>>>::new();
        for (namespace, key) in keys {
            let identity = crate::wtf8::view_json(&serde_json::json!([namespace, key]))?;
            for label in places.labels(std::slice::from_ref(namespace), false) {
                wanted
                    .entry(label)
                    .or_default()
                    .push(crate::wtf8::Wtf8Buf::from_utf8(&identity).into_bytes());
            }
        }
        let mut rows = TranslationRows::default();
        if wanted.is_empty() {
            return Ok(rows);
        }
        let starts = query.identity_starts("line")?;
        let ids = query.reader.bytes("query.line.id_utf8")?;
        for row in 0..self.source.len() {
            if row & 255 == 0 {
                checkpoint(cancelled)?;
            }
            // Only resolved lines have a namespace; unresolved IDs never end in an identity.
            let Some(identities) = self
                .namespace(places, Kind::Line, row)?
                .and_then(|label| wanted.get(&label))
            else {
                continue;
            };
            let id = ids
                .get(starts[row] as usize..starts[row + 1] as usize)
                .ok_or("Invalid identity byte range.")?;
            if identities.iter().any(|identity| id.ends_with(identity)) {
                rows.lines.insert(row as u32);
            }
        }
        for (raw, line) in self.slice_raw.iter().zip(self.slice_line.iter()) {
            if rows.lines.contains(line) {
                rows.raw.insert(*raw);
            }
        }
        Ok(rows)
    }
    pub fn namespace(&self, places: &Places, kind: Kind, row: usize) -> Result<Option<u32>> {
        let (defined, id) = if matches!(kind, Kind::Line) {
            (
                !(self.starts[row] != self.starts[row + 1]
                    && self.empty_ids.contains(&self.key[row])),
                self.namespace[row],
            )
        } else {
            let rows = self.rows(kind);
            (rows.namespace_defined[row], rows.namespace[row])
        };
        if defined {
            Ok(Some(places.namespace(id)?))
        } else {
            Ok(None)
        }
    }
}

impl EngineQuery {
    /// The selection's rows, in display order.
    pub fn matching(&self, selection: &Selection, cancelled: &AtomicBool) -> Result<Arc<[u32]>> {
        checkpoint(cancelled)?;
        Ok(self.match_rows(selection, cancelled)?.into())
    }

    /// Every row's problems in a culture scope, with `finding` from the counted rows of a
    /// findings layer: a line's with a target, a unit's (`textProblems` without marks) without
    /// one. Built once and read by the `problem` clause, problem counts and every group and
    /// facet tally.
    pub(crate) fn problem_column(
        &self,
        localized: bool,
        scope: &[usize],
        findings: Option<&FindingRows>,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        let key = format!(
            "{localized}|{scope:?}|{}",
            findings.map_or("", |findings| findings.key.as_str())
        );
        if let Some(column) = self.problem_columns.get(&key) {
            return Ok(column);
        }
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchProblemColumn");
        let p = Projection::open(self, cancelled)?;
        let len = if localized {
            p.source.len()
        } else {
            p.raw.visible.len()
        };
        let mut column = Vec::with_capacity(len);
        for row in 0..len {
            if row & 4095 == 0 {
                checkpoint(cancelled)?;
            }
            let finding = findings.is_some_and(|findings| findings.counted.contains(row));
            column.push(p.row_problem(localized, row, scope, finding));
        }
        let column: Arc<[u32]> = column.into();
        // A few scopes are live at once; past that, columns are rebuilt as they are asked for.
        Ok(self.problem_columns.with(|columns| {
            if columns.len() >= 8 {
                columns.clear();
            }
            Arc::clone(columns.entry(key).or_insert(column))
        }))
    }

    /// An atom's set, from the cache or evaluated over every row.
    fn atom(&self, key: String, evaluate: impl FnOnce(&Self) -> Result<RowSet>) -> Result<RowSet> {
        if let Some(set) = self.atoms.lock().get(&key) {
            return Ok(set);
        }
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchAtom");
        let set = evaluate(self)?;
        self.atoms.lock().insert(key, set.clone());
        Ok(set)
    }

    /// A selection's findings layer rows, in its relation and culture scope.
    pub(crate) fn request_findings(
        &self,
        selection: &Selection,
        cancelled: &AtomicBool,
    ) -> Result<Option<Arc<FindingRows>>> {
        let Some(findings) = &selection.findings else {
            return Ok(None);
        };
        let scope = self.culture_scope(selection)?;
        Ok(Some(self.finding_rows(
            findings,
            selection.localized(),
            &scope,
            cancelled,
        )?))
    }

    /// The intersection of the selection's atoms: its text, its visible rows and each conjunct of
    /// its `where`. Each atom is keyed by what it reads: the relation, the culture scope where it
    /// depends on it, and the findings layer it reads.
    fn match_rows(&self, selection: &Selection, cancelled: &AtomicBool) -> Result<Vec<u32>> {
        #[cfg(feature = "benchmark-timings")]
        let _span = crate::benchmark_timings::Span::new("searchMatch");
        let plan = selection.plan()?;
        checkpoint(cancelled)?;
        let localized = selection.localized();
        let scope = self.culture_scope(selection)?;
        let projection = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let relation = if localized { "line" } else { "raw" };
        let (len, order) = if localized {
            (projection.source.len(), Arc::clone(&projection.order))
        } else {
            (
                projection.raw.visible.len(),
                Arc::clone(&projection.raw.order),
            )
        };
        let query = selection
            .text
            .as_ref()
            .map_or("", |text| text.query.as_str());
        let lowered = query.to_lowercase();
        let wanted = lowered
            .split(crate::join_policy::js_space)
            .filter(|term| !term.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        // Translations are searched only when the selection names its cultures.
        let search_translations = selection
            .text
            .as_ref()
            .is_some_and(|text| text.translations == Some(true))
            && (selection.culture.is_some() || selection.cultures.is_some());
        let findings = self.request_findings(selection, cancelled)?;
        let mut sets = Vec::new();
        if !wanted.is_empty() && search_translations {
            // Each term is in the line's source, an in-scope culture's archive translation, or its
            // PO text when that is not synced: today's joined-string test, term by term.
            let p = Arc::clone(&projection);
            sets.push(self.atom(
                format!(
                    "line|translated-text|{}|{scope:?}",
                    serde_json::to_string(&lowered)?
                ),
                |query| {
                    let mut terms = Vec::with_capacity(wanted.len());
                    for term in &wanted {
                        terms.push((
                            query.source_matches(term, cancelled)?,
                            query.translation_matches(term, cancelled)?,
                        ));
                    }
                    let mut texts = Vec::with_capacity(scope.len());
                    for ci in &scope {
                        texts.push((*ci, query.culture_translations(*ci, cancelled)?));
                    }
                    let hit = |matches: &[u8], text: u32| {
                        text != 0 && matches.get(text as usize - 1) == Some(&1)
                    };
                    RowSet::from_fn(len, cancelled, |row| {
                        Ok(terms.iter().all(|(sources, translations)| {
                            sources.get(p.source[row] as usize) == Some(&1)
                                || texts.iter().any(|(ci, texts)| {
                                    hit(translations, texts.0[row])
                                        || (p.cultures[*ci].facts[row] & 8 != 0
                                            && hit(translations, texts.1[row]))
                                })
                        }))
                    })
                },
            )?);
        }
        if !wanted.is_empty() && !search_translations {
            let matches = self.source_matches(query, cancelled)?;
            let p = Arc::clone(&projection);
            sets.push(self.atom(
                format!("{relation}|text|{}", serde_json::to_string(&lowered)?),
                |query| {
                    RowSet::from_fn(len, cancelled, |row| {
                        if localized {
                            return Ok(matches.get(p.source[row] as usize) == Some(&1));
                        }
                        let sources = p.raw.sources(row);
                        if sources.len() == 1 {
                            return Ok(matches.get(sources[0] as usize) == Some(&1));
                        }
                        let source = query.reader.strings(sources)?.join(" ").to_lowercase();
                        Ok(text_matches(&source, &wanted))
                    })
                },
            )?);
        }
        // A visible row: a line whose source is visible, and with saved places, one of them is;
        // a unit that is visible.
        let p = Arc::clone(&projection);
        sets.push(self.atom(format!("{relation}|visible"), |_| {
            RowSet::from_fn(len, cancelled, |row| {
                Ok(if localized {
                    p.source_visible[row] != 0
                        && (p.starts[row] == p.starts[row + 1] || p.saved_visible[row])
                } else {
                    p.raw.visible[row] != 0
                })
            })
        })?);
        let kind = if localized { Kind::Line } else { Kind::Raw };
        let findings_key = findings
            .as_ref()
            .map_or("", |findings| findings.key.as_str());
        for conjunct in plan
            .map(crate::engine_where::Node::conjuncts)
            .unwrap_or_default()
        {
            let key = format!(
                "{relation}|where|{}|{}|{}",
                serde_json::to_string(&conjunct)?,
                if localized && conjunct.reads_scope() {
                    format!("{scope:?}")
                } else {
                    String::new()
                },
                if conjunct.reads_findings() {
                    findings_key
                } else {
                    ""
                }
            );
            let p = Arc::clone(&projection);
            let at = Arc::clone(&places);
            sets.push(self.atom(key, |query| {
                let context = Context {
                    query,
                    projection: &p,
                    places: &at,
                    scope: &scope,
                    localized,
                    findings: findings.as_deref(),
                    cancelled,
                };
                let test = Test::compile(&conjunct, &context)?;
                RowSet::from_fn(len, cancelled, |row| {
                    test.holds(&context, At::Row(kind, row))
                })
            })?);
        }
        RowSet::intersection(len, &sets)?.in_order(&order, cancelled)
    }
}
