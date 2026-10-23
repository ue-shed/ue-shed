//! Small persisted inputs with explicit expected facts, independent of the TypeScript join.
use crate::Result;
use crate::engine_query::EngineQuery;
use crate::join::{JoinInput, refresh};
use crate::join_columns::OCCURRENCE_FIELDS;
use crate::store::{Configuration, Store};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::AtomicBool;

struct Fixture {
    store: Store,
    configuration: Configuration,
    target: Value,
}

impl Fixture {
    fn new() -> Result<Self> {
        let configuration = Configuration {
            cache_root: crate::test_directory("join-facts"),
            project_key: "fixture".into(),
            target_key: "Game".into(),
            shared_project: false,
            view_prefix: None,
        };
        let store = Store::writer(configuration.clone())?;
        Ok(Self {
            store,
            configuration,
            target: json!({
                "name":"Game", "nativeCulture":"en", "cultures":["en","de"],
                "collapseMode":"IdenticalTextIdAndSource",
                "configs":[{"common":{},"steps":[{
                    "commandletClass":"GatherTextFromAssets", "fields":{
                        "IncludePathFilters":["Content/Text/*"],
                        "PackageFileNameFilters":["*.uasset"]
                    }
                }]}],
                "outputPaths":{"manifest":"Game.manifest",
                    "archives":{"en":"en.archive","de":"de.archive"},
                    "portableObjects":{"en":"en.po","de":"de.po"}}
            }),
        })
    }

    fn ids(&mut self, values: &[&str]) -> Result<Vec<u32>> {
        self.store.intern(
            "source",
            &values.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>(),
        )
    }

    fn file(&mut self, name: &str, format: &str, rows: &[Value]) -> Result<()> {
        self.ids(&[""])?;
        let fields = [
            "namespace",
            "key",
            "source",
            "translation",
            "path",
            "notes",
            "metadata",
            "source-extra",
            "translation-extra",
            "po-extra",
        ];
        let mut columns = Vec::new();
        for field in fields {
            let texts = rows
                .iter()
                .map(|row| row[field].as_str().unwrap_or(""))
                .collect::<Vec<_>>();
            columns.push((format!("entry.{field}"), "source".into(), self.ids(&texts)?));
        }
        columns.push((
            "entry.options".into(),
            String::new(),
            rows.iter()
                .map(|row| row["options"].as_u64().unwrap_or(0) as u32)
                .collect(),
        ));
        columns.push((
            "entry.ordinal".into(),
            String::new(),
            (0..rows.len() as u32).collect(),
        ));
        let path = self
            .store
            .directory
            .join(format!("test-input-{}.snapshot", crate::store::token()));
        let mut writer = crate::snapshot::Writer::new(&path.with_extension("tmp"))?;
        let values = crate::store::dictionary_bytes(&self.store.directory, &self.store.root)?;
        let mut order = vec![writer.add(
            "source.b0",
            4,
            "source",
            &crate::snapshot::string_block_bytes(&values)?,
            1,
        )?];
        order.push(writer.column("source.starts", &[0])?);
        for (name, domain, values) in columns {
            order.push(writer.add(
                &name,
                if domain.is_empty() { 2 } else { 3 },
                &domain,
                &crate::snapshot::u32_bytes(&values),
                1,
            )?);
        }
        order.push(writer.add(
            "file.meta",
            0,
            "",
            &serde_json::to_vec(
                &json!({"count":rows.len(),"format":format,"hasSourceText":true,"pathPrefix":""}),
            )?,
            1,
        )?);
        for entry in &mut writer.entries {
            if matches!(entry.kind, 3 | 4) {
                entry.strings = values.len() as u32;
            }
        }
        writer.finish(&path, &order)?;
        self.store.publish_local(
            name,
            &format!("test:{name}:{}", crate::store::token()),
            &path,
        )?;
        Ok(())
    }

    fn packages(&mut self, rows: &[Value]) -> Result<()> {
        self.packages_with_status(rows, 0)
    }

