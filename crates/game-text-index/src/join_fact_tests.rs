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
fn partial_packages_keep_empty_archive_entries_checkable_with_absent_or_blank_saved_source()
-> Result<()> {
    use crate::rules::{HostCollator, NativeSubjects, Subject, SubjectRows};
    for saved_source in [None, Some("")] {
        let mut fixture = Fixture::new()?;
        fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":"Source","path":"/Game/Text/Example.Example.Label"})])?;
        fixture.file(
            "en.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":"Source","translation":"Source"})],
        )?;
        fixture.file(
            "de.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":"Source","translation":""})],
        )?;
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])?;
        let rows = saved_source.map(|source| vec![json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/Example.Example","property":"Label"})]).unwrap_or_default();
        fixture.packages_with_status(&rows, 1)?;
        let lines = fixture.lines()?;
        if saved_source.is_none() {
            assert!(
                lines[0]["cultures"][1]["unknownReasons"]
                    .as_array()
                    .is_some_and(|reasons| reasons.contains(&json!("package_partial")))
            );
        }
        let mut query = EngineQuery::open(&fixture.configuration, None)?;
        let collator = HostCollator::new("en")?;
        let cancelled = AtomicBool::new(false);
        let mut subjects =
            NativeSubjects::new(&mut query, Subject::LineCulture, &collator, &cancelled)?;
        let de = subjects
            .cultures
            .iter()
            .position(|(_, ci)| ci == 1)
            .ok_or("Missing German row.")?;
        assert_eq!(subjects.field(de, "latest")?, json!(""));
        assert_eq!(
            subjects.field(de, "line.comparisonSource")?,
            json!("Source")
        );
        assert_eq!(subjects.field(de, "line.checkable")?, json!(true));
        let program = example_program(&["empty_translation"], None)?;
        let evaluation = program.evaluate(&mut subjects, &collator)?;
        assert_eq!(
            evaluation
                .findings
                .iter()
                .filter(|finding| finding.row == de)
                .count(),
            1
        );
    }
    Ok(())
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
fn manifest_notes_count_for_saved_lines_and_the_detail_keeps_the_list_culture_scope() -> Result<()>
{
    use crate::engine_types::{DetailSelection, LocalizationDetailRequest, parse_search_request};
    let mut fixture = Fixture::new()?;
    // `Noted` has translator notes only in its manifest entry; `Plain` has none anywhere.
    fixture.file("Game.manifest","manifest",&[
        json!({"namespace":"UI","key":"N","source":"Noted","path":"/Game/Text/Example.Example.Noted","notes":"Manifest context","options":4}),
        json!({"namespace":"UI","key":"P","source":"Plain","path":"/Game/Text/Example.Example.Plain"}),
    ])?;
    fixture.file(
        "en.archive",
        "archive",
        &[
            json!({"namespace":"UI","key":"N","source":"Noted","translation":"Noted"}),
            json!({"namespace":"UI","key":"P","source":"Plain","translation":"Plain"}),
        ],
    )?;
    // Only German has translation work: `Plain` has no German translation.
    fixture.file(
        "de.archive",
        "archive",
        &[json!({"namespace":"UI","key":"N","source":"Noted","translation":"Notiert"})],
    )?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    fixture.packages(&[
        json!({"namespace":"UI","key":"N","source":"Noted","object":"/Game/Text/Example.Example","property":"Noted"}),
        json!({"namespace":"UI","key":"P","source":"Plain","object":"/Game/Text/Example.Example","property":"Plain"}),
    ])?;
    let lines = fixture.lines()?;
    let plain = lines
        .iter()
        .find(|line| line["source"] == "Plain")
        .and_then(|line| line["id"].as_str())
        .ok_or("Missing the plain line.")?
        .to_owned();
    let mut query = EngineQuery::open(&fixture.configuration, None)?;
    let cancelled = AtomicBool::new(false);
    let without_notes = parse_search_request(
        &json!({"query":"","capability":"all","pageSize":50,"withoutNotes":true,
            "localization":{"target":"Game"}})
        .to_string(),
    )?;
    let page = query.search(&without_notes, &cancelled)?;
    let listed = page["localization"]["lines"]
        .as_array()
        .ok_or("Missing lines.")?
        .iter()
        .map(|line| line["source"].clone())
        .collect::<Vec<_>>();
    assert_eq!(listed, [json!("Plain")]);
    let detail = |culture: Option<&str>| LocalizationDetailRequest {
        target: "Game".into(),
        selection: DetailSelection {
            kind: "line".into(),
            id: plain.clone(),
        },
        culture: culture.map(str::to_owned),
        cultures: None,
        culture_offset: None,
        location_offset: None,
        po_context_offset: None,
    };
    let english = query.localization_detail(&detail(Some("en")), &cancelled)?;
    assert_eq!(english["problems"], json!(["up_to_date"]));
    let every = query.localization_detail(&detail(None), &cancelled)?;
    assert_eq!(every["problems"], json!(["translation"]));
    // Translations outside the scope are still listed.
    assert_eq!(english["translations"].as_array().map(Vec::len), Some(2));
    Ok(())
}

#[test]
fn search_atoms_are_reused_by_their_normal_form_and_never_change_an_answer() -> Result<()> {
    use crate::engine_types::parse_search_request;
    let mut fixture = Fixture::new()?;
    fixture.file("Game.manifest","manifest",&[
        json!({"namespace":"UI","key":"N","source":"Noted","path":"/Game/Text/Example.Example.Noted","notes":"Manifest context","options":4}),
        json!({"namespace":"UI","key":"P","source":"Plain","path":"/Game/Text/Example.Example.Plain"}),
        json!({"namespace":"UI","key":"Q","source":"Played","path":"/Game/Text/Example.Example.Played"}),
    ])?;
    fixture.file("en.archive", "archive", &[])?;
    fixture.file(
        "de.archive",
        "archive",
        &[json!({"namespace":"UI","key":"N","source":"Noted","translation":"Notiert"})],
    )?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    fixture.packages(&[
        json!({"namespace":"UI","key":"N","source":"Noted","object":"/Game/Text/Example.Example","property":"Noted"}),
        json!({"namespace":"UI","key":"P","source":"Plain","object":"/Game/Text/Example.Example","property":"Plain"}),
        json!({"namespace":"UI","key":"Q","source":"Played","object":"/Game/Text/Example.Example","property":"Played"}),
    ])?;
    fixture.lines()?;
    let cancelled = AtomicBool::new(false);
    let mut warm = EngineQuery::open(&fixture.configuration, None)?;
    let missing = json!([{"field":"notes","op":"is","values":["missing"]}]);
    let target = json!({"target":"Game"});
    let german = json!({"target":"Game","culture":"de","searchTranslations":true});
    let requests = [
        json!({"query":"","capability":"all","pageSize":50,"filter":missing,"localization":target}),
        json!({"query":"pl","capability":"all","pageSize":50,"filter":missing,"localization":target}),
        json!({"query":"pl","capability":"all","pageSize":50,"filter":missing,"localization":target}),
        json!({"query":"no","capability":"all","pageSize":50,"filter":missing,"localization":target}),
        json!({"query":"notiert","capability":"all","pageSize":50,"localization":german}),
        json!({"query":"pla","capability":"all","pageSize":50,"withoutNotes":true}),
    ];
    let mut atoms = Vec::new();
    let mut listed = Vec::new();
    for value in &requests {
        let request = parse_search_request(&value.to_string())?;
        let answer = warm.search(&request, &cancelled)?;
        let cold = EngineQuery::open(&fixture.configuration, None)?.search(&request, &cancelled)?;
        assert_eq!(answer, cold, "{value}");
        atoms.push(warm.atoms.len());
        listed.push(
            answer["localization"]["lines"]
                .as_array()
                .map(|lines| lines.iter().map(|line| line["source"].clone()).collect())
                .unwrap_or_else(Vec::new),
        );
    }
    assert_eq!(listed[1], [json!("Plain"), json!("Played")]);
    assert_eq!(listed[3], Vec::<Value>::new());
    // A translation search matches the German text, after every other atom.
    assert_eq!(listed[4], [json!("Noted")]);
    // A repeated request reuses every atom; one that changes only its text adds one.
    assert_eq!(atoms[2], atoms[1]);
    assert_eq!(atoms[3], atoms[2] + 1);
    Ok(())
}

#[test]
fn parts_compute_only_what_they_name_and_open_groups_list_their_first_rows() -> Result<()> {
    use crate::engine_types::parse_search_request;
    let mut fixture = Fixture::new()?;
    fixture.file("Game.manifest","manifest",&[
        json!({"namespace":"UI","key":"N","source":"Noted","path":"/Game/Text/Example.Example.Noted"}),
        json!({"namespace":"UI","key":"P","source":"Plain","path":"/Game/Text/Example.Example.Plain"}),
        json!({"namespace":"UI","key":"Q","source":"Plain","path":"/Game/Text/Example.Example.Again"}),
    ])?;
    fixture.file("en.archive", "archive", &[])?;
    fixture.file("de.archive", "archive", &[])?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    fixture.packages(&[
        json!({"namespace":"UI","key":"N","source":"Noted","object":"/Game/Text/Example.Example","property":"Noted"}),
        json!({"namespace":"UI","key":"P","source":"Plain","object":"/Game/Text/Example.Example","property":"Plain"}),
        json!({"namespace":"UI","key":"Q","source":"Plain","object":"/Game/Text/Example.Example","property":"Again"}),
    ])?;
    fixture.lines()?;
    let cancelled = AtomicBool::new(false);
    let mut query = EngineQuery::open(&fixture.configuration, None)?;
    let mut search = |value: Value| -> Result<Value> {
        query.search(&parse_search_request(&value.to_string())?, &cancelled)
    };
    let base = json!({"query":"","capability":"all","pageSize":50,"group":"source",
        "facets":{"origins":true},"localization":{"target":"Game"}});
    let with = |extra: Value| {
        let mut value = base.clone();
        for (key, field) in extra.as_object().into_iter().flatten() {
            value[key] = field.clone();
        }
        value
    };
    // Every part is the default answer.
    let full = search(base.clone())?;
    assert_eq!(
        search(with(json!({"parts":["rows","counts","facets","groups"]})))?,
        full
    );
    let groups = search(with(json!({"parts":["groups"]})))?;
    assert_eq!(groups["groups"], full["groups"]);
    for absent in [
        "counts",
        "total",
        "problems",
        "facets",
        "localization",
        "units",
    ] {
        assert!(groups.get(absent).is_none(), "{absent}");
    }
    let entries = full["groups"]["entries"]
        .as_array()
        .ok_or("Missing groups.")?;
    let keys = entries
        .iter()
        .map(|entry| entry["key"].clone())
        .collect::<Vec<_>>();
    assert_eq!(keys.len(), 2);
    let two = entries
        .iter()
        .position(|entry| entry["count"] == 2)
        .ok_or("Missing the two-line group.")?;
    let sources = |page: &Value| {
        page["localization"]["lines"]
            .as_array()
            .map(|lines| {
                lines
                    .iter()
                    .map(|line| line["source"].clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    // Open groups list their first rows in the order named; a key nothing has lists none.
    let rows = search(with(json!({"parts":["rows"],"firstRows":1,
        "openGroups":[keys[1], keys[0], "Nowhere"]})))?;
    for absent in ["counts", "groups", "facets"] {
        assert!(rows.get(absent).is_none(), "{absent}");
    }
    assert_eq!(rows["units"], json!([]));
    assert_eq!(sources(&rows), Vec::<Value>::new());
    let open = rows["openGroups"]
        .as_array()
        .ok_or("Missing open groups.")?;
    assert_eq!(
        open.iter()
            .map(|group| group["key"].clone())
            .collect::<Vec<_>>(),
        [keys[1].clone(), keys[0].clone(), json!("Nowhere")]
    );
    assert_eq!(sources(&open[2]["page"]), Vec::<Value>::new());
    // Each open group's page is the first page an `openGroup` read lists, with its cursor.
    for (index, key) in keys.iter().enumerate() {
        let page = &open[1 - index]["page"];
        let read = search(with(json!({"parts":["rows"],"pageSize":1,"openGroup":key})))?;
        assert_eq!(sources(page), sources(&read));
        assert_eq!(page["units"], read["units"]);
        assert_eq!(
            page["localization"]["nextCursor"],
            read["localization"]["nextCursor"]
        );
    }
    let example = &open[1 - two]["page"];
    let cursor = example["localization"]["nextCursor"].clone();
    assert!(cursor.is_string(), "the two-line group has a next page");
    let more = search(with(
        json!({"parts":["rows"],"pageSize":50,"openGroup":keys[two],
        "localizationCursor":cursor}),
    ))?;
    let mut listed = sources(example);
    listed.extend(sources(&more));
    let whole = search(with(json!({"parts":["rows"],"openGroup":keys[two]})))?;
    assert_eq!(listed, sources(&whole));
    assert_eq!(listed.len(), 2);
    Ok(())
}

fn example_program(checks: &[&str], document: Option<Value>) -> Result<crate::rules::Program> {
    crate::rules::compile(&example_document(checks, document)?)
}

/// The effective v4 document's JSON text, as the host sends it; without a document, the starter's checks.
fn example_document(checks: &[&str], document: Option<Value>) -> Result<String> {
    let output = std::process::Command::new("node").args(["--import","tsx","--input-type=module","-e","import {effectiveRuleDocument} from './packages/game-text/src/rules/effective.ts';import {STARTER_CHECK_RULES} from './packages/game-text/src/starter-rules.ts';const [checks,document]=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(effectiveRuleDocument(document??STARTER_CHECK_RULES,{checks})));",&serde_json::to_string(&(checks,document))?])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Missing repository root.")?).output()?;
    crate::require(
        output.status.success(),
        std::str::from_utf8(&output.stderr)?,
    )?;
    Ok(String::from_utf8(output.stdout)?)
}

#[test]
fn example_row_checks_emit_the_existing_evidence() -> Result<()> {
    use crate::rules::{HostCollator, NativeSubjects, Subject};
    let cases = vec![
        (
            "format_arguments",
            "Take {Count} {Item}",
            "Nimm {Count}",
            json!({"arguments":["Count"],"missing":["Item"],"added":[]}),
            json!({"arguments":["Count","Item"]}),
        ),
        (
            "argument_modifiers",
            "{N}|plural(one=x,other=y)",
            "{N}|plural(one=x)",
            json!({"side":"translation","issues":[{"code":"missing_form","modifier":"plural","argument":"N","forms":["other"],"position":3}],"modifiers":[{"argument":"N","name":"plural"}]}),
            json!({"modifiers":[{"argument":"N","name":"plural"}]}),
        ),
        (
            "rich_text",
            "<Em>Hello</>",
            "<Em>Hallo",
            json!({"opening":1,"closing":0}),
            json!({"opening":1,"closing":1}),
        ),
        (
            "po_escape_safety",
            "Line",
            "Zeile\\n",
            json!({"positions":[5],"sequences":["\\n"]}),
            json!({"roundTripSafe":true}),
        ),
        (
            "whitespace",
            "Hello",
            " Hallo",
            json!({"leading":" ","trailing":"","lineBreaks":0}),
            json!({"leading":"","trailing":"","lineBreaks":0}),
        ),
        (
            "empty_translation",
            "Empty",
            "",
            json!({"entryExists":true,"translation":""}),
            json!({"nonEmptyTranslation":true}),
        ),
        (
            "missing_translator_notes",
            "Hello",
            "Hallo",
            json!({"noteCount":0}),
            json!({"minimumNotes":1}),
        ),
        (
            "format_argument_renamed",
            "Take {Count}",
            "Nimm {Anzahl}",
            json!({"arguments":["Anzahl"],"renamed":[{"from":"Anzahl","to":"Count"}]}),
            json!({"arguments":["Count"]}),
        ),
        (
            "rich_text_tags",
            "Press <Key>Space</> or <img id=\"pad\"/>",
            "Leertaste drücken",
            json!({"tags":[],"missing":["Key","img"],"added":[]}),
            json!({"tags":["Key","img"]}),
        ),
        (
            "rich_text_tag_case",
            "<Italic>Note</>",
            "<italic>Hinweis</>",
            json!({"changed":[{"source":"Italic","translation":"italic"}]}),
            json!({"sameCase":true}),
        ),
        (
            "line_breaks",
            "Torn Pages\nA scrap",
            "Seiten",
            json!({"lineBreaks":0}),
            json!({"lineBreaks":1}),
        ),
        (
            "segment_separator",
            "First//Second",
            "Erste",
            json!({"separator":"//","count":0}),
            json!({"separator":"//","count":1}),
        ),
        (
            "length_outlier",
            "A fairly long sentence about the harbour",
            "Hafen",
            json!({"length":5,"ratio":0.13}),
            json!({"sourceLength":40,"minimumRatio":0.33,"maximumRatio":3}),
        ),
        (
            "placeholder_translation",
            "An actual long sentence",
            "TODO",
            json!({"translation":"TODO"}),
            json!({"translatedText":true}),
        ),
        (
            "rich_text_tags_added",
            "Plain",
            "<b>Schlicht</>",
            json!({"tags":["b"],"added":["b"]}),
            json!({"tags":[]}),
        ),
        (
            "placeholder_text",
            "TODO",
            "Erledigt",
            json!({"source":"TODO","matches":["TODO"]}),
            json!({"finalText":true}),
        ),
        (
            "source_whitespace",
            " Score:  10 ",
            "Punkte",
            json!({"source":" Score:  10 ","leading":" ","trailing":" ","repeatedSpaces":1}),
            json!({"trimmed":true}),
        ),
        (
            "source_markup",
            "<b>Hi",
            "Hallo",
            json!({"source":"<b>Hi","richText":{"opening":1,"closing":0},"braces":{"opening":0,"closing":0}}),
            json!({"balanced":true}),
        ),
        (
            "number_only_text",
            "100",
            "100",
            json!({"source":"100"}),
            json!({"cultureInvariant":true}),
        ),
    ];
    for (check, source, translation, actual, expectation) in cases {
        let mut fixture = Fixture::new()?;
        fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":source,"path":"/Game/Text/Example.Example.Label"})])?;
        fixture.file(
            "en.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":source,"translation":source})],
        )?;
        fixture.file(
            "de.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":source,"translation":translation})],
        )?;
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])?;
        fixture.packages(&[json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/Example.Example","property":"Label"})])?;
        fixture.lines()?;
        let document = if check == "segment_separator" {
            Some(
                json!({"schemaVersion":1,"roles":[],"rules":[{"kind":"segment_separator","params":{"separator":"//"}}]}),
            )
        } else {
            None
        };
        let program = example_program(&[check], document)?;
        let mut query = EngineQuery::open(&fixture.configuration, None)?;
        let collator = HostCollator::new("en")?;
        let cancelled = AtomicBool::new(false);
        let mut findings = Vec::new();
        for subject in [Subject::Line, Subject::LineCulture] {
            let mut rows = NativeSubjects::new(&mut query, subject, &collator, &cancelled)?;
            let evaluation = program.evaluate(&mut rows, &collator)?;
            findings.extend(evaluation.findings);
        }
        let found = findings
            .iter()
            .find(|finding| finding.actual == actual && finding.expectation == expectation);
        assert!(
            found.is_some(),
            "{check}: actual findings {findings:?}, expected {actual} / {expectation}"
        );
        if check == "format_argument_renamed" {
            assert_eq!(found.ok_or("Missing rename.")?.fix, "Nimm {Count}");
        }
    }
    Ok(())
}

