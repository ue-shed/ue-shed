//! Explicit release-only timing over a retained, read-only joined index.

use crate::engine_query::EngineQuery;
use crate::store::{Configuration, open_root};
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

fn retained_query(cache_root: &Path) -> Result<EngineQuery> {
    let mut projects = std::fs::read_dir(cache_root.join("game-text-v2"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.join("manifest.json").is_file())
        .collect::<Vec<_>>();
    projects.sort();
    require(
        projects.len() == 1,
        "Timing cache must contain exactly one retained project.",
    )?;
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(projects[0].join("manifest.json"))?)?;
    let identity: Vec<String> = serde_json::from_str(
        manifest["identity"]
            .as_str()
            .ok_or("Missing retained identity.")?,
    )?;
    require(identity.len() == 2, "Invalid retained project identity.")?;
    let shared = identity[1] == "shared-project-text-v1";
    let configuration = Configuration {
        cache_root: cache_root.to_owned(),
        project_key: identity[0].clone(),
        target_key: if shared {
            "retained-timing".into()
        } else {
            identity[1]
                .strip_prefix("shared-index-v2:")
                .ok_or("Unknown retained store identity.")?
                .to_owned()
        },
        shared_project: shared,
        view_prefix: None,
    };
    let (_, root) = open_root(&configuration)?;
    let active = root["active"]
        .as_object()
        .ok_or("Missing retained active views.")?;
    let mut candidates = Vec::new();
    if active.get("joined").is_some() {
        candidates.push(None);
    }
    if shared {
        candidates.extend(active.keys().filter_map(|name| {
            name.starts_with("target-join.")
                .then(|| name.strip_suffix("joined"))
                .flatten()
                .map(|prefix| Some(prefix.to_owned()))
        }));
    }
    let mut selected: Option<EngineQuery> = None;
    for prefix in candidates {
        let configuration = Configuration {
            view_prefix: prefix,
            ..configuration.clone()
        };
        if let Ok(query) = EngineQuery::open(&configuration, None)
            && selected
                .as_ref()
                .is_none_or(|selected| query.cultures.len() > selected.cultures.len())
        {
            selected = Some(query);
        }
    }
    let query = selected.ok_or("No readable joined view in the retained cache.")?;
    require(
        !query.cultures.is_empty(),
        "Timing needs the retained localization target, not a source-only view.",
    )?;
    Ok(query)
}

