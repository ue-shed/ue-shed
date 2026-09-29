use std::fs::File;
use std::io::Read;

use uasset_inspection::level_sequence::{LevelSequenceProjection, project_level_sequence};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, decode_export};

use super::blueprint::{asset_error_code, package_error_code};
use super::{Diagnostic, Failure, checkpoint, scan_failure_code};
use crate::cancellation::CancellationToken;

const MAX_REVIEW_INPUT_BYTES: u64 = 64 * 1024 * 1024;

/// Match the portable reader's input bound before allocating a complete file.
pub(super) fn read_review_asset(path: &str) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| {
            file.take(MAX_REVIEW_INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| {
            Failure::new("io", format!("could not read asset {path}: {error}"), true)
        })?;
    if bytes.len() as u64 > MAX_REVIEW_INPUT_BYTES {
        return Err(Failure::new(
            "resource_limit",
            "saved review input exceeds 64 MiB",
            false,
        ));
    }
    Ok(bytes)
}

pub(crate) struct LevelSequenceOutput {
    pub(crate) sequence: LevelSequenceProjection,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) partial: bool,
}

pub(crate) fn level_sequence_with_cancellation(
    path: &str,
    cancellation: &CancellationToken,
) -> Result<LevelSequenceOutput, Failure> {
    checkpoint(cancellation, "read")?;
    let bytes = read_review_asset(path)?;
    checkpoint(cancellation, "parsing")?;
    let package = Package::parse(&bytes).map_err(|error| {
        Failure::new(package_error_code(error.kind()), error.to_string(), false)
    })?;
    let context = AssetDecodeContext {
        source: &bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets = Vec::new();
    let mut diagnostics = Vec::new();
    for export in &package.exports {
        checkpoint(cancellation, "inspection")?;
        match decode_export(export, &context) {
            Ok(Some(asset)) => assets.push(asset),
            Ok(None) => {}
            Err(error) => diagnostics.push(Diagnostic {
                code: scan_failure_code(asset_error_code(error.kind())),
                message: error.message().to_owned(),
                path: export.object_path.to_string(),
                retry_safe: false,
            }),
        }
    }
    let sequence = project_level_sequence(&package, &assets).ok_or_else(|| {
        Failure::new(
            "unsupported",
            format!("package {path} contains no saved Level Sequence"),
            false,
        )
    })?;
    let partial = !diagnostics.is_empty()
        || !sequence.coverage_gaps.is_empty()
        || !sequence.reference_coverage_gaps.is_empty();
    Ok(LevelSequenceOutput {
        sequence,
        diagnostics,
        partial,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_input_before_parsing_and_honors_pre_read_cancellation() {
        let path = std::env::temp_dir().join(format!(
            "ue-shed-review-limit-{}.uasset",
            std::process::id()
        ));
        let file = File::create(&path).unwrap();
        file.set_len(MAX_REVIEW_INPUT_BYTES + 1).unwrap();
        drop(file);
        let result = read_review_asset(path.to_str().unwrap());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(result.unwrap_err().code, "resource_limit");
        let token = CancellationToken::new();
        token.cancel();
        assert_eq!(
            level_sequence_with_cancellation("does-not-exist.uasset", &token)
                .err()
                .unwrap()
                .code,
            "cancelled"
        );
    }
}