#[test]
fn remaining_source_and_archive_checks_keep_their_evidence() -> Result<()> {
    use crate::rules::{HostCollator, NativeSubjects, Subject};
    for (check, source, recorded, expected_actual, expected_expectation) in [
        (
            "outdated_translation",
            "New source",
            "Old source",
            json!({"translatedSource":"Old source"}),
            json!({"source":"New source"}),
        ),
        (
            "source_line_endings_changed",
            "A\nB",
            "A\r\nB",
            json!({"translatedSource":"A\r\nB"}),
            json!({"source":"A\nB"}),
        ),
        (
            "string_table_key_collision",
            "Text",
            "Text",
            json!({"tables":["/Game/Text/A.A","/Game/Text/B.B"],"tableCount":2}),
            json!({"oneTablePerKey":true}),
        ),
    ] {
        let mut fixture = Fixture::new()?;
        fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":source,"path":"/Game/Text/Example.Example.Label"})])?;
        fixture.file(
            "en.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":source,"translation":source})],
        )?;
        fixture.file(
            "de.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":recorded,"translation":"Foreign"})],
        )?;
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])?;
        fixture.packages(&if check == "string_table_key_collision" { vec![json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/A.A","location":2,"row":"K"}),json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/B.B","location":2,"row":"K"})] } else { vec![json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/Example.Example","property":"Label"})] })?;
        fixture.lines()?;
        let program = example_program(&[check], None)?;
        let mut query = EngineQuery::open(&fixture.configuration, None)?;
        let collator = HostCollator::new("en")?;
        let cancelled = AtomicBool::new(false);
        let mut findings = Vec::new();
        for subject in [Subject::Line, Subject::LineCulture] {
            let mut rows = NativeSubjects::new(&mut query, subject, &collator, &cancelled)?;
            findings.extend(program.evaluate(&mut rows, &collator)?.findings);
        }
        assert_eq!(findings.len(), 1, "{check}: {findings:?}");
        assert_eq!(findings[0].actual, expected_actual, "{check}");
        assert_eq!(findings[0].expectation, expected_expectation, "{check}");
    }
    Ok(())
}

