//! Native Game Text query execution over one pinned snapshot. JavaScript receives bounded values.
use crate::engine_reader::EngineReader;
use crate::engine_text::SourceSearch;
use crate::engine_types::*;
use crate::join_policy::{normalized, trim};
use crate::store::Configuration;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub struct EngineQuery {
    pub(crate) audience_rules: Vec<String>,
    pub(crate) summary_cache: Option<Value>,
    pub(crate) metadata_cache: crate::query_cache::QueryCache,
    pub(crate) row_ranks: HashMap<String, Arc<[u32]>>,
    pub(crate) copy_starts: HashMap<usize, Arc<[usize]>>,
    pub reader: EngineReader,
    pub target: Value,
    pub cultures: Vec<String>,
    sources: Option<SourceSearch>,
    source_matches: HashMap<String, Arc<[u8]>>,
    pub(crate) matched: HashMap<String, Arc<[u32]>>,
    pub(crate) places: Option<Arc<crate::engine_places::Places>>,
    pub(crate) projection: Option<Arc<crate::engine_match::Projection>>,
    pub(crate) asset_types: Option<Arc<crate::engine_asset_types::AssetTypes>>,
    package_names: Vec<String>,
    package_starts: Vec<u32>,
    validated_ids: HashSet<String>,
    id_indexes: HashMap<String, Arc<IdIndex>>,
    unit_lines: Option<Arc<[u32]>>,
    /// Unreal word counts by source text ID, filled by aggregates.
    pub(crate) line_break_words: HashMap<u32, u32>,
    /// The corpus fingerprint, computed once per reader.
    pub(crate) fingerprint: Option<String>,
    /// Package coverage and diagnostics, read once per reader.
    pub(crate) package_lists: Option<Arc<(Vec<Value>, Vec<Value>)>>,
    /// Each evidence input's file metadata, read once per reader.
    pub(crate) evidence_meta: HashMap<String, Arc<Value>>,
}

/// An open-addressed hash of one packed-ID arena: each slot holds a row plus one, zero when
/// empty. It borrows the reader's arena, so it costs four bytes per slot and no ID copies.
pub(crate) struct IdIndex {
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
    slots: Vec<u32>,
}

fn id_hash(bytes: &[u8]) -> usize {
    // FNV-1a: deterministic, and IDs are short enough that a byte loop is cheap.
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3);
    }
    (hash ^ (hash >> 32)) as usize
}

impl IdIndex {
    /// `starts` are validated identity offsets ending within `bytes`.
    fn new(starts: Arc<[u32]>, bytes: Arc<[u8]>) -> Self {
        let count = starts.len().saturating_sub(1);
        let mut index = Self {
            slots: vec![0; (count * 2).max(16).next_power_of_two()],
            starts,
            bytes,
        };
        let mask = index.slots.len() - 1;
        for row in 0..count {
            let id = index.id(row);
            let mut slot = id_hash(id) & mask;
            loop {
                match index.slots[slot] {
                    0 => {
                        index.slots[slot] = row as u32 + 1;
                        break;
                    }
                    // Keep the first row of a repeated ID, as a forward scan would find it.
                    other if index.id(other as usize - 1) == id => break,
                    _ => slot = (slot + 1) & mask,
                }
            }
        }
        index
    }

    fn id(&self, row: usize) -> &[u8] {
        &self.bytes[self.starts[row] as usize..self.starts[row + 1] as usize]
    }

    pub fn find(&self, wanted: &[u8]) -> Option<usize> {
        let mask = self.slots.len() - 1;
        let mut slot = id_hash(wanted) & mask;
        loop {
            match self.slots[slot] {
                0 => return None,
                row if self.id(row as usize - 1) == wanted => return Some(row as usize - 1),
                _ => slot = (slot + 1) & mask,
            }
        }
    }
}

