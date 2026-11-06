//! A culture without an archive reads its compiled `.locres`: the culture-state rule against
//! Unreal-compiled fixture resources (archives removed, and once with the manifest removed too)
//! and synthetic resources for the cases the fixtures lack.
use crate::Result;
use crate::engine_query::EngineQuery;
use crate::join_fact_tests::Fixture;
use crate::localization::import::{Input, Request, import};
use crate::localization::locres::source_hash_of_view;
use crate::localization::locres::tests::{Sample, encode};
use crate::localization::{Format, Limits, Options, parse_json};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

fn workspace() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate is in the workspace crates directory")
}
const GAME: &str = "Content/Localization/Game";

/// Imports files under `root` into the fixture's store, each named by its relative path.
fn import_files(fixture: &mut Fixture, root: &Path, files: &[(&str, Format)]) -> Result<()> {
    let request = Request {
        files: files
            .iter()
            .map(|(name, format)| Input {
                chunk_bytes: None,
                project_root: root.to_path_buf(),
                file: root.join(name),
                relative_path: (*name).into(),
                options: Options {
                    format: *format,
                    po_format: None,
                    collapse_mode: None,
                },
                limits: Limits::default(),
            })
            .collect(),
        maximum_in_flight_bytes: 1 << 24,
    };
    let outcome = import(fixture.store()?, &request, &mut |_, _| Ok(()))?;
    for file in &outcome.files {
        if let crate::localization::import::FileResult::Failed { error } = file {
            return Err(error.message.clone().into());
        }
    }
    Ok(())
}

/// A manifest or archive's rows by `(namespace, key)`: `(source, translation)`.
fn rows(path: &Path, format: Format) -> Result<BTreeMap<(String, String), (String, String)>> {
    let bytes = fs::read(path)?;
    let units = bytes
        .strip_prefix(&[0xff, 0xfe])
        .ok_or("fixture is UTF-16")?
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect::<Vec<_>>();
    let text = String::from_utf16(&units).map_err(|error| error.to_string())?;
    let document =
        parse_json(&text, "fixture", format, &Limits::default()).map_err(|error| error.message)?;
    Ok(document
        .rows
        .into_iter()
        .map(|row| {
            (
                (row.namespace, row.key),
                (
                    row.source.text,
                    row.translation.map(|text| text.text).unwrap_or_default(),
                ),
            )
        })
        .collect())
}

fn target(cultures: &[&str], manifest: Option<&str>, resources: Value) -> Value {
    let mut target = json!({
        "name":"Game", "nativeCulture":"en", "cultures":cultures,
        "collapseMode":"IdenticalTextIdAndSource",
        "configs":[{"common":{},"steps":[{
            "commandletClass":"GatherTextFromAssets", "fields":{
                "IncludePathFilters":["Content/Text/*"],
                "PackageFileNameFilters":["*.uasset"]
            }
        }]}],
        "outputPaths":{"archives":{},"portableObjects":{},"resources":resources}
    });
    if let Some(manifest) = manifest {
        target["outputPaths"]["manifest"] = json!(manifest);
    }
    target
}

/// Every line's culture marks by identity.
fn lines(fixture: &mut Fixture) -> Result<BTreeMap<(String, String), Vec<Value>>> {
    let outcome = fixture.join()?;
    let query = EngineQuery::open(&fixture.configuration, Some(&outcome.key))?;
    let count = query.reader.meta["count"].as_u64().ok_or("line count")? as usize;
    let mut lines = BTreeMap::new();
    for row in 0..count {
        let line = query.localization_line(row, &AtomicBool::new(false))?;
        let identity = (
            line["identity"]["namespace"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            line["identity"]["key"].as_str().unwrap_or("").to_owned(),
        );
        let cultures = line["cultures"].as_array().ok_or("cultures")?.clone();
        lines.insert(identity, cultures);
    }
    Ok(lines)
}

fn has(culture: &Value, fact: &str) -> bool {
    culture["facts"]
        .as_array()
        .is_some_and(|facts| facts.contains(&json!(fact)))
}

/// The resource-decided fact a culture of a line carries.
fn decided(culture: &Value) -> &'static str {
    ["translated", "not_translated", "needs_update"]
        .into_iter()
        .find(|fact| has(culture, fact))
        .unwrap_or("none")
}