#[test]
fn every_authored_kind_uses_the_same_evaluator_and_existing_evidence() -> Result<()> {
    use crate::rules::{HostCollator, NativeSubjects, Subject};
    let role = json!({"id":"all","scopes":[{"matchers":[{"kind":"object_path","operator":"prefix","value":"/Game/"}]}]});
    let cases = vec![
        (
            json!({"schemaVersion":1,"roles":[role],"rules":[{"id":"budget","kind":"character_budget","role":"all","maximumCharacters":4,"recovery":"Shorten it."}]}),
            "😀 bad",
            "Hallo",
            json!({"characterCount":6,"kind":"character_count","source":"😀 bad"}),
            json!({"kind":"maximum_characters","maximumCharacters":4}),
        ),
        (
            json!({"schemaVersion":1,"roles":[role],"rules":[{"id":"terms","kind":"terminology","role":"all","caseSensitive":false,"terms":[{"kind":"forbidden","term":"bad"}],"recovery":"Replace it."}]}),
            "😀 bad",
            "Hallo",
            json!({"end":6,"kind":"terminology_match","source":"😀 bad","start":3,"term":"bad"}),
            json!({"kind":"forbidden_term","term":"bad"}),
        ),
        (
            json!({"schemaVersion":1,"roles":[role],"rules":[{"id":"budget","kind":"localization_character_budget","role":"all","cultures":{"de":2},"recovery":"Shorten it."}]}),
            "Hi",
            "Hallo",
            json!({"kind":"character_count","characterCount":5,"translation":"Hallo"}),
            json!({"kind":"maximum_characters","maximumCharacters":2}),
        ),
        (
            json!({"schemaVersion":1,"roles":[role],"rules":[{"id":"terms","kind":"localization_terminology","role":"all","caseSensitive":false,"cultures":{"de":[{"kind":"forbidden","term":"bad"}]},"recovery":"Replace it."}]}),
            "Hi",
            "😀 bad",
            json!({"kind":"terminology_match","translation":"😀 bad","start":3,"end":6,"term":"bad"}),
            json!({"kind":"forbidden_term","term":"bad"}),
        ),
        (
            json!({"schemaVersion":1,"roles":[],"rules":[{"id":"pattern","label":"Pattern","kind":"pattern","subject":"translation","pattern":"\\bbad\\b","recovery":"Replace it."}]}),
            "Hi",
            "😀 bad",
            json!({"text":"😀 bad","matches":[{"match":"bad","start":3,"end":6}]}),
            json!({"pattern":"\\bbad\\b","report":"match"}),
        ),
        (
            json!({"schemaVersion":1,"roles":[],"rules":[{"id":"length","label":"Length","kind":"length","subject":"source","measure":"characters","minimum":2,"recovery":"Expand it."}]}),
            "😀",
            "Hallo",
            json!({"text":"😀","length":1}),
            json!({"measure":"characters","minimum":2}),
        ),
        (
            json!({"schemaVersion":1,"roles":[],"rules":[{"id":"terms","label":"Terms","kind":"forbidden_term","subject":"translation","terms":["bad"],"caseSensitive":false,"recovery":"Replace it."}]}),
            "Hi",
            "😀 bad",
            json!({"text":"😀 bad","matches":[{"match":"bad","start":3,"end":6}]}),
            json!({"terms":["bad"]}),
        ),
    ];
    for (document, source, translation, actual, expectation) in cases {
        let mut fixture = Fixture::new()?;
        fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":source,"path":"/Game/Text/Example.Example.Label"})])?;
        fixture.file(
            "en.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":source,"translation":source})],
        )?;
        fixture.file(
            "de.archive",
            "archive",
            &[json!({"namespace":"UI","key":"K","source":source,"translation":translation})],
        )?;
        fixture.file("en.po", "po", &[])?;
        fixture.file("de.po", "po", &[])?;
        fixture.packages(&[json!({"namespace":"UI","key":"K","source":source,"object":"/Game/Text/Example.Example","property":"Label"})])?;
        fixture.lines()?;
        let program = example_program(&[], Some(document))?;
        let mut query = EngineQuery::open(&fixture.configuration, None)?;
        let collator = HostCollator::new("en")?;
        let cancelled = AtomicBool::new(false);
        let mut findings = Vec::new();
        for subject in [Subject::Line, Subject::LineCulture, Subject::UnitSource] {
            let mut rows = NativeSubjects::new(&mut query, subject, &collator, &cancelled)?;
            findings.extend(program.evaluate(&mut rows, &collator)?.findings);
        }
        assert_eq!(
            findings.len(),
            1,
            "actual findings {findings:?}, expected {actual}"
        );
        assert_eq!(findings[0].actual, actual);
        assert_eq!(findings[0].expectation, expectation);
    }
    Ok(())
}

