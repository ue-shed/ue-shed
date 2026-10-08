//! WebAssembly adapter for the portable UAsset parser.

use std::collections::HashSet;
use std::io::{self, Write};

use serde::Serialize;
use uasset_inspection::blueprint::{
    BlueprintGraphProjection, is_control_rig_blueprint_package, project_blueprint_graphs,
    saved_blueprint_graph_node_paths,
};
use uasset_inspection::generic::{InspectionJsonError, PropertyValueOutput, write_inspection_json};
use uasset_inspection::level_sequence::{LevelSequenceProjection, project_level_sequence};
use uasset_inspection::projection::{
    TEXTURE2D_CLASS, TextCoverageGap, TextOccurrence, TextureRecord, project_text_asset,
    project_texture_asset, text_feature_version_gap,
};
use uasset_parser::asset::{
    AssetDecodeContext, AssetErrorKind, DecodedAsset, decode_export,
    decode_saved_blueprint_graph_node, supports_blueprint_graph_package_version,
};
use uasset_parser::schema::embedded_source_model;
use uasset_parser::{Package, PackageError, PackageErrorKind, PackageSummary};
use wasm_bindgen::prelude::*;

#[cfg(test)]
use uasset_parser::{archive, package, version};
#[cfg(test)]
#[allow(dead_code)]
#[path = "../../uasset-parser/src/test_support.rs"]
mod test_support;

/// Maximum package size accepted by the public WASM boundary.
///
/// JavaScript callers must enforce this limit before passing a typed array to wasm-bindgen. The
/// Rust check remains authoritative for callers that use the generated binding directly.
pub const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// Maximum serialized result size returned by the public WASM boundary.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;

/// Maximum number of exports decoded by one WASM operation.
pub const MAX_EXPORTS: usize = 100_000;

/// Maximum number of records emitted by a compact projection.
pub const MAX_PROJECTION_ITEMS: usize = 1_000_000;

/// Emits the same saved-file DataTable snapshot as the native authoring operation.
#[wasm_bindgen]
pub fn extract_authoring_table(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    if let Some(error) = export_limit_error(1, path, bytes) {
        return error;
    }
    match uasset_inspection::authoring::inspect_authoring_bytes(path, bytes) {
        Ok((snapshot, partial)) => {
            let rows = match &snapshot {
                uasset_inspection::authoring::AuthoringTableSnapshot::V1(value) => {
                    &value.table.rows
                }
                uasset_inspection::authoring::AuthoringTableSnapshot::V2(value) => {
                    &value.table.rows
                }
            };
            let items = rows.iter().fold(1_usize, |count, row| {
                row.fields
                    .iter()
                    .fold(count.saturating_add(1), |count, field| {
                        count.saturating_add(authoring_value_item_count(&field.value))
                    })
            });
            if items > MAX_PROJECTION_ITEMS {
                return serialize_projection_limit_error(
                    path,
                    "authoring projection item count exceeds the WASM limit",
                );
            }
            serialize_bounded_projection(
                path,
                &AuthoringTableOutput {
                    schema_version: 1,
                    status: if partial { "partial" } else { "ok" },
                    path,
                    snapshot,
                },
            )
        }
        Err(error) => serialize_bounded_projection(
            path,
            &ProjectionErrorOutput {
                schema_version: 1,
                status: "error",
                path,
                kind: match error.code.as_str() {
                    "malformed_data" => "malformed_data",
                    "resource_limit" => "resource_limit",
                    "unsupported_version" => "unsupported_version",
                    "unsupported_capability" | "unsupported" => "unsupported_capability",
                    "unsupported_format" => "unsupported_format",
                    _ => "internal",
                },
                message: error.message,
            },
        ),
    }
}

#[derive(Serialize)]
struct AuthoringTableOutput<'a> {
    schema_version: u8,
    status: &'static str,
    path: &'a str,
    snapshot: uasset_inspection::authoring::AuthoringTableSnapshot,
}

fn authoring_value_item_count(value: &uasset_inspection::authoring::AuthoringValue) -> usize {
    use uasset_inspection::authoring::AuthoringValue;
    let children = match value {
        AuthoringValue::Array { values } | AuthoringValue::Set { values } => {
            values.iter().fold(0_usize, |count, value| {
                count.saturating_add(authoring_value_item_count(value))
            })
        }
        AuthoringValue::Map { entries } => entries.iter().fold(0_usize, |count, entry| {
            count
                .saturating_add(authoring_value_item_count(&entry.key))
                .saturating_add(authoring_value_item_count(&entry.value))
        }),
        AuthoringValue::Struct { fields } => fields.iter().fold(0_usize, |count, field| {
            count.saturating_add(authoring_value_item_count(&field.value))
        }),
        _ => 0,
    };
    1_usize.saturating_add(children)
}