#[test]
fn fixture_resources_without_archives_follow_unreals_compile_rule() -> Result<()> {
    let root = workspace().join("fixtures/unreal-project");
    let cultures = ["de", "en", "fr", "ja"];
    let mut fixture = Fixture::new()?;
    let manifest = format!("{GAME}/Game.manifest");
    let resources = cultures.map(|culture| format!("{GAME}/{culture}/Game.locres"));
    let mut files = vec![(manifest.as_str(), Format::Manifest)];
    files.extend(resources.iter().map(|path| (path.as_str(), Format::Locres)));
    import_files(&mut fixture, &root, &files)?;
    fixture.packages(&[])?;
    fixture.target = target(
        &cultures,
        Some(&manifest),
        json!(
            cultures
                .iter()
                .zip(&resources)
                .map(|(culture, path)| ((*culture).to_owned(), json!(path)))
                .collect::<serde_json::Map<_, _>>()
        ),
    );
    let manifest = rows(&root.join(&manifest), Format::Manifest)?;
    let archives = cultures
        .iter()
        .map(|culture| {
            rows(
                &root.join(format!("{GAME}/{culture}/Game.archive")),
                Format::Archive,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    let english = &archives[1];
    let lines = lines(&mut fixture)?;
    let mut checked = [0; 2];
    for (id, (source, _)) in &manifest {
        let marks = lines.get(id).ok_or("manifest line absent")?;
        for (ci, culture) in cultures.iter().enumerate() {
            let mark = &marks[ci];
            // The oracle is Unreal's compile rule over the removed archives: a current, non-empty
            // translation is compiled in; otherwise the source (or the native text) is.
            let native = english
                .get(id)
                .filter(|(archived, _)| archived == source)
                .map(|(_, text)| text.as_str())
                .filter(|text| !text.is_empty());
            let compiled = archives[ci]
                .get(id)
                .filter(|(archived, text)| archived == source && !text.is_empty())
                .map(|(_, text)| text.as_str());
            let expected = if *culture == "en"
                || compiled.is_some_and(|text| text != source && Some(text) != native)
            {
                "translated"
            } else {
                "not_translated"
            };
            assert_eq!(decided(mark), expected, "{id:?} {culture}");
            assert!(mark["archive"].is_null());
            assert_eq!(
                mark["locres"]["sourceHash"],
                json!(source_hash_of_view(source)),
                "{id:?} {culture}"
            );
            assert!(mark["reducedSourceChecking"] == true);
            checked[usize::from(expected == "translated")] += 1;
        }
    }
    // Both outcomes occur in the fixture.
    assert!(checked[0] > 0 && checked[1] > 0, "{checked:?}");
    Ok(())
}

#[test]
fn without_a_manifest_the_resource_decides_against_the_saved_source() -> Result<()> {
    let root = workspace().join("fixtures/unreal-project");
    let resource = format!("{GAME}/de/Game.locres");
    let manifest = rows(
        &root.join(format!("{GAME}/Game.manifest")),
        Format::Manifest,
    )?;
    let archive = rows(
        &root.join(format!("{GAME}/de/Game.archive")),
        Format::Archive,
    )?;
    let translated = archive
        .iter()
        .find(|(id, (source, text))| {
            manifest
                .get(*id)
                .is_some_and(|(current, _)| current == source)
                && !text.is_empty()
                && text != source
        })
        .ok_or("no translated fixture entry")?;
    let untranslated = manifest
        .iter()
        .find(|(id, (source, _))| {
            archive
                .get(*id)
                .is_none_or(|(archived, text)| archived != source || text.is_empty())
        })
        .ok_or("no untranslated fixture entry")?;
    let stale = manifest
        .keys()
        .find(|id| *id != translated.0 && *id != untranslated.0)
        .ok_or("no third fixture entry")?;
    let mut fixture = Fixture::new()?;
    import_files(&mut fixture, &root, &[(&resource, Format::Locres)])?;
    fixture.target = target(&["en", "de"], None, json!({"de": resource}));
    let place = |(namespace, key): &(String, String), source: &str, property: &str| {
        json!({"namespace":namespace,"key":key,"source":source,
            "object":"/Game/Text/Example.Example","property":property})
    };
    fixture.packages(&[
        place(translated.0, &manifest[translated.0].0, "A"),
        place(untranslated.0, &untranslated.1.0, "B"),
        // Saved text that changed since the resource was compiled.
        place(stale, "A newer source", "C"),
        place(
            &("Fixture".into(), "NotCompiled".into()),
            "Never compiled",
            "D",
        ),
    ])?;
    let lines = lines(&mut fixture)?;
    let expect = |id: &(String, String), state: &str| -> Result<()> {
        let de = &lines.get(id).ok_or("saved line absent")?[1];
        assert_eq!(de["state"], json!(state), "{id:?}");
        // The line still says why gather states are undecided.
        assert!(
            de["unknownReasons"]
                .as_array()
                .is_some_and(|reasons| reasons.contains(&json!("missing_manifest"))),
            "{id:?}"
        );
        Ok(())
    };
    expect(translated.0, "translated")?;
    expect(untranslated.0, "not_translated")?;
    expect(stale, "needs_update")?;
    expect(&("Fixture".into(), "NotCompiled".into()), "unknown")?;
    // English has neither archive nor resource: still unknown.
    assert_eq!(lines[translated.0][0]["state"], json!("unknown"));
    assert_eq!(
        lines[translated.0][1]["locres"]["text"],
        json!(translated.1.1)
    );
    // Rules read the shipped text and its origin from the resource.
    use crate::rules::{HostCollator, NativeSubjects, Subject, SubjectRows};
    let query = EngineQuery::open(&fixture.configuration, None)?;
    let collator = HostCollator::new("en")?;
    let cancelled = AtomicBool::new(false);
    let mut subjects = NativeSubjects::new(&query, Subject::LineCulture, &collator, &cancelled)?;
    let row = subjects
        .cultures
        .iter()
        .position(|(line, ci)| {
            ci == 1
                && query
                    .reader
                    .value("line.key", line)
                    .and_then(|key| query.reader.string(key))
                    .is_ok_and(|key| key == translated.0.1)
        })
        .ok_or("German row absent")?;
    assert_eq!(subjects.field(row, "latestOrigin")?, json!("locres"));
    assert_eq!(subjects.field(row, "latest")?, json!(translated.1.1));
    Ok(())
}

fn sample(namespace: &str, key: &str, source: &str, text: &str) -> Sample {
    Sample {
        namespace: namespace.encode_utf16().collect(),
        key: key.encode_utf16().collect(),
        source_hash: source_hash_of_view(source),
        text: text.encode_utf16().collect(),
    }
}
fn write(directory: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    let path = directory.join(name);
    fs::create_dir_all(path.parent().ok_or("parent")?)?;
    fs::write(&path, bytes)?;
    Ok(path)
}

#[test]
fn native_text_unverified_versions_and_archives_follow_the_plan() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.packages(&[])?;
    let project = fixture.configuration.cache_root.join("project");
    fixture.file(
        "Game.manifest",
        "manifest",
        &[
            json!({"namespace":"UI","key":"Native","source":"Hello","path":"/Game/Text/Example.Example.A"}),
            json!({"namespace":"UI","key":"Stale","source":"Bye","path":"/Game/Text/Example.Example.B"}),
        ],
    )?;
    fixture.file(
        "fr.archive",
        "archive",
        &[json!({"namespace":"UI","key":"Native","source":"Hello","translation":"Bonjour"})],
    )?;
    // English shows "Hi" for "Hello"; German compiled English's text in, so it is untranslated.
    write(
        &project,
        "en.locres",
        &encode(
            3,
            &[
                sample("UI", "Native", "Hello", "Hi"),
                sample("UI", "Stale", "Bye", "Bye"),
            ],
        ),
    )?;
    write(
        &project,
        "de.locres",
        &encode(
            3,
            &[
                sample("UI", "Native", "Hello", "Hi"),
                sample("UI", "Stale", "Old", "Tschüss"),
            ],
        ),
    )?;
    // Version 2's hash is unverified: a mismatch is not trusted, so the text decides.
    write(
        &project,
        "ja.locres",
        &encode(
            2,
            &[
                sample("UI", "Native", "Hello", "Konnichiwa"),
                sample("UI", "Stale", "Old", "Sayonara"),
            ],
        ),
    )?;
    // French has an archive, so its resource is never read.
    write(
        &project,
        "fr.locres",
        &encode(3, &[sample("UI", "Native", "Hello", "Salut")]),
    )?;
    import_files(
        &mut fixture,
        &project,
        &[
            ("en.locres", Format::Locres),
            ("de.locres", Format::Locres),
            ("ja.locres", Format::Locres),
            ("fr.locres", Format::Locres),
        ],
    )?;
    fixture.target = target(
        &["en", "de", "ja", "fr"],
        Some("Game.manifest"),
        json!({"en":"en.locres","de":"de.locres","ja":"ja.locres","fr":"fr.locres"}),
    );
    fixture.target["outputPaths"]["archives"] = json!({"fr":"fr.archive"});
    let lines = lines(&mut fixture)?;
    let native = &lines[&("UI".into(), "Native".into())];
    let stale = &lines[&("UI".into(), "Stale".into())];
    assert_eq!(decided(&native[0]), "translated");
    assert_eq!(decided(&native[1]), "not_translated");
    assert_eq!(decided(&native[2]), "translated");
    assert_eq!(decided(&stale[1]), "needs_update");
    assert_eq!(decided(&stale[2]), "translated");
    assert_eq!(native[3]["locres"], Value::Null);
    assert_eq!(
        native[3]["archive"]["translation"]["Text"],
        json!("Bonjour")
    );
    assert_eq!(native[3]["reducedSourceChecking"], json!(false));
    let query = EngineQuery::open(&fixture.configuration, None)?;
    assert_eq!(
        query.reader.meta["resources"],
        json!(["en.locres", "de.locres", "ja.locres", null])
    );
    assert!(query.reader.meta["dependencies"].get("fr.locres").is_none());
    Ok(())
}