#[test]
fn persisted_findings_reuse_their_layer_and_retain_the_joined_view() -> Result<()> {
    let mut fixture = Fixture::new()?;
    fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":"Take {Count}","path":"/Game/Text/Example.Example.Label"})])?;
    fixture.file(
        "en.archive",
        "archive",
        &[json!({"namespace":"UI","key":"K","source":"Take {Count}","translation":"Take {Count}"})],
    )?;
    fixture.file("de.archive","archive",&[json!({"namespace":"UI","key":"K","source":"Take {Count}","translation":"Nimm {Anzahl}"})])?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    fixture.packages(&[json!({"namespace":"UI","key":"K","source":"Take {Count}","object":"/Game/Text/Example.Example","property":"Label"})])?;
    fixture.lines()?;
    let rules = example_document(&["format_argument_renamed"], None)?;
    let configuration = fixture.configuration.clone();
    drop(fixture);
    let cancelled = AtomicBool::new(false);
    let mut query = EngineQuery::open(&configuration, None)?;
    let joined = query.reader.joined_key.clone();
    let result = crate::json_value::parse(&query.findings_evaluate(&rules, "en", &cancelled)?)?;
    let key = result["key"].as_str().ok_or("Missing findings key.")?;
    assert_eq!(result["diagnosticCount"], 0);
    assert_eq!(result["counts"][0]["count"], 1);
    let page = |key: &str, limit: usize| {
        json!({"key":key,"view":"report","order":"report","limit":limit}).to_string()
    };
    let reply = query.findings_query(&page(key, 50), &cancelled)?;
    let lines = crate::json_value::parse(&reply)?;
    // The profile is set in the encoded reply; the text must be the reply's own encoding.
    assert_eq!(reply, crate::rules::javascript_json(&lines, false));
    let finding = &lines["findings"][0];
    assert_eq!(
        finding["actual"],
        json!({"arguments":["Anzahl"],"renamed":[{"from":"Anzahl","to":"Count"}]})
    );
    assert_eq!(finding["suggestedChange"]["translation"], "Nimm {Count}");
    assert_eq!(
        lines["places"][0]["occurrences"]
            .as_array()
            .ok_or("Missing places.")?
            .len(),
        1
    );
    assert_eq!(result["profile"]["cached"], false);
    let cached = crate::json_value::parse(&query.findings_evaluate(&rules, "en", &cancelled)?)?;
    let mut expected_cached = result.clone();
    expected_cached["profile"] = json!({"cached":true});
    assert_eq!(cached, expected_cached);
    assert_eq!(lines["profile"]["rowsRequested"], 50);
    assert_eq!(lines["profile"]["findingsReturned"], 1);
    assert_eq!(lines["profile"]["fileFallback"], false);
    assert_eq!(
        lines["profile"]["responseBytes"],
        crate::rules::javascript_json(&lines, false).len()
    );
    let (_, root) = crate::store::open_root(&configuration)?;
    assert_eq!(root["active"]["joined"], joined);
    assert_eq!(root["active"]["findings"], key);
    // The page's stage times, and so its length, differ between reads; the rest is the layer's.
    let unstaged = |mut page: Value| {
        page["stages"] = json!({});
        page["profile"]["responseBytes"] = json!(0);
        page
    };
    let mut reopened = EngineQuery::open(&configuration, None)?;
    assert_eq!(
        unstaged(crate::json_value::parse(
            &reopened.findings_query(&page(key, 50), &cancelled)?
        )?),
        unstaged(lines.clone())
    );
    assert!(
        reopened
            .findings_query(&page("missing", 50), &cancelled)
            .is_err()
    );
    assert!(
        reopened
            .findings_query(&page(key, 5001), &cancelled)
            .is_err()
    );
    let mut store = Store::writer(configuration)?;
    store.compact(true)?;
    drop(store);
    assert_eq!(
        unstaged(crate::json_value::parse(
            &query.findings_query(&page(key, 50), &cancelled)?
        )?),
        unstaged(lines)
    );
    Ok(())
}

