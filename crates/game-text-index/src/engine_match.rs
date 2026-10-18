//! Compiled native predicates. Hot scans use numeric columns, without crossing into JavaScript.
use crate::engine_places::{Places, Prefix};
use crate::engine_query::{EngineQuery, audience, mask};
use crate::engine_types::*;
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

pub(crate) struct Rows {
    pub visible: Column,
    pub signals: Column,
    pub origins: Column,
    pub editing: Column,
    pub notes: Column,
    pub audience: Column,
    pub identity: Column,
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
    fn open(query: &mut EngineQuery, kind: &str) -> Result<Self> {
        let rows = Self {
            visible: query.column(kind, "visible")?,
            signals: query.column(kind, "signals")?,
            origins: query.column(kind, "origins")?,
            editing: query.column(kind, "editing")?,
            notes: query.column(kind, "notes")?,
            audience: query.column(kind, "audience")?,
            identity: query.column(kind, "identity")?,
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
        require(
            rows.order.iter().all(|row| (*row as usize) < count),
            "Invalid raw row order.",
        )?;
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
    pub raw: Rows,
    pub slice: Rows,
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
    pub fn open(query: &mut EngineQuery, cancelled: &AtomicBool) -> Result<Arc<Self>> {
        if let Some(value) = &query.projection {
            return Ok(Arc::clone(value));
        }
        checkpoint(cancelled)?;
        let raw = Rows::open(query, "raw")?;
        let slice = Rows::open(query, "slice")?;
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
            raw,
            slice,
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
        require(
            result.order.iter().all(|row| (*row as usize) < count),
            "Invalid localization row order.",
        )?;
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
    pub fn problem(&self, row: usize, scope: &[usize]) -> u32 {
        let flags = self.flags[row];
        let mut bits = if self.key_change[row] > 0 && self.key_change[row] & 1 == 0 {
            1
        } else {
            0
        } | if flags & 16 != 0 { 2 } else { 0 }
            | if flags & 15 != 0 { 32 } else { 0 };
        for ci in scope {
            let c = &self.cultures[*ci];
            bits |= if c.reasons[row] & (1 << 11) != 0 {
                2
            } else {
                0
            } | if c.state[row] == 4 { 4 } else { 0 }
                | if c.state[row] == 5 { 8 } else { 0 }
                | if matches!(c.state[row], 1 | 2) || c.facts[row] & 8 != 0 {
                    16
                } else {
                    0
                };
        }
        if bits == 0 { 64 } else { bits }
    }
}

struct PreparedClause {
    field: FilterField,
    op: FilterOp,
    mask: u32,
    labels: HashSet<u32>,
    prefixes: Vec<Prefix>,
}
struct Predicates {
    clauses: Vec<PreparedClause>,
    path: Option<Prefix>,
    files: Option<HashSet<u32>>,
}
impl Predicates {
    fn new(request: &SearchRequest, places: &Places) -> Result<Self> {
        let mut clauses = Vec::new();
        for clause in request.filter.as_deref().unwrap_or(&[]) {
            let labels: &[&str] = match clause.field {
                FilterField::Problem => &PROBLEMS,
                FilterField::Finding => &SIGNALS[..4],
                FilterField::Translation => &["", "missing", "to_update", "not_synced"],
                FilterField::Origin => &ORIGINS,
                FilterField::Editing => &["editable", "read_only"],
                FilterField::Notes => &["missing", "present"],
                FilterField::Audience => &AUDIENCES,
                _ => &[],
            };
            clauses.push(PreparedClause {
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
            });
        }
        let location = request.location.as_ref();
        Ok(Self {
            clauses,
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
    pub fn namespace(&self, places: &Places, kind: Kind, row: usize) -> Result<Option<u32>> {
        let (defined, id) = if matches!(kind, Kind::Line) {
            (
                !(self.starts[row] != self.starts[row + 1] && self.key[row] == 0),
                self.namespace[row],
            )
        } else {
            let rows = self.rows(kind);
            (rows.identity[row] < 2, rows.namespace[row])
        };
        if defined {
            Ok(Some(places.namespace(id)?))
        } else {
            Ok(None)
        }
    }
    fn filter(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        scope: &[usize],
        prepared: &Predicates,
    ) -> Result<bool> {
        let line = matches!(kind, Kind::Line);
        let rows = self.rows(kind);
        let flags = if line {
            self.flags[row]
        } else {
            rows.signals[row]
        };
        for clause in &prepared.clauses {
            let has = match clause.field {
                FilterField::Problem => {
                    let bits = if line {
                        self.problem(row, scope)
                    } else {
                        let bits = if flags & 16 != 0 { 2 } else { 0 }
                            | if flags & 15 != 0 { 32 } else { 0 };
                        if bits == 0 { 64 } else { bits }
                    };
                    bits & clause.mask != 0
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
            };
            if (clause.op == FilterOp::Is && !has) || (clause.op == FilterOp::IsNot && has) {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn scope(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        request: &SearchRequest,
        prepared: &Predicates,
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
    fn eligible(
        &self,
        places: &Places,
        kind: Kind,
        row: usize,
        request: &SearchRequest,
        prepared: &Predicates,
        filter: bool,
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
        Ok((!filter || self.filter(places, kind, row, &[], prepared)?)
            && self.scope(places, kind, row, request, prepared)?)
    }
}

impl EngineQuery {
    pub fn matching(
        &mut self,
        request: &SearchRequest,
        cancelled: &AtomicBool,
    ) -> Result<Arc<[u32]>> {
        request.validate()?;
        checkpoint(cancelled)?;
        let mut key = request.clone();
        key.page_size = 1;
        key.cursor = None;
        key.localization_cursor = None;
        key.group = None;
        key.open_group = None;
        key.facets = None;
        let key = serde_json::to_string(&key)?;
        if let Some(rows) = self.matched.get(&key) {
            return Ok(Arc::clone(rows));
        }
        let rows: Arc<[u32]> = self.match_rows(request, cancelled)?.into();
        let bytes = rows.len().saturating_mul(4);
        if self.matched.len() >= 16
            || self
                .matched
                .values()
                .map(|rows| rows.len().saturating_mul(4))
                .sum::<usize>()
                .saturating_add(bytes)
                > 32 * 1024 * 1024
        {
            self.matched.clear();
        }
        if bytes <= 32 * 1024 * 1024 {
            self.matched.insert(key, Arc::clone(&rows));
        }
        Ok(rows)
    }
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
        let scope = self.culture_scope(request.localization.as_ref())?;
        let projection = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let prepared = Predicates::new(request, &places)?;
        let wanted = request
            .query
            .to_lowercase()
            .split(crate::join_policy::js_space)
            .filter(|term| !term.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let source_matches = if wanted.is_empty() {
            None
        } else {
            Some(self.source_matches(&request.query, cancelled)?)
        };
        let picked = if request.localization.is_some() {
            request
                .lines
                .as_ref()
                .map(|lines| {
                    lines
                        .iter()
                        .map(|id| self.find_id("line", id))
                        .collect::<Result<Vec<_>>>()
                        .map(|rows| rows.into_iter().flatten().collect::<HashSet<_>>())
                })
                .transpose()?
        } else {
            None
        };
        let order = if request.localization.is_some() {
            &projection.order
        } else {
            &projection.raw.order
        };
        let mut result = Vec::new();
        for (index, row) in order.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let Some(selection) = &request.localization else {
                if !projection.eligible(&places, Kind::Raw, row, request, &prepared, true)? {
                    continue;
                }
                if let Some(matches) = &source_matches {
                    let sources = projection.raw.sources(row);
                    if sources.len() == 1 {
                        if matches.get(sources[0] as usize) != Some(&1) {
                            continue;
                        }
                    } else {
                        let source = self.reader.strings(sources)?.join(" ").to_lowercase();
                        if !text_matches(&source, &wanted) {
                            continue;
                        }
                    }
                }
                result.push(row as u32);
                continue;
            };
            if projection.source_visible[row] == 0
                || picked.as_ref().is_some_and(|rows| !rows.contains(&row))
                || !projection.filter(&places, Kind::Line, row, &scope, &prepared)?
            {
                continue;
            }
            if projection.starts[row] != projection.starts[row + 1] {
                let unrestricted = request.capability == Capability::All
                    && request.without_notes != Some(true)
                    && request.lens.as_ref().is_none_or(|lens| lens == "all")
                    && request.location.is_none();
                let mut eligible = unrestricted && projection.saved_visible[row];
                if !unrestricted {
                    for sr in projection.starts[row] as usize..projection.starts[row + 1] as usize {
                        if projection.eligible(
                            &places,
                            Kind::Slice,
                            sr,
                            request,
                            &prepared,
                            false,
                        )? {
                            eligible = true;
                            break;
                        }
                    }
                }
                if !eligible {
                    continue;
                }
            } else if request.capability == Capability::SourceEditable
                || request.lens.as_ref().is_some_and(|lens| lens != "all")
                || (request.without_notes == Some(true) && projection.notes[row] != 0)
                || !projection.scope(&places, Kind::Line, row, request, &prepared)?
            {
                continue;
            }
            if let Some(review) = &selection.review {
                let bit = 1
                    << REVIEWS
                        .iter()
                        .position(|value| value == review)
                        .ok_or("Unknown validated review lens.")?;
                let mut has = false;
                for ci in &scope {
                    if projection.review(self, row, *ci)? & bit != 0 {
                        has = true;
                        break;
                    }
                }
                if !has {
                    continue;
                }
            }
            if selection.key_changed == Some(true)
                && !(projection.key_change[row] > 0 && projection.key_change[row] & 1 == 0)
            {
                continue;
            }
            if let Some(state) = &selection.state
                && !scope.iter().any(|ci| {
                    let c = &projection.cultures[*ci];
                    if state == "not_synced" {
                        c.facts[row] & 8 != 0
                    } else {
                        STATES[c.state[row] as usize] == state
                    }
                })
            {
                continue;
            }
            if let Some(matches) = &source_matches {
                if selection.search_translations != Some(true)
                    || (selection.culture.is_none() && selection.cultures.is_none())
                {
                    if matches.get(projection.source[row] as usize) != Some(&1) {
                        continue;
                    }
                } else {
                    let mut values = vec![self.reader.string(projection.source[row])?];
                    for ci in &scope {
                        // Search includes archive translations and PO text that differs from it.
                        values.push(self.translation_for_search(*ci, row, false)?);
                        if projection.cultures[*ci].facts[row] & 8 != 0 {
                            values.push(self.translation_for_search(*ci, row, true)?);
                        }
                    }
                    let text = values.join(" ").to_lowercase();
                    if !text_matches(&text, &wanted) {
                        continue;
                    }
                }
            }
            result.push(row as u32);
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
