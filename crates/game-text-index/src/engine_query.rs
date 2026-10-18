//! Native Game Text query execution over one pinned snapshot. JavaScript receives bounded values.
use crate::engine_reader::EngineReader;
use crate::engine_types::*;
use crate::join_policy::{js_space, normalized, trim};
use crate::store::Configuration;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub struct EngineQuery {
    pub(crate) audience_rules: Vec<String>,
    pub(crate) summary_cache: Option<Value>,
    pub(crate) copy_starts: HashMap<usize, Arc<[usize]>>,
    pub reader: EngineReader,
    pub target: Value,
    pub cultures: Vec<String>,
    sources: Option<SourceSearch>,
    source_matches: HashMap<String, Arc<[u8]>>,
    pub(crate) matched: HashMap<String, Arc<[u32]>>,
    pub(crate) places: Option<Arc<crate::engine_places::Places>>,
    pub(crate) projection: Option<Arc<crate::engine_match::Projection>>,
    package_names: Vec<String>,
    package_starts: Vec<u32>,
    validated_ids: HashSet<String>,
}

struct SourceSearch {
    lookup: Vec<u32>,
    starts: Arc<[u32]>,
    bytes: Arc<[u8]>,
    additions: HashMap<u32, Vec<u8>>,
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
            copy_starts: HashMap::new(),
            reader,
            target,
            cultures,
            sources: None,
            source_matches: HashMap::new(),
            matched: HashMap::new(),
            places: None,
            projection: None,
            package_names,
            package_starts,
            validated_ids: HashSet::new(),
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

    pub fn find_id(&mut self, kind: &str, id: &str) -> Result<Option<usize>> {
        let starts = self.identity_starts(kind)?;
        let bytes = self.reader.bytes(&format!("query.{kind}.id_utf8"))?;
        let wanted = Wtf8Buf::from_view(id);
        for (row, range) in starts.windows(2).enumerate() {
            if bytes
                .get(range[0] as usize..range[1] as usize)
                .ok_or("Invalid identity byte range.")?
                == wanted.as_bytes()
            {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    fn identity_starts(&mut self, kind: &str) -> Result<Arc<[u32]>> {
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

    fn prepare_sources(&mut self) -> Result<()> {
        if self.sources.is_some() {
            return Ok(());
        }
        let count = self.reader.dictionary_count()?;
        let mut lookup = vec![u32::MAX; count];
        let (starts, bytes) = if self.reader.has_column("query.source.folded") {
            let ids = self.reader.column("query.source.ids")?;
            let starts = self.reader.column("query.source.starts")?;
            let bytes = self.reader.bytes("query.source.folded")?;
            require(
                starts.len() == ids.len() + 1
                    && starts.first() == Some(&0)
                    && starts
                        .last()
                        .is_some_and(|last| *last as usize <= bytes.len())
                    && starts.windows(2).all(|pair| pair[0] <= pair[1]),
                "Invalid persisted source search ranges.",
            )?;
            for (row, id) in ids.iter().enumerate() {
                let slot = lookup
                    .get_mut(*id as usize)
                    .ok_or("Source ID outside dictionary.")?;
                require(*slot == u32::MAX, "Duplicate source search ID.")?;
                *slot = row as u32;
            }
            (starts, bytes)
        } else {
            (Arc::from([0u32]), Arc::from([]))
        };
        self.sources = Some(SourceSearch {
            lookup,
            starts,
            bytes,
            additions: HashMap::new(),
        });
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
        self.prepare_sources()?;
        let terms = trim(&lowered)
            .split(js_space)
            .filter(|term| !term.is_empty())
            .map(|term| Wtf8Buf::from_view(term).into_bytes())
            .collect::<Vec<_>>();
        let unit_terms = if terms.iter().any(|term| std::str::from_utf8(term).is_err()) {
            Some(
                terms
                    .iter()
                    .map(|term| Wtf8Buf::from_bytes(term.clone()).map(|value| value.to_utf16()))
                    .collect::<Result<Vec<_>>>()?,
            )
        } else {
            None
        };
        let ids = self.reader.column("line.source")?;
        let raw = self.column("raw", "sources")?;
        let mut matches = vec![0u8; self.reader.dictionary_count()?];
        for (index, id) in ids.iter().chain(raw.iter()).copied().enumerate() {
            if index & 255 == 0 {
                crate::engine_match::checkpoint(cancelled)?;
            }
            if matches
                .get(id as usize)
                .copied()
                .ok_or("Source ID outside dictionary.")?
                != 0
            {
                continue;
            }
            let sources = self
                .sources
                .as_mut()
                .ok_or("Source search was not opened.")?;
            let row = sources.lookup[id as usize];
            if row == u32::MAX && !sources.additions.contains_key(&id) {
                sources.additions.insert(
                    id,
                    Wtf8Buf::from_view(&self.reader.string(id)?.to_lowercase()).into_bytes(),
                );
            }
            let bytes = if row == u32::MAX {
                sources
                    .additions
                    .get(&id)
                    .ok_or("Missing source addition.")?
                    .as_slice()
            } else {
                sources
                    .bytes
                    .get(
                        sources.starts[row as usize] as usize
                            ..sources.starts[row as usize + 1] as usize,
                    )
                    .ok_or("Invalid source search range.")?
            };
            let matched = if let Some(terms) = &unit_terms {
                let units = Wtf8Buf::from_bytes(bytes.to_vec())?.to_utf16();
                terms.iter().all(|term| {
                    term.is_empty() || units.windows(term.len()).any(|value| value == term)
                })
            } else {
                terms.iter().all(|term| {
                    term.is_empty() || bytes.windows(term.len()).any(|value| value == term)
                })
            };
            matches[id as usize] = if matched { 1 } else { 2 };
        }
        let matches: Arc<[u8]> = matches.into();
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