    fn packages_with_status(&mut self, rows: &[Value], status: u32) -> Result<()> {
        let mut columns = Vec::new();
        for field in OCCURRENCE_FIELDS {
            let values = if [
                "source",
                "notes",
                "namespace",
                "key",
                "object",
                "property",
                "class",
                "row",
            ]
            .contains(&field)
            {
                self.ids(
                    &rows
                        .iter()
                        .map(|row| row[field].as_str().unwrap_or(""))
                        .collect::<Vec<_>>(),
                )?
            } else {
                rows.iter()
                    .map(|row| row[field].as_u64().unwrap_or(0) as u32)
                    .collect()
            };
            columns.push((
                format!("occurrence.{field}"),
                if [
                    "source",
                    "notes",
                    "namespace",
                    "key",
                    "object",
                    "property",
                    "class",
                    "row",
                ]
                .contains(&field)
                {
                    "source".into()
                } else {
                    String::new()
                },
                values,
            ));
        }
        columns.push((
            "package.path".into(),
            "source".into(),
            self.ids(&["Content/Text/Example.uasset"])?,
        ));
        columns.push(("package.status".into(), String::new(), vec![status]));
        columns.push((
            "package.occurrence_start".into(),
            String::new(),
            vec![0, rows.len() as u32],
        ));
        for field in ["gap0", "gather_missing"] {
            columns.push((format!("package.{field}"), String::new(), vec![0]));
        }
        for field in ["gap_start", "missing_start"] {
            columns.push((format!("package.{field}"), String::new(), vec![0, 0]));
        }
        columns.push(("gap.reason".into(), String::new(), vec![]));
        self.store.publish_global(
            "package-text.0",
            &format!("test:packages:{}", crate::store::token()),
            &columns,
            b"{}",
            &BTreeMap::new(),
            &[],
        )?;
        Ok(())
    }

    fn lines(&mut self) -> Result<Vec<Value>> {
        let input: JoinInput =
            serde_json::from_value(json!({"projectRoot":"/project","target":self.target}))?;
        let outcome = refresh(&mut self.store, &input)?;
        let mut query = EngineQuery::open(&self.configuration, Some(&outcome.key))?;
        let count = query.reader.meta["count"].as_u64().ok_or("line count")? as usize;
        (0..count)
            .map(|row| query.localization_line(row, &AtomicBool::new(false)))
            .collect()
    }
}

#[test]
fn rule_subjects_read_saved_manifest_and_translation_stages_independently() -> Result<()> {
    use crate::rules::{HostCollator, NativeSubjects, Subject, SubjectRows};
    let mut fixture = Fixture::new()?;
    fixture.file("Game.manifest","manifest", &[json!({"namespace":"UI","key":"K","source":"Raw","path":"/Game/Text/Example.Example.Label","notes":"Developer context","metadata":"{\"Info\":{\"Comment\":\"Translator context\"}}","options":12})])?;
    fixture.file(
        "en.archive",
        "archive",
        &[json!({"namespace":"UI","key":"K","source":"Raw","translation":"Native"})],
    )?;
    fixture.file(
        "de.archive",
        "archive",
        &[json!({"namespace":"UI","key":"K","source":"Native","translation":"Foreign"})],
    )?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po","po", &[json!({"namespace":"UI","key":"K","source":"Native","translation":"Pending","options":64})])?;
    fixture.packages(&[json!({"namespace":"UI","key":"K","source":"Saved","object":"/Game/Text/Example.Example","property":"Label","notes":"Occurrence context"})])?;
    fixture.lines()?;
    let mut query = EngineQuery::open(&fixture.configuration, None)?;
    let collator = HostCollator::new("en")?;
    let cancelled = AtomicBool::new(false);
    let mut rows = NativeSubjects::new(&mut query, Subject::LineCulture, &collator, &cancelled)?;
    let row = (0..rows.len())
        .find(|row| rows.field(*row, "culture").ok().as_ref() == Some(&json!("de")))
        .ok_or("Missing foreign subject.")?;
    assert_eq!(rows.field(row, "line.source")?, "Saved");
    assert_eq!(rows.field(row, "line.manifestSource")?, "Raw");
    assert_eq!(rows.field(row, "line.comparisonSource")?, "Raw");
    assert_eq!(rows.field(row, "expectedSource")?, "Native");
    assert_eq!(rows.field(row, "archive")?, "Foreign");
    assert_eq!(rows.field(row, "po")?, "Pending");
    assert_eq!(rows.field(row, "latest")?, "Pending");
    assert_eq!(rows.field(row, "latestOrigin")?, "po");
    assert_eq!(rows.field(row, "line.sourceCulture")?, "en");
    assert_eq!(
        rows.field(row, "line.manifestNotes")?,
        json!(["Developer context", "Translator context"])
    );
    let occurrences = rows.occurrences(row)?;
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0]["source"], "Saved");
    assert_eq!(occurrences[0]["devNotes"], "Occurrence context");
    assert_eq!(occurrences[0]["unitStatus"], "resolved");
    drop(rows);
    let mut units = NativeSubjects::new(&mut query, Subject::UnitSource, &collator, &cancelled)?;
    assert_eq!(units.len(), 1);
    assert_eq!(units.field(0, "source")?, "Saved");
    Ok(())
}

