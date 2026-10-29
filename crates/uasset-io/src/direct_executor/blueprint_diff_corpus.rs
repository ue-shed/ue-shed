//! Measures the Blueprint graph diff on real revision pairs. Ignored by default: it needs a corpus.
//!
//! `UE_SHED_BLUEPRINT_DIFF_CORPUS` names a folder of change folders, each holding
//! `<Name>.before.uasset` and `<Name>.after.uasset`; `UE_SHED_BLUEPRINT_DIFF_OUT` names a folder for
//! each pair's diff and a `summary.json`. Run with
//! `cargo test --release -p uasset-io --lib blueprint_diff_corpus -- --ignored --nocapture`.

use std::fs;
use std::path::Path;
use std::time::Instant;

use serde_json::json;
use uasset_inspection::blueprint_diff::diff_blueprints;

use super::blueprint::blueprint_with_cancellation;
use crate::cancellation::CancellationToken;

#[test]
#[ignore = "needs a corpus of Blueprint revision pairs"]
fn blueprint_diff_corpus() {
    let corpus = std::env::var("UE_SHED_BLUEPRINT_DIFF_CORPUS").expect("corpus folder");
    let out = std::env::var("UE_SHED_BLUEPRINT_DIFF_OUT").expect("output folder");
    fs::create_dir_all(&out).expect("output folder");
    let cancellation = CancellationToken::new();
    let mut pairs = Vec::new();
    let mut changes: Vec<_> = fs::read_dir(&corpus)
        .expect("corpus")
        .flatten()
        .map(|entry| entry.path())
        .collect();
    changes.sort();
    for change in changes {
        let mut names: Vec<_> = fs::read_dir(&change)
            .expect("change folder")
            .flatten()
            .filter_map(|entry| {
                entry
                    .file_name()
                    .to_str()?
                    .strip_suffix(".after.uasset")
                    .map(str::to_owned)
            })
            .collect();
        names.sort();
        let change_name = change
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        for name in names {
            pairs.push(measure(&change, change_name, &name, &out, &cancellation));
        }
    }
    fs::write(
        Path::new(&out).join("summary.json"),
        serde_json::to_string_pretty(&pairs).expect("summary"),
    )
    .expect("summary written");
}

fn measure(
    change: &Path,
    change_name: &str,
    name: &str,
    out: &str,
    cancellation: &CancellationToken,
) -> serde_json::Value {
    let before_path = change.join(format!("{name}.before.uasset"));
    let after_path = change.join(format!("{name}.after.uasset"));
    let bytes = |path: &Path| fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    let read = |path: &Path| {
        let started = Instant::now();
        let result = path
            .exists()
            .then(|| blueprint_with_cancellation(&path.to_string_lossy(), cancellation));
        (result, started.elapsed().as_secs_f64() * 1000.0)
    };
    let (before, before_ms) = read(&before_path);
    let (after, after_ms) = read(&after_path);
    let mut record = json!({
        "change": change_name,
        "name": name,
        "before_bytes": bytes(&before_path),
        "after_bytes": bytes(&after_path),
        "before_read_ms": before_ms,
        "after_read_ms": after_ms,
    });
    let failure =
        |result: &Option<Result<super::blueprint::BlueprintOutput, super::Failure>>| match result {
            None => Some("absent".to_owned()),
            Some(Err(failure)) => Some(format!("{}: {}", failure.code, failure.message)),
            Some(Ok(_)) => None,
        };
    record["before_failure"] = json!(failure(&before));
    record["after_failure"] = json!(failure(&after));
    let (Some(Ok(before)), Some(Ok(after))) = (before, after) else {
        return record;
    };
    let started = Instant::now();
    let diff = diff_blueprints(&before.blueprint, &after.blueprint);
    record["diff_ms"] = json!(started.elapsed().as_secs_f64() * 1000.0);
    record["counts"] = json!(diff.counts);
    record["partial"] = json!([before.partial, after.partial]);
    record["gaps"] = json!([
        before.blueprint.coverage_gaps.len() + before.diagnostics.len(),
        after.blueprint.coverage_gaps.len() + after.diagnostics.len()
    ]);
    record["nodes"] = json!([
        before
            .blueprint
            .graphs
            .iter()
            .map(|graph| graph.nodes.len())
            .sum::<usize>(),
        after
            .blueprint
            .graphs
            .iter()
            .map(|graph| graph.nodes.len())
            .sum::<usize>()
    ]);
    let text = serde_json::to_string_pretty(&diff).expect("diff");
    record["diff_bytes"] = json!(text.len());
    fs::write(
        Path::new(out).join(format!("{change_name}-{name}.json")),
        text,
    )
    .expect("diff written");
    record
}