/// Parses bounded package bytes and returns the native schema-versioned inspection JSON.
#[wasm_bindgen]
pub fn inspect(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(8, path, bytes) {
        return error;
    }
    if let Some(error) = export_limit_error(8, path, bytes) {
        return error;
    }
    let mut writer = CappedWriter::new(MAX_OUTPUT_BYTES);
    match write_inspection_json(path, bytes, &mut writer) {
        Ok(_) => writer.finish(),
        Err(_) if writer.exceeded() => serialize_generic_error(
            path,
            "resource_limit",
            "serialized inspection exceeds the WASM limit",
        ),
        Err(InspectionJsonError::Inspection(error)) => serialize_bounded_generic(path, &*error),
        Err(InspectionJsonError::Serialization(message)) => {
            serialize_generic_error(path, "internal", message)
        }
    }
}

/// Parses one package and emits the compact, portable Game Text projection.
#[wasm_bindgen]
pub fn extract_text(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    match Package::parse(bytes) {
        Ok(package) => extract_text_from_package(path, bytes, &package),
        Err(error) => serialize_projection_error(path, &error),
    }
}

fn extract_text_from_package(path: &str, bytes: &[u8], package: &Package) -> String {
    if let Some(error) = projection_export_limit(path, package.exports.len()) {
        return error;
    }
    let context = AssetDecodeContext {
        source: bytes,
        package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut occurrences = Vec::new();
    let mut coverage_gaps = Vec::new();
    let mut diagnostics = Vec::new();
    for export in &package.exports {
        match decode_export(export, &context) {
            Ok(Some(asset)) => {
                let projection = project_text_asset(package, &asset);
                let current_items = occurrences.len().saturating_add(coverage_gaps.len());
                let additional_items = projection
                    .occurrences
                    .len()
                    .saturating_add(projection.coverage_gaps.len());
                if exceeds_limit(current_items, additional_items, MAX_PROJECTION_ITEMS) {
                    return serialize_projection_limit_error(
                        path,
                        "text projection item count exceeds the WASM limit",
                    );
                }
                occurrences.extend(projection.occurrences);
                coverage_gaps.extend(projection.coverage_gaps);
            }
            Ok(None) => {}
            Err(error) => {
                if let Some(gap) = text_feature_version_gap(package, export, &error) {
                    if exceeds_limit(
                        occurrences.len().saturating_add(coverage_gaps.len()),
                        1,
                        MAX_PROJECTION_ITEMS,
                    ) {
                        return serialize_projection_limit_error(
                            path,
                            "text projection item count exceeds the WASM limit",
                        );
                    }
                    coverage_gaps.push(gap);
                }
                diagnostics.push(ProjectionDiagnostic {
                    object_path: export.object_path.to_string(),
                    class_path: export.class_path.as_ref().map(ToString::to_string),
                    code: asset_error_kind_name(error.kind()),
                    message: error.message().to_owned(),
                });
            }
        }
    }
    serialize_bounded_projection(
        path,
        &TextProjectionOutput {
            schema_version: 1,
            status: if coverage_gaps.is_empty() {
                projection_status(&diagnostics)
            } else {
                "partial"
            },
            path,
            occurrences,
            coverage_gaps,
            diagnostics,
        },
    )
}

/// Parses one package and emits the compact, portable Texture Audit projection.
#[wasm_bindgen]
pub fn extract_textures(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    match Package::parse(bytes) {
        Ok(package) => {
            if let Some(error) = projection_export_limit(path, package.exports.len()) {
                return error;
            }
            let context = AssetDecodeContext {
                source: bytes,
                package: &package,
                schemas: embedded_source_model(),
            };
            let mut records = Vec::new();
            let mut diagnostics = Vec::new();
            for export in &package.exports {
                if export
                    .class_path
                    .as_ref()
                    .is_none_or(|class_path| class_path.as_str() != TEXTURE2D_CLASS)
                {
                    continue;
                }
                match decode_export(export, &context) {
                    Ok(Some(asset)) => {
                        if let Some(record) = project_texture_asset(
                            &package,
                            &asset,
                            u64::try_from(bytes.len()).expect("usize fits u64"),
                        ) {
                            if records.len() >= MAX_PROJECTION_ITEMS {
                                return serialize_projection_limit_error(
                                    path,
                                    "texture projection item count exceeds the WASM limit",
                                );
                            }
                            records.push(record);
                        }
                    }
                    Ok(None) => {}
                    Err(error) => diagnostics.push(ProjectionDiagnostic {
                        object_path: export.object_path.to_string(),
                        class_path: export.class_path.as_ref().map(ToString::to_string),
                        code: asset_error_kind_name(error.kind()),
                        message: error.message().to_owned(),
                    }),
                }
            }
            serialize_bounded_projection(
                path,
                &TextureProjectionOutput {
                    schema_version: 1,
                    status: projection_status(&diagnostics),
                    path,
                    records,
                    diagnostics,
                },
            )
        }
        Err(error) => serialize_projection_error(path, &error),
    }
}

/// Parses one package and emits its saved animation summaries.
#[wasm_bindgen]
pub fn extract_animations(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    if let Some(error) = export_limit_error(1, path, bytes) {
        return error;
    }
    match uasset_inspection::animation::inspect_animation_bytes(path, bytes) {
        Ok(output) => {
            let items = output
                .animations
                .iter()
                .fold(output.diagnostics.len(), |count, a| {
                    count
                        .saturating_add(1)
                        .saturating_add(a.bone_tracks.len())
                        .saturating_add(a.curves.len())
                        .saturating_add(a.notifies.len())
                        .saturating_add(a.coverage_gaps.len())
                });
            if items > MAX_PROJECTION_ITEMS {
                return serialize_projection_limit_error(
                    path,
                    "animation projection item count exceeds the WASM limit",
                );
            }
            serialize_bounded_projection(path, &output)
        }
        Err(error) => serialize_projection_error(path, &error),
    }
}

/// Parses one package and emits the compact, portable Level Sequence projection.
#[wasm_bindgen]
pub fn extract_level_sequences(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    match Package::parse(bytes) {
        Ok(package) => {
            if let Some(error) = projection_export_limit(path, package.exports.len()) {
                return error;
            }
            let context = AssetDecodeContext {
                source: bytes,
                package: &package,
                schemas: embedded_source_model(),
            };
            let mut assets = Vec::new();
            let mut diagnostics = Vec::new();
            for export in &package.exports {
                match decode_export(export, &context) {
                    Ok(Some(asset)) => assets.push(asset),
                    Ok(None) => {}
                    Err(error) => diagnostics.push(ProjectionDiagnostic {
                        object_path: export.object_path.to_string(),
                        class_path: export.class_path.as_ref().map(ToString::to_string),
                        code: asset_error_kind_name(error.kind()),
                        message: error.message().to_owned(),
                    }),
                }
            }
            let sequences: Vec<_> = project_level_sequence(&package, &assets)
                .into_iter()
                .collect();
            let item_count = sequences
                .iter()
                .map(level_sequence_item_count)
                .sum::<usize>();
            if item_count > MAX_PROJECTION_ITEMS {
                return serialize_projection_limit_error(
                    path,
                    "Level Sequence projection item count exceeds the WASM limit",
                );
            }
            serialize_bounded_projection(
                path,
                &LevelSequenceProjectionOutput {
                    schema_version: 1,
                    status: projection_status(&diagnostics),
                    path,
                    sequences,
                    diagnostics,
                },
            )
        }
        Err(error) => serialize_projection_error(path, &error),
    }
}

/// Parses one package and emits the compact, portable Blueprint graph projection.
#[wasm_bindgen]
pub fn extract_blueprints(path: &str, bytes: &[u8]) -> String {
    if let Some(error) = input_limit_error(1, path, bytes) {
        return error;
    }
    match Package::parse(bytes) {
        Ok(package) => extract_blueprints_from_package(path, bytes, &package),
        Err(error) => serialize_projection_error(path, &error),
    }
}

fn extract_blueprints_from_package(path: &str, bytes: &[u8], package: &Package) -> String {
    if let Some(error) = projection_export_limit(path, package.exports.len()) {
        return error;
    }
    if !supports_blueprint_graph_package_version(&package.summary.versions) {
        return serialize_projection_error_kind(
            path,
            "unsupported_version",
            format!(
                "Blueprint graph inspection supports UE 5.7-loadable saved package revisions; {path} uses UE4 {}, UE5 {}",
                package.summary.versions.ue4, package.summary.versions.ue5
            ),
        );
    }
    if is_control_rig_blueprint_package(package) {
        return serialize_projection_error_kind(
            path,
            "unsupported_capability",
            format!(
                "Control Rig Blueprint {path} uses the separate RigVM graph model, which is not supported by the saved Blueprint graph projection"
            ),
        );
    }
    let context = AssetDecodeContext {
        source: bytes,
        package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets = Vec::new();
    let mut pending_errors = Vec::new();
    for export in &package.exports {
        match decode_export(export, &context) {
            Ok(Some(asset)) => assets.push(asset),
            Ok(None) => {}
            Err(error) => pending_errors.push((
                export.object_path.to_string(),
                export.class_path.as_ref().map(ToString::to_string),
                error.kind(),
                error.message().to_owned(),
            )),
        }
    }
    let node_paths: HashSet<_> = saved_blueprint_graph_node_paths(package, &assets)
        .into_iter()
        .collect();
    let mut decoded_node_paths: HashSet<_> = assets
        .iter()
        .filter_map(|asset| match asset {
            DecodedAsset::BlueprintGraphNode(node) => Some(node.object_path.to_string()),
            _ => None,
        })
        .collect();
    let mut diagnostics = Vec::new();
    for node_path in &node_paths {
        if decoded_node_paths.contains(node_path) {
            continue;
        }
        let Some(export) = package
            .exports
            .iter()
            .find(|export| export.object_path.as_str() == node_path)
        else {
            continue;
        };
        match decode_saved_blueprint_graph_node(export, &context) {
            Ok(node) => {
                decoded_node_paths.insert(node_path.clone());
                assets.push(DecodedAsset::BlueprintGraphNode(node));
            }
            Err(error) => diagnostics.push(ProjectionDiagnostic {
                object_path: node_path.clone(),
                class_path: export.class_path.as_ref().map(ToString::to_string),
                code: asset_error_kind_name(error.kind()),
                message: error.message().to_owned(),
            }),
        }
    }
    diagnostics.extend(pending_errors.into_iter().filter_map(
        |(object_path, class_path, kind, message)| {
            (!node_paths.contains(&object_path)
                && class_path.as_deref().is_some_and(is_graph_class_candidate))
            .then(|| ProjectionDiagnostic {
                object_path,
                class_path,
                code: asset_error_kind_name(kind),
                message,
            })
        },
    ));
    let blueprints: Vec<_> = project_blueprint_graphs(package, &assets)
        .into_iter()
        .collect();
    let item_count = blueprints
        .iter()
        .map(blueprint_graph_item_count)
        .sum::<usize>();
    if item_count > MAX_PROJECTION_ITEMS {
        return serialize_projection_limit_error(
            path,
            "Blueprint graph projection item count exceeds the WASM limit",
        );
    }
    let status = if diagnostics.is_empty()
        && blueprints
            .iter()
            .all(|blueprint| blueprint.coverage_gaps.is_empty())
    {
        "ok"
    } else {
        "partial"
    };
    serialize_bounded_projection(
        path,
        &BlueprintGraphProjectionOutput {
            schema_version: 1,
            status,
            path,
            blueprints,
            diagnostics,
        },
    )
}

fn is_graph_class_candidate(class_path: &str) -> bool {
    class_path.rsplit('.').next().is_some_and(|class_name| {
        class_name == "EdGraph" || (class_name.ends_with("Graph") && !class_name.contains("Node"))
    })
}

/// Returns the parser/binding package version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Returns the limits enforced by this binding and its JavaScript assembly package.
#[wasm_bindgen]
pub fn limits() -> String {
    serde_json::json!({
        "max_input_bytes": MAX_INPUT_BYTES,
        "max_output_bytes": MAX_OUTPUT_BYTES,
        "max_exports": MAX_EXPORTS,
        "max_projection_items": MAX_PROJECTION_ITEMS,
    })
    .to_string()
}

#[derive(Serialize)]
struct TextProjectionOutput<'a> {
    schema_version: u32,
    status: &'static str,
    path: &'a str,
    occurrences: Vec<TextOccurrence>,
    coverage_gaps: Vec<TextCoverageGap>,
    diagnostics: Vec<ProjectionDiagnostic>,
}

#[derive(Serialize)]
struct TextureProjectionOutput<'a> {
    schema_version: u32,
    status: &'static str,
    path: &'a str,
    records: Vec<TextureRecord>,
    diagnostics: Vec<ProjectionDiagnostic>,
}