#[test]
fn missing_table_entry_retains_unknown_without_claiming_an_unavailable_namespace() -> Result<()> {
    let mut fixture = Fixture::new()?;
    for (name, format) in [
        ("Game.manifest", "manifest"),
        ("en.archive", "archive"),
        ("de.archive", "archive"),
        ("en.po", "po"),
        ("de.po", "po"),
    ] {
        fixture.file(name, format, &[])?;
    }
    fixture.packages(&[
        json!({"source":"An entry","namespace":"UI","key":"Present","object":"/Game/Text/Table.Table","row":"Present","location":2}),
        json!({"source":"Missing entry","namespace":"/Game/Text/Table.Table","key":"Absent","object":"/Game/Text/Example.Example","property":"MissingEntry","identity":1}),
        json!({"source":"Missing table","namespace":"/Game/Text/Missing.Missing","key":"Absent","object":"/Game/Text/Example.Example","property":"MissingTable","identity":1})
    ])?;
    let lines = fixture.lines()?;
    for (source, reason) in [
        ("Missing entry", "string_table_entry_missing"),
        ("Missing table", "string_table_namespace_unavailable"),
    ] {
        let line = lines
            .iter()
            .find(|line| line["source"] == source)
            .ok_or("expected reference")?;
        assert!(line["identity"].is_null());
        for mark in line["cultures"].as_array().ok_or("culture marks")? {
            assert_eq!(mark["state"], "unknown");
            assert_eq!(mark["unknownReasons"], json!([reason]));
        }
    }
    Ok(())
}

#[test]
fn foreign_sources_use_native_archive_translations_including_metadata() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let cases = [
        ("Current", "Native", "", "Native", "", "translated"),
        ("Stale", "Native", "", "Raw", "", "needs_update"),
        ("NoOverride", "Raw", "", "Raw", "", "translated"),
        (
            "Metadata",
            "Raw",
            r#"{"MetaData":{"Tag":"Native"}}"#,
            "Raw",
            r#"{"MetaData":{"Tag":"Native"}}"#,
            "translated",
        ),
        (
            "StaleMetadata",
            "Raw",
            r#"{"MetaData":{"Tag":"Native"}}"#,
            "Raw",
            "",
            "needs_update",
        ),
        ("EmptyNative", "", "", "", "", "translated"),
    ];
    let manifest = cases.iter().map(|(key, ..)| json!({"namespace":"UI","key":key,"source":"Raw","path":"/Game/Text/Example.Example.Label"})).collect::<Vec<_>>();
    let native = cases.iter().map(|(key, translation, extra, ..)| json!({"namespace":"UI","key":key,"source":"Raw","translation":translation,"translation-extra":extra})).collect::<Vec<_>>();
    let foreign = cases.iter().map(|(key, _, _, source, extra, _)| json!({"namespace":"UI","key":key,"source":source,"source-extra":extra,"translation":"Foreign"})).collect::<Vec<_>>();
    fixture.file("Game.manifest", "manifest", &manifest)?;
    fixture.file("en.archive", "archive", &native)?;
    fixture.file("de.archive", "archive", &foreign)?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    fixture.packages(&cases.iter().map(|(key, ..)| json!({"namespace":"UI","key":key,"source":"Raw","object":"/Game/Text/Example.Example","property":key})).collect::<Vec<_>>())?;
    let lines = fixture.lines()?;
    for (key, _, _, _, _, expected) in cases {
        let line = lines
            .iter()
            .find(|line| line["identity"]["key"] == key)
            .ok_or("expected line")?;
        let mark = line["cultures"]
            .as_array()
            .ok_or("culture marks")?
            .iter()
            .find(|mark| mark["culture"] == "de")
            .ok_or("foreign mark")?;
        assert_eq!(mark["state"], expected, "{key}");
        assert_eq!(mark["unknownReasons"], json!([]), "{key}");
    }
    Ok(())
}

