//! A target's code layer: the places `unreal-code` finds in the target's C++, config and String
//! Table CSV files, as package-text records, one per file, staged and published like a package
//! shard. The layer is keyed by its content, so a scan that finds what the index holds publishes
//! nothing and the target's join stays as it is.
use std::collections::BTreeMap;
use std::path::Path;

use game_text_index::builder::{BuildOutcome, BuildRequest, BuildSession, InputLayer};
use game_text_index::package_text_contract::{
    CODE_DIAGNOSTIC_SAMPLES, CodeLayerOutcome, CodeLayerRequest, code_layer,
};
use game_text_index::store::{Configuration, digest};
use game_text_index::{Error, ErrorCode, Result};
use unreal_code::{CodePlace, CodeTextResult};

use crate::package_text_columns::{Columns, Evidence, Occurrence, Stored, write_staged};
use crate::protocol_result::{
    EditCapability, ProjectionStatus, SavedAssetPackageTextRecord, TextExtractionIdentity,
    TextExtractionLocation, TextGapCounts,
};

/// The package-text schema version these records carry.
const SCHEMA_VERSION: u8 = 8;

pub fn publish(
    session: &mut BuildSession,
    configuration: &Configuration,
    request: &CodeLayerRequest,
) -> Result<BuildOutcome> {
    let name = code_layer(&request.target);
    let active = session.active_layer(configuration, &name)?;
    let Some(scan) = &request.scan else {
        let mut outcome = if active.is_some() {
            session.execute(&BuildRequest::Publish {
                configuration: configuration.clone(),
                inputs: Vec::new(),
                cold: false,
                removed_names: vec![name.clone()],
            })?
        } else {
            BuildOutcome::new("publish_code")
        };
        outcome.action = "publish_code".into();
        outcome.code = Some(Box::new(CodeLayerOutcome {
            published: active.is_some(),
            ..empty(name)
        }));
        return Ok(outcome);
    };
    let started = std::time::Instant::now();
    let result = unreal_code::run(scan);
    let scanned = started.elapsed().as_secs_f64();
    let stored = records(&result)?;
    let mut hashed = Vec::new();
    for record in &stored {
        serde_json::to_writer(&mut hashed, record)?;
        hashed.push(b'\n');
    }
    let key = format!(
        "{}:code:{}",
        request.format,
        digest(&[request.policy_json.as_bytes(), &hashed].concat())
    );
    let mut code = summary(&result, name.clone(), key.clone());
    let mut outcome = if active.as_deref() == Some(key.as_str()) {
        BuildOutcome::new("publish_code")
    } else {
        let mut columns = Columns::new()?;
        for record in stored {
            columns.feed(record, &request.rules)?;
        }
        write_staged(Path::new(&request.staging_file), &columns.finish()?)?;
        code.published = true;
        session.execute(&BuildRequest::Publish {
            configuration: configuration.clone(),
            inputs: vec![InputLayer {
                name,
                key,
                file: request.staging_file.clone().into(),
            }],
            cold: true,
            removed_names: Vec::new(),
        })?
    };
    outcome.action = "publish_code".into();
    outcome.stage_seconds.insert("code.scan".into(), scanned);
    outcome.code = Some(Box::new(code));
    Ok(outcome)
}

fn empty(name: String) -> CodeLayerOutcome {
    CodeLayerOutcome {
        name,
        key: None,
        published: false,
        places: 0,
        left_out: 0,
        files: 0,
        counts: None,
        diagnostic_count: 0,
        diagnostics: Vec::new(),
        engine_wrappers: None,
        profile: None,
    }
}

fn summary(result: &CodeTextResult, name: String, key: String) -> CodeLayerOutcome {
    let mut code = empty(name);
    code.key = Some(key);
    code.engine_wrappers = Some(result.engine_wrappers);
    code.profile = Some(result.profile.clone());
    if let Some(target) = result.targets.first() {
        code.places = target.places.len() as u32;
        code.left_out = target.places.iter().filter(|p| !p.gathered).count() as u32;
        code.files = target
            .places
            .iter()
            .map(|place| place.file.as_str())
            .collect::<std::collections::BTreeSet<_>>()
            .len() as u32;
        code.counts = Some(target.files.clone());
        code.diagnostic_count = target.diagnostics.len() as u32;
        code.diagnostics = target
            .diagnostics
            .iter()
            .take(CODE_DIAGNOSTIC_SAMPLES)
            .cloned()
            .collect();
    }
    code
}

/// One record per file with places, in path order; within a file, in scan order.
fn records(result: &CodeTextResult) -> Result<Vec<Stored>> {
    let target = result.targets.first().ok_or(Error::new(
        ErrorCode::InvalidInput,
        "a code layer scans its one target",
    ))?;
    let mut files = BTreeMap::<&str, Vec<&CodePlace>>::new();
    for place in &target.places {
        files.entry(place.file.as_str()).or_default().push(place);
    }
    Ok(files
        .into_iter()
        .map(|(file, places)| Stored {
            signature: String::new(),
            path: file.to_owned(),
            evidence: Evidence::Package {
                record: Box::new(SavedAssetPackageTextRecord {
                    file_bytes: 0,
                    path: file.to_owned(),
                    package_name: None,
                    asset_class: None,
                    schema_version: SCHEMA_VERSION,
                    status: ProjectionStatus::Complete,
                    decode_errors: 0,
                    occurrences: places.into_iter().map(occurrence).collect(),
                    gap_counts: TextGapCounts::default(),
                    text_gap_counts: None,
                    gap_samples: Vec::new(),
                    gather_coverage: None,
                    blueprint_classes: Vec::new(),
                }),
                blueprint_json: None,
            },
        })
        .collect())
}

fn occurrence(place: &CodePlace) -> Occurrence {
    Occurrence {
        source: place.source.clone(),
        dev_notes: place.dev_notes.clone().unwrap_or_default(),
        identity: TextExtractionIdentity::Resolved {
            namespace: place.namespace.clone(),
            key: place.key.clone(),
        },
        location: TextExtractionLocation::CodePlace {
            file: place.file.clone(),
            line: place.line,
            macro_name: place.macro_name.clone(),
            wrapper: place.wrapper.clone(),
            table: place.table.clone(),
        },
        // UE Shed never edits code (Plan 060, decision 8).
        edit_capability: EditCapability::ReadOnly,
        gather_editor_only: Some(place.editor_only),
        copies: Vec::new(),
        left_out: !place.gathered,
    }
}
