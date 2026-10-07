use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{Value, json};
use uasset_inspection::projection::{TextCoverageGapReason, project_text_asset};
use uasset_inspection::text_wire::text_occurrence;
use uasset_parser::asset::{AssetDecodeContext, DecodedAsset, decode_export};
use uasset_parser::package::Package;
use uasset_parser::property::{PropertyStream, PropertyValue, RawReason, TextHistory};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    schema_version: u32,
    engine_version: String,
    packages: Vec<AssetEvidence>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Versions {
    ue4: i32,
    ue5: Option<i32>,
    licensee: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetEvidence {
    asset_name: String,
    object_path: String,
    serialized_package_name: String,
    class_path: String,
    versions: Versions,
    #[serde(default)]
    texts: Vec<TextEvidence>,
    #[serde(default)]
    rows: Vec<RowEvidence>,
    namespace: Option<String>,
    #[serde(default)]
    entries: Vec<EntryEvidence>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextEvidence {
    property_path: String,
    row: Option<String>,
    source: String,
    history: String,
    culture_invariant: bool,
    namespace: Option<String>,
    key: Option<String>,
    table_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RowEvidence {
    name: String,
    texts: Vec<TextEvidence>,
    vectors: Vec<[f64; 3]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryEvidence {
    key: String,
    source: String,
    metadata: BTreeMap<String, String>,
}

/// UE 4.27 usually saves `None` as the summary package name; the parser then resolves top-level
/// exports to their bare object name, because the mounted path needs caller context.
fn serialized_object_path(evidence: &AssetEvidence) -> String {
    if evidence.serialized_package_name == "None" {
        evidence.asset_name.clone()
    } else {
        format!(
            "{}.{}",
            evidence.serialized_package_name, evidence.asset_name
        )
    }
}

fn decoded(root: &std::path::Path, evidence: &AssetEvidence) -> (Package, DecodedAsset) {
    let bytes = fs::read(root.join(format!("Content/Legacy/{}.uasset", evidence.asset_name)))
        .expect("generate legacy fixtures with pnpm fixture:generate-legacy --update");
    let package = Package::parse(&bytes).expect("legacy fixture package parses");
    assert_eq!(
        package.summary.package_name,
        evidence.serialized_package_name
    );
    assert_eq!(package.summary.versions.ue4, evidence.versions.ue4);
    assert_eq!(
        package.summary.versions.ue5,
        evidence.versions.ue5.unwrap_or_default()
    );
    assert_eq!(
        package.summary.versions.licensee,
        evidence.versions.licensee
    );
    let object_path = serialized_object_path(evidence);
    let export = package
        .exports
        .iter()
        .find(|export| export.object_path.as_str() == object_path)
        .expect("saved asset export");
    assert_eq!(
        export.class_path.as_ref().unwrap().as_str(),
        evidence.class_path.as_str()
    );
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let asset = decode_export(export, &context)
        .expect("legacy export decodes")
        .expect("legacy export is supported");
    (package, asset)
}

fn text_values<'a>(
    package: &Package,
    stream: &'a PropertyStream,
) -> BTreeMap<String, &'a uasset_parser::property::TextValue> {
    fn value<'a>(
        package: &Package,
        item: &'a PropertyValue,
        path: String,
        out: &mut BTreeMap<String, &'a uasset_parser::property::TextValue>,
    ) {
        match item {
            PropertyValue::Text(text) => {
                assert!(out.insert(path, text).is_none());
            }
            PropertyValue::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    value(package, item, format!("{path}[{index}]"), out);
                }
            }
            PropertyValue::Map(items) => {
                for (index, item) in items.iter().enumerate() {
                    value(package, &item.key, format!("{path}{{{index}}}.key"), out);
                    value(
                        package,
                        &item.value,
                        format!("{path}{{{index}}}.value"),
                        out,
                    );
                }
            }
            PropertyValue::Struct(stream) => {
                for property in &stream.records {
                    let name = package.resolve_name(property.name).unwrap();
                    value(package, &property.value, format!("{path}.{name}"), out);
                }
            }
            PropertyValue::Raw { .. } => assert_eq!(path, "NativeVectors"),
            _ => {}
        }
    }
    let mut out = BTreeMap::new();
    for property in &stream.records {
        value(
            package,
            &property.value,
            package.resolve_name(property.name).unwrap(),
            &mut out,
        );
    }
    out
}