#[test]
fn namespace_collapsed_po_entries_join_only_their_source_and_track_pending_imports() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.target["collapseMode"] = json!("IdenticalNamespaceAndSource");
    let rows = [
        ("A", "Amber harbor"),
        ("B", "Silver harbor"),
        ("C", "Amber harbor"),
    ];
    fixture.file("Game.manifest", "manifest", &rows.iter().map(|(key, source)| json!({"namespace":"UI","key":key,"source":source,"path":"/Game/Text/Example.Example.Label"})).collect::<Vec<_>>())?;
    fixture.file("en.archive", "archive", &rows.iter().map(|(key, source)| json!({"namespace":"UI","key":key,"source":source,"translation":source})).collect::<Vec<_>>())?;
    fixture.file("de.archive", "archive", &rows.iter().map(|(key, source)| json!({"namespace":"UI","key":key,"source":source,"translation":if *key == "B" { "Silber" } else { "Bernstein" }})).collect::<Vec<_>>())?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[
        json!({"namespace":"UI","key":"","source":"Amber harbor","translation":"Bernstein","options":64}),
        json!({"namespace":"UI","key":"","source":"Silver harbor","translation":"New silver","options":64})
    ])?;
    fixture.packages(&rows.iter().map(|(key, source)| json!({"namespace":"UI","key":key,"source":source,"object":"/Game/Text/Example.Example","property":key})).collect::<Vec<_>>())?;
    for line in fixture.lines()? {
        let mark = line["cultures"]
            .as_array()
            .ok_or("cultures")?
            .iter()
            .find(|mark| mark["culture"] == "de")
            .ok_or("foreign culture")?;
        assert_eq!(mark["unknownReasons"], json!([]));
        assert_eq!(
            mark["state"],
            if line["identity"]["key"] == "B" {
                "not_synced"
            } else {
                "translated"
            }
        );
        assert_eq!(
            mark["po"]["msgstr"]["0"],
            if line["identity"]["key"] == "B" {
                "New silver"
            } else {
                "Bernstein"
            }
        );
    }
    Ok(())
}

#[test]
fn complete_inventory_proves_a_deleted_package_absent_but_unprepared_and_failed_reads_do_not()
-> Result<()> {
    for (prepared, status, path, expected, reason) in [
        (
            false,
            0,
            "/Game/Text/Deleted.Deleted.Label",
            "unknown",
            Some("package_not_scanned"),
        ),
        (
            true,
            0,
            "/Game/Text/Deleted.Deleted.Label",
            "not_found",
            None,
        ),
        (
            true,
            1,
            "/Game/Text/Example.Example.Label",
            "unknown",
            Some("package_partial"),
        ),
        (
            true,
            2,
            "/Game/Text/Example.Example.Label",
            "unknown",
            Some("package_partial"),
        ),
        (
            true,
            3,
            "/Game/Text/Example.Example.Label",
            "unknown",
            Some("package_failed"),
        ),
    ] {
        let mut fixture = Fixture::new()?;
        fixture.file(
            "Game.manifest",
            "manifest",
            &[json!({"namespace":"UI","key":"Deleted","source":"Raw","path":path})],
        )?;
        for name in ["en.archive", "de.archive"] {
            fixture.file(
                name,
                "archive",
                &[json!({"namespace":"UI","key":"Deleted","source":"Raw","translation":"Raw"})],
            )?;
        }
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])?;
        if prepared {
            fixture.packages_with_status(&[], status)?;
        }
        for line in fixture.lines()? {
            for mark in line["cultures"].as_array().ok_or("cultures")? {
                assert_eq!(
                    mark["state"], expected,
                    "prepared={prepared} status={status}"
                );
                assert_eq!(
                    mark["unknownReasons"],
                    json!(reason.into_iter().collect::<Vec<_>>())
                );
            }
        }
    }
    Ok(())
}
