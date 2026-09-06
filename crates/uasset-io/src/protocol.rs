//! Rust-side validation for the versioned UAsset IO process contract.
//!
//! This module deliberately contains only wire decoding and boundary validation. Filesystem
//! access, scheduling, and inspection belong to the IO and inspection crates introduced later in
//! the migration.

use serde::{Deserialize, Serialize};

use crate::protocol_result::ProjectIndexStatusPayload;
pub use crate::protocol_result::{ResultFrame, SavedAssetInspection};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    pub name: String,
    pub version: ContractVersion,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    #[serde(rename = "blueprint")]
    Blueprint {
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
    #[serde(rename = "project_index_status")]
    ProjectIndexStatus {
        #[serde(rename = "cacheRoot")]
        cache_root: String,
        #[serde(rename = "projectRoot")]
        project_root: String,
    },
    #[serde(rename = "project_index_refresh")]
    ProjectIndexRefresh {
        #[serde(rename = "cacheRoot")]
        cache_root: String,
        #[serde(rename = "projectRoot")]
        project_root: String,
    },
    #[serde(rename = "project_index_rebuild")]
    ProjectIndexRebuild {
        #[serde(rename = "cacheRoot")]
        cache_root: String,
        #[serde(rename = "projectRoot")]
        project_root: String,
    },
    #[serde(rename = "project_index_query")]
    ProjectIndexQuery {
        #[serde(rename = "cacheRoot")]
        cache_root: String,
        #[serde(rename = "pageEncoding")]
        page_encoding: Option<ProjectIndexPageEncoding>,
        query: ProjectIndexQuery,
    },
    #[serde(rename = "project_index_count")]
    ProjectIndexCount {
        #[serde(rename = "cacheRoot")]
        cache_root: String,
        request: ProjectIndexCount,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectIndexCount {
    pub project_id: String,
    pub expected_generation: u64,
    pub filters: Vec<ProjectIndexFilter>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProjectIndexFilter {
    Maps,
    ExactClasses { values: Vec<String> },
    ClassPrefixes { values: Vec<String> },
    ClassNameSuffixes { values: Vec<String> },
    SerializedNames { values: Vec<String> },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub enum ProjectIndexPageEncoding {
    #[serde(rename = "dictionary")]
    Dictionary,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum ProjectIndexQuery {
    #[serde(rename = "maps")]
    Maps {
        cursor: Option<String>,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        limit: u32,
        #[serde(rename = "projectId")]
        project_id: String,
    },
    #[serde(rename = "exact_classes")]
    ExactClasses {
        cursor: Option<String>,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        limit: u32,
        #[serde(rename = "projectId")]
        project_id: String,
        values: Vec<String>,
    },
    #[serde(rename = "class_prefixes")]
    ClassPrefixes {
        cursor: Option<String>,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        limit: u32,
        #[serde(rename = "projectId")]
        project_id: String,
        values: Vec<String>,
    },
    #[serde(rename = "class_name_suffixes")]
    ClassNameSuffixes {
        cursor: Option<String>,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        limit: u32,
        #[serde(rename = "projectId")]
        project_id: String,
        values: Vec<String>,
    },
    #[serde(rename = "serialized_names")]
    SerializedNames {
        cursor: Option<String>,
        #[serde(rename = "expectedGeneration")]
        expected_generation: u64,
        limit: u32,
        #[serde(rename = "projectId")]
        project_id: String,
        values: Vec<String>,
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
    #[serde(rename = "project_index_count")]
    ProjectIndexCount,
    Inspect,
    Blueprint,
    Authoring,
    Scan,
    #[serde(rename = "extract_text")]
    ExtractText,
    #[serde(rename = "extract_texture")]
    ExtractTexture,
    #[serde(rename = "saved_world")]
    SavedWorld,
    #[serde(rename = "project_index_status")]
    ProjectIndexStatus,
    #[serde(rename = "project_index_refresh")]
    ProjectIndexRefresh,
    #[serde(rename = "project_index_rebuild")]
    ProjectIndexRebuild,
    #[serde(rename = "project_index_query")]
    ProjectIndexQuery,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProgressPhase {
    Starting,
    Discovering,
    Reading,
    Inspecting,
    Emitting,
    Enumerating,
    Comparing,
    #[serde(rename = "reading_headers")]
    ReadingHeaders,
    Committing,
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
        #[serde(rename = "actualGeneration")]
        actual_generation: Option<u64>,
        code: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: Option<u64>,
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

/// Decodes exactly one bounded request frame.
pub fn decode_request_frame(input: &[u8], maximum_bytes: usize) -> Result<Request, ProtocolError> {
    if input.len() > maximum_bytes {
        return Err(ProtocolError(format!(
            "request frame exceeds configured limit of {maximum_bytes} bytes"
        )));
    }
    decode_request(input)
}

pub fn decode_event(input: &[u8]) -> Result<Event, ProtocolError> {
    let event = serde_json::from_slice::<Event>(input)
        .map_err(|error| ProtocolError(format!("invalid event: {error}")))?;
    validate_event(&event)?;
    Ok(event)
}

/// Decodes one newline-delimited event frame with a per-frame bound.
pub fn decode_event_frame(input: &[u8], maximum_bytes: usize) -> Result<Event, ProtocolError> {
    if input.is_empty() {
        return Err(ProtocolError("event frame must not be empty".to_owned()));
    }
    if input.len() > maximum_bytes {
        return Err(ProtocolError(format!(
            "event frame exceeds configured limit of {maximum_bytes} bytes"
        )));
    }
    decode_event(input)
}

/// Decodes and validates a complete NDJSON event stream.
pub fn decode_event_stream(
    input: &[u8],
    maximum_frame_bytes: usize,
) -> Result<Vec<Event>, ProtocolError> {
    let lines = input.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    let mut events = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        if index + 1 == lines.len() && line.is_empty() {
            continue;
        }
        if line.is_empty() {
            return Err(ProtocolError(format!(
                "event stream contains an empty frame at line {}",
                index + 1
            )));
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        events.push(decode_event_frame(line, maximum_frame_bytes)?);
    }
    validate_event_sequence(&events)?;
    Ok(events)
}

#[derive(Debug, Default)]
pub struct EventSequenceValidator {
    contract: Option<Contract>,
    request_id: Option<String>,
    previous_sequence: Option<u64>,
    terminal_seen: bool,
}

impl EventSequenceValidator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: &Event) -> Result<(), ProtocolError> {
        validate_event(event)?;
        if self.terminal_seen {
            return Err(ProtocolError(
                "event stream contains a frame after its terminal event".to_owned(),
            ));
        }
        let fields = event_fields(event);
        if self.previous_sequence.is_none() {
            if !matches!(event, Event::Accepted { .. }) {
                return Err(ProtocolError(
                    "event stream must begin with an accepted event".to_owned(),
                ));
            }
            if fields.sequence != 0 {
                return Err(ProtocolError(
                    "event stream sequence must begin at zero".to_owned(),
                ));
            }
            self.contract = Some(fields.contract.clone());
            self.request_id = Some(fields.request_id.clone());
        } else {
            if matches!(event, Event::Accepted { .. }) {
                return Err(ProtocolError(
                    "event stream contains more than one accepted event".to_owned(),
                ));
            }
            if self.contract.as_ref() != Some(&fields.contract) {
                return Err(ProtocolError(
                    "event stream changes contract between frames".to_owned(),
                ));
            }
            if self.request_id.as_deref() != Some(fields.request_id.as_str()) {
                return Err(ProtocolError(
                    "event stream changes requestId between frames".to_owned(),
                ));
            }
            if self
                .previous_sequence
                .is_some_and(|previous| previous.checked_add(1) != Some(fields.sequence))
            {
                return Err(ProtocolError(
                    "event stream sequence must be contiguous".to_owned(),
                ));
            }
        }
        self.previous_sequence = Some(fields.sequence);
        self.terminal_seen = is_terminal_event(event);
        Ok(())
    }

    pub fn finish(&self) -> Result<(), ProtocolError> {
        if self.previous_sequence.is_none() {
            return Err(ProtocolError("event stream must not be empty".to_owned()));
        }
        if !self.terminal_seen {
            return Err(ProtocolError(
                "event stream must end with a terminal event".to_owned(),
            ));
        }
        Ok(())
    }
}

pub fn validate_event_sequence(events: &[Event]) -> Result<(), ProtocolError> {
    let mut validator = EventSequenceValidator::new();
    for event in events {
        validator.push(event)?;
    }
    validator.finish()
}

fn event_fields(event: &Event) -> &EventFields {
    match event {
        Event::Accepted { fields, .. }
        | Event::Progress { fields, .. }
        | Event::Diagnostic { fields, .. }
        | Event::Completed { fields, .. }
        | Event::Failed { fields, .. }
        | Event::Rejected { fields, .. }
        | Event::Result { fields, .. } => fields,
    }
}

fn is_terminal_event(event: &Event) -> bool {
    matches!(
        event,
        Event::Completed { .. } | Event::Failed { .. } | Event::Rejected { .. }
    )
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
        Operation::Inspect { asset_path }
        | Operation::Blueprint { asset_path }
        | Operation::Authoring { asset_path } => validate_non_empty(asset_path, "assetPath"),
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
        Operation::ProjectIndexStatus {
            cache_root,
            project_root,
        }
        | Operation::ProjectIndexRefresh {
            cache_root,
            project_root,
        }
        | Operation::ProjectIndexRebuild {
            cache_root,
            project_root,
        } => {
            validate_non_empty(cache_root, "cacheRoot")?;
            validate_non_empty(project_root, "projectRoot")
        }
        Operation::ProjectIndexQuery {
            cache_root, query, ..
        } => {
            validate_non_empty(cache_root, "cacheRoot")?;
            validate_project_index_query(query)
        }
        Operation::ProjectIndexCount {
            cache_root,
            request,
        } => {
            validate_non_empty(cache_root, "cacheRoot")?;
            validate_non_empty(&request.project_id, "projectId")?;
            if request.expected_generation == 0
                || request.filters.is_empty()
                || request.filters.len() > 16
            {
                return Err(ProtocolError(
                    "counts require a positive generation and between 1 and 16 filters".into(),
                ));
            }
            for filter in &request.filters {
                let values = match filter {
                    ProjectIndexFilter::Maps => continue,
                    ProjectIndexFilter::ExactClasses { values }
                    | ProjectIndexFilter::ClassPrefixes { values }
                    | ProjectIndexFilter::ClassNameSuffixes { values }
                    | ProjectIndexFilter::SerializedNames { values } => values,
                };
                if values.is_empty() || values.len() > 64 {
                    return Err(ProtocolError(
                        "count filter values require between 1 and 64 entries".into(),
                    ));
                }
                for value in values {
                    validate_non_empty(value, "filter value")?;
                }
            }
            Ok(())
        }
    }
}

const PROJECT_INDEX_MAX_PAGE_SIZE: u32 = 1024;

fn validate_project_index_query(query: &ProjectIndexQuery) -> Result<(), ProtocolError> {
    let (project_id, expected_generation, limit, cursor, values) = match query {
        ProjectIndexQuery::Maps {
            cursor,
            expected_generation,
            limit,
            project_id,
        } => (project_id, *expected_generation, *limit, cursor, None),
        ProjectIndexQuery::ExactClasses {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        }
        | ProjectIndexQuery::ClassPrefixes {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        }
        | ProjectIndexQuery::ClassNameSuffixes {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        }
        | ProjectIndexQuery::SerializedNames {
            cursor,
            expected_generation,
            limit,
            project_id,
            values,
        } => (
            project_id,
            *expected_generation,
            *limit,
            cursor,
            Some(values.as_slice()),
        ),
    };
    validate_non_empty(project_id, "projectId")?;
    if expected_generation == 0 {
        return Err(ProtocolError(
            "expectedGeneration must be greater than zero".to_owned(),
        ));
    }
    if limit == 0 || limit > PROJECT_INDEX_MAX_PAGE_SIZE {
        return Err(ProtocolError(format!(
            "Project Index query limit must be between 1 and {PROJECT_INDEX_MAX_PAGE_SIZE}"
        )));
    }
    if let Some(cursor) = cursor {
        validate_non_empty(cursor, "cursor")?;
    }
    if let Some(values) = values {
        if values.is_empty() || values.len() > 64 {
            return Err(ProtocolError(
                "Project Index query values must contain between 1 and 64 entries".to_owned(),
            ));
        }
        for value in values {
            validate_non_empty(value, "query value")?;
        }
    }
    Ok(())
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
        Event::Result { result, .. } => validate_result_frame(result),
        _ => Ok(()),
    }
}

fn validate_result_frame(result: &ResultFrame) -> Result<(), ProtocolError> {
    match result {
        ResultFrame::ProjectIndexCount { result } => {
            validate_non_empty(&result.project_id, "projectId")?;
            if result.generation == 0 {
                return Err(ProtocolError("count generation must be positive".into()));
            }
            Ok(())
        }
        ResultFrame::ProjectIndexDictionaryPage { page } => {
            use crate::protocol_result::ProjectIndexDictionaryItem;
            if page.items.len() > PROJECT_INDEX_MAX_PAGE_SIZE as usize
                || page.strings.len() > PROJECT_INDEX_MAX_PAGE_SIZE as usize * 128
                || page.generation == 0
            {
                return Err(ProtocolError(
                    "invalid Project Index dictionary page bounds".to_owned(),
                ));
            }
            validate_non_empty(&page.project_id, "projectId")?;
            if let Some(cursor) = &page.next_cursor {
                validate_non_empty(cursor, "nextCursor")?;
            }
            for value in &page.strings {
                validate_non_empty(value, "dictionary string")?;
            }
            for item in &page.items {
                match item {
                    ProjectIndexDictionaryItem::Map {
                        map_path,
                        package_name,
                    } => {
                        validate_non_empty(map_path, "mapPath")?;
                        validate_non_empty(package_name, "packageName")?;
                    }
                    ProjectIndexDictionaryItem::Header {
                        classes,
                        package_name,
                        package_path,
                        serialized_names,
                    } => {
                        validate_non_empty(package_name, "packageName")?;
                        validate_non_empty(package_path, "packagePath")?;
                        for references in [classes, serialized_names] {
                            if references.len() > 64
                                || references
                                    .iter()
                                    .any(|id| *id as usize >= page.strings.len())
                            {
                                return Err(ProtocolError(
                                    "invalid Project Index dictionary references".to_owned(),
                                ));
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        ResultFrame::ProjectIndexPage { page } => {
            if page.items.len() > PROJECT_INDEX_MAX_PAGE_SIZE as usize {
                return Err(ProtocolError(format!(
                    "Project Index page must contain at most {PROJECT_INDEX_MAX_PAGE_SIZE} items"
                )));
            }
            if page.generation == 0 {
                return Err(ProtocolError(
                    "Project Index page generation must be greater than zero".to_owned(),
                ));
            }
            validate_non_empty(&page.project_id, "projectId")?;
            if let Some(cursor) = &page.next_cursor {
                validate_non_empty(cursor, "nextCursor")?;
            }
            Ok(())
        }
        ResultFrame::ProjectIndexSummary { summary }
        | ResultFrame::ProjectIndexStatus {
            status: ProjectIndexStatusPayload::Ready { summary },
        } => validate_project_index_summary(summary),
        ResultFrame::ProjectIndexStatus {
            status: ProjectIndexStatusPayload::Absent,
        } => Ok(()),
        _ => Ok(()),
    }
}

fn validate_project_index_summary(
    summary: &crate::protocol_result::ProjectIndexSummary,
) -> Result<(), ProtocolError> {
    validate_non_empty(&summary.project_id, "projectId")?;
    if summary.generation == 0 {
        return Err(ProtocolError(
            "Project Index generation must be greater than zero".to_owned(),
        ));
    }
    if summary.diagnostics.len() > 64 {
        return Err(ProtocolError(
            "Project Index diagnostics must contain at most 64 entries".to_owned(),
        ));
    }
    for diagnostic in &summary.diagnostics {
        validate_non_empty(&diagnostic.code, "diagnostic code")?;
        validate_non_empty(&diagnostic.message, "diagnostic message")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use serde_json::Value;

    use super::{
        EventSequenceValidator, decode_event, decode_event_stream, decode_request,
        decode_request_frame, validate_event_sequence,
    };

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
    const VALID_BLUEPRINT_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/blueprint-request.json"
    );
    const VALID_BLUEPRINT_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/blueprint-result-event.json"
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
    const VALID_PROJECT_INDEX_STATUS_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-status-request.json"
    );
    const VALID_PROJECT_INDEX_REFRESH_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-refresh-request.json"
    );
    const VALID_PROJECT_INDEX_REBUILD_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-rebuild-request.json"
    );
    const VALID_PROJECT_INDEX_QUERY_REQUEST: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-query-request.json"
    );
    const VALID_PROJECT_INDEX_ACCEPTED: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-accepted-event.json"
    );
    const VALID_PROJECT_INDEX_PROGRESS: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-progress-event.json"
    );
    const VALID_PROJECT_INDEX_STATUS_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-status-result-event.json"
    );
    const VALID_PROJECT_INDEX_SUMMARY_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-summary-result-event.json"
    );
    const VALID_PROJECT_INDEX_PAGE_RESULT: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-page-result-event.json"
    );
    const VALID_PROJECT_INDEX_STALE: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-stale-generation-failed-event.json"
    );
    const INVALID_MAJOR: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/request-wrong-major.json"
    );
    const INVALID_KIND: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/event-unknown-kind.json"
    );
    const INVALID_PROJECT_INDEX_OVERSIZE: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/project-index-query-oversize-limit.json"
    );
    const INVALID_PROJECT_INDEX_UNBOUNDED: &str = include_str!(
        "../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/project-index-page-unbounded.json"
    );

    #[test]
    fn accepts_shared_valid_fixtures() {
        decode_request(include_bytes!("../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-count-request.json")).unwrap();
        decode_event(include_bytes!("../../../packages/protocol/contracts/uasset-io/v1/fixtures/valid/project-index-count-result-event.json")).unwrap();
        decode_request(VALID_REQUEST.as_bytes()).expect("valid request");
        decode_request(VALID_BLUEPRINT_REQUEST.as_bytes()).expect("valid Blueprint request");
        decode_event(VALID_ACCEPTED.as_bytes()).expect("valid accepted event");
        decode_event(VALID_COMPLETED.as_bytes()).expect("valid completed event");
        decode_event(VALID_INSPECT_RESULT.as_bytes()).expect("valid inspect result event");
        for fixture in [
            VALID_AUTHORING_RESULT,
            VALID_BLUEPRINT_RESULT,
            VALID_SCAN_ASSET_RESULT,
            VALID_SCAN_INVENTORY_RESULT,
            VALID_SCAN_SUMMARY_RESULT,
            VALID_EXTRACT_TEXT_RESULT,
            VALID_EXTRACT_TEXT_OCCURRENCE_RESULT,
            VALID_EXTRACT_TEXTURE_RESULT,
            VALID_EXTRACT_TEXTURE_RECORD_RESULT,
            VALID_SAVED_WORLD_RESULT,
            VALID_PROJECT_INDEX_ACCEPTED,
            VALID_PROJECT_INDEX_PROGRESS,
            VALID_PROJECT_INDEX_STATUS_RESULT,
            VALID_PROJECT_INDEX_SUMMARY_RESULT,
            VALID_PROJECT_INDEX_PAGE_RESULT,
            VALID_PROJECT_INDEX_STALE,
        ] {
            decode_event(fixture.as_bytes()).expect("valid typed result event");
        }
        for fixture in [
            VALID_PROJECT_INDEX_STATUS_REQUEST,
            VALID_PROJECT_INDEX_REFRESH_REQUEST,
            VALID_PROJECT_INDEX_REBUILD_REQUEST,
            VALID_PROJECT_INDEX_QUERY_REQUEST,
        ] {
            decode_request(fixture.as_bytes()).expect("valid project index request");
        }
    }

    #[test]
    fn rejects_shared_invalid_fixtures() {
        assert!(decode_request(include_bytes!("../../../packages/protocol/contracts/uasset-io/v1/fixtures/invalid/project-index-count-empty-filters.json")).is_err());
        assert!(decode_request(INVALID_MAJOR.as_bytes()).is_err());
        assert!(decode_event(INVALID_KIND.as_bytes()).is_err());
        assert!(decode_request(INVALID_PROJECT_INDEX_OVERSIZE.as_bytes()).is_err());
        assert!(decode_event(INVALID_PROJECT_INDEX_UNBOUNDED.as_bytes()).is_err());
    }

    #[test]
    fn validates_a_complete_event_sequence() {
        let mut accepted = serde_json::from_str::<Value>(VALID_ACCEPTED).expect("accepted JSON");
        let mut completed = serde_json::from_str::<Value>(VALID_COMPLETED).expect("completed JSON");
        completed["sequence"] = Value::from(1_u64);
        accepted["requestId"] = Value::String("sequence-test".to_owned());
        completed["requestId"] = Value::String("sequence-test".to_owned());
        let stream = format!(
            "{}\n{}\n",
            serde_json::to_string(&accepted).expect("accepted serializes"),
            serde_json::to_string(&completed).expect("completed serializes")
        );
        let events = decode_event_stream(stream.as_bytes(), 4096).expect("valid event stream");
        validate_event_sequence(&events).expect("sequence validates twice");

        let mut validator = EventSequenceValidator::new();
        validator.push(&events[0]).expect("accepted event");
        validator.push(&events[1]).expect("completed event");
        validator.finish().expect("terminal event");
    }

    #[test]
    fn rejects_event_sequences_with_invalid_order_or_frames() {
        let mut accepted = serde_json::from_str::<Value>(VALID_ACCEPTED).expect("accepted JSON");
        let mut completed = serde_json::from_str::<Value>(VALID_COMPLETED).expect("completed JSON");
        accepted["requestId"] = Value::String("sequence-test".to_owned());
        completed["requestId"] = Value::String("sequence-test".to_owned());
        completed["sequence"] = Value::from(0_u64);
        let stream = format!(
            "{}\n{}\n",
            serde_json::to_string(&accepted).expect("accepted serializes"),
            serde_json::to_string(&completed).expect("completed serializes")
        );
        assert!(decode_event_stream(stream.as_bytes(), 4096).is_err());

        completed["sequence"] = Value::from(2_u64);
        let skipped_sequence = format!(
            "{}\n{}\n",
            serde_json::to_string(&accepted).expect("accepted serializes"),
            serde_json::to_string(&completed).expect("completed serializes")
        );
        assert!(decode_event_stream(skipped_sequence.as_bytes(), 4096).is_err());

        let only_accepted = format!(
            "{}\n",
            serde_json::to_string(&accepted).expect("accepted serializes")
        );
        assert!(decode_event_stream(only_accepted.as_bytes(), 4096).is_err());
        assert!(decode_event_stream(b"\n", 4096).is_err());
    }

    #[test]
    fn deterministic_mutations_never_panic_and_never_bypass_sequence_validation() {
        let mut accepted = serde_json::from_str::<Value>(VALID_ACCEPTED).expect("accepted JSON");
        let mut completed = serde_json::from_str::<Value>(VALID_COMPLETED).expect("completed JSON");
        accepted["requestId"] = Value::String("mutation-test".to_owned());
        completed["requestId"] = Value::String("mutation-test".to_owned());
        completed["sequence"] = Value::from(1_u64);
        let source = format!(
            "{}\n{}\n",
            serde_json::to_string(&accepted).expect("accepted serializes"),
            serde_json::to_string(&completed).expect("completed serializes")
        )
        .into_bytes();

        for seed in 0_u64..512 {
            let mut candidate = source.clone();
            let mut state = seed.wrapping_add(0x9e37_79b9);
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let index = (state as usize) % candidate.len();
            match seed % 4 {
                0 => candidate[index] ^= (state as u8).max(1),
                1 => candidate.truncate(index),
                2 => candidate.insert(index, b' '),
                _ => candidate.push(b'}'),
            }
            let result = catch_unwind(AssertUnwindSafe(|| {
                decode_event_stream(&candidate, source.len() + 8)
            }));
            let Ok(decoded) = result else {
                panic!("mutation {seed} panicked");
            };
            if let Ok(events) = decoded {
                validate_event_sequence(&events).expect("successful decode has valid sequence");
            }
        }

        let request = VALID_REQUEST.as_bytes();
        assert!(decode_request_frame(request, request.len()).is_ok());
        assert!(decode_request_frame(request, request.len() - 1).is_err());
    }
}