pub fn audience(mask: u32) -> &'static str {
    if mask & 1 != 0 {
        "player"
    } else if mask & 4 != 0 || mask & 2 == 0 {
        "unknown"
    } else {
        "editor"
    }
}

pub fn mask(labels: &[&str], values: &[String]) -> u32 {
    values
        .iter()
        .filter_map(|value| labels.iter().position(|label| *label == value))
        .fold(0, |bits, bit| bits | (1 << bit))
}

pub fn selected_bits<'a>(labels: &[&'a str], value: u32) -> Vec<&'a str> {
    labels
        .iter()
        .enumerate()
        .filter_map(|(bit, label)| (value & (1 << bit) != 0).then_some(*label))
        .collect()
}

impl EngineQuery {
    pub fn open_with_policy(
        configuration: &Configuration,
        expected_joined: Option<&str>,
        policy: &crate::engine::EnginePolicy,
    ) -> Result<Self> {
        policy.validate()?;
        let mut query = Self::open(configuration, expected_joined)?;
        query.audience_rules = policy.audience_rules.clone();
        Ok(query)
    }
    pub fn search_json(
        &mut self,
        payload: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<String> {
        let request = parse_search_request(payload)?;
        crate::wtf8::view_json(&self.search(&request, cancelled)?)
    }

    pub fn open(configuration: &Configuration, expected_joined: Option<&str>) -> Result<Self> {
        let reader = EngineReader::open(configuration, expected_joined)?;
        let target = reader.meta["input"]["target"].clone();
        let cultures = target["cultures"]
            .as_array()
            .ok_or("Target cultures are absent.")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Invalid target culture.")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        require(cultures.len() <= 256, "Target has too many cultures.")?;
        let package_names = reader.meta["packageNames"]
            .as_array()
            .ok_or("Package names are absent.")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Invalid package name.")
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let package_starts = reader.meta["packageStarts"]
            .as_array()
            .ok_or("Package offsets are absent.")?
            .iter()
            .map(|value| {
                Ok(u32::try_from(
                    value.as_u64().ok_or("Invalid package offset.")?,
                )?)
            })
            .collect::<Result<Vec<_>>>()?;
        require(
            package_starts.len() >= package_names.len()
                && package_starts.windows(2).all(|pair| pair[0] <= pair[1]),
            "Invalid package offset order.",
        )?;
        Ok(Self {
            audience_rules: Vec::new(),
            summary_cache: None,
            metadata_cache: crate::query_cache::QueryCache::default(),
            row_ranks: HashMap::new(),
            copy_starts: HashMap::new(),
            reader,
            target,
            cultures,
            sources: None,
            source_matches: HashMap::new(),
            matched: HashMap::new(),
            places: None,
            projection: None,
            asset_types: None,
            package_names,
            package_starts,
            validated_ids: HashSet::new(),
            id_indexes: HashMap::new(),
            unit_lines: None,
            line_break_words: HashMap::new(),
            fingerprint: None,
            package_lists: None,
            evidence_meta: HashMap::new(),
        })
    }

    pub fn column(&mut self, kind: &str, field: &str) -> Result<Arc<[u32]>> {
        self.reader.column(&format!("query.{kind}.{field}"))
    }
    pub fn value(&mut self, kind: &str, field: &str, row: usize) -> Result<u32> {
        self.reader.value(&format!("query.{kind}.{field}"), row)
    }

    pub fn packed(&mut self, kind: &str, row: usize) -> Result<String> {
        let starts = self.identity_starts(kind)?;
        let bytes = self.reader.bytes(&format!("query.{kind}.id_utf8"))?;
        let begin = *starts.get(row).ok_or("Identity row outside index.")? as usize;
        let end = *starts.get(row + 1).ok_or("Identity end outside index.")? as usize;
        Wtf8Buf::from_bytes(
            bytes
                .get(begin..end)
                .ok_or("Invalid identity byte range.")?
                .to_vec(),
        )
        .map(Wtf8Buf::into_view)
    }

    /// The first row whose packed ID equals `id`, through the reader's ID index.
    pub fn find_id(&mut self, kind: &str, id: &str) -> Result<Option<usize>> {
        let index = self.id_index(kind)?;
        Ok(index.find(Wtf8Buf::from_view(id).as_bytes()))
    }

    /// Hash each packed ID once per pinned reader, so every lookup costs one probe rather than a
    /// scan of the whole identity arena.
    pub(crate) fn id_index(&mut self, kind: &str) -> Result<Arc<IdIndex>> {
        if let Some(index) = self.id_indexes.get(kind) {
            return Ok(Arc::clone(index));
        }
        let starts = self.identity_starts(kind)?;
        let bytes = self.reader.bytes(&format!("query.{kind}.id_utf8"))?;
        require(
            starts
                .last()
                .is_some_and(|end| *end as usize <= bytes.len()),
            "Invalid identity byte range.",
        )?;
        let index = Arc::new(IdIndex::new(starts, bytes));
        self.id_indexes.insert(kind.to_owned(), Arc::clone(&index));
        Ok(index)
    }

    /// The dictionary IDs of exact source texts. A text no row holds has no ID, or an ID no source
    /// column references, so it matches nothing.
    pub(crate) fn source_ids(&mut self, values: &[String]) -> Result<HashSet<u32>> {
        let mut ids = HashSet::new();
        for value in values {
            if let Some(id) = self.reader.find_string(value)? {
                ids.insert(id);
            }
        }
        Ok(ids)
    }

    /// For each saved unit, the last line in display order holding one of its slices. Focus
    /// without a localization selection reports that line.
    pub(crate) fn unit_lines(
        &mut self,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Arc<[u32]>> {
        if let Some(lines) = &self.unit_lines {
            return Ok(Arc::clone(lines));
        }
        let p = crate::engine_match::Projection::open(self, cancelled)?;
        let raws = self.column("slice", "raw")?;
        require(
            raws.len() == p.slice.visible.len(),
            "Invalid slice-to-unit projection.",
        )?;
        let mut lines = vec![u32::MAX; p.raw.visible.len()];
        for (index, line) in p.order.iter().enumerate() {
            if index & 255 == 0 {
                crate::engine_match::checkpoint(cancelled)?;
            }
            let line = *line as usize;
            for raw in &raws[p.starts[line] as usize..p.starts[line + 1] as usize] {
                *lines
                    .get_mut(*raw as usize)
                    .ok_or("Slice points outside raw units.")? = line as u32;
            }
        }
        let lines: Arc<[u32]> = lines.into();
        self.unit_lines = Some(Arc::clone(&lines));
        Ok(lines)
    }

    pub(crate) fn identity_starts(&mut self, kind: &str) -> Result<Arc<[u32]>> {
        let starts = self.column(kind, "id_starts")?;
        if !self.validated_ids.contains(kind) {
            let count = if kind == "line" {
                self.reader.column("line.source")?.len()
            } else {
                require(kind == "raw", "Unknown identity projection.")?;
                self.column(kind, "visible")?.len()
            };
            require(
                starts.len() == count + 1
                    && starts.first() == Some(&0)
                    && starts.windows(2).all(|range| range[0] <= range[1]),
                "Invalid query identity offsets.",
            )?;
            self.validated_ids.insert(kind.to_owned());
        }
        Ok(starts)
    }

    pub fn package_coordinate(&self, occurrence: usize) -> Result<(usize, usize)> {
        let shard = self
            .package_starts
            .partition_point(|start| *start as usize <= occurrence)
            .checked_sub(1)
            .ok_or("Occurrence precedes first shard.")?;
        require(
            shard < self.package_names.len(),
            "Occurrence exceeds package shards.",
        )?;
        Ok((shard, occurrence - self.package_starts[shard] as usize))
    }

    pub fn package_column(&mut self, shard: usize, field: &str) -> Result<Arc<[u32]>> {
        let name = self
            .package_names
            .get(shard)
            .ok_or("Unknown package shard.")?;
        self.reader.input_column(name, field)
    }

    /// The global row of a package shard's first occurrence.
    pub(crate) fn package_occurrence_start(&self, shard: usize) -> Option<usize> {
        self.package_starts.get(shard).map(|start| *start as usize)
    }

    pub(crate) fn package_count(&self) -> usize {
        self.package_names.len()
    }

    pub fn occurrence_value(&mut self, occurrence: usize, field: &str) -> Result<u32> {
        let (shard, row) = self.package_coordinate(occurrence)?;
        self.package_column(shard, &format!("occurrence.{field}"))?
            .get(row)
            .copied()
            .ok_or_else(|| "Occurrence row exceeds shard.".into())
    }

    pub fn occurrence_identity(&mut self, occurrence: usize) -> Result<Value> {
        let identity = self.occurrence_value(occurrence, "identity")?;
        let ns = self.occurrence_value(occurrence, "namespace")?;
        let key = self.occurrence_value(occurrence, "key")?;
        if identity < 2 && self.reader.string(key)?.is_empty() {
            return Ok(json!({"status":"unresolved","reason":"missing_key"}));
        }
        Ok(match identity {
            0 => {
                json!({"status":"resolved","namespace":self.reader.string(ns)?,"key":self.reader.string(key)?})
            }
            1 => {
                json!({"status":"string_table","tableId":self.reader.string(ns)?,"key":self.reader.string(key)?})
            }
            2 | 3 => {
                json!({"status":"unresolved","reason":if identity == 2 { "culture_invariant" } else { "missing_key" }})
            }
            _ => return Err("Invalid stored occurrence identity.".into()),
        })
    }

    pub fn occurrence_location(&mut self, occurrence: usize) -> Result<Value> {
        let code = self.occurrence_value(occurrence, "location")?;
        let object_id = self.occurrence_value(occurrence, "object")?;
        let object = self.reader.string(object_id)?;
        let mut result = json!({"objectPath":object});
        match code {
            0 => {
                let property = self.occurrence_value(occurrence, "property")?;
                let class = self.occurrence_value(occurrence, "class")?;
                result["kind"] = json!("asset_property");
                result["propertyPath"] = json!(self.reader.string(property)?);
                result["classPath"] = json!(self.reader.string(class)?);
            }
            1 => {
                let property = self.occurrence_value(occurrence, "property")?;
                let row = self.occurrence_value(occurrence, "row")?;
                result["kind"] = json!("data_table_cell");
                result["propertyPath"] = json!(self.reader.string(property)?);
                result["row"] = json!(self.reader.string(row)?);
            }
            2 => {
                let row = self.occurrence_value(occurrence, "row")?;
                result["kind"] = json!("string_table_entry");
                result["entryKey"] = json!(self.reader.string(row)?);
            }
            _ => return Err("Invalid stored occurrence location.".into()),
        }
        Ok(result)
    }

    pub fn presentation(&mut self, kind: &str, row: usize) -> Result<Value> {
        let all_members = self.column(kind, "members")?;
        let begin = self.value(kind, "member_start", row)? as usize;
        let end = self.value(kind, "member_end", row)? as usize;
        let members = all_members
            .get(begin..end)
            .ok_or("Invalid occurrence range.")?;
        let mut contexts = Vec::new();
        for member in members.iter().take(3) {
            let editable = self.occurrence_value(*member as usize, "editable")? != 0;
            contexts.push(json!({"editCapability":if editable { "source_editable" } else { "read_only" },"location":self.occurrence_location(*member as usize)?}));
        }
        let first = self.value(kind, "representative", row)? as usize;
        let begin = self.value(kind, "source_start", row)? as usize;
        let end = self.value(kind, "source_end", row)? as usize;
        let ids = self.column(kind, "sources")?;
        let values = self
            .reader
            .strings(ids.get(begin..end).ok_or("Invalid source range.")?)?;
        require(!values.is_empty(), "Stored unit has no source values.")?;
        let source = if values.len() == 1 {
            json!({"status":"consistent","value":values[0]})
        } else {
            json!({"status":"conflicting","values":values})
        };
        let origins = self.value(kind, "origins", row)?;
        let raw = self.value(kind, "raw", row)? as usize;
        let location_kinds = [
            (4, "asset_property"),
            (2, "data_table_cell"),
            (1, "string_table_entry"),
        ]
        .iter()
        .filter_map(|(bit, kind)| (origins & bit != 0).then_some(kind))
        .collect::<Vec<_>>();
        Ok(json!({
            "id":self.packed("raw", raw)?, "identity":self.occurrence_identity(first)?, "source":source,
            "contexts":contexts,"occurrenceCount":members.len(),"remainingContextCount":members.len().saturating_sub(3),
            "characterCount":self.value(kind,"characters",row)?,"wordCount":self.value(kind,"words",row)?,
            "reviewSignals":selected_bits(&SIGNALS,self.value(kind,"signals",row)?),
            "locationKinds":location_kinds,
            "audience":audience(self.value(kind,"audience",row)?)
        }))
    }

    pub fn culture_scope(&self, selected: Option<&LocalizationScope>) -> Result<Vec<usize>> {
        if let Some(selected) = selected {
            require(
                self.target["name"] == selected.target,
                invalid("The selected localization target is not open."),
            )?;
            require(
                selected
                    .culture
                    .as_ref()
                    .is_none_or(|culture| self.cultures.contains(culture))
                    && selected.cultures.as_ref().is_none_or(|cultures| {
                        cultures
                            .iter()
                            .all(|culture| self.cultures.contains(culture))
                    }),
                invalid("The selected localization culture is not available."),
            )?;
            if let (Some(culture), Some(cultures)) = (&selected.culture, &selected.cultures) {
                require(
                    cultures.contains(culture),
                    invalid("The selected culture is outside the culture scope."),
                )?;
            }
        }
        Ok(self
            .cultures
            .iter()
            .enumerate()
            .filter_map(|(index, culture)| {
                selected
                    .is_none_or(|selected| {
                        selected.culture.as_ref().map_or_else(
                            || {
                                selected
                                    .cultures
                                    .as_ref()
                                    .is_none_or(|cultures| cultures.contains(culture))
                            },
                            |wanted| culture == wanted,
                        )
                    })
                    .then_some(index)
            })
            .collect())
    }

    pub fn translation(&mut self, name: &str, row: usize, po: bool) -> Result<Option<String>> {
        let options = self.reader.input_column(name, "entry.options")?;
        let options = *options.get(row).ok_or("Translation row outside file.")?;
        if po && options & 64 == 0 {
            return Ok(None);
        }
        let values = self.reader.input_column(
            name,
            if options & 128 != 0 {
                "entry.source"
            } else {
                "entry.translation"
            },
        )?;
        Ok(Some(self.reader.string(
            *values.get(row).ok_or("Translation row outside values.")?,
        )?))
    }

    pub fn culture_mark(&mut self, ci: usize, row: usize) -> Result<Value> {
        let prefix = format!("c{ci}.");
        let facts = self.reader.value(&(prefix.clone() + "facts"), row)?;
        let state = self.reader.value(&(prefix.clone() + "state"), row)? as usize;
        let review = self.reader.value(&(prefix.clone() + "review"), row)?;
        let record = self
            .reader
            .value(&(prefix.clone() + "review_record"), row)? as usize;
        let not_synced = facts & 8 != 0;
        let entry = self.reader.value(
            &(prefix.clone() + if not_synced { "po" } else { "archive" }),
            row,
        )?;
        let culture = self
            .cultures
            .get(ci)
            .ok_or("Culture outside target.")?
            .clone();
        let path = self.target["outputPaths"][if not_synced {
            "portableObjects"
        } else {
            "archives"
        }][&culture]
            .as_str()
            .map(str::to_owned);
        let translation = if entry != 0 {
            self.translation(
                &path.ok_or("Translation input is absent.")?,
                entry as usize - 1,
                not_synced,
            )?
        } else {
            None
        };
        let mut result = json!({"culture":culture,"state":STATES.get(state).ok_or("Invalid localization state.")?,"facts":selected_bits(&STATES,facts),"unknownReasons":selected_bits(&REASONS,self.reader.value(&(prefix+"reasons"),row)?),"reducedSourceChecking":self.reader.meta["reducedSourceChecking"][ci].as_bool().unwrap_or(false),"translation":translation.map(Value::String).unwrap_or(if not_synced { json!("") } else { Value::Null })});
        if review != 0 {
            result["review"] = if review == 1 {
                json!({"status":"not_reviewed"})
            } else {
                let record = self.reader.meta["input"]["review"]["records"]
                    .get(record.checked_sub(1).ok_or("Missing review record.")?)
                    .ok_or("Review record outside metadata.")?;
                json!({"status":if review==2 { "current" } else { "changed" },"flags":record["flags"],"by":record["by"],"at":record["at"]})
            };
        }
        Ok(result)
    }

    pub fn preview(&mut self, row: usize) -> Result<Value> {
        let id = self.packed("line", row)?;
        let source_id = self.reader.value("line.source", row)?;
        let source = self.reader.string(source_id)?;
        let begin = self.value("line", "starts", row)? as usize;
        let end = *self
            .column("line", "starts")?
            .get(row + 1)
            .ok_or("Invalid line slice range.")? as usize;
        let raws = self.column("slice", "raw")?;
        let mut units = Vec::new();
        for raw in raws.get(begin..end).ok_or("Invalid line slices.")? {
            units.push(self.packed("raw", *raw as usize)?);
        }
        units.sort_by(|left, right| crate::join::ordinal(left, right));
        units.dedup();
        let ns = self.reader.value("line.namespace", row)?;
        let key = self.reader.value("line.key", row)?;
        let namespace = self.reader.string(ns)?;
        let key = self.reader.string(key)?;
        let identity = if !units.is_empty() && key.is_empty() {
            Value::Null
        } else {
            json!({"namespace":namespace,"key":key})
        };
        let begin = self.reader.value("line.manifest_start", row)? as usize;
        let end = self.reader.value("line.manifest_end", row)? as usize;
        let rows = self.reader.column("manifest.rows")?;
        let name = self.target["outputPaths"]["manifest"]
            .as_str()
            .map(str::to_owned);
        let mut locations = Vec::new();
        if begin != end {
            let name = name.ok_or("Manifest path is absent.")?;
            let paths = self.reader.input_column(&name, "entry.path")?;
            let options = self.reader.input_column(&name, "entry.options")?;
            for entry in rows
                .get(begin..end.min(begin + 3))
                .ok_or("Invalid manifest range.")?
            {
                let entry = *entry as usize;
                let path = self
                    .reader
                    .string(*paths.get(entry).ok_or("Manifest path outside input.")?)?;
                locations.push(
                    if options.get(entry).ok_or("Manifest flags outside input.")? & 1024 != 0 {
                        format!(
                            "{}{}",
                            self.reader.input_metadata(&name, "file.meta")?["pathPrefix"]
                                .as_str()
                                .unwrap_or(""),
                            path
                        )
                    } else {
                        path
                    },
                );
            }
        }
        let code = self.reader.value("line.audience", row)?;
        let mut result = json!({"id":id,"source":source,"identity":identity,"audience":audience(code),"manifestLocations":locations,"remainingLocationCount":end.saturating_sub(begin+3),"origin":if units.is_empty() { json!({"kind":"evidence","id":format!("evidence:{id}")}) } else { json!({"kind":"corpus","unitIds":units}) },"cultures":(0..self.cultures.len()).map(|ci| self.culture_mark(ci,row)).collect::<Result<Vec<_>>>()?});
        if let Some(reason) = ["outside_gather_paths", "editor_only_data_not_gathered"]
            .get((code >> 4).wrapping_sub(1) as usize)
        {
            result["outOfScope"] = json!(reason);
        }
        let change = self.reader.value("line.key_change", row)?;
        if let Some(pair) = self.reader.meta["pairs"].get(((change >> 1) as usize).wrapping_sub(1))
        {
            result["keyChange"] = json!({"direction":if change & 1 != 0 {"from"}else{"to"},"other":pair[if change & 1 != 0 {"to"}else{"from"}],"match":pair["match"],"sourceChanged":pair["sourceChanged"],"previousSource":pair["previousSource"],"translations":pair["translations"]});
        }
        Ok(result)
    }

    pub(crate) fn prepare_source_search(
        &mut self,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<()> {
        crate::engine_match::checkpoint(cancelled)?;
        if self.sources.is_none() {
            self.sources = Some(SourceSearch::open(self, cancelled)?);
        }
        Ok(())
    }

    pub fn source_matches(
        &mut self,
        query: &str,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Arc<[u8]>> {
        crate::engine_match::checkpoint(cancelled)?;
        let lowered = query.to_lowercase();
        if let Some(value) = self.source_matches.get(&lowered) {
            return Ok(Arc::clone(value));
        }
        self.prepare_source_search(cancelled)?;
        let matches = self
            .sources
            .as_ref()
            .ok_or("Source search was not opened.")?
            .matching(&lowered, cancelled)?;
        if self.source_matches.len() >= 16
            || self
                .source_matches
                .values()
                .map(|value| value.len())
                .sum::<usize>()
                .saturating_add(matches.len())
                > 32 * 1024 * 1024
        {
            self.source_matches.clear();
        }
        if matches.len() <= 32 * 1024 * 1024 {
            self.source_matches.insert(lowered, Arc::clone(&matches));
        }
        Ok(matches)
    }

    pub fn normalized_path(value: &str) -> String {
        normalized(trim(value)).to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena(ids: &[&[u8]]) -> (Arc<[u32]>, Arc<[u8]>) {
        let mut starts = vec![0u32];
        let mut bytes = Vec::new();
        for id in ids {
            bytes.extend_from_slice(id);
            starts.push(bytes.len() as u32);
        }
        (starts.into(), bytes.into())
    }

    #[test]
    fn id_index_finds_the_first_row_a_forward_scan_would() {
        let generated = (0..5000)
            .map(|n| format!("Game:[\"NS{}\",\"Key{n}\"]", n % 7).into_bytes())
            .collect::<Vec<_>>();
        let mut ids = generated.iter().map(Vec::as_slice).collect::<Vec<_>>();
        // Repeats keep their first row; an empty ID and prefixes are distinct IDs.
        ids.extend([
            &b"Game:[\"NS1\",\"Key8\"]"[..],
            b"",
            b"Game:",
            b"",
            b"\xed\xa0\x80",
        ]);
        let (starts, bytes) = arena(&ids);
        let index = IdIndex::new(Arc::clone(&starts), Arc::clone(&bytes));
        let scan = |wanted: &[u8]| ids.iter().position(|id| *id == wanted);
        for id in &ids {
            assert_eq!(index.find(id), scan(id));
        }
        assert_eq!(index.find(b"Game:[\"NS1\",\"Key8\"]"), Some(8));
        assert_eq!(index.find(b""), Some(5001));
        for absent in [&b"Game:[\"NS1\",\"Key5000\"]"[..], b"Game", b"\xed\xa0"] {
            assert_eq!(index.find(absent), None);
        }
        let (starts, bytes) = arena(&[]);
        assert_eq!(IdIndex::new(starts, bytes).find(b""), None);
    }
}
