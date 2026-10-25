//! Native grouping and facet aggregation over matched rows.
use crate::engine_asset_types::AssetTypes;
use crate::engine_match::{Kind, Projection, checkpoint};
use crate::engine_places::Places;
use crate::engine_query::{EngineQuery, audience};
use crate::engine_types::*;
use crate::rules::FindingRows;
use crate::text_problem::{self, PROBLEM_LABELS};
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;

const ORIGIN_LABELS: [&str; 5] = ["String table", "Data table", "Asset", "C++", "Other source"];
const AUDIENCE_LABELS: [&str; 3] = ["Player text", "Editor text", "Unknown"];
struct Tally {
    count: usize,
    work: usize,
    worst: u32,
    label: u32,
    first: usize,
    last: usize,
}

impl Places {
    pub(crate) fn coordinate(
        &self,
        id: u32,
        folder: bool,
        depth: Option<usize>,
        parent: Option<&[u8]>,
    ) -> Result<(u32, u32)> {
        let row = self.file_row(id)?;
        if !folder {
            return Ok((self.assets[row], self.file_values[row]));
        }
        let begin = *self.folder_starts.get(row).ok_or("Missing folder start.")? as usize;
        let end = *self
            .folder_starts
            .get(row + 1)
            .ok_or("Missing folder end.")? as usize;
        require(
            begin < end && end <= self.folder_keys.len() && end <= self.folder_labels.len(),
            "Invalid folder range.",
        )?;
        let position = depth.map_or(end - 1, |depth| {
            begin.saturating_add(depth.saturating_sub(1))
        });
        if position >= end
            || parent.is_some_and(|parent| {
                self.labels
                    .get(self.folder_keys[end - 1])
                    .map_or(true, |last| !last.starts_with(parent))
            })
        {
            return Ok((0, 0));
        }
        Ok((self.folder_keys[position], self.folder_labels[position]))
    }
    fn display(&self, by: GroupBy, key: u32, label: u32) -> Result<(String, String)> {
        let key = key as usize;
        Ok(match by {
            GroupBy::Problem => (
                PROBLEMS
                    .get(key)
                    .ok_or("Unknown problem group.")?
                    .to_string(),
                PROBLEM_LABELS
                    .get(key)
                    .ok_or("Unknown problem label.")?
                    .to_string(),
            ),
            GroupBy::Origin => {
                if key == 0 {
                    (String::new(), String::new())
                } else {
                    (
                        ORIGINS
                            .get(key - 1)
                            .ok_or("Unknown origin group.")?
                            .to_string(),
                        ORIGIN_LABELS
                            .get(key - 1)
                            .ok_or("Unknown origin label.")?
                            .to_string(),
                    )
                }
            }
            GroupBy::Audience => (
                AUDIENCES
                    .get(key)
                    .ok_or("Unknown audience group.")?
                    .to_string(),
                AUDIENCE_LABELS
                    .get(key)
                    .ok_or("Unknown audience label.")?
                    .to_string(),
            ),
            _ => (self.labels.text(key as u32)?, self.labels.text(label)?),
        })
    }
    fn label_rank(&self, by: GroupBy, key: u32, label: u32) -> Result<u32> {
        Ok(match by {
            GroupBy::Problem => 0,
            GroupBy::Origin => *[0, 5, 3, 1, 2, 4]
                .get(key as usize)
                .ok_or("Unknown origin rank.")?,
            GroupBy::Audience => *[1, 0, 2]
                .get(key as usize)
                .ok_or("Unknown audience rank.")?,
            _ => *self.rank.get(label as usize).ok_or("Unknown place rank.")?,
        })
    }
}
impl Projection {
    /// A line's problems, or a unit's (`textProblems` without marks) outside a target, with
    /// `finding` when a rule that counts has a finding on it.
    pub(crate) fn row_problem(
        &self,
        localized: bool,
        row: usize,
        scope: &[usize],
        finding: bool,
    ) -> u32 {
        if localized {
            return self.problem(row, scope, finding);
        }
        text_problem::settle(
            text_problem::signals(self.raw.signals[row])
                | if finding { text_problem::FINDING } else { 0 },
        )
    }
    /// A row's group under `by`; `problems` is the request's problem column.
    pub(crate) fn group_key(
        &self,
        places: &Places,
        localized: bool,
        row: usize,
        problems: &[u32],
        by: GroupBy,
    ) -> Result<u32> {
        let kind = if localized { Kind::Line } else { Kind::Raw };
        Ok(match by {
            GroupBy::Problem => problems[row].trailing_zeros(),
            GroupBy::Origin => {
                let bits = if localized {
                    self.origins[row]
                } else {
                    self.raw.origins[row]
                };
                if bits == 0 {
                    0
                } else {
                    bits.trailing_zeros() + 1
                }
            }
            GroupBy::Audience => {
                let value = audience(if localized {
                    self.audience[row]
                } else {
                    self.raw.audience[row]
                });
                AUDIENCES
                    .iter()
                    .position(|label| *label == value)
                    .ok_or("Unknown audience.")? as u32
            }
            GroupBy::Namespace => self.namespace(places, kind, row)?.unwrap_or(0),
            // The source's dictionary ID. Unit sources are stored in UTF-16 order.
            GroupBy::Source => {
                if localized {
                    self.source[row]
                } else {
                    *self
                        .raw
                        .sources(row)
                        .first()
                        .ok_or("Stored unit has no source values.")?
                }
            }
            GroupBy::AssetType => return Err("Asset types are a facet, not a group.".into()),
            GroupBy::Finding => return Err("A row can have several findings.".into()),
            GroupBy::Asset | GroupBy::Folder => {
                let mut key = 0;
                self.each_file(kind, row, &mut |file| {
                    key = places
                        .coordinate(file, by == GroupBy::Folder, None, None)?
                        .0;
                    Ok(true)
                })?;
                key
            }
        })
    }
}
impl EngineQuery {
    /// One entry per rule of the layer in program order, with the rows it has a finding on. A
    /// row counts in every rule it has a finding of. A facet (`minimum` absent) lists every
    /// rule; groups list those with at least `minimum` rows.
    pub(crate) fn finding_groups(
        &self,
        rows: &[u32],
        selection: &Selection,
        findings: &FindingRows,
        minimum: Option<usize>,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let localized = selection.localized();
        let scope = if localized {
            self.culture_scope(selection)?
        } else {
            Vec::new()
        };
        let problems = self.problem_column(localized, &scope, Some(findings), cancelled)?;
        let worst_none = (PROBLEMS.len() - 1) as u32;
        let mut tallies = vec![(0usize, 0usize, worst_none); findings.rules.len()];
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let bits = problems[row];
            for rule in findings.of(row) {
                let tally = &mut tallies[rule];
                tally.0 += 1;
                tally.1 += usize::from(bits & text_problem::WORK != 0);
                tally.2 = tally.2.min(bits.trailing_zeros());
            }
        }
        let minimum = minimum.unwrap_or(0);
        let entries = findings
            .rules
            .iter()
            .zip(tallies)
            .filter(|(_, (count, _, _))| *count >= minimum)
            .map(|(rule, (count, work, worst))| {
                json!({"key":rule.id,"label":rule.label,"count":count,"needWork":work,"worst":PROBLEMS[worst as usize]})
            })
            .collect::<Vec<_>>();
        let more = entries.len().saturating_sub(MAX_GROUPS);
        Ok(json!({"entries":entries.into_iter().take(MAX_GROUPS).collect::<Vec<_>>(),"more":more}))
    }

    /// The rows counted by `by`: a facet when `minimum` is absent, which lists every value, or
    /// groups holding at least `minimum` rows.
    pub(crate) fn aggregate(
        &self,
        rows: &[u32],
        selection: &Selection,
        by: GroupBy,
        minimum: Option<usize>,
        under: &str,
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let facet = minimum.is_none();
        let projection = Projection::open(self, cancelled)?;
        let places = Places::open(self)?;
        let localized = selection.localized();
        let kind = if localized { Kind::Line } else { Kind::Raw };
        let scope = if localized {
            self.culture_scope(selection)?
        } else {
            Vec::new()
        };
        let findings = self.request_findings(selection, cancelled)?;
        let problems = self.problem_column(localized, &scope, findings.as_deref(), cancelled)?;
        let parent = Self::normalized_path(under)
            .trim_end_matches('/')
            .to_owned();
        let depth = if parent.is_empty() {
            1
        } else {
            parent.split('/').count() + 1
        };
        let parent = if parent.is_empty() {
            None
        } else {
            Some(Wtf8Buf::from_view(&(parent + "/")).into_bytes())
        };
        let types = if by == GroupBy::AssetType {
            Some(AssetTypes::open(self, cancelled)?)
        } else {
            None
        };
        let mut tallies: HashMap<u32, Tally> = HashMap::new();
        for (stamp, row) in rows.iter().enumerate() {
            if stamp & 255 == 0 {
                checkpoint(cancelled)?;
            }
            let row = *row as usize;
            let bits = problems[row];
            let worst = bits.trailing_zeros();
            let mut visit = |key: u32, label: u32| {
                let tally = tallies.entry(key).or_insert(Tally {
                    count: 0,
                    work: 0,
                    worst,
                    label,
                    first: stamp,
                    last: usize::MAX,
                });
                if tally.first == stamp {
                    tally.label = label;
                }
                if tally.last != stamp {
                    tally.count += 1;
                    tally.work += usize::from(bits & text_problem::WORK != 0);
                    tally.worst = tally.worst.min(worst);
                    tally.last = stamp;
                }
            };
            match by {
                GroupBy::Asset | GroupBy::Folder => {
                    let mut found = false;
                    projection.each_file(kind, row, &mut |file| {
                        let (key, label) = places.coordinate(
                            file,
                            by == GroupBy::Folder,
                            if facet && by == GroupBy::Folder {
                                Some(depth)
                            } else {
                                None
                            },
                            parent.as_deref().filter(|_| facet && by == GroupBy::Folder),
                        )?;
                        if facet && label == 0 {
                            return Ok(false);
                        }
                        visit(key, label);
                        found = true;
                        Ok(!facet)
                    })?;
                    if !facet && !found {
                        visit(0, 0);
                    }
                }
                // A line of several types counts in each.
                GroupBy::AssetType => {
                    let types = types.as_ref().ok_or("Asset types are not open.")?;
                    types.each(&projection, kind, row, &mut |kind| {
                        visit(kind, kind);
                        false
                    })?;
                }
                GroupBy::Origin if facet => {
                    let bits = if localized {
                        projection.origins[row]
                    } else {
                        projection.raw.origins[row]
                    };
                    for bit in 0..ORIGINS.len() {
                        if bits & (1 << bit) != 0 {
                            visit(bit as u32 + 1, bit as u32 + 1);
                        }
                    }
                }
                _ => {
                    let key = projection.group_key(&places, localized, row, &problems, by)?;
                    visit(key, key);
                }
            }
        }
        // Groups below the requested size are left out before ranking, and so are not counted
        // in `more`. Facets list every value.
        let minimum = minimum.unwrap_or(1);
        let tallies = tallies
            .into_iter()
            .filter(|(_, tally)| tally.count >= minimum)
            .collect::<Vec<_>>();
        // Source groups are keyed by dictionary ID; they read and tie-break by their text.
        let mut texts = HashMap::new();
        if by == GroupBy::Source {
            let mut keys = Vec::with_capacity(tallies.len());
            for (index, (key, _)) in tallies.iter().enumerate() {
                if index & 255 == 0 {
                    checkpoint(cancelled)?;
                }
                keys.push((self.reader.string(*key)?, *key));
            }
            keys.sort_by(|(a, _), (b, _)| crate::join::ordinal(a, b));
            for (rank, (text, key)) in keys.into_iter().enumerate() {
                texts.insert(key, (rank as u32, text));
            }
        }
        let mut entries = tallies
            .into_iter()
            .map(|(key, tally)| {
                let rank = match (texts.get(&key), &types) {
                    (Some((rank, _)), _) => *rank,
                    (None, Some(types)) => *types
                        .ranks
                        .get(key as usize)
                        .ok_or("Unknown asset type rank.")?,
                    (None, None) => places.label_rank(by, key, tally.label)?,
                };
                Ok((rank, key, tally))
            })
            .collect::<Result<Vec<_>>>()?;
        entries.sort_by(|(a_rank, _, a), (b_rank, _, b)| {
            a.worst
                .cmp(&b.worst)
                .then_with(|| b.work.cmp(&a.work))
                .then_with(|| b.count.cmp(&a.count))
                .then_with(|| a_rank.cmp(b_rank))
        });
        let more = entries.len().saturating_sub(MAX_GROUPS);
        let entries=entries.into_iter().take(MAX_GROUPS).map(|(_,key,tally)| {
            let (key,label)=match (texts.get(&key), &types) {
                (Some((_, text)), _) => (text.clone(), text.clone()),
                (None, Some(types)) => (
                    types.names.get(key as usize).ok_or("Unknown asset type.")?.clone(),
                    types.labels.get(key as usize).ok_or("Unknown asset type label.")?.clone(),
                ),
                (None, None) => places.display(by,key,tally.label)?,
            };
            Ok(json!({"key":key,"label":label,"count":tally.count,"needWork":tally.work,"worst":PROBLEMS[tally.worst as usize]}))
        }).collect::<Result<Vec<_>>>()?;
        Ok(json!({"entries":entries,"more":more}))
    }
    /// How many of `files` hold matching text, lie outside the project or were not scanned.
    pub(crate) fn file_scope(
        &self,
        rows: &[u32],
        selection: &Selection,
        files: &[String],
        cancelled: &AtomicBool,
    ) -> Result<Value> {
        let mut outside = 0;
        let mut keys = HashSet::new();
        for file in files {
            let key = crate::join_policy::file_key(file);
            if key.is_empty() {
                continue;
            }
            let bytes = key.as_bytes();
            if key.starts_with('/')
                || (bytes.len() > 2
                    && bytes[0].is_ascii_lowercase()
                    && bytes[1] == b':'
                    && bytes[2] == b'/')
            {
                outside += 1;
            } else {
                keys.insert(key);
            }
        }
        let places = Places::open(self)?;
        let projection = Projection::open(self, cancelled)?;
        let labels = places.labels(&keys.iter().cloned().collect::<Vec<_>>(), false);
        let mut seen = HashSet::new();
        for (index, row) in rows.iter().enumerate() {
            if index & 255 == 0 {
                checkpoint(cancelled)?;
            }
            projection.each_file(
                if selection.localized() {
                    Kind::Line
                } else {
                    Kind::Raw
                },
                *row as usize,
                &mut |file| {
                    let key = places.asset(file)?;
                    if labels.contains(&key) {
                        seen.insert(key);
                    }
                    Ok(false)
                },
            )?;
        }
        let scanned = places.scanned_keys.iter().copied().collect::<HashSet<_>>();
        let mut missing = 0;
        for key in &keys {
            let basename = key.rsplit('/').next().unwrap_or("");
            let extension = basename
                .rsplit_once('.')
                .is_some_and(|(_, suffix)| !suffix.is_empty());
            if !extension
                && places
                    .labels(std::slice::from_ref(key), false)
                    .iter()
                    .all(|id| !scanned.contains(id))
            {
                missing += 1;
            }
        }
        Ok(
            json!({"files":keys.len()+outside,"textFiles":seen.len(),"outside":outside,"notScanned":missing}),
        )
    }
}
