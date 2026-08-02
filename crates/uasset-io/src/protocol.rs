//! Rust-side validation for the versioned UAsset IO process contract.
//!
//! This module deliberately contains only wire decoding and boundary validation. Filesystem
//! access, scheduling, and inspection belong to the IO and inspection crates introduced later in
//! the migration.

use serde::Deserialize;

pub use crate::protocol_result::{ResultFrame, SavedAssetInspection};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub name: String,
    pub version: ContractVersion,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContractVersion {
    pub major: u32,
    pub minor: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimits {
    pub concurrency: Option<u32>,
    #[serde(rename = "maximumAssets")]
    pub maximum_assets: Option<u64>,
    #[serde(rename = "maximumOutputBytes")]
    pub maximum_output_bytes: Option<u64>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ProjectSelection {
    pub paths: Option<Vec<String>>,
    #[serde(rename = "projectRoot")]
    pub project_root: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ScanFilters {
    #[serde(rename = "classNameSuffixes")]
    pub class_name_suffixes: Option<Vec<String>>,
    #[serde(rename = "classPrefixes")]
    pub class_prefixes: Option<Vec<String>>,
    pub classes: Option<Vec<String>>,
    pub names: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Operation {
    #[serde(rename = "inspect")]
    Inspect {
        #[serde(rename = "assetPath")]
        asset_path: String,
    },
    #[serde(rename = "authoring")]
    Authoring {
        #[serde(rename = "assetPath")]
        asset_path: String,
    },
    #[serde(rename = "scan")]
    Scan {
        #[serde(rename = "cachePath")]
        cache_path: Option<String>,
        depth: ScanDepth,
        #[serde(flatten)]
        selection: ProjectSelection,
        #[serde(flatten)]
        filters: ScanFilters,
        inventory: Option<bool>,
    },
    #[serde(rename = "extract_text")]
    ExtractText {
        #[serde(flatten)]
        selection: ProjectSelection,
    },
    #[serde(rename = "extract_texture")]
    ExtractTexture {
        #[serde(flatten)]
        selection: ProjectSelection,
    },
    #[serde(rename = "saved_world")]
    SavedWorld {
        #[serde(rename = "mapPath")]
        map_path: String,
        #[serde(rename = "projectRoot")]
        project_root: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScanDepth {
    Header,
    Full,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub contract: Contract,
    pub limits: ResourceLimits,
    pub operation: Operation,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Inspect,
    Authoring,
    Scan,
    #[serde(rename = "extract_text")]
    ExtractText,
    #[serde(rename = "extract_texture")]
    ExtractTexture,
    #[serde(rename = "saved_world")]
    SavedWorld,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProgressPhase {
    Starting,
    Discovering,
    Reading,
    Inspecting,
    Emitting,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CompletionOutcome {
    Complete,
    Partial,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EventFields {
    pub contract: Contract,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Event {
    #[serde(rename = "accepted")]
    Accepted {
        #[serde(flatten)]
        fields: EventFields,
        operation: OperationKind,
    },
    #[serde(rename = "progress")]
    Progress {
        #[serde(flatten)]
        fields: EventFields,
        #[serde(rename = "completedItems")]
        completed_items: u64,
        phase: ProgressPhase,
        #[serde(rename = "totalItems")]
        total_items: Option<u64>,
    },
    #[serde(rename = "diagnostic")]
    Diagnostic {
        #[serde(flatten)]
        fields: EventFields,
        code: String,
        message: String,
        severity: DiagnosticSeverity,
    },
    #[serde(rename = "completed")]
    Completed {
        #[serde(flatten)]
        fields: EventFields,
        outcome: CompletionOutcome,
    },
    #[serde(rename = "failed")]
    Failed {
        #[serde(flatten)]
        fields: EventFields,
        code: String,
        message: String,
        #[serde(rename = "retrySafe")]
        retry_safe: bool,
    },
    #[serde(rename = "rejected")]
    Rejected {
        #[serde(flatten)]
        fields: EventFields,
        problems: Vec<String>,
    },
    #[serde(rename = "result")]
    Result {
        #[serde(flatten)]
        fields: EventFields,
        result: Box<ResultFrame>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(String);

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProtocolError {}

pub fn decode_request(input: &[u8]) -> Result<Request, ProtocolError> {
    let request = serde_json::from_slice::<Request>(input)
        .map_err(|error| ProtocolError(format!("invalid request: {error}")))?;
    validate_contract(&request.contract)?;
    validate_request(&request)?;
    Ok(request)
}

pub fn decode_event(input: &[u8]) -> Result<Event, ProtocolError> {
    let event = serde_json::from_slice::<Event>(input)
        .map_err(|error| ProtocolError(format!("invalid event: {error}")))?;
    validate_event(&event)?;
    Ok(event)
}

fn validate_contract(contract: &Contract) -> Result<(), ProtocolError> {
    if contract.name != "uasset-io" {
        return Err(ProtocolError(format!(
            "unsupported contract name {:?}",
            contract.name
        )));
    }
    if contract.version.major != 1 {
        return Err(ProtocolError(format!(
            "unsupported contract major {}",
            contract.version.major
        )));
    }
    Ok(())
}

fn validate_non_empty(value: &str, field: &str) -> Result<(), ProtocolError> {
    if value.trim().is_empty() {
        return Err(ProtocolError(format!("{field} must not be empty")));
    }
    Ok(())
}

fn validate_optional_paths(paths: &Option<Vec<String>>) -> Result<(), ProtocolError> {
    if let Some(paths) = paths {
        for path in paths {
            validate_non_empty(path, "path")?;
        }
    }
    Ok(())
}

fn validate_request(request: &Request) -> Result<(), ProtocolError> {
    validate_non_empty(&request.request_id, "requestId")?;
    if request.limits.concurrency == Some(0)
        || request.limits.maximum_output_bytes == Some(0)
        || request.limits.timeout_ms == Some(0)
    {
        return Err(ProtocolError(
            "positive resource limits must be greater than zero".to_owned(),
        ));
    }
    match &request.operation {
        Operation::Inspect { asset_path } | Operation::Authoring { asset_path } => {
            validate_non_empty(asset_path, "assetPath")
        }
        Operation::Scan {
            cache_path,
            selection,
            filters,
            ..
        } => {
            validate_non_empty(&selection.project_root, "projectRoot")?;
            validate_optional_paths(&selection.paths)?;
            if let Some(path) = cache_path {
                validate_non_empty(path, "cachePath")?;
            }
            for values in [
                &filters.class_name_suffixes,
                &filters.class_prefixes,
                &filters.classes,
                &filters.names,
            ] {
                validate_optional_paths(values)?;
            }
            Ok(())
        }
        Operation::ExtractText { selection } | Operation::ExtractTexture { selection } => {
            validate_non_empty(&selection.project_root, "projectRoot")?;
            validate_optional_paths(&selection.paths)
        }
        Operation::SavedWorld {
            map_path,
            project_root,
        } => {
            validate_non_empty(map_path, "mapPath")?;
            validate_non_empty(project_root, "projectRoot")
        }
    }
}

fn validate_event(event: &Event) -> Result<(), ProtocolError> {
    let fields = match event {
        Event::Accepted { fields, .. }
        | Event::Progress { fields, .. }
        | Event::Diagnostic { fields, .. }
        | Event::Completed { fields, .. }
        | Event::Failed { fields, .. }
        | Event::Rejected { fields, .. }
        | Event::Result { fields, .. } => fields,
    };
    validate_contract(&fields.contract)?;
    validate_non_empty(&fields.request_id, "requestId")?;
    match event {
        Event::Diagnostic { code, message, .. } | Event::Failed { code, message, .. } => {
            validate_non_empty(code, "code")?;
            validate_non_empty(message, "message")
        }
        Event::Rejected { problems, .. } if problems.is_empty() => Err(ProtocolError(
            "rejected must contain at least one problem".to_owned(),
        )),
        Event::Rejected { problems, .. } => {
            for problem in problems {
                validate_non_empty(problem, "problem")?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_event, decode_request};

    const VALID_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-request.json"
    );
    const VALID_ACCEPTED: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/accepted-event.json"
    );
    const VALID_COMPLETED: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/partial-completed-event.json"
    );
    const VALID_INSPECT_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/inspect-result-event.json"
    );
    const VALID_AUTHORING_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/authoring-result-event.json"
    );
    const VALID_SCAN_ASSET_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-asset-result-event.json"
    );
    const VALID_SCAN_INVENTORY_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-inventory-result-event.json"
    );
    const VALID_SCAN_SUMMARY_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/scan-summary-result-event.json"
    );
    const VALID_EXTRACT_TEXT_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/extract-text-result-event.json"
    );
    const VALID_EXTRACT_TEXT_OCCURRENCE_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/extract-text-occurrence-result-event.json"
    );
    const VALID_EXTRACT_TEXTURE_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/extract-text-summary-result-event.json"
    );
    const VALID_EXTRACT_TEXTURE_RECORD_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/extract-texture-record-result-event.json"
    );
    const VALID_SAVED_WORLD_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/saved-world-result-event.json"
    );
    const INVALID_MAJOR: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/request-wrong-major.json"
    );
    const INVALID_KIND: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/event-unknown-kind.json"
    );

    #[test]
    fn accepts_shared_valid_fixtures() {
        decode_request(VALID_REQUEST.as_bytes()).expect("valid request");
        decode_event(VALID_ACCEPTED.as_bytes()).expect("valid accepted event");
        decode_event(VALID_COMPLETED.as_bytes()).expect("valid completed event");
        decode_event(VALID_INSPECT_RESULT.as_bytes()).expect("valid inspect result event");
        for fixture in [
            VALID_AUTHORING_RESULT,
            VALID_SCAN_ASSET_RESULT,
            VALID_SCAN_INVENTORY_RESULT,
            VALID_SCAN_SUMMARY_RESULT,
            VALID_EXTRACT_TEXT_RESULT,
            VALID_EXTRACT_TEXT_OCCURRENCE_RESULT,
            VALID_EXTRACT_TEXTURE_RESULT,
            VALID_EXTRACT_TEXTURE_RECORD_RESULT,
            VALID_SAVED_WORLD_RESULT,
        ] {
            decode_event(fixture.as_bytes()).expect("valid typed result event");
        }
    }

    #[test]
    fn rejects_shared_invalid_fixtures() {
        assert!(decode_request(INVALID_MAJOR.as_bytes()).is_err());
        assert!(decode_event(INVALID_KIND.as_bytes()).is_err());
    }
}
