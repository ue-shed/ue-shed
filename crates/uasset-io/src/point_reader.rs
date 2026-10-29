//! Reads a point: each of its files as a record keyed by its content, read
//! only when the cache lacks it, then the point's manifest. Packages go through the projection
//! the shard staging uses, so a record holds exactly what a shard would for that file.
use std::fs;
use std::path::Path;
use std::time::Instant;

use game_text_index::builder::BuildOutcome;
use game_text_index::package_text_contract::{
    PointEntry, PointFile, PointFileStatus, PointOutcome, PointRequest,
};
use game_text_index::points;
use game_text_index::store::{Configuration, digest, token};
use game_text_index::wtf8::Wtf8Buf;
use game_text_index::{Error, ErrorCode, Result};
use uasset_inspection::package_header::PackageHeaderData;
use uasset_parser::package::Package;

use crate::package_text_columns::{Columns, Evidence, Stored, native_stored, write_staged};

/// Time spent per stage, in seconds, for the host's span.
#[derive(Default)]
struct Stages {
    hash: f64,
    parse: f64,
    write: f64,
}

pub fn read(configuration: &Configuration, request: &PointRequest) -> Result<BuildOutcome> {
    let started = Instant::now();
    let mut stages = Stages::default();
    let mut point = PointOutcome {
        point: request.point.clone(),
        read: 0,
        reused: 0,
        bytes: 0,
        entries: Vec::with_capacity(request.files.len()),
    };
    for file in &request.files {
        let entry = entry(configuration, request, file, &mut point, &mut stages)?;
        point.entries.push(entry);
    }
    points::write_point(
        configuration,
        &request.point,
        request.base.as_deref(),
        &point.entries,
    )?;
    let mut outcome = BuildOutcome::new("read_point");
    for (stage, seconds) in [
        ("point.hash", stages.hash),
        ("point.parse", stages.parse),
        ("point.write", stages.write),
        ("point.total", started.elapsed().as_secs_f64()),
    ] {
        outcome.stage_seconds.insert(stage.into(), seconds);
    }
    outcome.point = Some(Box::new(point));
    Ok(outcome)
}

fn entry(
    configuration: &Configuration,
    request: &PointRequest,
    file: &PointFile,
    point: &mut PointOutcome,
    stages: &mut Stages,
) -> Result<PointEntry> {
    let path = file.path.replace('\\', "/");
    let Some(source) = &file.file else {
        return Ok(PointEntry {
            path,
            record: None,
            status: PointFileStatus::Removed,
        });
    };
    if !is_package(&path) {
        return Ok(PointEntry {
            path,
            record: None,
            status: PointFileStatus::Unread,
        });
    }
    let hashing = Instant::now();
    let bytes = fs::read(source)?;
    point.bytes += bytes.len() as u64;
    let content = digest(&bytes);
    let key = points::record_key(&request.format, &request.policy_json, &path, &content);
    stages.hash += hashing.elapsed().as_secs_f64();
    let record = points::record_file(configuration, &key);
    let status_file = record.with_extension("status");
    if let (true, Ok(status)) = (record.is_file(), fs::read_to_string(&status_file)) {
        point.reused += 1;
        return Ok(PointEntry {
            path,
            record: Some(key),
            status: serde_json::from_str(&status)?,
        });
    }
    let parsing = Instant::now();
    let (stored, status) = project(&path, &content, &bytes);
    let mut columns = Columns::new()?;
    columns.feed(stored, &request.rules)?;
    let columns = columns.finish()?;
    stages.parse += parsing.elapsed().as_secs_f64();
    let writing = Instant::now();
    write_record(&record, &status_file, &columns, status)?;
    stages.write += writing.elapsed().as_secs_f64();
    point.read += 1;
    Ok(PointEntry {
        path,
        record: Some(key),
        status,
    })
}

fn is_package(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".uasset") || lower.ends_with(".umap")
}

