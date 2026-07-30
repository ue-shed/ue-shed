//! WebAssembly adapter for the portable UAsset parser.

use serde::Serialize;
use uasset_parser::asset::{AssetDecodeContext, AssetErrorKind, decode_export};
use uasset_parser::projection::{
    TEXTURE2D_CLASS, TextCoverageGap, TextOccurrence, TextureRecord, project_text_asset,
    project_texture_asset,
};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};
use uasset_parser::{Package, PackageError, PackageErrorKind};
use wasm_bindgen::prelude::*;

// Keep the versioned inspection projection shared with the native executable. The module contains
// native host adapters too, but the linker removes those unreachable functions from the WASM
// artifact. Moving the projection into a dedicated library module can follow without changing this
// public binding.
#[allow(dead_code)]
#[path = "../../uasset-parser/src/bin/uasset.rs"]
mod native_inspection;

/// Parses bounded package bytes and returns the native schema-versioned inspection JSON.
#[wasm_bindgen]
pub fn inspect(path: &str, bytes: &[u8]) -> String {
    native_inspection::inspect_bytes_json(path, bytes)
}

/// Parses one package and emits the compact, portable Game Text projection.
#[wasm_bindgen]
pub fn extract_text(path: &str, bytes: &[u8]) -> String {
    match Package::parse(bytes) {
        Ok(package) => {
            let schemas = EmptySchemas;
            let context = AssetDecodeContext {
                source: bytes,
                package: &package,
                schemas: &schemas,
            };
            let mut occurrences = Vec::new();
            let mut coverage_gaps = Vec::new();
            let mut diagnostics = Vec::new();
            for export in &package.exports {
                match decode_export(export, &context) {
                    Ok(Some(asset)) => {
                        let projection = project_text_asset(&package, &asset);
                        occurrences.extend(projection.occurrences);
                        coverage_gaps.extend(projection.coverage_gaps);
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
            serialize_projection(&TextProjectionOutput {
                schema_version: 1,
                status: projection_status(&diagnostics),
                path,
                occurrences,
                coverage_gaps,
                diagnostics,
            })
        }
        Err(error) => serialize_projection_error(path, &error),
    }
}

/// Parses one package and emits the compact, portable Texture Audit projection.
#[wasm_bindgen]
pub fn extract_textures(path: &str, bytes: &[u8]) -> String {
    match Package::parse(bytes) {
        Ok(package) => {
            let schemas = EmptySchemas;
            let context = AssetDecodeContext {
                source: bytes,
                package: &package,
                schemas: &schemas,
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
            serialize_projection(&TextureProjectionOutput {
                schema_version: 1,
                status: projection_status(&diagnostics),
                path,
                records,
                diagnostics,
            })
        }
        Err(error) => serialize_projection_error(path, &error),
    }
}

/// Returns the parser/binding package version.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&ClassSchema> {
        None
    }
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

fn serialize_projection(value: &impl Serialize) -> String {
    serde_json::to_string(value).unwrap_or_else(|error| {
        serde_json::json!({
            "schema_version": 1,
            "status": "error",
            "kind": "internal",
            "message": error.to_string()
        })
        .to_string()
    })
}

fn serialize_projection_error(path: &str, error: &PackageError) -> String {
    serialize_projection(&ProjectionErrorOutput {
        schema_version: 1,
        status: "error",
        path,
        kind: package_error_kind_name(error.kind()),
        message: error.detail().to_owned(),
    })
}
