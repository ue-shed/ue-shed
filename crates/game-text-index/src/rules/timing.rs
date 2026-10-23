//! Explicit release-only timing over a retained, read-only joined index.

use crate::engine_query::EngineQuery;
use crate::store::{Configuration, open_root};
use crate::{Result, require};
use serde_json::{Value, json};
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
    let mut query = retained_query(Path::new(&cache))?;
    let cancelled = AtomicBool::new(false);
    let rules = catalogue["rules"]
        .as_str()
        .ok_or("Missing default catalogue.")?;
    let directory = root.join("test-results");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("timing-rules-{}.json", crate::store::token()));
    // Whitespace has no semantic effect; a distinct cache key ensures this measures a fresh run.
    let fresh = format!("{}{}", rules, " ".repeat(257));
    std::fs::write(&path, fresh)?;
    let response = query.findings_evaluate(
        &path,
        catalogue["locale"].as_str().ok_or("Missing host locale.")?,
        &cancelled,
    );
    std::fs::remove_file(path)?;
    let response = crate::json_value::parse(&response?)?;
    let profile = &response["profile"];
    require(
        profile["cached"] == false,
        "Timing unexpectedly reused a cached findings layer.",
    )?;
    let result = json!({"profile":profile,"peakWorkingSetBytes":peak_memory()?,"rayonThreads":rayon::current_num_threads()});
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