#[derive(Serialize)]
struct LevelSequenceProjectionOutput<'a> {
    schema_version: u32,
    status: &'static str,
    path: &'a str,
    sequences: Vec<LevelSequenceProjection>,
    diagnostics: Vec<ProjectionDiagnostic>,
}

#[derive(Serialize)]
struct BlueprintGraphProjectionOutput<'a> {
    schema_version: u32,
    status: &'static str,
    path: &'a str,
    blueprints: Vec<BlueprintGraphProjection>,
    diagnostics: Vec<ProjectionDiagnostic>,
}

fn native_item_count(value: &PropertyValueOutput) -> usize {
    let children = match value {
        PropertyValueOutput::NativeStruct { fields } => {
            fields.iter().fold(0_usize, |count, field| {
                count.saturating_add(native_item_count(&field.value))
            })
        }
        PropertyValueOutput::Array { values } | PropertyValueOutput::Set { values } => {
            values.iter().fold(0_usize, |count, value| {
                count.saturating_add(native_item_count(value))
            })
        }
        PropertyValueOutput::Struct { properties } => {
            properties.iter().fold(0_usize, |count, property| {
                count.saturating_add(native_item_count(&property.value))
            })
        }
        PropertyValueOutput::Map { entries } => entries.iter().fold(0_usize, |count, entry| {
            count
                .saturating_add(native_item_count(&entry.key))
                .saturating_add(native_item_count(&entry.value))
        }),
        PropertyValueOutput::InstancedStruct { value, .. } => {
            value.as_deref().map_or(0, native_item_count)
        }
        _ => 0,
    };
    1_usize.saturating_add(children)
}

