use super::{Failure, checkpoint};
use crate::cancellation::CancellationToken;
use crate::protocol_result::SavedAssetInspection;

pub(super) fn inspect_bytes(
    path: &str,
    bytes: &[u8],
    cancellation: &CancellationToken,
) -> Result<(SavedAssetInspection, bool), Failure> {
    uasset_inspection::saved_inspection::inspect_bytes_with_checkpoint(path, bytes, &|stage| {
        checkpoint(cancellation, stage).map_err(|error| {
            uasset_inspection::saved_inspection::InspectionError::new(
                error.code,
                error.message,
                error.retry_safe,
            )
        })
    })
    .map_err(|error| Failure::new(error.code, error.message, error.retry_safe))
}

#[cfg(test)]
mod tests {
    use uasset_inspection::generic::inspect_bytes as inspect_generic_bytes;

    use super::inspect_bytes;
    use crate::cancellation::CancellationToken;
    use crate::protocol_adapter::adapt_inspection;

    const PARITY_FIXTURES: &[(&str, &[u8])] = &[
        (
            "Content/Fixture/ParserNative/CF_Native.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/CF_Native.uasset"
            ),
        ),
        (
            "Content/Fixture/ParserNative/CV_Native.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/CV_Native.uasset"
            ),
        ),
        (
            "Content/Fixture/ParserNative/CC_Native.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/CC_Native.uasset"
            ),
        ),
        (
            "Content/Fixture/ParserNative/SK_Native.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/SK_Native.uasset"
            ),
        ),
        (
            "Content/Fixture/ParserNative/DA_Native.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset"
            ),
        ),
        (
            "Content/Fixture/ParserNative/LS_Numeric.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/LS_Numeric.uasset"
            ),
        ),
        (
            "Content/Fixture/Authoring/DT_Scalars.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
            ),
        ),
        (
            "Content/Fixture/Authoring/DT_LargeScalars.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Authoring/DT_LargeScalars.uasset"
            ),
        ),
        (
            "Content/Fixture/Input/IMC_Fixture.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Input/IMC_Fixture.uasset"
            ),
        ),
        (
            "Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
            ),
        ),
        (
            "Content/Fixture/Text/ST_Game.uasset",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset"
            ),
        ),
        (
            "Content/Fixture/Cameras/L_CameraLoad.umap",
            include_bytes!(
                "../../../../fixtures/unreal-project/Content/Fixture/Cameras/L_CameraLoad.umap"
            ),
        ),
    ];

    #[test]
    fn direct_protocol_projection_matches_the_previous_generic_adapter() {
        for (path, bytes) in PARITY_FIXTURES {
            let generic = inspect_generic_bytes(path, bytes).expect("generic inspection succeeds");
            let expected = adapt_inspection(generic).expect("generic inspection adapts");
            let (actual, partial) = inspect_bytes(path, bytes, &CancellationToken::new())
                .expect("direct protocol inspection succeeds");

            assert_eq!(actual, expected, "protocol projection differs for {path}");
            assert_eq!(
                partial,
                actual.status == crate::protocol_result::InspectionStatus::Partial
            );
        }
    }
}
