//! The scanner against Unreal's own gathers of the fixture's source cases (Plan 060, Phase 0).
//!
//! Each manifest in `fixtures/unreal-project/FixtureExpected/unreal-code/<engine>` is what the
//! stock `GatherTextFromSource` commandlet wrote for one recipe. The scan of the same files must
//! produce exactly its entries: namespace, key, text, source location, developer notes and
//! String Table metadata.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;
use unreal_code::{
    CodePlace, CodeScan, DiagnosticCode, DiskStore, EngineLine, GatherStep, ScanSettings,
    find_wrappers, scan, step_files, wrapper_files,
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
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
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

/// The `GatherTextFromSource` step of a fixture recipe, read from its config file.
fn recipe_step(path: &Path) -> GatherStep {
    let text =
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let mut step = GatherStep::default();
    let mut in_step = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            in_step = line == "[GatherTextStep0]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| in_step) else {
            continue;
        };
        let value = value.trim().to_owned();
        match key.trim() {
            "SearchDirectoryPaths" => step.search_directory_paths.push(value),
            "ExcludePathFilters" => step.exclude_path_filters.push(value),
            "FileNameFilters" => step.file_name_filters.push(value),
            "ShouldGatherFromEditorOnlyData" => {
                step.gather_editor_only = value.eq_ignore_ascii_case("true")
            }
            _ => {}
        }
    }
    step
}

fn label(place: &CodePlace, engine: EngineLine) -> String {
    match (place.line, engine) {
        (Some(line), EngineLine::Ue4_27) => format!("{}:{line}", place.file),
        (Some(line), _) => format!("{}({line})", place.file),
        (None, _) => place.file.clone(),
    }
}

fn fixture_scan(engine: EngineLine, recipe: &str) -> CodeScan {
    let repository = repository();
    let project = if engine == EngineLine::Ue4_27 {
        repository.join("fixtures/unreal-427-localization")
    } else {
        repository.join("fixtures/unreal-project")
    };
    let step = recipe_step(&project.join("Config/Localization").join(recipe));
    let files = step_files(engine, &project, None, &step).files;
    let settings = ScanSettings {
        engine,
        gather_editor_only: step.gather_editor_only,
        game_content: project.join("Content"),
        engine_content: PathBuf::new(),
        split_platforms: Vec::new(),
    };
    // The project's half of the wrapper prepass; the engine's half holds no wrapper the fixture calls.
    let wrappers = find_wrappers(engine, &wrapper_files(&project, &project), &DiskStore);
    scan(&settings, &files, &wrappers, &DiskStore)
}

fn scanned_rows(engine: EngineLine, recipe: &str) -> BTreeSet<Row> {
    fixture_scan(engine, recipe)
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

/// Scans with the target's recipe and compares with the manifest Unreal wrote for it. The 4.27
/// recipe lives in the 4.27 project and is named for it.
fn check(engine: EngineLine, folder: &str, target: &str) {
    let manifest = format!("{target}.manifest");
    let recipe = if engine == EngineLine::Ue4_27 {
        format!("{target}427.ini")
    } else {
        format!("{target}.ini")
    };
    let expected = manifest_rows(
        &repository()
            .join("fixtures/unreal-project/FixtureExpected/unreal-code")
            .join(folder)
            .join(&manifest),
    );
    // Every manifest holds at least the shared cases; an empty read would pass vacuously.
    assert!(
        expected.len() >= 35,
        "{folder}/{manifest}: only {} entries read",
        expected.len()
    );
    let actual = scanned_rows(engine, &recipe);
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
        let result = fixture_scan(engine, "UnrealSource.ini");
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
    check(EngineLine::Ue5_8, "5.8", "UnrealSource");
    check(EngineLine::Ue5_8, "5.8", "UnrealSourceEditor");
}

#[test]
fn matches_unreal_5_7() {
    check(EngineLine::Ue5_7, "5.7", "UnrealSource");
    check(EngineLine::Ue5_7, "5.7", "UnrealSourceEditor");
}

#[test]
fn matches_unreal_4_27() {
    check(EngineLine::Ue4_27, "4.27", "UnrealSource");
}