fn assert_texts(
    package: &Package,
    stream: &PropertyStream,
    expected: &[TextEvidence],
    sources: &BTreeMap<String, String>,
    table_path: &str,
) {
    let actual = text_values(package, stream);
    assert_eq!(
        actual.len(),
        expected.len(),
        "every text must decode exactly once"
    );
    for evidence in expected {
        let text = actual
            .get(&evidence.property_path)
            .expect("text property path");
        match &text.history {
            TextHistory::Base { namespace, key, .. } => {
                assert_eq!(evidence.history, "base");
                assert!(!evidence.culture_invariant);
                assert_eq!(evidence.namespace.as_deref(), Some(namespace.as_str()));
                assert_eq!(evidence.key.as_deref(), Some(key.as_str()));
                assert_eq!(text.source, evidence.source);
            }
            TextHistory::None => {
                assert_eq!(evidence.history, "none");
                assert_eq!(evidence.culture_invariant, !evidence.source.is_empty());
                assert_eq!(text.source, evidence.source);
            }
            TextHistory::StringTableEntry { table_id, key } => {
                assert_eq!(evidence.history, "string_table_entry");
                assert!(!evidence.culture_invariant);
                assert_eq!(evidence.table_id.as_deref(), Some(table_id.as_str()));
                assert_eq!(table_id, table_path);
                assert_eq!(evidence.key.as_deref(), Some(key.as_str()));
                assert!(text.source.is_empty(), "references serialize identity only");
                assert_eq!(sources.get(key), Some(&evidence.source));
            }
            _ => panic!("unexpected fixture text history"),
        }
    }
}

fn expected_occurrence(asset: &AssetEvidence, text: &TextEvidence) -> Value {
    let object_path = serialized_object_path(asset);
    let identity = match text.history.as_str() {
        "base" => json!({"status": "resolved", "namespace": text.namespace, "key": text.key}),
        "string_table_entry" => {
            json!({"status": "string_table", "table_id": text.table_id, "key": text.key})
        }
        "none" => json!({"status": "unresolved", "reason": "culture_invariant"}),
        _ => panic!("unexpected oracle history"),
    };
    let location = match &text.row {
        Some(row) => json!({
            "kind": "data_table_cell", "object_path": object_path,
            "row": row, "property_path": text.property_path
        }),
        None => json!({
            "kind": "asset_property", "object_path": object_path,
            "class_path": asset.class_path, "property_path": text.property_path
        }),
    };
    // Without a source model for the fixture class, the data asset decodes as a generic UObject,
    // whose text the projection cannot prove source-editable.
    let edit_capability = if text.row.is_some() {
        "source_editable"
    } else {
        "read_only"
    };
    json!({
        "source": if text.history == "string_table_entry" { "" } else { &text.source },
        "dev_notes": "", "identity": identity, "location": location,
        "edit_capability": edit_capability
    })
}