fn blueprint_graph_item_count(blueprint: &BlueprintGraphProjection) -> usize {
    1_usize
        .saturating_add(blueprint.definition.variables.as_ref().map_or(0, |v| {
            v.iter().fold(0_usize, |count, variable| {
                count
                    .saturating_add(1)
                    .saturating_add(variable.properties.len())
            })
        }))
        .saturating_add(blueprint.definition.default_object.as_ref().map_or(0, |v| {
            v.properties
                .len()
                .saturating_add(v.native_data.as_deref().map_or(0, native_item_count))
        }))
        .saturating_add(
            blueprint
                .definition
                .construction_script
                .as_ref()
                .map_or(0, |v| {
                    v.root_nodes.as_ref().map_or(0, Vec::len).saturating_add(
                        v.nodes
                            .iter()
                            .map(|n| {
                                1_usize
                                    .saturating_add(n.children.as_ref().map_or(0, Vec::len))
                                    .saturating_add(n.template.as_ref().map_or(0, |v| {
                                        v.properties.len().saturating_add(
                                            v.native_data.as_deref().map_or(0, native_item_count),
                                        )
                                    }))
                            })
                            .sum::<usize>(),
                    )
                }),
        )
        .saturating_add(blueprint.coverage_gaps.len())
        .saturating_add(
            blueprint
                .graphs
                .iter()
                .map(|graph| {
                    1_usize.saturating_add(graph.links.len()).saturating_add(
                        graph
                            .nodes
                            .iter()
                            .map(|node| 1_usize.saturating_add(node.pins.len()))
                            .sum::<usize>(),
                    )
                })
                .sum::<usize>(),
        )
}