#[test]
fn persisted_place_sets_may_exceed_one_dictionary_string() -> Result<()> {
    // One line placed 6,000 times under long object paths: its finding's place set, as one JSON
    // string, would pass the dictionary's 1 MiB string cap.
    let occurrences = 6000;
    let mut fixture = Fixture::new()?;
    fixture.file("Game.manifest","manifest",&[json!({"namespace":"UI","key":"K","source":"Take {Count}","path":"/Game/Text/Example.Example.Label"})])?;
    fixture.file(
        "en.archive",
        "archive",
        &[json!({"namespace":"UI","key":"K","source":"Take {Count}","translation":"Take {Count}"})],
    )?;
    fixture.file("de.archive","archive",&[json!({"namespace":"UI","key":"K","source":"Take {Count}","translation":"Nimm {Anzahl}"})])?;
    fixture.file("en.po", "po", &[])?;
    fixture.file("de.po", "po", &[])?;
    let deep = "Nested".repeat(30);
    fixture.packages(
        &(0..occurrences)
            .map(|index| json!({"namespace":"UI","key":"K","source":"Take {Count}","object":format!("/Game/Text/Example.Example.{deep}_{index}"),"property":"Label"}))
            .collect::<Vec<_>>(),
    )?;
    fixture.lines()?;
    let rules = example_document(&["format_argument_renamed"], None)?;
    let configuration = fixture.configuration.clone();
    drop(fixture);
    let cancelled = AtomicBool::new(false);
    let mut query = EngineQuery::open(&configuration, None)?;
    let result = crate::json_value::parse(&query.findings_evaluate(&rules, "en", &cancelled)?)?;
    let key = result["key"].as_str().ok_or("Missing findings key.")?;
    let lines = crate::json_value::parse(&query.findings_query(
        &json!({"key":key,"view":"report","order":"report","limit":50}).to_string(),
        &cancelled,
    )?)?;
    let places = lines["places"].as_array().ok_or("Missing places.")?;
    assert_eq!(places.len(), 1);
    let placed = places[0]["occurrences"]
        .as_array()
        .ok_or("Missing occurrences.")?;
    assert_eq!(placed.len(), occurrences);
    assert!(crate::rules::javascript_json(&places[0], false).len() > 1024 * 1024);
    assert_eq!(lines["findings"][0]["places"], places[0]["id"]);
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

#[test]
fn related_lines_list_the_same_text_conflicting_sources_and_their_evidence() -> Result<()> {
    let mut fixture = Fixture::new()?;
    let entry = |key: &str, source: &str| json!({"namespace":"UI","key":key,"source":source,"path":format!("/Game/Text/Example.Example.{key}")});
    fixture.file(
        "Game.manifest",
        "manifest",
        &[entry("A", "Exit"), entry("B", "Exit"), entry("C", "Open")],
    )?;
    for culture in ["en", "de"] {
        fixture.file(
            &format!("{culture}.archive"),
            "archive",
            &[
                json!({"namespace":"UI","key":"A","source":"Exit","translation":if culture == "de" {"Beenden"} else {"Exit"}}),
                json!({"namespace":"UI","key":"B","source":"Exit","translation":if culture == "de" {"Verlassen"} else {"Exit"}}),
            ],
        )?;
        fixture.file(&format!("{culture}.po"), "po", &[])?;
    }
    let place = |key: &str, source: &str, object: &str| json!({"namespace":"UI","key":key,"source":source,"object":object,"property":"Label"});
    fixture.packages(&[
        place("A", "Exit", "/Game/Text/A.A"),
        place("B", "Exit", "/Game/Text/B.B"),
        place("C", "Open", "/Game/Text/C.C"),
        place("C", "Opened", "/Game/Text/D.D"),
    ])?;
    let lines = fixture.lines()?;
    let line = |key: &str| -> Result<&Value> {
        lines
            .iter()
            .find(|line| line["identity"]["key"] == key)
            .ok_or_else(|| format!("Missing line {key}.").into())
    };
    let unit = |key: &str| -> Result<String> {
        Ok(line(key)?["origin"]["unitIds"][0]
            .as_str()
            .ok_or("Missing unit.")?
            .to_owned())
    };
    let (a, b, c) = (unit("A")?, unit("B")?, unit("C")?);
    let line_c = line("C")?["id"]
        .as_str()
        .ok_or("Missing line ID.")?
        .to_owned();
    let mut query = EngineQuery::open(&fixture.configuration, None)?;
    let cancelled = AtomicBool::new(false);
    let related = |query: &mut EngineQuery, request: Value| {
        query.related(
            &crate::engine_related::parse_related_request(&request.to_string())?,
            &cancelled,
        )
    };
    let ids = |section: &Value| -> Vec<Value> {
        section["members"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|member| member["unit"]["id"].clone())
            .collect()
    };
    let found = related(
        &mut query,
        json!({"target":"Game","selection":{"kind":"unit","id":a},"pageSize":50}),
    )?;
    assert_eq!(found["self"]["unit"]["id"], json!(a));
    assert_eq!(found["self"]["complete"], true);
    assert_eq!(
        found["self"]["translations"].as_array().map(Vec::len),
        Some(2)
    );
    assert_eq!(found["self"]["translationsComplete"], true);
    assert_eq!(found["self"]["line"]["id"], line("A")?["id"]);
    assert_eq!(found["self"]["line"]["identity"]["key"], "A");
    assert_eq!(ids(&found["sameText"]), [json!(b)]);
    assert_eq!(found["sameText"]["complete"], true);
    assert_eq!(
        found["sameText"]["members"][0]["translations"][1]["culture"],
        "de"
    );
    assert_eq!(ids(&found["sameKey"]), Vec::<Value>::new());
    assert_eq!(ids(&found["conflict"]), Vec::<Value>::new());
    assert_eq!(found["keyChange"]["members"], json!([]));
    // A unit with two saved sources conflicts with its key's gathered source.
    let conflicting = related(
        &mut query,
        json!({"target":"Game","selection":{"kind":"unit","id":c},"pageSize":1}),
    )?;
    assert_eq!(ids(&conflicting["conflict"]), [json!(c)]);
    assert_eq!(conflicting["sameText"]["members"], json!([]));
    assert_eq!(
        conflicting["self"]["occurrences"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(conflicting["self"]["complete"], false);
    // A line's own units are its self member's; its sections list lines and units.
    let by_line = related(
        &mut query,
        json!({"target":"Game","selection":{"kind":"line","id":line_c},"pageSize":50}),
    )?;
    assert_eq!(by_line["self"]["kind"], "line");
    assert_eq!(by_line["self"]["unitIds"], json!([c]));
    assert_eq!(ids(&by_line["conflict"]), [json!(c)]);
    // Without a target there are only unit sections, and no translations.
    let untargeted = related(
        &mut query,
        json!({"selection":{"kind":"unit","id":b},"pageSize":50}),
    )?;
    assert_eq!(ids(&untargeted["sameText"]), [json!(a)]);
    assert!(untargeted.get("conflict").is_none());
    assert!(untargeted["self"].get("translations").is_none());
    assert_eq!(
        related(
            &mut query,
            json!({"target":"Other","selection":{"kind":"unit","id":a},"pageSize":50}),
        )?,
        Value::Null
    );
    Ok(())
}
