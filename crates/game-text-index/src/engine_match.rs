//! Compiled native predicates. Hot scans use numeric columns, without crossing into JavaScript.
use crate::engine_asset_types::AssetTypes;
use crate::engine_places::{Places, Prefix};
use crate::engine_query::{EngineQuery, audience, mask};
use crate::engine_rows::RowSet;
use crate::engine_types::*;
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
    fn open(query: &mut EngineQuery, kind: &str, cancelled: &AtomicBool) -> Result<Self> {
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
    slice_raw: Column,
    slice_line: Column,
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
    pub fn open(query: &mut EngineQuery, cancelled: &AtomicBool) -> Result<Arc<Self>> {
        if let Some(value) = &query.projection {
            return Ok(Arc::clone(value));
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
        query.projection = Some(Arc::clone(&result));
        Ok(result)
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
    /// A line's problems in the cultures of `scope`, as `textProblems` reports them.
    pub fn problem(&self, row: usize, scope: &[usize], counted: u32) -> u32 {
        let key_change = self.key_change[row];
        let mut bits = if key_change > 0 && key_change & 1 == 0 {
            text_problem::KEY_CHANGED
        } else {
            0
        } | text_problem::signals(self.flags[row], counted);
        for ci in scope {
            let c = &self.cultures[*ci];
            bits |= text_problem::culture(c.state[row], c.facts[row], c.reasons[row]);
        }
        text_problem::settle(bits)
    }
}

/// Rows whose gathered identity is one of a translation-key clause's values.
#[derive(Default)]
struct TranslationRows {
    lines: HashSet<u32>,
    raw: HashSet<u32>,
}
struct PreparedClause {
    field: FilterField,
    op: FilterOp,
    mask: u32,
    labels: HashSet<u32>,
    prefixes: Vec<Prefix>,
    translation: TranslationRows,
    sources: HashSet<u32>,
    /// The asset types and which of them the clause names, for `asset_type` clauses.
    asset_types: Option<(Arc<AssetTypes>, Vec<bool>)>,
    /// Every row's problems in the clause's scope, for `problem` clauses.
    problems: Option<Arc<[u32]>>,
}
impl PreparedClause {
    fn new(
        query: &mut EngineQuery,
        projection: &Projection,
        clause: &Clause,
        places: &Places,
        cancelled: &AtomicBool,
    ) -> Result<Self> {
        let labels: &[&str] = match clause.field {
            FilterField::Problem => &PROBLEMS,
            FilterField::Finding => &SIGNALS,
            FilterField::Translation => &["", "missing", "to_update", "not_synced"],
            FilterField::Origin => &ORIGINS,
            FilterField::Editing => &["editable", "read_only"],
            FilterField::Notes => &["missing", "present"],
            FilterField::Audience => &AUDIENCES,
            _ => &[],
        };
        Ok(Self {
            field: clause.field,
            op: clause.op,
            mask: mask(labels, &clause.values),
            labels: places.labels(&clause.values, clause.field == FilterField::Asset),
            prefixes: if clause.field == FilterField::Folder {
                clause
                    .values
                    .iter()
                    .map(|value| places.prefix(value))
                    .collect::<Result<_>>()?
            } else {
                Vec::new()
            },
            translation: if clause.field == FilterField::TranslationKey {
                projection.translation_rows(query, places, &clause.values, cancelled)?
            } else {
                TranslationRows::default()
            },
            // Each value is looked up in the dictionary once; rows then compare string IDs.
            sources: if clause.field == FilterField::Source {
                query.source_ids(&clause.values)?
            } else {
                HashSet::new()
            },
            asset_types: if clause.field == FilterField::AssetType {
                let types = AssetTypes::open(query, cancelled)?;
                let wanted = types.wanted(&clause.values);
                Some((types, wanted))
            } else {
                None
            },
            problems: None,
        })
    }
}
/// A request's `where` path prefix and changed files, prepared once.
struct Location {
    path: Option<Prefix>,
    files: Option<HashSet<u32>>,
}
impl Location {
    fn new(request: &SearchRequest, places: &Places) -> Result<Self> {
        let location = request.location.as_ref();
        Ok(Self {
            path: location
                .and_then(|scope| scope.path_prefix.as_deref())
                .map(|value| places.prefix(value))
                .transpose()?,
            files: location
                .and_then(|scope| scope.files.as_deref())
                .map(|values| places.labels(values, true)),
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Raw,
    Slice,
    Line,
}
impl Projection {
    fn rows(&self, kind: Kind) -> &Rows {
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
    fn has_file(
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
    fn path_matches(
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
    fn translation_rows(
        &self,
        query: &mut EngineQuery,
        places: &Places,
        values: &[String],
        cancelled: &AtomicBool,
    ) -> Result<TranslationRows> {
        // A resolved line's ID ends with its identity's JSON, so keys compare as bytes rather
        // than decoding every key string in a namespace.
        let mut wanted = std::collections::HashMap::<u32, Vec<Vec<u8>>>::new();
        for value in values {
            let (namespace, key) = translation_key(value)?;
            let identity = crate::wtf8::view_json(&serde_json::json!([namespace, key]))?;
            for label in places.labels(&[namespace], false) {
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
    /// Whether a row meets one clause, with its operator applied.
    fn clause_holds(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        scope: &[usize],
        clause: &PreparedClause,
    ) -> Result<bool> {
        let line = matches!(kind, Kind::Line);
        let rows = self.rows(kind);
        let flags = if line {
            self.flags[row]
        } else {
            rows.signals[row]
        };
        let has = match clause.field {
            FilterField::Problem => {
                clause
                    .problems
                    .as_ref()
                    .ok_or("Problem clause without its problems.")?[row]
                    & clause.mask
                    != 0
            }
            FilterField::Finding => flags & clause.mask != 0,
            FilterField::Origin => {
                (if line {
                    self.origins[row]
                } else {
                    rows.origins[row]
                }) & clause.mask
                    != 0
            }
            FilterField::Editing => {
                (if line {
                    self.editing[row]
                } else {
                    rows.editing[row]
                }) & clause.mask
                    != 0
            }
            FilterField::Notes => {
                clause.mask
                    & (if (if line {
                        self.notes[row]
                    } else {
                        rows.notes[row]
                    }) != 0
                    {
                        2
                    } else {
                        1
                    })
                    != 0
            }
            FilterField::Audience => {
                let value = audience(if line {
                    self.audience[row]
                } else {
                    rows.audience[row]
                });
                clause.mask
                    & (1 << AUDIENCES
                        .iter()
                        .position(|label| *label == value)
                        .ok_or("Unknown audience.")?)
                    != 0
            }
            FilterField::Translation => {
                line && scope.iter().any(|ci| {
                    let c = &self.cultures[*ci];
                    ((1 << c.state[row]) | (c.facts[row] & 8)) & clause.mask != 0
                })
            }
            FilterField::Folder => {
                let mut has = false;
                for prefix in &clause.prefixes {
                    if self.path_matches(places, kind, row, prefix)? {
                        has = true;
                        break;
                    }
                }
                has
            }
            FilterField::Asset => self.has_file(places, kind, row, &clause.labels)?,
            FilterField::Namespace => self
                .namespace(places, kind, row)?
                .is_some_and(|value| clause.labels.contains(&value)),
            FilterField::TranslationKey => match kind {
                Kind::Line => clause.translation.lines.contains(&(row as u32)),
                Kind::Slice => clause.translation.lines.contains(&self.slice_line[row]),
                Kind::Raw => clause.translation.raw.contains(&(row as u32)),
            },
            FilterField::AssetType => {
                let (types, wanted) = clause
                    .asset_types
                    .as_ref()
                    .ok_or("Asset type clause without types.")?;
                types.each(self, kind, row, &mut |kind| wanted[kind as usize])?
            }
            // A unit with conflicting sources has each of them.
            FilterField::Source => {
                if line {
                    clause.sources.contains(&self.source[row])
                } else {
                    rows.sources(row)
                        .iter()
                        .any(|id| clause.sources.contains(id))
                }
            }
        };
        Ok(has == (clause.op == FilterOp::Is))
    }
    fn scope(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        request: &SearchRequest,
        prepared: &Location,
    ) -> Result<bool> {
        let line = matches!(kind, Kind::Line);
        let rows = self.rows(kind);
        let origins = if line {
            self.origins[row]
        } else {
            rows.origins[row]
        };
        if let Some(kinds) = request
            .location
            .as_ref()
            .and_then(|scope| scope.kinds.as_ref())
            && origins & mask(&ORIGINS, kinds) == 0
        {
            return Ok(false);
        }
        if let Some(prefix) = &prepared.path
            && !self.path_matches(places, kind, row, prefix)?
        {
            return Ok(false);
        }
        if let Some(files) = &prepared.files
            && !self.has_file(places, kind, row, files)?
        {
            return Ok(false);
        }
        Ok(true)
    }
    /// Whether a raw row or a slice is visible and meets the capability, notes, lens and `where`.
    fn eligible(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        request: &SearchRequest,
        prepared: &Location,
    ) -> Result<bool> {
        let rows = self.rows(kind);
        if rows.visible[row] == 0
            || (request.capability == Capability::SourceEditable && rows.editing[row] & 1 == 0)
            || (request.capability == Capability::ReadOnly && rows.editing[row] & 2 == 0)
            || (request.without_notes == Some(true) && rows.notes[row] != 0)
        {
            return Ok(false);
        }
        if let Some(lens) = &request.lens
            && lens != "all"
            && rows.signals[row]
                & (1 << SIGNALS
                    .iter()
                    .position(|value| value == lens)
                    .ok_or("Unknown validated lens.")?)
                == 0
        {
            return Ok(false);
        }
        self.scope(places, kind, row, request, prepared)
    }
}

impl EngineQuery {
    /// The request's rows, in display order.
    pub fn matching(
        &mut self,
        request: &SearchRequest,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        request.validate()?;
        checkpoint(cancelled)?;
        Ok(self.match_rows(request, cancelled)?.into())
    }

    /// Every row's problems in a culture scope, with the findings a request counts: a line's
    /// with a target, a unit's (`textProblems` without marks) without one. Built once and read
    /// by the `problem` clause, problem counts and every group and facet tally.
    pub(crate) fn problem_column(
        &mut self,
        localized: bool,
        scope: &[usize],
        counted: u32,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        let key = format!("{localized}|{scope:?}|{counted}");
        if let Some(column) = self.problem_columns.get(&key) {
            return Ok(Arc::clone(column));
        }
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
            column.push(p.row_problem(localized, row, scope, counted));
        }
        let column: Arc<[u32]> = column.into();
        // A few scopes are live at once; past that, columns are rebuilt as they are asked for.
        if self.problem_columns.len() >= 8 {
            self.problem_columns.clear();
        }
        self.problem_columns.insert(key, Arc::clone(&column));
        Ok(column)
    }

    /// An atom's set, from the cache or evaluated over every row.
    fn atom(
        &mut self,
        key: String,
        evaluate: impl FnOnce(&mut Self) -> Result<RowSet>,
    ) -> Result<RowSet> {
        if let Some(set) = self.atoms.get(&key) {
            return Ok(set);
        }
        let set = evaluate(self)?;
        self.atoms.insert(key, set.clone());
        Ok(set)
    }

    /// The intersection of the request's atoms. Each atom is keyed by what it reads: the
    /// relation, the culture scope where it depends on it, and the findings it counts.
    fn match_rows(&mut self, request: &SearchRequest, cancelled: &AtomicBool) -> Result<Vec<u32>> {
        request.validate()?;
        checkpoint(cancelled)?;
        require(
            request.localization.is_some()
                || !request
                    .filter
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .any(|clause| clause.field == FilterField::Translation),
            invalid("Translation filters need a localization target."),
        )?;
        let localized = request.localization.is_some();
        let scope = self.culture_scope(request.localization.as_ref())?;
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
        let lowered = request.query.to_lowercase();
        let wanted = lowered
            .split(crate::join_policy::js_space)
            .filter(|term| !term.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        // Translations are searched only when the request names its cultures; the text is then
        // checked per remaining line, after every atom, rather than as an atom of its own.
        let search_translations = request.localization.as_ref().is_some_and(|selection| {
            selection.search_translations == Some(true)
                && (selection.culture.is_some() || selection.cultures.is_some())
        });
        let counted = request.counted_findings();
        let scoped = |field: FilterField| {
            if localized && matches!(field, FilterField::Problem | FilterField::Translation) {
                scope.clone()
            } else {
                Vec::new()
            }
        };
        let mut sets = Vec::new();
        if !wanted.is_empty() && !search_translations {
            let matches = self.source_matches(&request.query, cancelled)?;
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
        if localized {
            let p = Arc::clone(&projection);
            sets.push(self.atom("line|visible".into(), |_| {
                RowSet::from_fn(len, cancelled, |row| Ok(p.source_visible[row] != 0))
            })?);
            if let Some(lines) = &request.lines {
                sets.push(self.atom(
                    format!("line|picked|{}", serde_json::to_string(lines)?),
                    |query| {
                        let mut picked = HashSet::new();
                        for id in lines {
                            picked.extend(query.find_id("line", id)?);
                        }
                        RowSet::from_fn(len, cancelled, |row| Ok(picked.contains(&row)))
                    },
                )?);
            }
        }
        for clause in request.filter.as_deref().unwrap_or(&[]) {
            let clause_scope = scoped(clause.field);
            let clause_counted = if clause.field == FilterField::Problem {
                counted
            } else {
                0
            };
            let p = Arc::clone(&projection);
            let at = Arc::clone(&places);
            sets.push(self.atom(
                format!(
                    "{relation}|clause|{}|{clause_scope:?}|{clause_counted}",
                    serde_json::to_string(clause)?
                ),
                |query| {
                    let mut prepared = PreparedClause::new(query, &p, clause, &at, cancelled)?;
                    if clause.field == FilterField::Problem {
                        prepared.problems = Some(query.problem_column(
                            localized,
                            &clause_scope,
                            clause_counted,
                            cancelled,
                        )?);
                    }
                    let kind = if localized { Kind::Line } else { Kind::Raw };
                    RowSet::from_fn(len, cancelled, |row| {
                        p.clause_holds(&at, kind, row, &clause_scope, &prepared)
                    })
                },
            )?);
        }
        let p = Arc::clone(&projection);
        let at = Arc::clone(&places);
        sets.push(self.atom(
            format!(
                "{relation}|eligible|{}",
                serde_json::to_string(&(
                    request.capability,
                    request.without_notes,
                    &request.lens,
                    &request.location
                ))?
            ),
            |_| {
                let location = Location::new(request, &at)?;
                if !localized {
                    return RowSet::from_fn(len, cancelled, |row| {
                        p.eligible(&at, Kind::Raw, row, request, &location)
                    });
                }
                let unrestricted = request.capability == Capability::All
                    && request.without_notes != Some(true)
                    && request.lens.as_ref().is_none_or(|lens| lens == "all")
                    && request.location.is_none();
                RowSet::from_fn(len, cancelled, |row| {
                    // A line with saved places is eligible when one place meets every condition.
                    if p.starts[row] != p.starts[row + 1] {
                        if unrestricted {
                            return Ok(p.saved_visible[row]);
                        }
                        for sr in p.starts[row] as usize..p.starts[row + 1] as usize {
                            if p.eligible(&at, Kind::Slice, sr, request, &location)? {
                                return Ok(true);
                            }
                        }
                        return Ok(false);
                    }
                    Ok(request.capability != Capability::SourceEditable
                        && request.lens.as_ref().is_none_or(|lens| lens == "all")
                        && !(request.without_notes == Some(true) && p.notes[row] != 0)
                        && p.scope(&at, Kind::Line, row, request, &location)?)
                })
            },
        )?);
        if let Some(selection) = &request.localization {
            if let Some(review) = &selection.review {
                let bit = 1
                    << REVIEWS
                        .iter()
                        .position(|value| value == review)
                        .ok_or("Unknown validated review lens.")?;
                let p = Arc::clone(&projection);
                let at_scope = scope.clone();
                sets.push(
                    self.atom(format!("line|review|{review}|{scope:?}"), |query| {
                        RowSet::from_fn(len, cancelled, |row| {
                            for ci in &at_scope {
                                if p.review(query, row, *ci)? & bit != 0 {
                                    return Ok(true);
                                }
                            }
                            Ok(false)
                        })
                    })?,
                );
            }
            if selection.key_changed == Some(true) {
                let p = Arc::clone(&projection);
                sets.push(self.atom("line|keyChanged".into(), |_| {
                    RowSet::from_fn(len, cancelled, |row| {
                        Ok(p.key_change[row] > 0 && p.key_change[row] & 1 == 0)
                    })
                })?);
            }
            if let Some(state) = &selection.state {
                let p = Arc::clone(&projection);
                let at_scope = scope.clone();
                sets.push(self.atom(format!("line|state|{state}|{scope:?}"), |_| {
                    RowSet::from_fn(len, cancelled, |row| {
                        Ok(at_scope.iter().any(|ci| {
                            let c = &p.cultures[*ci];
                            if state == "not_synced" {
                                c.facts[row] & 8 != 0
                            } else {
                                STATES[c.state[row] as usize] == state
                            }
                        }))
                    })
                })?);
            }
        }
        let rows = RowSet::intersection(len, &sets)?.in_order(&order, cancelled)?;
        if wanted.is_empty() || !search_translations {
            return Ok(rows);
        }
        // Translation search reads each remaining line's translations, after every other atom.
        let mut result = Vec::with_capacity(rows.len());
        for (index, row) in rows.into_iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let line = row as usize;
            let mut values = vec![self.reader.string(projection.source[line])?];
            for ci in &scope {
                // Search includes archive translations and PO text that differs from it.
                values.push(self.translation_for_search(*ci, line, false)?);
                if projection.cultures[*ci].facts[line] & 8 != 0 {
                    values.push(self.translation_for_search(*ci, line, true)?);
                }
            }
            if text_matches(&values.join(" ").to_lowercase(), &wanted) {
                result.push(row);
            }
        }
        checkpoint(cancelled)?;
        Ok(result)
    }
    fn translation_for_search(&mut self, ci: usize, row: usize, po: bool) -> Result<String> {
        let prefix = if po { "po" } else { "archive" };
        let entry = self.reader.value(&format!("c{ci}.{prefix}"), row)?;
        if entry == 0 {
            return Ok(String::new());
        }
        let culture = self.cultures.get(ci).ok_or("Unknown culture.")?;
        let path = self.target["outputPaths"][if po { "portableObjects" } else { "archives" }]
            .get(culture)
            .and_then(serde_json::Value::as_str)
            .ok_or("Missing translation input.")?
            .to_owned();
        Ok(self
            .translation(&path, (entry - 1) as usize, po)?
            .unwrap_or_default())
    }
}