fn level_sequence_item_count(sequence: &LevelSequenceProjection) -> usize {
    let binding_tracks = sequence.bindings.iter().flat_map(|binding| &binding.tracks);
    let tracks = binding_tracks.chain(&sequence.root_tracks);
    1_usize
        .saturating_add(sequence.bindings.len())
        .saturating_add(sequence.references.len())
        .saturating_add(sequence.reference_coverage_gaps.len())
        .saturating_add(sequence.coverage_gaps.len())
        .saturating_add(
            tracks
                .map(|track| {
                    1_usize.saturating_add(
                        track
                            .sections
                            .iter()
                            .map(|section| {
                                1_usize
                                    .saturating_add(section.text_keys.len())
                                    .saturating_add(section.numeric_channels.iter().fold(
                                        0_usize,
                                        |count, channel| {
                                            count
                                                .saturating_add(1)
                                                .saturating_add(channel.keys.len())
                                        },
                                    ))
                                    .saturating_add(section.discrete_channels.iter().fold(
                                        0_usize,
                                        |count, channel| {
                                            count
                                                .saturating_add(1)
                                                .saturating_add(channel.key_count())
                                        },
                                    ))
                                    .saturating_add(section.value_channels.iter().fold(
                                        0_usize,
                                        |count, channel| {
                                            count
                                                .saturating_add(1)
                                                .saturating_add(channel.key_count())
                                        },
                                    ))
                                    .saturating_add(usize::from(section.camera_cut.is_some()))
                                    .saturating_add(
                                        section.settings.blend_type.as_ref().map_or(0, Vec::len),
                                    )
                                    .saturating_add(
                                        section.settings.easing.as_ref().map_or(0, Vec::len),
                                    )
                                    .saturating_add(usize::from(section.sequence_path.is_some()))
                            })
                            .sum::<usize>(),
                    )
                })
                .sum::<usize>(),
        )
}

#[derive(Serialize)]
struct ProjectionDiagnostic {
    object_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_path: Option<String>,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ProjectionErrorOutput<'a> {
    schema_version: u32,
    status: &'static str,
    path: &'a str,
    kind: &'static str,
    message: String,
}

#[derive(Serialize)]
struct GenericErrorOutput<'a> {
    schema_version: u8,
    status: &'static str,
    path: &'a str,
    kind: &'static str,
    message: String,
    field: Option<String>,
    offset: Option<u64>,
}

fn projection_status(diagnostics: &[ProjectionDiagnostic]) -> &'static str {
    if diagnostics.is_empty() {
        "complete"
    } else {
        "partial"
    }
}

