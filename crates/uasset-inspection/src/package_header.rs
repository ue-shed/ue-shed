//! Portable saved-header evidence; no payload decode or filesystem authority.
use serde::{Deserialize, Serialize};
use uasset_parser::package::Package;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageHeaderData {
    pub package_flags: u32,
    pub gatherable_text_data_count: u32,
    pub gatherable_text_data_offset: u64,
    /// Probe the complete name map, rather than the bounded Project Index name sample.
    pub has_text_property: bool,
}

impl PackageHeaderData {
    #[must_use]
    pub fn from_package(package: &Package) -> Self {
        let table = package.summary.gatherable_text_data;
        Self {
            package_flags: package.summary.versions.package_flags.bits(),
            gatherable_text_data_count: table.map_or(0, |table| table.count),
            gatherable_text_data_offset: table.map_or(0, |table| table.offset.get()),
            has_text_property: package.names.iter().any(|name| name == "TextProperty"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_summary_evidence_covers_legacy_and_current_packages() {
        for bytes in [
            include_bytes!("../../../fixtures/legacy-unreal-project/Generated/4.27/Content/Legacy/ST_LegacyText.uasset").as_slice(),
            include_bytes!("../../../fixtures/legacy-unreal-project/Generated/5.3/Content/Legacy/ST_LegacyText.uasset").as_slice(),
            include_bytes!("../../../fixtures/unreal-project/Content/Fixture/Text/ST_Game.uasset").as_slice(),
        ] {
            let package = Package::parse(bytes).unwrap();
            let data = PackageHeaderData::from_package(&package);
            assert!(!data.has_text_property);
            assert!(data.gatherable_text_data_count > 0);
            assert!(data.gatherable_text_data_offset > 0);
            assert_eq!(data.package_flags, package.summary.versions.package_flags.bits());
        }
    }
}
