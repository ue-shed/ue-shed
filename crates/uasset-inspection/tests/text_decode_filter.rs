#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "fixture tests fail loudly on missing or changed saved packages"
)]

use std::fs;
use std::path::{Path, PathBuf};

use uasset_inspection::blueprint_classes::blueprint_classes;
use uasset_inspection::projection::{TextDecodeFilter, project_text_asset};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, decode_export};
use uasset_parser::schema::embedded_source_model;

fn fixture_packages(directory: &Path, packages: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("fixture directory") {
        let entry = entry.expect("fixture entry");
        let path = entry.path();
        if entry.file_type().expect("fixture file type").is_dir() {
            fixture_packages(&path, packages);
        } else if matches!(
            path.extension().and_then(|value| value.to_str()),
            Some("uasset" | "umap")
        ) {
            packages.push(path);
        }
    }
}

#[test]
fn text_filter_preserves_every_fixture_export_text_and_blueprint_classes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut paths = Vec::new();
    fixture_packages(&root, &mut paths);
    paths.sort();
    assert!(!paths.is_empty(), "repository fixtures must be present");
    let mut recovered_exports = 0;
    let mut compared_exports = 0;
    for path in &paths {
        let bytes = fs::read(path).expect("fixture bytes");
        // Separate packages also exercise graph-membership memoization independently.
        let package =
            Package::parse(&bytes).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let filtered_package = Package::parse(&bytes).expect("same fixture parses");
        let context = AssetDecodeContext {
            source: &bytes,
            package: &package,
            schemas: embedded_source_model(),
            property_filter: None,
        };
        let filtered_context = AssetDecodeContext {
            package: &filtered_package,
            property_filter: Some(&TextDecodeFilter),
            ..context
        };
        for (export, filtered_export) in package.exports.iter().zip(&filtered_package.exports) {
            let unfiltered = decode_export(export, &context);
            let filtered = decode_export(filtered_export, &filtered_context);
            let label = format!("{}: {}", path.display(), export.object_path);
            match (unfiltered, filtered) {
                (Ok(Some(asset)), Ok(Some(filtered_asset))) => {
                    compared_exports += 1;
                    let original = project_text_asset(&package, &asset);
                    let filtered = project_text_asset(&filtered_package, &filtered_asset);
                    assert_eq!(
                        original.occurrences, filtered.occurrences,
                        "{label}: occurrences"
                    );
                    assert_eq!(
                        blueprint_classes(&package, &asset),
                        blueprint_classes(&filtered_package, &filtered_asset),
                        "{label}: Blueprint classes"
                    );
                    assert_eq!(
                        original
                            .coverage_gaps
                            .iter()
                            .filter(|gap| gap.may_contain_text)
                            .collect::<Vec<_>>(),
                        filtered
                            .coverage_gaps
                            .iter()
                            .filter(|gap| gap.may_contain_text)
                            .collect::<Vec<_>>(),
                        "{label}: text-capable coverage gaps"
                    );
                    // Decoder-owned reads and native tails may retain text-free
                    // gaps. Only text-free gaps may disappear, and none may be introduced.
                    for gap in filtered
                        .coverage_gaps
                        .iter()
                        .filter(|gap| !gap.may_contain_text)
                    {
                        assert!(
                            original.coverage_gaps.contains(gap),
                            "{label}: new text-free gap {gap:?}"
                        );
                    }
                    let retained: Vec<_> = original
                        .coverage_gaps
                        .iter()
                        .filter(|gap| gap.may_contain_text || filtered.coverage_gaps.contains(gap))
                        .collect();
                    assert_eq!(
                        retained,
                        filtered.coverage_gaps.iter().collect::<Vec<_>>(),
                        "{label}: retained coverage gap order"
                    );
                }
                (Ok(None), Ok(None)) => {}
                (Err(_), Ok(Some(_))) => recovered_exports += 1,
                (Err(original), Err(filtered)) => {
                    assert_eq!(
                        (original.kind(), original.message()),
                        (filtered.kind(), filtered.message()),
                        "{label}: decode failure"
                    )
                }
                (original, filtered) => {
                    panic!("{label}: unexpected decode change: {original:?} -> {filtered:?}")
                }
            }
        }
    }
    println!(
        "Text decode filter: {} fixture packages, {compared_exports} compared exports, {recovered_exports} exports failed unfiltered but succeeded filtered",
        paths.len()
    );
}
