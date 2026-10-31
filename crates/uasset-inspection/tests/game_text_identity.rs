use std::fs;

use uasset_inspection::generic::inspect_bytes;
use uasset_inspection::projection::{
    TextIdentity, TextIdentityReason, TextLocation, project_text_asset,
};
use uasset_parser::asset::{AssetDecodeContext, decode_export};
use uasset_parser::package::Package;

#[test]
fn compiled_identity_literals_match_real_ue57_and_ue58_saves() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/unreal-project");
    for (version, relative) in [
        (
            "5.7",
            "Content/Fixture/GameTextActions/Slice2/BP_IdentityLiterals.uasset",
        ),
        (
            "5.8",
            "FixtureExpected/game-text-actions/ue5.8-saved/BP_IdentityLiterals.uasset",
        ),
    ] {
        let bytes = fs::read(root.join(relative)).expect("saved identity Blueprint");
        let inspection = inspect_bytes(relative, &bytes).unwrap();
        assert_eq!(
            inspection.status, "ok",
            "UE {version}: {:?}",
            inspection.decode_errors
        );
        let package = Package::parse(&bytes).unwrap();
        let context = AssetDecodeContext {
            property_filter: None,
            source: &bytes,
            package: &package,
            schemas: uasset_parser::schema::embedded_source_model(),
        };
        let occurrences: Vec<_> = package
            .exports
            .iter()
            .filter_map(|export| decode_export(export, &context).unwrap())
            .flat_map(|asset| project_text_asset(&package, &asset).occurrences)
            .filter(|text| {
                matches!(&text.location, TextLocation::AssetProperty { property_path, .. }
                if property_path.starts_with("ScriptBytecode"))
            })
            .collect();
        let lamp = occurrences
            .iter()
            .find(|text| text.source == "Lamp lit")
            .expect("typed literal");
        assert!(matches!(lamp.identity, TextIdentity::Resolved { .. }));
        assert_eq!(
            lamp.dev_notes,
            if version == "5.8" {
                "A lit lantern, not a command"
            } else {
                ""
            }
        );
        assert!(
            occurrences.iter().any(|text| text.source == "v1.0"
                && matches!(
                    text.identity,
                    TextIdentity::Unresolved {
                        reason: TextIdentityReason::CultureInvariant
                    }
                )),
            "UE {version}: invariant literal"
        );
        assert!(
            occurrences.iter().any(|text| matches!(&text.identity,
                TextIdentity::StringTable { key, .. } if key == "Farewell"
            )),
            "UE {version}: String Table literal"
        );
    }
}