/// The record a shard would hold for these bytes: not gatherable from the header's flags, else
/// the package's text, or the failure that stopped it.
fn project(path: &str, signature: &str, bytes: &[u8]) -> (Stored, PointFileStatus) {
    let view = |text: &str| Wtf8Buf::from_utf8(text).into_view();
    let failed = |code: &str, message: String| {
        (
            Stored {
                path: view(path),
                signature: view(signature),
                evidence: Evidence::Error {
                    code: view(code),
                    message: view(&message),
                    path: view(path),
                    retry_safe: false,
                    json: None,
                },
            },
            PointFileStatus::Failed,
        )
    };
    let package = match Package::parse(bytes) {
        Ok(package) => package,
        Err(error) => return failed("package_parse", format!("could not parse {path}: {error}")),
    };
    if !crate::direct_executor::gathered(Some(&PackageHeaderData::from_package(&package))) {
        return (
            Stored {
                path: view(path),
                signature: view(signature),
                evidence: Evidence::NotGatherable { path: view(path) },
            },
            PointFileStatus::NotGatherable,
        );
    }
    let (events, partial) = match crate::direct_executor::package_text_events(path, bytes, &package)
    {
        Ok(result) => result,
        Err(error) => return failed(&error.code, error.message),
    };
    let stored = events
        .into_iter()
        .find_map(|event| native_stored(event, path, signature));
    match stored {
        Some(stored) => {
            let status = match &stored.evidence {
                Evidence::Error { .. } => PointFileStatus::Failed,
                _ if partial => PointFileStatus::Partial,
                _ => PointFileStatus::Complete,
            };
            (stored, status)
        }
        None => failed("no_record", format!("{path} produced no text record")),
    }
}

/// Writes a record and its status beside it; the record's rename comes last, so a record that
/// exists is complete.
fn write_record(
    record: &Path,
    status_file: &Path,
    columns: &[crate::package_text_columns::Column],
    status: PointFileStatus,
) -> Result<()> {
    let directory = record
        .parent()
        .ok_or_else(|| Error::new(ErrorCode::Io, "A record has no folder."))?;
    fs::create_dir_all(directory)?;
    fs::write(status_file, serde_json::to_string(&status)?)?;
    let temporary = record.with_extension(format!("{}.tmp", token()));
    write_staged(&temporary, columns)?;
    fs::rename(&temporary, record)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configuration() -> Configuration {
        Configuration {
            cache_root: std::env::temp_dir().join(format!("ue-shed-points-{}", token())),
            project_key: "fixture".into(),
            target_key: "Game".into(),
            shared_project: false,
            view_prefix: None,
        }
    }

    fn request(point: &str, files: Vec<PointFile>) -> PointRequest {
        PointRequest {
            point: point.into(),
            base: None,
            format: "test-format".into(),
            policy_json: "{}".into(),
            rules: Vec::new(),
            files,
        }
    }

    #[test]
    fn a_point_reads_each_package_once_and_names_what_it_cannot_read() -> Result<()> {
        let package = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/legacy-unreal-project/Generated/4.27/Content/Legacy/DA_LegacyText.uasset");
        let configuration = configuration();
        let files = vec![
            PointFile {
                path: r"Content\Legacy\DA_LegacyText.uasset".into(),
                file: Some(package.to_string_lossy().into_owned()),
            },
            PointFile {
                path: "Content/Legacy/Gone.uasset".into(),
                file: None,
            },
            PointFile {
                path: "Source/Game/Menu.cpp".into(),
                file: Some(package.to_string_lossy().into_owned()),
            },
        ];
        let first = read(&configuration, &request("depot@1", files.clone()))?;
        let first = first.point.ok_or("a point outcome")?;
        assert_eq!((first.read, first.reused), (1, 0));
        assert_eq!(
            first.entries.iter().map(|e| e.status).collect::<Vec<_>>(),
            [
                PointFileStatus::Complete,
                PointFileStatus::Removed,
                PointFileStatus::Unread
            ]
        );
        assert_eq!(first.entries[0].path, "Content/Legacy/DA_LegacyText.uasset");
        let key = first.entries[0].record.clone().ok_or("a record")?;
        assert!(points::record_file(&configuration, &key).is_file());
        assert!(points::point_file(&configuration, "depot@1")?.is_file());
        // The same bytes at another point reuse the record.
        let second = read(&configuration, &request("depot@2", files))?;
        let second = second.point.ok_or("a point outcome")?;
        assert_eq!((second.read, second.reused), (0, 1));
        assert_eq!(second.entries[0].record.as_deref(), Some(key.as_str()));
        assert_eq!(second.entries[0].status, PointFileStatus::Complete);
        let _ = fs::remove_dir_all(&configuration.cache_root);
        Ok(())
    }
}
