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

fn example_program(checks: &[&str], document: Option<Value>) -> Result<crate::rules::Program> {
    let output = std::process::Command::new("node").args(["--import","tsx","--input-type=module","-e","import {translateRuleDocument} from './packages/game-text/src/rules/translate.ts';const [checks,document]=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(translateRuleDocument(document??undefined,{checks})));",&serde_json::to_string(&(checks,document))?])
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(2).ok_or("Missing repository root.")?).output()?;
    crate::require(
        output.status.success(),
        std::str::from_utf8(&output.stderr)?,
    )?;
    crate::rules::compile(std::str::from_utf8(&output.stdout)?)
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
            Some(json!({"schemaVersion":1,"roles":[],"rules":[],"segmentSeparator":"//"}))
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
            json!({"schemaVersion":2,"roles":[role],"rules":[],"localizationRules":[{"id":"budget","kind":"localization_character_budget","role":"all","cultures":{"de":2},"recovery":"Shorten it."}]}),
            "Hi",
            "Hallo",
            json!({"kind":"character_count","characterCount":5,"translation":"Hallo"}),
            json!({"kind":"maximum_characters","maximumCharacters":2}),
        ),
        (
            json!({"schemaVersion":2,"roles":[role],"rules":[],"localizationRules":[{"id":"terms","kind":"localization_terminology","role":"all","caseSensitive":false,"cultures":{"de":[{"kind":"forbidden","term":"bad"}]},"recovery":"Replace it."}]}),
            "Hi",
            "😀 bad",
            json!({"kind":"terminology_match","translation":"😀 bad","start":3,"end":6,"term":"bad"}),
            json!({"kind":"forbidden_term","term":"bad"}),
        ),
        (
            json!({"schemaVersion":3,"roles":[],"rules":[],"customChecks":[{"id":"pattern","label":"Pattern","kind":"pattern","subject":"translation","pattern":"\\bbad\\b","recovery":"Replace it."}]}),
            "Hi",
            "😀 bad",
            json!({"text":"😀 bad","matches":[{"match":"bad","start":3,"end":6}]}),
            json!({"pattern":"\\bbad\\b","report":"match"}),
        ),
        (
            json!({"schemaVersion":3,"roles":[],"rules":[],"customChecks":[{"id":"length","label":"Length","kind":"length","subject":"source","measure":"characters","minimum":2,"recovery":"Expand it."}]}),
            "😀",
            "Hallo",
            json!({"text":"😀","length":1}),
            json!({"measure":"characters","minimum":2}),
        ),
        (
            json!({"schemaVersion":3,"roles":[],"rules":[],"customChecks":[{"id":"terms","label":"Terms","kind":"forbidden_term","subject":"translation","terms":["bad"],"caseSensitive":false,"recovery":"Replace it."}]}),
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
    let program = example_program(&["format_argument_renamed"], None)?;
    let path = fixture.store.directory.join("rules.json");
    std::fs::write(
        &path,
        serde_json::to_vec(
            &json!({"schemaVersion":4,"roles":[],"rules":program.rules.iter().map(|rule| &rule.rule).collect::<Vec<_>>()}),
        )?,
    )?;
    let configuration = fixture.configuration.clone();
    drop(fixture);
    let cancelled = AtomicBool::new(false);
    let mut query = EngineQuery::open(&configuration, None)?;
    let joined = query.reader.joined_key.clone();
    let result = crate::json_value::parse(&query.findings_evaluate(&path, "en", &cancelled)?)?;
    let key = result["key"].as_str().ok_or("Missing findings key.")?;
    assert_eq!(result["diagnosticCount"], 0);
    assert_eq!(result["counts"][0]["count"], 1);
    let lines = crate::json_value::parse(&query.findings_lines(key, &[0], &cancelled)?)?;
    let finding = &lines["lines"][0]["builtIns"][0];
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
    assert_eq!(
        query.findings_evaluate(&path, "en", &cancelled)?,
        crate::rules::javascript_json(&result, false)
    );
    let (_, root) = crate::store::open_root(&configuration)?;
    assert_eq!(root["active"]["joined"], joined);
    assert_eq!(root["active"]["findings"], key);
    let mut reopened = EngineQuery::open(&configuration, None)?;
    assert_eq!(
        crate::json_value::parse(&reopened.findings_lines(key, &[0], &cancelled)?)?,
        lines
    );
    assert!(
        reopened
            .findings_lines(key, &[u32::MAX], &cancelled)
            .is_err()
    );
    assert!(
        reopened
            .findings_lines("missing", &[0], &cancelled)
            .is_err()
    );
    assert!(
        reopened
            .findings_lines(key, &vec![0; 5001], &cancelled)
            .is_err()
    );
    let mut store = Store::writer(configuration)?;
    store.compact(true)?;
    drop(store);
    assert_eq!(
        crate::json_value::parse(&query.findings_lines(key, &[0], &cancelled)?)?,
        lines
    );
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
