//! Reads a point: each of its files as a record keyed by its content, read
//! only when the cache lacks it, then the point's manifest. Packages go through the projection
//! the shard staging uses, so a record holds exactly what a shard would for that file.
use std::fs;
use std::path::Path;
use std::time::Instant;

use game_text_index::builder::BuildOutcome;
use game_text_index::package_text_contract::{
    PointCode, PointEntry, PointFile, PointFileStatus, PointOutcome, PointRequest,
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
    wrappers: f64,
}

/// The target's code scan with its wrappers, found once for a point with code files.
struct Code<'a> {
    point: &'a PointCode,
    wrappers: Vec<unreal_code::WrapperMacro>,
    /// Names the wrappers and the scan context, so records change when either does.
    context: String,
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
    let reads_code = request
        .files
        .iter()
        .any(|file| file.file.is_some() && !is_package(&file.path));
    let code = match &request.code {
        Some(code) if reads_code => {
            let finding = Instant::now();
            let (wrappers, key) = unreal_code::code_wrappers(&code.scan);
            stages.wrappers = finding.elapsed().as_secs_f64();
            let scan = serde_json::to_string(&code.scan)?;
            Some(Code {
                point: code,
                wrappers,
                context: digest(
                    [key.as_str(), &code.policy_json, &scan]
                        .join("\0")
                        .as_bytes(),
                ),
            })
        }
        _ => None,
    };
    for file in &request.files {
        let entry = entry(
            configuration,
            request,
            code.as_ref(),
            file,
            &mut point,
            &mut stages,
        )?;
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
        ("point.wrappers", stages.wrappers),
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
    code: Option<&Code>,
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
    let package = is_package(&path);
    if !package {
        let Some(code) = code else {
            return Ok(PointEntry {
                path,
                record: None,
                status: PointFileStatus::Unread,
            });
        };
        // A code file the target does not gather holds no text it gathers, as in Unreal.
        if !unreal_code::target_includes(&code.point.scan, &path) {
            return Ok(PointEntry {
                path,
                record: None,
                status: PointFileStatus::NotGatherable,
            });
        }
    }
    let hashing = Instant::now();
    let bytes = fs::read(source)?;
    point.bytes += bytes.len() as u64;
    let content = digest(&bytes);
    let policy = match code {
        Some(code) if !package => code.context.as_str(),
        _ => request.policy_json.as_str(),
    };
    let key = points::record_key(&request.format, policy, &path, &content);
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
    let (stored, status) = match code {
        Some(code) if !package => (scan_code(code, &path, source), PointFileStatus::Complete),
        _ => project(&path, &content, &bytes),
    };
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

/// One code file's record: its places as the target's scan finds them in the file's bytes.
fn scan_code(code: &Code, path: &str, source: &str) -> Stored {
    let file = unreal_code::CodeFile {
        path: path.to_owned(),
        location: source.into(),
    };
    let text = unreal_code::scan_files(
        &code.point.scan,
        std::slice::from_ref(&file),
        &code.wrappers,
        &unreal_code::DiskStore,
    );
    let places = text.places.iter().collect::<Vec<_>>();
    crate::code_layer::code_record(path, &places)
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
            code: None,
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

    #[test]
    fn a_point_reads_the_code_its_target_gathers() -> Result<()> {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
        let configuration = configuration();
        let code = PointCode {
            policy_json: "{}".into(),
            scan: unreal_code::CodeTextRequest {
                project_root: project.to_string_lossy().into_owned(),
                engine_root: None,
                engine: unreal_code::EngineLine::Ue5_7,
                targets: vec![unreal_code::CodeTarget {
                    name: "UnrealSource".into(),
                    steps: vec![unreal_code::GatherStep {
                        search_directory_paths: vec!["FixtureSource/UnrealSource".into()],
                        exclude_path_filters: Vec::new(),
                        file_name_filters: vec!["*.cpp".into()],
                        gather_editor_only: false,
                    }],
                }],
                cache_root: None,
                refresh_engine_wrappers: false,
            },
        };
        let literals = project.join("FixtureSource/UnrealSource/Literals.cpp");
        let file = |path: &str| PointFile {
            path: path.into(),
            file: Some(literals.to_string_lossy().into_owned()),
        };
        let mut point = request(
            "local",
            vec![
                file("FixtureSource/UnrealSource/Literals.cpp"),
                // Outside the step's folder: the target does not gather it.
                file("Source/Other/Literals.cpp"),
            ],
        );
        point.code = Some(code.clone());
        let first = read(&configuration, &point)?
            .point
            .ok_or("a point outcome")?;
        assert_eq!(
            first.entries.iter().map(|e| e.status).collect::<Vec<_>>(),
            [PointFileStatus::Complete, PointFileStatus::NotGatherable]
        );
        assert_eq!((first.read, first.reused), (1, 0));
        let record = first.entries[0].record.clone().ok_or("a record")?;
        assert!(points::record_file(&configuration, &record).is_file());
        // Another scan context makes another record; the same one reuses it.
        let again = read(&configuration, &point)?
            .point
            .ok_or("a point outcome")?;
        assert_eq!((again.read, again.reused), (0, 1));
        point.code = Some(PointCode {
            policy_json: "{\"other\":1}".into(),
            ..code
        });
        let other = read(&configuration, &point)?
            .point
            .ok_or("a point outcome")?;
        assert_eq!((other.read, other.reused), (1, 0));
        assert_ne!(other.entries[0].record.as_deref(), Some(record.as_str()));
        let _ = fs::remove_dir_all(&configuration.cache_root);
        Ok(())
    }

    /// A code file before and after an edit, judged against a manifest and two archives.
    #[test]
    fn a_change_is_judged_against_the_localization_it_started_from() -> Result<()> {
        use game_text_index::package_text_contract::{
            BaseLocalization, ComparePointsRequest, CultureArchive, GateCheck,
            LocalizationRevision, PageRequest, PointChangeKind,
        };
        let configuration = configuration();
        let project = configuration.cache_root.join("project");
        fs::create_dir_all(project.join("Source"))?;
        let write = |name: &str, text: &str| -> Result<String> {
            let file = project.join(name);
            fs::write(&file, text)?;
            Ok(file.to_string_lossy().into_owned())
        };
        let before = write(
            "before.cpp",
            "#define LOCTEXT_NAMESPACE \"Shop\"\n\
             LOCTEXT(\"Buy\", \"Buy\");\n\
             LOCTEXT(\"Sell\", \"Sell\");\n\
             LOCTEXT(\"Gone\", \"Gone\");\n\
             LOCTEXT(\"Same\", \"Same\");\n\
             LOCTEXT(\"Moving\", \"Moving\");\n\
             #undef LOCTEXT_NAMESPACE\n",
        )?;
        let after = write(
            "after.cpp",
            "// A line above moves every macro down.\n\
             #define LOCTEXT_NAMESPACE \"Shop\"\n\
             LOCTEXT(\"Same\", \"Same\");\n\
             LOCTEXT(\"Buy\", \"Purchase\");\n\
             LOCTEXT(\"SellItem\", \"Sell\");\n\
             LOCTEXT(\"New\", \"New text\");\n\
             LOCTEXT(\"Shared\", \"Different\");\n\
             NSLOCTEXT(\"Other\", \"Moved\", \"Moving\");\n\
             #undef LOCTEXT_NAMESPACE\n",
        )?;
        let manifest = write(
            "Game.manifest",
            r#"{"FormatVersion":1,"Namespace":"","Subnamespaces":[{"Namespace":"Shop","Children":[
                {"Source":{"Text":"Buy"},"Keys":[{"Key":"Buy","Path":"Source/Shop.cpp(2)"}]},
                {"Source":{"Text":"Sell"},"Keys":[{"Key":"Sell","Path":"Source/Shop.cpp(3)"}]},
                {"Source":{"Text":"Gone"},"Keys":[{"Key":"Gone","Path":"Source/Shop.cpp(4)"}]},
                {"Source":{"Text":"Same"},"Keys":[{"Key":"Same","Path":"Source/Shop.cpp(5)"}]},
                {"Source":{"Text":"Moving"},"Keys":[{"Key":"Moving","Path":"Source/Shop.cpp(6)"}]},
                {"Source":{"Text":"Original"},"Keys":[{"Key":"Shared","Path":"Source/Other.cpp(9)"}]}]}]}"#,
        )?;
        let archive = |culture: &str,
                       translations: &[(&str, &str, &str)]|
         -> Result<CultureArchive> {
            let children = translations
                .iter()
                .map(|(key, source, text)| {
                    format!(
                        r#"{{"Source":{{"Text":"{source}"}},"Translation":{{"Text":"{text}"}},"Key":"{key}"}}"#
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            let file = write(
                &format!("{culture}.archive"),
                &format!(
                    r#"{{"FormatVersion":2,"Namespace":"","Subnamespaces":[{{"Namespace":"Shop","Children":[{children}]}}]}}"#
                ),
            )?;
            Ok(CultureArchive {
                culture: culture.into(),
                archive: LocalizationRevision {
                    path: format!("{culture}/Game.archive"),
                    file,
                    revision: format!("{culture}#1"),
                },
            })
        };
        let localization = BaseLocalization {
            native_culture: "en".into(),
            manifest: LocalizationRevision {
                path: "Game.manifest".into(),
                file: manifest,
                revision: "manifest#1".into(),
            },
            archives: vec![
                archive(
                    "en",
                    &[
                        ("Buy", "Buy", "Buy"),
                        ("Sell", "Sell", "Sell"),
                        ("Gone", "Gone", "Gone"),
                    ],
                )?,
                archive(
                    "de",
                    &[
                        ("Buy", "Buy", "Kaufen"),
                        ("Sell", "Sell", "Verkaufen"),
                        ("Gone", "Gone", "Weg"),
                        ("Moving", "Moving", "Bewegt"),
                    ],
                )?,
            ],
        };
        let code = PointCode {
            policy_json: "{}".into(),
            scan: unreal_code::CodeTextRequest {
                project_root: project.to_string_lossy().into_owned(),
                engine_root: None,
                engine: unreal_code::EngineLine::Ue5_7,
                targets: vec![unreal_code::CodeTarget {
                    name: "Game".into(),
                    steps: vec![unreal_code::GatherStep {
                        search_directory_paths: vec!["Source".into()],
                        exclude_path_filters: Vec::new(),
                        file_name_filters: vec!["*.cpp".into()],
                        gather_editor_only: false,
                    }],
                }],
                cache_root: None,
                refresh_engine_wrappers: false,
            },
        };
        for (point, file) in [("before.local", before), ("local", after)] {
            let mut request = request(
                point,
                vec![PointFile {
                    path: "Source/Shop.cpp".into(),
                    file: Some(file),
                }],
            );
            request.code = Some(code.clone());
            read(&configuration, &request)?;
        }
        let page = PageRequest {
            offset: 0,
            limit: 100,
        };
        let compared = game_text_index::point_compare::compare(
            &configuration,
            &ComparePointsRequest {
                point: "local".into(),
                base: "before.local".into(),
                gather_editor_only: false,
                localization: Some(localization),
                changes: page,
                findings: page,
            },
        )?;
        let kinds = compared
            .changes
            .iter()
            .map(|change| {
                (
                    change.kind,
                    change
                        .after
                        .as_ref()
                        .or(change.before.as_ref())
                        .map_or("", |text| text.key.as_str()),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                (PointChangeKind::Edited, "Buy"),
                (PointChangeKind::Rekeyed, "SellItem"),
                (PointChangeKind::Added, "New"),
                (PointChangeKind::Added, "Shared"),
                (PointChangeKind::Added, "Moved"),
                (PointChangeKind::Removed, "Gone"),
                (PointChangeKind::Removed, "Moving"),
            ]
        );
        // `Same` moved down a line and is unchanged.
        assert_eq!(compared.counts.unchanged, 1);
        let findings = compared.findings.ok_or("findings")?;
        assert!(findings.built);
        let found = findings
            .rows
            .iter()
            .map(|finding| {
                (
                    finding.check,
                    finding.key.clone().unwrap_or_default(),
                    finding.cultures.clone(),
                )
            })
            .collect::<Vec<_>>();
        let de = || vec!["de".to_owned()];
        assert_eq!(
            found,
            [
                (GateCheck::KeyChanged, "SellItem".into(), de()),
                (GateCheck::KeyChanged, "Moved".into(), de()),
                (GateCheck::ConflictingSource, "Shared".into(), Vec::new()),
                (GateCheck::TranslatedTextChanged, "Buy".into(), de()),
                (GateCheck::NotGathered, "New".into(), Vec::new()),
                (GateCheck::Removed, "Gone".into(), de()),
            ]
        );
        let _ = fs::remove_dir_all(&configuration.cache_root);
        Ok(())
    }
}
