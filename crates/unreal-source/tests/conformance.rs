//! The scanner against Unreal's own gathers of the fixture's source cases (Plan 060, Phase 0).
//!
//! Each manifest in `fixtures/unreal-project/FixtureExpected/unreal-source/<engine>` is what the
//! stock `GatherTextFromSource` commandlet wrote for one recipe. The scan of the same files must
//! produce exactly its entries: namespace, key, text, source location, developer notes and
//! String Table metadata.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unreal_source::{
    DiagnosticCode, DiskStore, EngineLine, ScanSettings, SourceFile, SourcePlace, SourceScan,
    find_wrappers, scan,
};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Row {
    namespace: String,
    key: String,
    source: String,
    path: String,
    dev_notes: String,
    metadata: Vec<(String, String)>,
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn text(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn manifest_rows(path: &Path) -> BTreeSet<Row> {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let units: Vec<u16> = bytes[2..]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let json: Value =
        serde_json::from_str(&String::from_utf16_lossy(&units)).unwrap_or(Value::Null);
    let mut rows = BTreeSet::new();
    fn walk(node: &Value, namespace: &[String], rows: &mut BTreeSet<Row>) {
        for child in node
            .get("Children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let source = child
                .get("Source")
                .map(|source| text(source, "Text"))
                .unwrap_or_default();
            for key in child
                .get("Keys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let mut metadata: Vec<(String, String)> = key
                    .pointer("/MetaData/Info")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .map(|(name, value)| {
                        (name.clone(), value.as_str().unwrap_or_default().to_owned())
                    })
                    .collect();
                metadata.sort();
                rows.insert(Row {
                    namespace: namespace.join("."),
                    key: text(key, "Key"),
                    source: source.clone(),
                    path: text(key, "Path"),
                    dev_notes: text(key, "DevNotes"),
                    metadata,
                });
            }
        }
        for sub in node
            .get("Subnamespaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let mut inner = namespace.to_vec();
            inner.push(text(sub, "Namespace"));
            walk(sub, &inner, rows);
        }
    }
    walk(&json, &[], &mut rows);
    rows
}

/// The project's half of Unreal's wrapper prepass: `Source` and `Plugins`, `*.cpp` and `*.h`.
/// The engine's half holds no wrapper the fixture calls.
fn prepass_files(project: &Path) -> Vec<SourceFile> {
    fn walk(folder: &Path, project: &Path, files: &mut Vec<SourceFile>) {
        let Ok(entries) = std::fs::read_dir(folder) else {
            return;
        };
        for entry in entries.filter_map(Result::ok) {
            let location = entry.path();
            if location.is_dir() {
                walk(&location, project, files);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let generated = name.ends_with(".generated.h") || name.ends_with(".gen.cpp");
            if (name.ends_with(".cpp") || name.ends_with(".h")) && !generated {
                let path = location
                    .strip_prefix(project)
                    .unwrap_or(&location)
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push(SourceFile { path, location });
            }
        }
    }
    let mut files = Vec::new();
    for folder in ["Source", "Plugins"] {
        walk(&project.join(folder), project, &mut files);
    }
    files.sort_by_key(|file| file.path.to_ascii_lowercase());
    files
}

fn label(place: &SourcePlace, engine: EngineLine) -> String {
    match (place.line, engine) {
        (Some(line), EngineLine::Ue4_27) => format!("{}:{line}", place.file),
        (Some(line), _) => format!("{}({line})", place.file),
        (None, _) => place.file.clone(),
    }
}

fn fixture_scan(engine: EngineLine, gather_editor_only: bool) -> SourceScan {
    let repository = repository();
    let project = repository.join("fixtures/unreal-project");
    let folder = project.join("FixtureSource/UnrealSource");
    let (base, content, excluded) = if engine == EngineLine::Ue4_27 {
        (
            "../unreal-project/FixtureSource/UnrealSource",
            repository.join("fixtures/unreal-427-localization/Content"),
            Some("StringTablesUnregistered.cpp"),
        )
    } else {
        ("FixtureSource/UnrealSource", project.join("Content"), None)
    };
    let mut names: Vec<String> = std::fs::read_dir(&folder)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.retain(|name| {
        let lower = name.to_ascii_lowercase();
        (lower.ends_with(".cpp") || lower.ends_with(".ini")) && Some(name.as_str()) != excluded
    });
    names.sort_by_key(|name| name.to_ascii_lowercase());
    let files: Vec<SourceFile> = names
        .iter()
        .map(|name| SourceFile {
            path: format!("{base}/{name}"),
            location: folder.join(name),
        })
        .collect();
    let settings = ScanSettings {
        engine,
        gather_editor_only,
        game_content: content,
        engine_content: PathBuf::new(),
        split_platforms: Vec::new(),
    };
    let wrappers = find_wrappers(engine, &prepass_files(&project), &DiskStore);
    scan(&settings, &files, &wrappers, &DiskStore)
}

fn scanned_rows(engine: EngineLine, gather_editor_only: bool) -> BTreeSet<Row> {
    fixture_scan(engine, gather_editor_only)
        .places
        .iter()
        .filter(|place| place.gathered)
        .map(|place| {
            let mut metadata: Vec<(String, String)> = place
                .metadata
                .iter()
                .map(|field| (field.name.clone(), field.value.clone()))
                .collect();
            metadata.sort();
            Row {
                namespace: place.namespace.clone(),
                key: place.key.clone(),
                source: place.source.clone(),
                path: label(place, engine),
                dev_notes: place.dev_notes.clone().unwrap_or_default(),
                metadata,
            }
        })
        .collect()
}

fn check(engine: EngineLine, folder: &str, manifest: &str, gather_editor_only: bool) {
    let expected = manifest_rows(
        &repository()
            .join("fixtures/unreal-project/FixtureExpected/unreal-source")
            .join(folder)
            .join(manifest),
    );
    // Every manifest holds at least the shared cases; an empty read would pass vacuously.
    assert!(
        expected.len() >= 35,
        "{folder}/{manifest}: only {} entries read",
        expected.len()
    );
    let actual = scanned_rows(engine, gather_editor_only);
    println!("{folder}/{manifest}: {} entries match", actual.len());
    let missing: Vec<&Row> = expected.difference(&actual).collect();
    let extra: Vec<&Row> = actual.difference(&expected).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "{folder}/{manifest}: {} expected, {} scanned\nmissing: {missing:#?}\nextra: {extra:#?}",
        expected.len(),
        actual.len()
    );
}

#[test]
fn says_which_wrappers_unreal_never_gathers() {
    for engine in [EngineLine::Ue5_7, EngineLine::Ue5_8] {
        let result = fixture_scan(engine, false);
        let twins: Vec<&str> = result
            .diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.code == DiagnosticCode::WrapperUnsupported)
            .map(|diagnostic| diagnostic.message.as_str())
            .collect();
        assert_eq!(twins.len(), 1, "{engine:?}: {twins:?}");
        assert!(
            twins[0].contains("UE_SHED_HARBOR_TEXT"),
            "{engine:?}: {twins:?}"
        );
    }
}

#[test]
fn matches_unreal_5_8() {
    check(EngineLine::Ue5_8, "5.8", "UnrealSource.manifest", false);
    check(
        EngineLine::Ue5_8,
        "5.8",
        "UnrealSourceEditor.manifest",
        true,
    );
}

#[test]
fn matches_unreal_5_7() {
    check(EngineLine::Ue5_7, "5.7", "UnrealSource.manifest", false);
    check(
        EngineLine::Ue5_7,
        "5.7",
        "UnrealSourceEditor.manifest",
        true,
    );
}

#[test]
fn matches_unreal_4_27() {
    check(EngineLine::Ue4_27, "4.27", "UnrealSource.manifest", false);
}