/// The retained cache and the default catalogue, after checking the release build, the
/// heavy-run lease and Node 26.
fn timing_inputs() -> Result<(EngineQuery, Value)> {
    require(
        !cfg!(debug_assertions),
        "Run this timing test with cargo test --release.",
    )?;
    let lock = std::env::var("UE_SHED_UNREAL_LOCK")
        .map_err(|cause| crate::Error::new(crate::ErrorCode::InvalidInput, cause.to_string()))?;
    require(
        Path::new(&lock).is_file(),
        "Hold the shared heavy-run lease before this timing test.",
    )?;
    let cache = std::env::var("UE_SHED_GAME_TEXT_TIMING_CACHE")
        .map_err(|cause| crate::Error::new(crate::ErrorCode::InvalidInput, cause.to_string()))?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let catalogue = Command::new("node")
        .args(["--import","tsx","--input-type=module","-e",r#"import {canonicalRuleDocument,translateRuleDocument} from "./packages/game-text/src/rules/translate.ts"; console.log(JSON.stringify({node:process.versions.node,locale:new Intl.Collator().resolvedOptions().locale,rules:canonicalRuleDocument(translateRuleDocument())}));"#])
        .current_dir(&root)
        .output()?;
    require(
        catalogue.status.success(),
        String::from_utf8_lossy(&catalogue.stderr).to_string(),
    )?;
    let catalogue: Value = serde_json::from_slice(&catalogue.stdout)?;
    require(
        catalogue["node"]
            .as_str()
            .is_some_and(|version| version.starts_with("26.")),
        "Use Node 26 for the default catalogue.",
    )?;
    Ok((retained_query(Path::new(&cache))?, catalogue))
}

#[test]
#[ignore = "Requires a retained cache, Node 26, a heavy-run lease, and --release"]
fn persisted_default_catalogue_timing() -> Result<()> {
    let (mut query, catalogue) = timing_inputs()?;
    let cancelled = AtomicBool::new(false);
    let rules = catalogue["rules"]
        .as_str()
        .ok_or("Missing default catalogue.")?;
    // Local measurement only: keep the listed rules, in catalogue order.
    let only = std::env::var("UE_SHED_GAME_TEXT_TIMING_RULES").ok();
    let filtered;
    let rules = if let Some(only) = &only {
        let keep = only.split(',').collect::<HashSet<_>>();
        let mut document: Value = serde_json::from_str(rules)?;
        document["rules"]
            .as_array_mut()
            .ok_or("Missing rules.")?
            .retain(|rule| rule["id"].as_str().is_some_and(|id| keep.contains(id)));
        require(
            document["rules"].as_array().map(Vec::len) == Some(keep.len()),
            "A listed rule is not in the catalogue.",
        )?;
        filtered = serde_json::to_string(&document)?;
        filtered.as_str()
    } else {
        rules
    };
    let program = super::compile(rules)?;
    let collator =
        super::HostCollator::new(catalogue["locale"].as_str().ok_or("Missing host locale.")?)?;
    let evaluated = query.evaluate_findings(&program, &collator, &cancelled, None)?;
    let profile = &evaluated.profile;
    // A fresh test process: its peaks are this evaluation's.
    let memory = process_metrics::memory()?;
    let result = json!({"digest":evaluated.digest,"profile":profile,"peakPrivateBytes":memory.peak_private_bytes,"peakWorkingSetBytes":memory.peak_working_set_bytes,"rayonThreads":rayon::current_num_threads()});
    println!("{}", serde_json::to_string(&result)?);
    require(
        only.is_some()
            || evaluated.digest
                == "424bcba6a51182dc7dd21a397912877ff8edd35dbec28d7fcece84b471f32148",
        "Retained output digest differs from 5b9d85fb.",
    )?;
    Ok(())
}

/// Workspace Quality reads every line's findings back, 5,000 lines a call. Each call's time on
/// the retained cache: the first also opens the read state, the rest are the steady cost.
/// The findings layer is written to the cache, so point it at a disposable copy.
#[test]
#[ignore = "Requires a disposable retained cache, Node 26, a heavy-run lease, and --release"]
fn persisted_findings_lines_timing() -> Result<()> {
    let (mut query, catalogue) = timing_inputs()?;
    let cancelled = AtomicBool::new(false);
    let rules = catalogue["rules"]
        .as_str()
        .ok_or("Missing default catalogue.")?;
    let locale = catalogue["locale"].as_str().ok_or("Missing host locale.")?;
    let started = std::time::Instant::now();
    let evaluated: Value =
        serde_json::from_str(&query.findings_evaluate(rules, locale, &cancelled)?)?;
    let key = evaluated["key"].as_str().ok_or("Missing findings key.")?;
    println!(
        "{}",
        json!({"evaluateMs": started.elapsed().as_secs_f64() * 1000.0})
    );
    let calls = std::env::var("UE_SHED_GAME_TEXT_TIMING_CALLS")
        .ok()
        .and_then(|calls| calls.parse::<u32>().ok())
        .unwrap_or(4);
    // Workspace Quality reads one scan page a call, 64 to 256 lines.
    let size = std::env::var("UE_SHED_GAME_TEXT_TIMING_ROWS")
        .ok()
        .and_then(|rows| rows.parse::<u32>().ok())
        .unwrap_or(5000);
    // Source Quality reads units the same way.
    let units = std::env::var("UE_SHED_GAME_TEXT_TIMING_UNITS").is_ok();
    for call in 0..calls {
        let rows = (call * size..(call + 1) * size).collect::<Vec<_>>();
        let started = std::time::Instant::now();
        let reply = if units {
            query.findings_units(key, &rows, &cancelled)?
        } else {
            query.findings_lines(key, &rows, &cancelled)?
        };
        println!(
            "{}",
            json!({"call": call, "ms": started.elapsed().as_secs_f64() * 1000.0, "bytes": reply.len()})
        );
    }
    Ok(())
}

/// Streaming canonical output digest. Delimit records with their byte length; keep emission,
/// affected-set and diagnostic order, and sort only object keys and the mask map.
pub(super) fn digest_subject(
    digest: &mut sha2::Sha256,
    program: &super::Program,
    subjects: &mut super::NativeSubjects<'_>,
    arena: &super::columns::Arena,
    evaluated: &super::evaluator::Evaluated,
) -> Result<()> {
    use super::SubjectRows;
    fn record(digest: &mut sha2::Sha256, value: &Value) {
        use sha2::Digest;
        let bytes = super::javascript_json(value, true);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes.as_bytes());
    }
    record(digest, &json!(["subject", subjects.subject()]));
    let mut identities = std::collections::HashMap::<usize, (String, String)>::new();
    // Places are hydrated a chunk of findings at a time, as reads do, so the digest holds no
    // more of them than it needs.
    for findings in evaluated.findings.chunks(4096) {
        let mut places = std::collections::BTreeMap::new();
        for finding in findings {
            for (row, id) in finding.affected.rows.iter().zip(&finding.affected.ids) {
                places.entry(*row).or_insert_with(|| id.clone());
            }
        }
        let (rows, ids): (Vec<_>, Vec<_>) = places.into_iter().unzip();
        let places = rows
            .iter()
            .copied()
            .zip(subjects.places(&rows, &ids)?)
            .collect::<std::collections::HashMap<_, _>>();
        for typed in findings {
            let finding = &typed.emission(arena);
            let compiled = program
                .rules
                .iter()
                .find(|rule| rule.ordinal == finding.rule)
                .ok_or("Missing digest rule.")?;
            let rule = &compiled.rule;
            let identity = if let Some(identity) = identities.get(&finding.row) {
                identity.clone()
            } else {
                let identity: (String, String) = if finding.subject == super::Subject::UnitSource {
                    (
                        subjects
                            .field(finding.row, "textUnitId")?
                            .as_str()
                            .ok_or("Missing unit ID.")?
                            .to_owned(),
                        String::new(),
                    )
                } else if finding.subject == super::Subject::LineCulture {
                    (
                        subjects
                            .field(finding.row, "line.lineId")?
                            .as_str()
                            .ok_or("Missing line ID.")?
                            .to_owned(),
                        subjects
                            .field(finding.row, "culture")?
                            .as_str()
                            .ok_or("Missing culture.")?
                            .to_owned(),
                    )
                } else {
                    (
                        subjects
                            .field(finding.row, "lineId")?
                            .as_str()
                            .ok_or("Missing line ID.")?
                            .to_owned(),
                        subjects
                            .field(finding.row, "sourceCulture")?
                            .as_str()
                            .unwrap_or("")
                            .to_owned(),
                    )
                };
                identities.insert(finding.row, identity.clone());
                identity
            };
            let rule_id = rule.rule_id.as_ref().unwrap_or(&rule.id);
            let id = if finding.subject == super::Subject::UnitSource {
                super::source_identity(
                    rule_id,
                    rule.role.as_deref(),
                    &identity.0,
                    &rule.kind,
                    &finding.actual,
                    &finding.expectation,
                    &finding.affected.ids,
                )
                .0
            } else {
                super::localization_identity(
                    &identity.0,
                    &identity.1,
                    rule_id,
                    &rule.kind,
                    &finding.actual,
                    &finding.expectation,
                )
                .0
            };
            record(
                digest,
                &json!([
                    "finding",
                    finding.rule,
                    finding.row,
                    finding.subject,
                    finding.actual,
                    finding.expectation,
                    finding.fix,
                    finding.extra,
                    finding.translation_origin,
                    finding.recovery,
                    finding
                        .affected
                        .rows
                        .iter()
                        .map(|row| &places[row])
                        .collect::<Vec<_>>(),
                    id
                ]),
            );
        }
    }
    let masks = evaluated
        .masks
        .iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    for (rule, words) in masks {
        record(digest, &json!(["mask", rule, words]));
    }
    fn diagnostic_record(
        digest: &mut sha2::Sha256,
        name: &str,
        subject: super::Subject,
        values: &[super::Diagnostic],
    ) {
        use sha2::Digest;
        let prefix = format!("[{},[", super::javascript_json(&json!(name), true));
        let encoded = |value: &super::Diagnostic| {
            super::javascript_json(&json!([subject, value.row, value.name()]), true)
        };
        let length = prefix.len()
            + 2
            + values.len().saturating_sub(1)
            + values
                .iter()
                .map(|value| encoded(value).len())
                .sum::<usize>();
        digest.update((length as u64).to_le_bytes());
        digest.update(prefix.as_bytes());
        for (index, value) in values.iter().enumerate() {
            if index > 0 {
                digest.update(b",");
            }
            digest.update(encoded(value).as_bytes());
        }
        digest.update(b"]]");
    }
    let subject = subjects.subject();
    diagnostic_record(digest, "rule-diagnostics", subject, &evaluated.diagnostics);
    diagnostic_record(
        digest,
        "projection-diagnostics",
        subject,
        &evaluated.projection,
    );
    // Keep the trait in this function so baseline and product share precisely the same encoder.
    let _ = digest;
    Ok(())
}