fn asset_error_kind_name(kind: AssetErrorKind) -> &'static str {
    match kind {
        AssetErrorKind::MalformedData => "malformed_data",
        AssetErrorKind::ResourceLimit => "resource_limit",
        AssetErrorKind::UnsupportedFormat => "unsupported_format",
        AssetErrorKind::UnsupportedVersion => "unsupported_version",
        AssetErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn package_error_kind_name(kind: PackageErrorKind) -> &'static str {
    match kind {
        PackageErrorKind::MalformedData => "malformed_data",
        PackageErrorKind::ResourceLimit => "resource_limit",
        PackageErrorKind::UnsupportedFormat => "unsupported_format",
        PackageErrorKind::UnsupportedVersion => "unsupported_version",
        PackageErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn serialize_bounded_projection(path: &str, value: &impl Serialize) -> String {
    match serialize_with_limit(value, MAX_OUTPUT_BYTES) {
        Ok(output) => output,
        Err(SerializationFailure::LimitExceeded) => {
            serialize_projection_limit_error(path, "serialized projection exceeds the WASM limit")
        }
        Err(SerializationFailure::Internal(message)) => {
            serialize_projection_error_kind(path, "internal", message)
        }
    }
}

fn serialize_projection_error(path: &str, error: &PackageError) -> String {
    serialize_projection_error_kind(path, package_error_kind_name(error.kind()), error.detail())
}

fn serialize_projection_error_kind(
    path: &str,
    kind: &'static str,
    message: impl Into<String>,
) -> String {
    let output = ProjectionErrorOutput {
        schema_version: 1,
        status: "error",
        path,
        kind,
        message: message.into(),
    };
    serialize_with_limit(&output, MAX_OUTPUT_BYTES).unwrap_or_else(|failure| match failure {
        SerializationFailure::LimitExceeded => PROJECTION_OUTPUT_LIMIT_ERROR.to_owned(),
        SerializationFailure::Internal(_) => PROJECTION_INTERNAL_ERROR.to_owned(),
    })
}

fn serialize_projection_limit_error(path: &str, message: &str) -> String {
    serialize_projection_error_kind(path, "resource_limit", message)
}

fn serialize_generic_error(path: &str, kind: &'static str, message: impl Into<String>) -> String {
    let output = GenericErrorOutput {
        schema_version: 8,
        status: "error",
        path,
        kind,
        message: message.into(),
        field: None,
        offset: None,
    };
    serialize_with_limit(&output, MAX_OUTPUT_BYTES).unwrap_or_else(|failure| match failure {
        SerializationFailure::LimitExceeded => GENERIC_OUTPUT_LIMIT_ERROR.to_owned(),
        SerializationFailure::Internal(_) => GENERIC_INTERNAL_ERROR.to_owned(),
    })
}

fn serialize_bounded_generic(path: &str, value: &impl Serialize) -> String {
    match serialize_with_limit(value, MAX_OUTPUT_BYTES) {
        Ok(output) => output,
        Err(SerializationFailure::LimitExceeded) => serialize_generic_error(
            path,
            "resource_limit",
            "serialized inspection exceeds the WASM limit",
        ),
        Err(SerializationFailure::Internal(message)) => {
            serialize_generic_error(path, "internal", message)
        }
    }
}

const GENERIC_OUTPUT_LIMIT_ERROR: &str = concat!(
    r#"{"schema_version":8,"status":"error","path":"","kind":"resource_limit","message":""#,
    r#"serialized inspection exceeds the WASM limit","field":null,"offset":null}"#
);
const GENERIC_INTERNAL_ERROR: &str = concat!(
    r#"{"schema_version":8,"status":"error","path":"","kind":"internal","message":""#,
    r#"inspection serialization failed","field":null,"offset":null}"#
);
const PROJECTION_OUTPUT_LIMIT_ERROR: &str = concat!(
    r#"{"schema_version":1,"status":"error","path":"","kind":"resource_limit","message":""#,
    r#"serialized projection exceeds the WASM limit"}"#
);
const PROJECTION_INTERNAL_ERROR: &str = concat!(
    r#"{"schema_version":1,"status":"error","path":"","kind":"internal","message":""#,
    r#"projection serialization failed"}"#
);

#[derive(Debug, Eq, PartialEq)]
enum SerializationFailure {
    LimitExceeded,
    Internal(String),
}

struct CappedWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl CappedWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded: false,
        }
    }

    fn finish(self) -> String {
        String::from_utf8(self.bytes).expect("serde_json writes valid UTF-8")
    }

    fn exceeded(&self) -> bool {
        self.exceeded
    }
}

impl Write for CappedWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("serialized output exceeds the WASM limit"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialize_with_limit(
    value: &impl Serialize,
    limit: usize,
) -> Result<String, SerializationFailure> {
    let mut writer = CappedWriter::new(limit);
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        return if writer.exceeded {
            Err(SerializationFailure::LimitExceeded)
        } else {
            Err(SerializationFailure::Internal(error.to_string()))
        };
    }
    Ok(writer.finish())
}

fn input_limit_error(schema_version: u8, path: &str, bytes: &[u8]) -> Option<String> {
    (bytes.len() > MAX_INPUT_BYTES).then(|| {
        let message = format!(
            "input size {} exceeds the WASM limit of {} bytes",
            bytes.len(),
            MAX_INPUT_BYTES
        );
        if schema_version == 8 {
            serialize_generic_error(path, "resource_limit", message)
        } else {
            serialize_projection_limit_error(path, &message)
        }
    })
}

fn export_limit_error(schema_version: u8, path: &str, bytes: &[u8]) -> Option<String> {
    let summary = PackageSummary::parse(bytes).ok()?;
    let export_count = usize::try_from(summary.exports.count).expect("u32 fits in usize");
    (export_count > MAX_EXPORTS).then(|| {
        let message = format!(
            "export count {} exceeds the WASM limit of {}",
            export_count, MAX_EXPORTS
        );
        if schema_version == 8 {
            serialize_generic_error(path, "resource_limit", message)
        } else {
            serialize_projection_limit_error(path, &message)
        }
    })
}

fn projection_export_limit(path: &str, export_count: usize) -> Option<String> {
    (export_count > MAX_EXPORTS).then(|| {
        serialize_projection_limit_error(
            path,
            &format!("export count {export_count} exceeds the WASM limit of {MAX_EXPORTS}"),
        )
    })
}

fn exceeds_limit(current: usize, additional: usize, limit: usize) -> bool {
    current > limit || additional > limit.saturating_sub(current)
}

#[cfg(test)]
mod tests {
    #[test]
    fn synthetic_legacy_text_matches_the_native_projection_at_the_wasm_adapter() {
        for ue5 in [0, 1000, 1009, 1010, 1011] {
            let (bytes, package) = crate::test_support::legacy_text_package(ue5);
            let context = uasset_parser::asset::AssetDecodeContext {
                source: &bytes,
                package: &package,
                schemas: uasset_parser::schema::embedded_source_model(),
            };
            let asset = uasset_parser::asset::decode_export(&package.exports[0], &context)
                .unwrap()
                .unwrap();
            let native = uasset_inspection::projection::project_text_asset(&package, &asset);
            assert_eq!(native.occurrences.len(), 1);
            assert_eq!(native.coverage_gaps.len(), 4);
            let wasm: serde_json::Value = serde_json::from_str(&super::extract_text_from_package(
                "legacy.uasset",
                &bytes,
                &package,
            ))
            .unwrap();
            assert_eq!(wasm["status"], "partial");
            assert_eq!(
                wasm["occurrences"],
                serde_json::to_value(&native.occurrences).unwrap()
            );
            assert_eq!(
                wasm["coverage_gaps"],
                serde_json::to_value(&native.coverage_gaps).unwrap()
            );
            assert_eq!(wasm["diagnostics"], serde_json::json!([]));
        }
    }

