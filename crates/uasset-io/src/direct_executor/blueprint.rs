use std::collections::HashSet;
use std::fs;

use uasset_inspection::{
    BlueprintGraphProjection, is_control_rig_blueprint_package, project_blueprint_graphs,
    saved_blueprint_graph_node_paths,
};
use uasset_parser::Package;
use uasset_parser::asset::{
    AssetDecodeContext, DecodedAsset, decode_export, decode_saved_blueprint_graph_node,
    supports_blueprint_graph_package_version,
};

use super::{Diagnostic, Failure, checkpoint, scan_failure_code};
use crate::cancellation::CancellationToken;

pub(crate) struct BlueprintOutput {
    pub(crate) blueprint: BlueprintGraphProjection,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) partial: bool,
}

pub(crate) fn blueprint_with_cancellation(
    path: &str,
    cancellation: &CancellationToken,
) -> Result<BlueprintOutput, Failure> {
    checkpoint(cancellation, "read")?;
    let bytes = fs::read(path).map_err(|error| Failure {
        code: "io".to_owned(),
        message: format!("could not read Blueprint asset {path}: {error}"),
        retry_safe: true,
        ..Default::default()
    })?;
    checkpoint(cancellation, "read")?;
    blueprint_bytes_with_cancellation(path, &bytes, cancellation)
}

fn blueprint_bytes_with_cancellation(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<BlueprintOutput, Failure> {
    checkpoint(cancellation, "parsing")?;
    let package = Package::parse(bytes).map_err(|error| Failure {
        code: package_error_code(error.kind()).to_owned(),
        message: format!("could not parse Blueprint asset {path}: {error}"),
        retry_safe: false,
        ..Default::default()
    })?;
    if !supports_blueprint_graph_package_version(&package.summary.versions) {
        return Err(Failure {
            code: "unsupported_version".to_owned(),
            message: format!(
                "Blueprint graph inspection supports UE 5.7-loadable saved package revisions; {path} uses UE4 {}, UE5 {}",
                package.summary.versions.ue4, package.summary.versions.ue5
            ),
            retry_safe: false,
            ..Default::default()
        });
    }
    if is_control_rig_blueprint_package(&package) {
        return Err(Failure {
            code: "unsupported_capability".to_owned(),
            message: format!(
                "Control Rig Blueprint {path} uses the separate RigVM graph model, which is not supported by the saved Blueprint graph projection"
            ),
            retry_safe: false,
            ..Default::default()
        });
    }
    let context = AssetDecodeContext {
        source: bytes,
        package: &package,
    };
    let mut assets = Vec::new();
    let mut pending_errors = Vec::new();
    for export in &package.exports {
        checkpoint(cancellation, "inspection")?;
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

    let node_paths: HashSet<_> = saved_blueprint_graph_node_paths(&package, &assets)
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
        checkpoint(cancellation, "inspection")?;
        match decode_saved_blueprint_graph_node(export, &context) {
            Ok(node) => {
                decoded_node_paths.insert(node_path.clone());
                assets.push(DecodedAsset::BlueprintGraphNode(node));
            }
            Err(error) => diagnostics.push(Diagnostic {
                code: scan_failure_code(asset_error_code(error.kind())),
                message: error.message().to_owned(),
                path: node_path.clone(),
                retry_safe: false,
            }),
        }
    }
    diagnostics.extend(pending_errors.into_iter().filter_map(
        |(object_path, class_path, kind, message)| {
            (!node_paths.contains(&object_path)
                && class_path.as_deref().is_some_and(is_graph_class_candidate))
            .then(|| Diagnostic {
                code: scan_failure_code(asset_error_code(kind)),
                message,
                path: object_path,
                retry_safe: false,
            })
        },
    ));
    let blueprint = project_blueprint_graphs(&package, &assets).ok_or_else(|| Failure {
        code: "unsupported".to_owned(),
        message: format!("package {path} contains no saved Blueprint editor graph"),
        retry_safe: false,
        ..Default::default()
    })?;
    let partial = !diagnostics.is_empty() || !blueprint.coverage_gaps.is_empty();
    Ok(BlueprintOutput {
        blueprint,
        diagnostics,
        partial,
    })
}

fn is_graph_class_candidate(class_path: &str) -> bool {
    class_path.rsplit('.').next().is_some_and(|class_name| {
        class_name == "EdGraph" || (class_name.ends_with("Graph") && !class_name.contains("Node"))
    })
}

fn package_error_code(kind: uasset_parser::PackageErrorKind) -> &'static str {
    match kind {
        uasset_parser::PackageErrorKind::MalformedData => "malformed_data",
        uasset_parser::PackageErrorKind::ResourceLimit => "resource_limit",
        uasset_parser::PackageErrorKind::UnsupportedFormat => "unsupported_format",
        uasset_parser::PackageErrorKind::UnsupportedVersion => "unsupported_version",
        uasset_parser::PackageErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn asset_error_code(kind: uasset_parser::asset::AssetErrorKind) -> &'static str {
    match kind {
        uasset_parser::asset::AssetErrorKind::MalformedData => "malformed_data",
        uasset_parser::asset::AssetErrorKind::ResourceLimit => "resource_limit",
        uasset_parser::asset::AssetErrorKind::UnsupportedFormat => "unsupported_format",
        uasset_parser::asset::AssetErrorKind::UnsupportedVersion => "unsupported_version",
        uasset_parser::asset::AssetErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}
