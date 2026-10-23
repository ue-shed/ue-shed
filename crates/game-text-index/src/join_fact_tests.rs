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
        columns.push(("package.status".into(), String::new(), vec![0]));
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
