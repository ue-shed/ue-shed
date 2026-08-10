//! WebAssembly adapter for the portable UAsset parser.

use std::io::{self, Write};

use serde::Serialize;
use uasset_inspection::generic::{InspectionJsonError, write_inspection_json};
use uasset_inspection::projection::{
    TEXTURE2D_CLASS, TextCoverageGap, TextOccurrence, TextureRecord, project_text_asset,
    project_texture_asset,
};
use uasset_parser::asset::{AssetDecodeContext, AssetErrorKind, decode_export};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};
use uasset_parser::{Package, PackageError, PackageErrorKind, PackageSummary};
use wasm_bindgen::prelude::*;

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
        Ok(package) => {
            if let Some(error) = projection_export_limit(path, package.exports.len()) {
                return error;
            }
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
                &TextProjectionOutput {
                    schema_version: 1,
                    status: projection_status(&diagnostics),
                    path,
                    occurrences,
                    coverage_gaps,
                    diagnostics,
                },
            )
        }
        Err(error) => serialize_projection_error(path, &error),
    }
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
    use serde_json::Value;

    use super::{
        MAX_EXPORTS, MAX_INPUT_BYTES, MAX_PROJECTION_ITEMS, SerializationFailure, exceeds_limit,
        inspect, limits, projection_export_limit, serialize_with_limit,
    };

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