fn conformance(version: &str, ue5: Option<i32>) {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/legacy-unreal-project/Generated")
        .join(version);
    let evidence: Evidence = serde_json::from_slice(
        &fs::read(root.join("evidence.json"))
            .expect("run pnpm fixture:generate-legacy --update for both legacy engines first"),
    )
    .expect("engine evidence is valid");
    assert_eq!(evidence.schema_version, 1);
    assert_eq!(evidence.engine_version, version);
    assert_eq!(evidence.packages.len(), 3);
    for asset in &evidence.packages {
        assert_eq!(
            asset.object_path,
            format!("/Game/Legacy/{}.{}", asset.asset_name, asset.asset_name)
        );
        assert_eq!(asset.versions.ue4, 522);
        assert_eq!(asset.versions.ue5, ue5);
        assert_eq!(asset.versions.licensee, 0);
    }
    let strings = evidence
        .packages
        .iter()
        .find(|asset| asset.asset_name == "ST_LegacyText")
        .unwrap();
    let (string_package, string_asset) = decoded(&root, strings);
    let DecodedAsset::StringTable(table) = &string_asset else {
        panic!("StringTable must decode as a StringTable");
    };
    assert_eq!(Some(&table.namespace), strings.namespace.as_ref());
    assert!(table.entries.len() >= 3);
    let sources: BTreeMap<_, _> = table
        .entries
        .iter()
        .map(|entry| (entry.key.clone(), entry.source.clone()))
        .collect();
    assert_eq!(
        sources,
        strings
            .entries
            .iter()
            .map(|entry| (entry.key.clone(), entry.source.clone()))
            .collect::<BTreeMap<_, _>>()
    );
    assert_eq!(
        table.metadata,
        strings
            .entries
            .iter()
            .map(|entry| (entry.key.clone(), entry.metadata.clone()))
            .collect::<BTreeMap<_, _>>()
    );
    let projection = project_text_asset(&string_package, &string_asset);
    assert!(projection.coverage_gaps.is_empty());
    let mut actual: Vec<_> = projection
        .occurrences
        .into_iter()
        .map(|occurrence| serde_json::to_value(text_occurrence(occurrence)).unwrap())
        .collect();
    let mut expected: Vec<_> = strings
        .entries
        .iter()
        .map(|entry| {
            json!({
                "source": entry.source, "dev_notes": "",
                "identity": {
                    "status": "resolved", "namespace": strings.namespace, "key": entry.key
                },
                "location": {
                    "kind": "string_table_entry", "object_path": serialized_object_path(strings),
                    "entry_key": entry.key
                },
                "edit_capability": "source_editable"
            })
        })
        .collect();
    actual.sort_by_key(Value::to_string);
    expected.sort_by_key(Value::to_string);
    assert_eq!(actual, expected, "{version} StringTable text projection");

    for asset in evidence
        .packages
        .iter()
        .filter(|asset| asset.asset_name != "ST_LegacyText")
    {
        let (package, decoded) = decoded(&root, asset);
        let expected: Vec<_> = match &decoded {
            DecodedAsset::DataTable(table) => {
                assert_eq!(table.rows.len(), 2);
                assert_eq!(asset.rows.len(), table.rows.len());
                for row in &table.rows {
                    let name = package.resolve_name(row.name).unwrap();
                    let oracle = asset.rows.iter().find(|row| row.name == name).unwrap();
                    assert_texts(
                        &package,
                        &row.properties,
                        &oracle.texts,
                        &sources,
                        &strings.object_path,
                    );
                    let vectors = row
                        .properties
                        .records
                        .iter()
                        .find(|property| package.resolve_name(property.name).unwrap() == "Vectors")
                        .expect("vector array tag");
                    let PropertyValue::Array(values) = &vectors.value else {
                        panic!("vector array must decode without guessing widths");
                    };
                    let components: Vec<_> = values
                        .iter()
                        .map(|value| match value {
                            PropertyValue::Vector(value) => [value.x, value.y, value.z],
                            _ => panic!("vector array element must decode as a vector"),
                        })
                        .collect();
                    assert_eq!(components, oracle.vectors);
                    let native = row
                        .properties
                        .records
                        .iter()
                        .find(|property| {
                            package.resolve_name(property.name).unwrap() == "NativeVectors"
                        })
                        .expect("native map tag");
                    if name == "Full" {
                        assert!(
                            matches!(
                                &native.value,
                                PropertyValue::Raw {
                                    reason: RawReason::LegacyContainerElementWithoutTypeInformation
                                }
                            ),
                            "native struct map must be Raw, never a guessed value"
                        );
                        assert_eq!(components.len(), 2);
                    } else {
                        assert_eq!(name, "EmptyContainers");
                        assert!(components.is_empty());
                        let PropertyValue::Map(entries) = &native.value else {
                            panic!("empty native map must remain a decoded empty map");
                        };
                        assert!(entries.is_empty());
                    }
                }
                asset.rows.iter().flat_map(|row| &row.texts).collect()
            }
            DecodedAsset::UObject(object) => {
                assert_texts(
                    &package,
                    &object.properties,
                    &asset.texts,
                    &sources,
                    &strings.object_path,
                );
                asset.texts.iter().collect()
            }
            DecodedAsset::DataAsset(object) => {
                assert_texts(
                    &package,
                    &object.properties,
                    &asset.texts,
                    &sources,
                    &strings.object_path,
                );
                asset.texts.iter().collect()
            }
            _ => panic!("expected DataTable or text DataAsset"),
        };
        let projection = project_text_asset(&package, &decoded);
        let mut actual: Vec<_> = projection
            .occurrences
            .into_iter()
            .map(|occurrence| serde_json::to_value(text_occurrence(occurrence)).unwrap())
            .collect();
        let mut expected: Vec<_> = expected
            .into_iter()
            .map(|text| expected_occurrence(asset, text))
            .collect();
        actual.sort_by_key(Value::to_string);
        expected.sort_by_key(Value::to_string);
        assert_eq!(
            actual, expected,
            "{version} {} text projection",
            asset.asset_name
        );
        if asset.asset_name == "DT_LegacyText" {
            assert_eq!(projection.coverage_gaps.len(), 1);
            let gap = &projection.coverage_gaps[0];
            assert_eq!(gap.object_path, serialized_object_path(asset));
            assert_eq!(gap.property_path, "NativeVectors");
            assert_eq!(
                gap.reason,
                TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation
            );
        } else {
            assert!(projection.coverage_gaps.is_empty());
        }
    }
}

#[test]
fn ue427_saved_text_matches_fresh_process_engine_evidence() {
    conformance("4.27", None);
}

#[test]
fn ue53_saved_text_matches_fresh_process_engine_evidence() {
    conformance("5.3", Some(1009));
}
