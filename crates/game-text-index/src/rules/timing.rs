//! Explicit release-only timing over a retained, read-only joined index.
use super::{HostCollator, NativeSubjects, Subject, SubjectRows, compile};
use crate::engine_query::EngineQuery;
use crate::store::{Configuration, open_root};
use crate::{Result, require};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

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

#[cfg(windows)]
fn peak_memory() -> Result<u64> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("powershell.exe")
        .creation_flags(0x0800_0000)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!("(Get-Process -Id {}).PeakWorkingSet64", std::process::id()),
        ])
        .output()?;
    require(
        output.status.success(),
        "Could not read the evaluator's peak working set.",
    )?;
    Ok(std::str::from_utf8(&output.stdout)?.trim().parse()?)
}
#[cfg(target_os = "linux")]
fn peak_memory() -> Result<u64> {
    let status = std::fs::read_to_string("/proc/self/status")?;
    let value = status
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))
        .ok_or("Missing process high-water mark.")?;
    Ok(value
        .split_whitespace()
        .next()
        .ok_or("Missing VmHWM value.")?
        .parse::<u64>()?
        * 1024)
}
#[cfg(not(any(windows, target_os = "linux")))]
fn peak_memory() -> Result<u64> {
    Err("Peak working set measurement is unavailable on this platform.".into())
}

#[test]
#[ignore = "Requires a retained cache, Node 26, a heavy-run lease, and --release"]
fn persisted_default_catalogue_timing() -> Result<()> {
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
        .current_dir(root)
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
    let program = compile(
        catalogue["rules"]
            .as_str()
            .ok_or("Missing default catalogue.")?,
    )?;
    let collator = HostCollator::new(catalogue["locale"].as_str().ok_or("Missing host locale.")?)?;
    let open_started = Instant::now();
    let mut query = retained_query(Path::new(&cache))?;
    let open_elapsed = open_started.elapsed();
    let cancelled = AtomicBool::new(false);
    let started = Instant::now();
    let mut stages = Vec::new();
    let mut kernels = HashMap::<String, (Duration, usize, usize)>::new();
    let mut retained = Vec::new();
    let mut finding_count = 0;
    let mut diagnostic_count = 0;
    for subject in [Subject::Line, Subject::LineCulture, Subject::UnitSource] {
        if subject != Subject::LineCulture
            && !program
                .rules
                .iter()
                .any(|rule| rule.rule.subject == subject)
        {
            continue;
        }
        let subject_started = Instant::now();
        let mut subjects = NativeSubjects::new(&mut query, subject, &collator, &cancelled)?;
        let setup = subject_started.elapsed();
        let rows = subjects.len();
        let (evaluation, timings, diagnostics) =
            program.evaluate_with_diagnostics(&mut subjects, &collator)?;
        for (node, timing) in program.nodes.iter().zip(&timings.nodes) {
            let value = kernels.entry(node.op.clone()).or_default();
            value.0 += timing.scalar;
            value.1 += timing.tuples;
            value.2 += timing.rows;
        }
        finding_count += evaluation.findings.len();
        diagnostic_count += evaluation.diagnostics.len() + diagnostics.len();
        stages.push(json!({
            "subject":subject,"rows":rows,"setupMs":setup.as_secs_f64()*1000.0,
            "prepareMs":timings.prepare.as_secs_f64()*1000.0,
            "executeMs":timings.execute.as_secs_f64()*1000.0,
            "diagnosticsMs":timings.diagnostics.as_secs_f64()*1000.0,
            "emissionMs":timings.emission.as_secs_f64()*1000.0,
            "projections":timings.projections.iter().map(|(name,time)| json!({"column":name,"ms":time.as_secs_f64()*1000.0})).collect::<Vec<_>>()
        }));
        retained.push((evaluation, diagnostics));
    }
    let elapsed = started.elapsed();
    let peak = peak_memory()?;
    let mut kernels = kernels.into_iter().collect::<Vec<_>>();
    kernels.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    let result = json!({
        "elapsedSeconds":elapsed.as_secs_f64(),"openSeconds":open_elapsed.as_secs_f64(),
        "peakWorkingSetBytes":peak,"rayonThreads":rayon::current_num_threads(),
        "findings":finding_count,"diagnostics":diagnostic_count,"stages":stages,
        "kernels":kernels.into_iter().take(15).map(|(op,(time,tuples,rows))| json!({"op":op,"seconds":time.as_secs_f64(),"tuples":tuples,"rowVisits":rows})).collect::<Vec<_>>()
    });
    println!("{}", serde_json::to_string(&result)?);
    if elapsed.as_secs_f64() > 30.0 {
        println!(
            "Evaluation exceeded 30 seconds; the stage and scalar-kernel breakdown above identifies the remaining cost."
        );
    }
    drop(retained);
    Ok(())
}
