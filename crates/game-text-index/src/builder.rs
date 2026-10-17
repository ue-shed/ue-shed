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
}

impl BuildOutcome {
    fn new(action: &str) -> Self {
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
            | Self::Publish { configuration, .. }
            | Self::PublishIds { configuration, .. }
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
        let result = execute(store, request);
        // A failed publication may have staged files or remapped IDs. Reopen before further work.
        if result.is_err() {
            self.leased.take();
        }
        result
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

fn execute(store: &mut Store, request: &BuildRequest) -> Result<BuildOutcome> {
    let started = Instant::now();
    let mut outcome = BuildOutcome::new("status");
    match request {
        BuildRequest::Status { .. } => {}
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
                store.publish_cold(inputs)?;
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
                serde_json::from_slice(&bounded(file, 32 * 1024 * 1024)?)?;
            outcome.join = Some(crate::join::refresh(store, &input)?);
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
    let mut reader = Reader::open(file)?;
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