    use serde_json::Value;
    use uasset_parser::Package;
    use uasset_parser::package::ObjectPath;

    use super::{
        MAX_EXPORTS, MAX_INPUT_BYTES, MAX_PROJECTION_ITEMS, SerializationFailure, exceeds_limit,
        extract_blueprints, extract_blueprints_from_package, extract_text_from_package, inspect,
        limits, projection_export_limit, serialize_with_limit,
    };

    const BLUEPRINT_FIXTURE: &[u8] = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_GraphFixture.uasset"
    );

    #[test]
    fn authoring_envelope_preserves_the_portable_snapshot() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
        );
        let output: Value =
            serde_json::from_str(&super::extract_authoring_table("DT.uasset", bytes))
                .expect("authoring envelope");
        let (snapshot, partial) =
            uasset_inspection::authoring::inspect_authoring_bytes("DT.uasset", bytes)
                .expect("portable authoring projection");
        assert_eq!(output["schema_version"], 1);
        assert_eq!(output["status"], if partial { "partial" } else { "ok" });
        assert_eq!(
            output["snapshot"],
            serde_json::to_value(snapshot).expect("snapshot JSON")
        );
    }

    #[test]
    fn authoring_rejects_non_tables_malformed_bytes_and_oversized_input() {
        for (bytes, kind) in [
            (BLUEPRINT_FIXTURE, "unsupported_capability"),
            (&[0_u8, 1, 2, 3][..], "unsupported_format"),
        ] {
            let output: Value =
                serde_json::from_str(&super::extract_authoring_table("Other.uasset", bytes))
                    .expect("authoring error JSON");
            assert_eq!(output["schema_version"], 1);
            assert_eq!(output["status"], "error");
            assert_eq!(output["kind"], kind);
        }
        let output: Value = serde_json::from_str(&super::extract_authoring_table(
            "Large.uasset",
            &vec![0; MAX_INPUT_BYTES + 1],
        ))
        .expect("authoring limit JSON");
        assert_eq!(output["kind"], "resource_limit");
    }

    #[test]
    fn discrete_channels_and_keys_count_toward_the_projection_limit() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/ParserNative/LS_Discrete.uasset"
        );
        let output: Value =
            serde_json::from_str(&super::extract_level_sequences("LS_Discrete.uasset", bytes))
                .unwrap();
        let mut sequence: super::LevelSequenceProjection =
            serde_json::from_value(output["sequences"][0].clone()).unwrap();
        let count = super::level_sequence_item_count(&sequence);
        for track in &mut sequence.root_tracks {
            for section in &mut track.sections {
                section.discrete_channels.clear();
            }
        }
        assert_eq!(count - super::level_sequence_item_count(&sequence), 7 + 18);
    }

    #[test]
    fn saved_channels_defaults_and_component_properties_consume_projection_budget() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/ParserNative/LS_SavedDetails.uasset"
        );
        let output: Value =
            serde_json::from_str(&super::extract_level_sequences("saved.uasset", bytes)).unwrap();
        let mut sequence: super::LevelSequenceProjection =
            serde_json::from_value(output["sequences"][0].clone()).unwrap();
        let count = super::level_sequence_item_count(&sequence);
        for track in &mut sequence.root_tracks {
            for section in &mut track.sections {
                section.value_channels.clear();
                section.camera_cut = None;
            }
        }
        assert_eq!(
            count - super::level_sequence_item_count(&sequence),
            3 + 6 + 3
        );
        assert!(exceeds_limit(0, count, count - 1));
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Blueprints/BP_ReviewFixture.uasset"
        );
        let output: Value =
            serde_json::from_str(&super::extract_blueprints("review.uasset", bytes)).unwrap();
        let mut blueprint: super::BlueprintGraphProjection =
            serde_json::from_value(output["blueprints"][0].clone()).unwrap();
        let count = super::blueprint_graph_item_count(&blueprint);
        blueprint.definition.variables = None;
        blueprint.definition.default_object = None;
        blueprint.definition.construction_script = None;
        assert!(count - super::blueprint_graph_item_count(&blueprint) > 6 + 3);
        assert!(exceeds_limit(0, count, count - 1));
    }

    #[test]
    fn native_member_arrays_count_toward_the_blueprint_budget() {
        let output: Value = serde_json::from_str(&super::extract_blueprints(
            "graph.uasset",
            BLUEPRINT_FIXTURE,
        ))
        .unwrap();
        let mut blueprint: super::BlueprintGraphProjection =
            serde_json::from_value(output["blueprints"][0].clone()).unwrap();
        let count = super::blueprint_graph_item_count(&blueprint);
        let template = blueprint
            .definition
            .construction_script
            .as_mut()
            .unwrap()
            .nodes[0]
            .template
            .as_mut()
            .unwrap();
        template.native_data = Some(Box::new(super::PropertyValueOutput::Array {
            values: vec![
                super::PropertyValueOutput::Bool { value: false };
                super::MAX_PROJECTION_ITEMS
            ],
        }));
        assert!(super::blueprint_graph_item_count(&blueprint) > super::MAX_PROJECTION_ITEMS);
        assert!(super::blueprint_graph_item_count(&blueprint) > count);
    }

    #[test]
    fn projects_the_real_blueprint_fixture_through_the_wasm_boundary() {
        let output = extract_blueprints("BP_GraphFixture.uasset", BLUEPRINT_FIXTURE);
        let value: Value = serde_json::from_str(&output).expect("Blueprint projection is JSON");

        assert_eq!(value["status"], "ok");
        let blueprint = &value["blueprints"][0];
        assert_eq!(blueprint["coverage_gaps"].as_array().map(Vec::len), Some(0));
        assert!(
            blueprint["graphs"]
                .as_array()
                .is_some_and(|graphs| !graphs.is_empty())
        );
        assert!(
            blueprint["graphs"][0]["nodes"]
                .as_array()
                .is_some_and(|nodes| !nodes.is_empty())
        );
    }

    #[test]
    fn keeps_blueprint_revision_gating_off_compact_text() {
        let mut package = Package::parse(BLUEPRINT_FIXTURE).expect("parse Blueprint fixture");
        package.summary.versions.ue5 = 1016;

        let text =
            extract_text_from_package("BP_OlderRevision.uasset", BLUEPRINT_FIXTURE, &package);
        let text: Value = serde_json::from_str(&text).expect("text projection is JSON");
        assert_ne!(text["status"], "error");
        assert_eq!(text["diagnostics"].as_array().map(Vec::len), Some(0));

        let blueprint =
            extract_blueprints_from_package("BP_OlderRevision.uasset", BLUEPRINT_FIXTURE, &package);
        let blueprint: Value =
            serde_json::from_str(&blueprint).expect("Blueprint rejection is JSON");
        assert_eq!(blueprint["status"], "error");
        assert_eq!(blueprint["kind"], "unsupported_version");
    }

    #[test]
    fn keeps_control_rig_gating_off_compact_text() {
        let mut package = Package::parse(BLUEPRINT_FIXTURE).expect("parse Blueprint fixture");
        let root = package
            .exports
            .iter_mut()
            .find(|export| {
                export.class_path.as_ref().map(ObjectPath::as_str)
                    == Some("/Script/Engine.Blueprint")
            })
            .expect("Blueprint root export");
        root.class_path = Some(ObjectPath::new(
            "/Script/ControlRigDeveloper.ControlRigBlueprint",
        ));

        let text = extract_text_from_package("CR_Test.uasset", BLUEPRINT_FIXTURE, &package);
        let text: Value = serde_json::from_str(&text).expect("text projection is JSON");
        assert_ne!(text["status"], "error");
        assert_eq!(text["diagnostics"].as_array().map(Vec::len), Some(0));

        let blueprint =
            extract_blueprints_from_package("CR_Test.uasset", BLUEPRINT_FIXTURE, &package);
        let blueprint: Value =
            serde_json::from_str(&blueprint).expect("Control Rig rejection is JSON");
        assert_eq!(blueprint["status"], "error");
        assert_eq!(blueprint["kind"], "unsupported_capability");
    }

    #[test]
    fn rejects_default_oversized_input_at_the_public_boundary() {
        let bytes = vec![0; MAX_INPUT_BYTES + 1];
        let output = inspect("large.uasset", &bytes);
        let value: Value = serde_json::from_str(&output).expect("limit result is JSON");
        assert_eq!(value["schema_version"], 8);
        assert_eq!(value["status"], "error");
        assert_eq!(value["kind"], "resource_limit");
        assert_eq!(value["path"], "large.uasset");
    }

    #[test]
    fn stops_serialization_at_the_configured_byte_limit() {
        let value = serde_json::json!({ "payload": "a value larger than the cap" });
        let failure = serialize_with_limit(&value, 8).expect_err("output should hit the cap");
        assert_eq!(failure, SerializationFailure::LimitExceeded);
    }

    #[test]
    fn rejects_adapter_counts_before_accumulating_projection_items() {
        let output = projection_export_limit("many.uasset", MAX_EXPORTS + 1)
            .expect("export count should hit the adapter cap");
        let value: Value = serde_json::from_str(&output).expect("limit result is JSON");
        assert_eq!(value["kind"], "resource_limit");
        assert!(exceeds_limit(
            MAX_PROJECTION_ITEMS - 1,
            2,
            MAX_PROJECTION_ITEMS
        ));
    }

    #[test]
    fn publishes_the_runtime_limits() {
        let value: Value = serde_json::from_str(&limits()).expect("limits are JSON");
        assert_eq!(value["max_input_bytes"], MAX_INPUT_BYTES);
        assert_eq!(value["max_output_bytes"], 64 * 1024 * 1024);
        assert_eq!(value["max_exports"], 100_000);
        assert_eq!(value["max_projection_items"], 1_000_000);
    }
}
