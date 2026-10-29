//! Scoped index-writing operations over caller-prepared snapshots, not Unreal projects.
use crate::snapshot::{Reader, Writer, integers};
use crate::store::{Configuration, Store, token};
use crate::{Result, require};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputLayer {
    pub name: String,
    pub key: String,
    pub file: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageInput {
    pub name: String,
    pub key: String,
    pub previous_key: String,
    pub file: PathBuf,
    /// Nonnegative rows retain previous records; -1-row selects an authored replacement.
    pub rows: Vec<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum BuildRequest {
    Capabilities,
    Begin {
        configuration: Configuration,
    },
    End {
        configuration: Configuration,
    },
    Status {
        configuration: Configuration,
    },
    ImportLocalization {
        configuration: Configuration,
        request: crate::localization::import::Request,
    },
    Publish {
        configuration: Configuration,
        inputs: Vec<InputLayer>,
        #[serde(default)]
        cold: bool,
        #[serde(rename = "removedNames", default)]
        removed_names: Vec<String>,
    },
    PublishIds {
        configuration: Configuration,
        name: String,
        key: String,
        file: PathBuf,
        generation: String,
        #[serde(rename = "stringColumns")]
        string_columns: BTreeMap<String, String>,
        #[serde(default)]
        retained: BTreeMap<String, String>,
        #[serde(default)]
        removed: Vec<String>,
    },
    /// Planned by the reader, which reads the Catalog: `BuildSession::plan_packages`.
    PlanPackages {
        configuration: Configuration,
        request: crate::package_text_contract::PackageTextPlanRequest,
    },
    /// Scanned and staged by the reader, which runs `unreal-code`: `BuildSession::publish_code`.
    PublishCode {
        configuration: Configuration,
        request: crate::package_text_contract::CodeLayerRequest,
    },
    /// Read by the reader, which parses the packages: per-file records and the point's manifest.
    ReadPoint {
        configuration: Configuration,
        request: crate::package_text_contract::PointRequest,
    },
    PublishPackages {
        configuration: Configuration,
        inputs: Vec<PackageInput>,
        #[serde(rename = "removedNames", default)]
        removed_names: Vec<String>,
    },
    Intern {
        configuration: Configuration,
        domain: String,
        file: PathBuf,
    },
    Strings {
        configuration: Configuration,
        ids: Vec<u32>,
        output: PathBuf,
    },
    Join {
        configuration: Configuration,
        file: PathBuf,
    },
    Compact {
        configuration: Configuration,
        #[serde(default)]
        force: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildOutcome {
    pub action: String,
    pub capabilities: Vec<String>,
    pub root: Option<Value>,
    pub records: Vec<Value>,
    pub ids: Vec<u32>,
    pub join: Option<crate::join::JoinOutcome>,
    pub compaction: Option<crate::store::Compaction>,
    pub string_count: Option<u32>,
    pub io: crate::snapshot::IoMetrics,
    pub stage_seconds: BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub localization: Option<crate::localization::import::Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<crate::package_text_contract::PackageTextPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<Box<crate::package_text_contract::CodeLayerOutcome>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<Box<crate::package_text_contract::PointOutcome>>,
}

impl BuildOutcome {
    pub fn new(action: &str) -> Self {
        Self {
            action: action.into(),
            capabilities: vec!["game_text_index_v1".into()],
            root: None,
            records: Vec::new(),
            ids: Vec::new(),
            join: None,
            compaction: None,
            string_count: None,
            io: crate::snapshot::io_metrics(),
            stage_seconds: BTreeMap::new(),
            localization: None,
            plan: None,
            code: None,
            point: None,
        }
    }
}

impl BuildRequest {
    fn configuration(&self) -> Option<&Configuration> {
        match self {
            Self::Capabilities => None,
            Self::Begin { configuration }
            | Self::End { configuration }
            | Self::Status { configuration }
            | Self::ImportLocalization { configuration, .. }
            | Self::Publish { configuration, .. }
            | Self::PublishIds { configuration, .. }
            | Self::PublishPackages { configuration, .. }
            | Self::PlanPackages { configuration, .. }
            | Self::PublishCode { configuration, .. }
            | Self::ReadPoint { configuration, .. }
            | Self::Intern { configuration, .. }
            | Self::Strings { configuration, .. }
            | Self::Join { configuration, .. }
            | Self::Compact { configuration, .. } => Some(configuration),
        }
    }

    /// Boundary validation happens before the IO adapter emits accepted.
    pub fn validate(&self) -> Result<()> {
        if let Some(config) = self.configuration() {
            config.identity()?;
        }
        match self {
            Self::ImportLocalization { request, .. } => request.validate()?,
            Self::PublishPackages {
                inputs,
                removed_names,
                ..
            } => {
                require(
                    inputs.len() <= 256 && removed_names.len() <= 256,
                    "package batch limit",
                )?;
                let mut names = BTreeSet::new();
                for input in inputs {
                    require(
                        input.name.starts_with("package-text.")
                            && input.name.len() <= 1024
                            && !input.key.is_empty()
                            && input.key.len() <= 1024
                            && !input.previous_key.is_empty()
                            && input.previous_key.len() <= 1024
                            && input.rows.len() <= 64_000_000
                            && input
                                .rows
                                .iter()
                                .all(|row| (-64_000_000..64_000_000).contains(row))
                            && names.insert(&input.name),
                        "invalid package replacement",
                    )?;
                }
                require(
                    removed_names.iter().all(|name| {
                        name.starts_with("package-text.")
                            && name.len() <= 1024
                            && !names.contains(name)
                    }),
                    "invalid removed package shard",
                )?;
            }
            Self::Publish {
                inputs,
                removed_names,
                ..
            } => {
                require(
                    inputs.len() <= 2560 && removed_names.len() <= 2560,
                    crate::Error::new(crate::ErrorCode::InvalidInput, "layer batch limit"),
                )?;
                for input in inputs {
                    require(
                        !input.name.is_empty()
                            && input.name.len() <= 1024
                            && !input.key.is_empty()
                            && input.key.len() <= 1024,
                        crate::Error::new(crate::ErrorCode::InvalidInput, "layer name or key"),
                    )?;
                }
            }
            Self::PublishIds {
                name,
                key,
                string_columns,
                retained,
                removed,
                ..
            } => {
                require(
                    !name.is_empty() && name.len() <= 1024 && !key.is_empty() && key.len() <= 1024,
                    crate::Error::new(crate::ErrorCode::InvalidInput, "layer name or key"),
                )?;
                require(
                    string_columns.len() <= 8192 && retained.len() <= 2560 && removed.len() <= 2560,
                    crate::Error::new(
                        crate::ErrorCode::InvalidInput,
                        "column or retained layer limit",
                    ),
                )?;
            }
            Self::PublishCode { request, .. } => require(
                !request.target.is_empty()
                    && request.target.len() <= 1024
                    && !request.staging_file.is_empty()
                    && request.scan.as_ref().is_none_or(|scan| {
                        scan.targets.len() == 1 && scan.targets[0].name == request.target
                    }),
                crate::Error::new(
                    crate::ErrorCode::InvalidInput,
                    "a code layer scans its one target",
                ),
            )?,
            Self::ReadPoint { request, .. } => require(
                crate::points::valid_id(&request.point)
                    && request.base.as_deref().is_none_or(crate::points::valid_id)
                    && request.files.len() <= 1_000_000
                    && request
                        .files
                        .iter()
                        .all(|file| !file.path.is_empty() && file.path.len() <= 4096),
                crate::Error::new(crate::ErrorCode::InvalidInput, "an invalid point"),
            )?,
            Self::Strings { ids, .. } => require(
                ids.len() <= 8192,
                crate::Error::new(crate::ErrorCode::InvalidInput, "string request limit"),
            )?,
            Self::Intern { domain, .. } => require(
                !domain.is_empty() && domain.len() <= 23,
                crate::Error::new(crate::ErrorCode::InvalidInput, "string domain"),
            )?,
            _ => {}
        }
        Ok(())
    }
}

/// One session owns one explicit project/view lease; dropping it releases the writer lock.
#[derive(Default)]
pub struct BuildSession {
    leased: Option<(Configuration, Store)>,
}

impl BuildSession {
    pub fn execute(&mut self, request: &BuildRequest) -> Result<BuildOutcome> {
        self.execute_with_progress(request, &mut |_, _| Ok(()))
    }
    pub fn execute_with_progress(
        &mut self,
        request: &BuildRequest,
        progress: &mut dyn FnMut(usize, usize) -> Result<()>,
    ) -> Result<BuildOutcome> {
        request.validate()?;
        if matches!(request, BuildRequest::Capabilities) {
            return Ok(BuildOutcome::new("capabilities"));
        }
        let config = request.configuration().ok_or(crate::Error::new(
            crate::ErrorCode::InvalidInput,
            "missing configuration",
        ))?;
        if let Some((active, _)) = &self.leased {
            require(
                active == config,
                crate::Error::new(
                    crate::ErrorCode::InvalidInput,
                    "request belongs to another build lease",
                ),
            )?;
        }
        if matches!(request, BuildRequest::Begin { .. }) {
            require(
                self.leased.is_none(),
                crate::Error::new(
                    crate::ErrorCode::Busy,
                    "build session already owns a writer lease",
                ),
            )?;
            let mut store = Store::writer(config.clone())?;
            if !store.directory.join("manifest.json").exists() {
                store.publish_root()?;
            }
            let mut outcome = BuildOutcome::new("begin");
            outcome.root = Some(response_root(&store)?);
            self.leased = Some((config.clone(), store));
            return Ok(outcome);
        }
        if matches!(request, BuildRequest::End { .. }) {
            require(
                self.leased.take().is_some(),
                crate::Error::new(crate::ErrorCode::InvalidInput, "no writer lease"),
            )?;
            return Ok(BuildOutcome::new("end"));
        }
        let (_, store) = self.leased.as_mut().ok_or(crate::Error::new(
            crate::ErrorCode::InvalidInput,
            "call begin in a protocol session first",
        ))?;
        let result = execute(store, request, progress);
        // A failed publication may have staged files or remapped IDs. Reopen before further work.
        if result.is_err() {
            self.leased.take();
        }
        result
    }
}

impl BuildSession {
    /// The key the leased store holds active under `name`.
    pub fn active_layer(
        &self,
        configuration: &Configuration,
        name: &str,
    ) -> Result<Option<String>> {
        let (active, store) = self.leased.as_ref().ok_or(crate::Error::new(
            crate::ErrorCode::InvalidInput,
            "call begin in a protocol session first",
        ))?;
        require(
            active == configuration,
            crate::Error::new(
                crate::ErrorCode::InvalidInput,
                "request belongs to another build lease",
            ),
        )?;
        Ok(store.root["active"][name].as_str().map(str::to_owned))
    }

    /// Plans a package-text refresh of the reader's Catalog `inventory` against the leased store.
    pub fn plan_packages(
        &mut self,
        configuration: &Configuration,
        request: &crate::package_text_contract::PackageTextPlanRequest,
        inventory: Vec<crate::package_text_contract::PackageTextExpected>,
    ) -> Result<BuildOutcome> {
        let (active, store) = self.leased.as_ref().ok_or(crate::Error::new(
            crate::ErrorCode::InvalidInput,
            "call begin in a protocol session first",
        ))?;
        require(
            active == configuration,
            crate::Error::new(
                crate::ErrorCode::InvalidInput,
                "request belongs to another build lease",
            ),
        )?;
        let started = std::time::Instant::now();
        let mut outcome = BuildOutcome::new("plan_packages");
        outcome.plan = Some(crate::package_text_plan::plan(store, request, inventory)?);
        outcome
            .stage_seconds
            .insert("plan.keys".into(), started.elapsed().as_secs_f64());
        Ok(outcome)
    }
}

fn response_root(store: &Store) -> Result<Value> {
    let mut root = store.root.clone();
    if store.configuration_view_prefix().is_some() {
        root["active"]
            .as_object_mut()
            .ok_or("invalid shared root object")?
            .retain(|name, _| !name.starts_with("target-join."));
    }
    Ok(root)
}

fn execute(
    store: &mut Store,
    request: &BuildRequest,
    progress: &mut dyn FnMut(usize, usize) -> Result<()>,
) -> Result<BuildOutcome> {
    let _measure = crate::scan_timings::Request::new(match request {
        BuildRequest::Publish { inputs, .. }
            if inputs.iter().all(|i| i.name.starts_with("package-text.")) =>
        {
            "publish_packages"
        }
        BuildRequest::Publish { .. } => "publish_localization",
        BuildRequest::Join { .. } => "join",
        _ => "builder_other",
    });
    let _span = crate::scan_timings::Span::new("builder.execute");
    let started = Instant::now();
    let mut outcome = BuildOutcome::new("status");
    match request {
        BuildRequest::ImportLocalization { request, .. } => {
            outcome.action = "import_localization".into();
            let result = crate::localization::import::import(store, request, progress)?;
            outcome
                .stage_seconds
                .insert("localization_parse".into(), result.parse_ms / 1000.0);
            outcome.stage_seconds.insert(
                "localization_parse_cpu".into(),
                result.parse_cpu_ms / 1000.0,
            );
            outcome
                .stage_seconds
                .insert("localization_publish".into(), result.publish_ms / 1000.0);
            outcome.localization = Some(result);
        }
        BuildRequest::PublishPackages {
            inputs,
            removed_names,
            ..
        } => {
            outcome.action = "publish_packages".into();
            outcome.records = crate::package_delta::publish(store, inputs, removed_names)?;
        }
        BuildRequest::Status { .. } => {}
        BuildRequest::PlanPackages { .. } => {
            return Err("The reader plans package text from its Catalog.".into());
        }
        BuildRequest::PublishCode { .. } => {
            return Err("The reader scans code text and stages its layer.".into());
        }
        BuildRequest::ReadPoint { .. } => {
            return Err("The reader parses a point's packages.".into());
        }
        BuildRequest::Publish {
            inputs,
            cold,
            removed_names,
            ..
        } => {
            outcome.action = "publish".into();
            if *cold
                && store.root["active"]
                    .as_object()
                    .ok_or("invalid shared root object")?
                    .is_empty()
            {
                let measured = store.publish_cold(inputs)?;
                for (field, stage) in [
                    ("collectSortSeconds", "cold_collect"),
                    ("mergeSeconds", "cold_merge"),
                    ("dictionaryEncodeSeconds", "cold_dictionary"),
                    ("layerEncodeSeconds", "cold_layers"),
                ] {
                    if let Some(seconds) = measured[field].as_f64() {
                        outcome.stage_seconds.insert(stage.into(), seconds);
                    }
                }
            } else {
                if *cold {
                    store.prepare_batch_cold(inputs)?;
                } else {
                    store.prepare_batch(inputs)?;
                }
                for input in inputs {
                    store.root["active"][&input.name] = json!(input.key);
                }
            }
            for name in removed_names {
                store.root["active"]
                    .as_object_mut()
                    .ok_or("invalid shared root object")?
                    .remove(name);
            }
            store.publish_root()?;
            outcome.records = inputs
                .iter()
                .map(|input| store.root["layers"][&input.key].clone())
                .collect();
        }
        BuildRequest::PublishIds {
            name,
            key,
            file,
            generation,
            string_columns,
            retained,
            removed,
            ..
        } => {
            outcome.action = "publish_ids".into();
            outcome.records.push(publish_ids(
                store,
                name,
                key,
                file,
                generation,
                string_columns,
                retained,
                removed,
            )?);
        }
        BuildRequest::Intern { domain, file, .. } => {
            outcome.action = "intern".into();
            let bytes = bounded(file, 32 * 1024 * 1024)?;
            let mut cursor = 0;
            let mut values = Vec::new();
            while cursor < bytes.len() {
                let length = u32::from_le_bytes(
                    bytes
                        .get(cursor..cursor + 4)
                        .ok_or(crate::Error::new(
                            crate::ErrorCode::InvalidInput,
                            "truncated string length",
                        ))?
                        .try_into()?,
                ) as usize;
                cursor += 4;
                let value = bytes.get(cursor..cursor + length).ok_or(crate::Error::new(
                    crate::ErrorCode::InvalidInput,
                    "truncated string",
                ))?;
                crate::wtf8::validate(value).map_err(|cause| {
                    crate::Error::with_source(
                        crate::ErrorCode::InvalidInput,
                        "An intern request contains invalid WTF-8.",
                        cause,
                    )
                })?;
                values.push(value.to_vec());
                cursor += length;
            }
            outcome.ids = store.intern_bytes(domain, &values)?;
        }
        BuildRequest::Strings { ids, output, .. } => {
            outcome.action = "strings".into();
            let selected = crate::store::dictionary_selected_strings(
                &store.directory,
                &store.root,
                &ids.iter().copied().collect::<BTreeSet<_>>(),
            )?;
            let mut offsets = vec![0u32];
            let mut bytes = Vec::new();
            for id in ids {
                let value = crate::wtf8::Wtf8Buf::from_view(selected.get(id).ok_or(
                    crate::Error::new(crate::ErrorCode::InvalidInput, "string ID"),
                )?);
                require(
                    bytes.len() + value.as_bytes().len() <= 32 * 1024 * 1024,
                    crate::Error::new(
                        crate::ErrorCode::LimitExceeded,
                        "string response exceeds 32 MiB",
                    ),
                )?;
                bytes.extend_from_slice(value.as_bytes());
                offsets.push(bytes.len() as u32);
            }
            let mut payload = crate::snapshot::u32_bytes(&offsets);
            payload.extend(bytes);
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(output)?;
            file.write_all(&payload)?;
            outcome.string_count = Some(ids.len() as u32);
        }
        BuildRequest::Join { file, .. } => {
            outcome.action = "join".into();
            let input: crate::join::JoinInput =
                serde_json::from_slice(&bounded(file, 32 * 1024 * 1024)?).map_err(|cause| {
                    crate::Error::with_source(
                        crate::ErrorCode::InvalidInput,
                        "The native Game Text join request file is invalid.",
                        cause,
                    )
                })?;
            outcome.join = Some(crate::join::refresh(store, &input)?);
            let diagnostics = crate::join_incremental::diagnostics();
            if let Some(seconds) = diagnostics["dependencyGraphBuildSeconds"].as_f64() {
                outcome
                    .stage_seconds
                    .insert("dependency_graph_build".into(), seconds);
            }
            if let Some(stages) = diagnostics["stageSeconds"].as_object() {
                for (stage, seconds) in stages {
                    if let Some(seconds) = seconds.as_f64() {
                        outcome
                            .stage_seconds
                            .insert(format!("join_{stage}"), seconds);
                    }
                }
            }
        }
        BuildRequest::Compact { force, .. } => {
            outcome.action = "compact".into();
            outcome.compaction = Some(store.compact(*force)?);
        }
        _ => {
            return Err(crate::Error::new(
                crate::ErrorCode::InvalidInput,
                "invalid leased operation",
            ));
        }
    }
    outcome.io = crate::snapshot::io_metrics();
    outcome.root = Some(response_root(store)?);
    outcome
        .stage_seconds
        .insert(outcome.action.clone(), started.elapsed().as_secs_f64());
    Ok(outcome)
}

fn bounded(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    require(
        bytes.len() as u64 <= maximum,
        crate::Error::new(
            crate::ErrorCode::LimitExceeded,
            "staged input exceeds 32 MiB",
        ),
    )?;
    Ok(bytes)
}

#[allow(clippy::too_many_arguments)]
fn publish_ids(
    store: &mut Store,
    name: &str,
    key: &str,
    file: &Path,
    generation: &str,
    string_columns: &BTreeMap<String, String>,
    retained: &BTreeMap<String, String>,
    removed: &[String],
) -> Result<Value> {
    require(
        store.root["generation"] == generation,
        crate::Error::new(
            crate::ErrorCode::StaleGeneration,
            "global ID publication uses another dictionary",
        ),
    )?;
    for hash in retained.values() {
        require(
            store.root["layers"].get(hash).is_some(),
            crate::Error::new(crate::ErrorCode::InvalidInput, "retained layer absent"),
        )?;
    }
    let reader = Reader::open(file)?;
    let mut writer = Writer::new(&store.directory.join(format!("{}.tmp", token())))?;
    let mut order = Vec::new();
    let mut columns = serde_json::Map::new();
    let maximum = store.root["segments"]
        .as_array()
        .ok_or("invalid shared root array")?
        .last()
        .map(|segment| {
            Ok::<_, crate::Error>(
                segment["start"].as_u64().ok_or("invalid segment start")?
                    + segment["count"].as_u64().ok_or("invalid segment count")?,
            )
        })
        .transpose()?
        .unwrap_or(0);
    for id in 0..reader.entries.len() {
        let entry = reader.entries[id].clone();
        let mut bytes = reader.load(id)?;
        let mut kind = entry.kind;
        if let Some(domain) = string_columns.get(&entry.name) {
            let ids = integers(&bytes)?;
            require(
                ids.iter().all(|id| u64::from(*id) < maximum),
                crate::Error::new(
                    crate::ErrorCode::InvalidInput,
                    "global ID outside dictionary",
                ),
            )?;
            bytes = crate::store::encode_ids(&ids);
            kind = 2;
            columns.insert(entry.name.clone(), json!(domain));
        }
        order.push(writer.add(&entry.name, kind, "", &bytes, 1)?);
    }
    require(
        string_columns
            .keys()
            .all(|name| reader.entries.iter().any(|entry| &entry.name == name)),
        crate::Error::new(crate::ErrorCode::InvalidInput, "missing string column"),
    )?;
    let file = format!("layer-{}.snapshot", token());
    let mut record = json!({"file":file,"key":key,"storeGeneration":store.root["generation"],"segmentCount":store.root["segments"].as_array().ok_or("invalid shared root array")?.len(),"bytes":0,"stringColumns":columns,"idEncoding":"delta32"});
    order.push(writer.add("shared.meta", 0, "", &serde_json::to_vec(&record)?, 1)?);
    record["bytes"] = json!(writer.finish(&store.directory.join(file), &order)?);
    for name in removed {
        store.root["active"]
            .as_object_mut()
            .ok_or("invalid shared root object")?
            .remove(name);
    }
    for (name, hash) in retained {
        store.root["active"][name] = json!(hash);
    }
    store.root["layers"][key] = record.clone();
    store.root["active"][name] = json!(key);
    store.publish_root()?;
    Ok(record)
}

pub fn failure_code(error: &crate::Error) -> &'static str {
    error.code.as_str()
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    #[test]
    fn malformed_request_files_are_input_errors_and_leave_the_cache_usable() {
        let root = crate::test_directory("invalid-request");
        let configuration = Configuration {
            cache_root: root.clone(),
            project_key: "request-fixture".into(),
            target_key: "source".into(),
            shared_project: false,
            view_prefix: None,
        };
        let mut session = BuildSession::default();
        session
            .execute(&BuildRequest::Begin {
                configuration: configuration.clone(),
            })
            .unwrap();
        let file = root.join("bad-join.json");
        fs::write(&file, b"{bad").unwrap();
        let error = session
            .execute(&BuildRequest::Join {
                configuration: configuration.clone(),
                file,
            })
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::InvalidInput);
        assert!(
            std::error::Error::source(&error)
                .unwrap()
                .is::<serde_json::Error>()
        );
        crate::store::open_root(&configuration).unwrap();
        session
            .execute(&BuildRequest::Begin {
                configuration: configuration.clone(),
            })
            .unwrap();
        let file = root.join("bad-intern.bin");
        fs::write(&file, [1, 0, 0, 0, 0xff]).unwrap();
        let error = session
            .execute(&BuildRequest::Intern {
                configuration: configuration.clone(),
                domain: "source".into(),
                file,
            })
            .unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::InvalidInput);
        assert!(std::error::Error::source(&error).is_some());
        session
            .execute(&BuildRequest::Begin {
                configuration: configuration.clone(),
            })
            .unwrap();
        session
            .execute(&BuildRequest::End {
                configuration: configuration.clone(),
            })
            .unwrap();
        crate::store::open_root(&configuration).unwrap();
        drop(session);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unicode_view_prefix_without_panicking() {
        // The byte length is valid, but a view prefix accepts only lowercase ASCII hex digits.
        let prefix = format!("target-join.{}é.", "a".repeat(62));
        assert_eq!(prefix.len(), 77);
        let request = BuildRequest::Begin {
            configuration: Configuration {
                cache_root: std::env::temp_dir(),
                project_key: "validation-fixture".into(),
                target_key: "source".into(),
                shared_project: true,
                view_prefix: Some(prefix),
            },
        };
        let error = request.validate().unwrap_err();
        assert_eq!(error.code, crate::ErrorCode::InvalidInput);
    }

    #[test]
    fn invalid_requests_and_invalid_session_order_have_stable_codes() {
        let configuration = Configuration {
            cache_root: std::env::temp_dir(),
            project_key: "validation-fixture".into(),
            target_key: "source".into(),
            shared_project: false,
            view_prefix: None,
        };
        let invalid = BuildRequest::Intern {
            configuration: configuration.clone(),
            domain: "".into(),
            file: "unused".into(),
        };
        assert_eq!(
            invalid.validate().unwrap_err().code,
            crate::ErrorCode::InvalidInput
        );
        let error = BuildSession::default()
            .execute(&BuildRequest::Status { configuration })
            .unwrap_err();
        assert_eq!(failure_code(&error), "invalid_input");
    }
}
