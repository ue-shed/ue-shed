//! Saved text wire models and pure conversions from portable text evidence.

use serde::{Deserialize, Serialize};

use crate::projection::{TextEditCapability, TextIdentity, TextIdentityReason, TextLocation};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextOccurrence {
    pub source: String,
    #[serde(default)]
    pub dev_notes: String,
    pub identity: TextExtractionIdentity,
    pub location: TextExtractionLocation,
    pub edit_capability: EditCapability,
    /// uasset-io v1.11 package text records: Unreal's editor-only bit for this text from the
    /// package's gather table, when the table was read and lists the text's namespace, key and
    /// source. Absent means no gather-table evidence, not runtime text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gather_editor_only: Option<bool>,
}

impl SavedAssetTextOccurrence {
    /// Records the gather table's editor-only bit for keyed text the table lists.
    pub fn record_gather_audience(
        &mut self,
        audience: &crate::gather_coverage::GatherSiteAudience,
    ) {
        if let TextExtractionIdentity::Resolved { namespace, key } = &self.identity {
            self.gather_editor_only = audience.editor_only(
                namespace,
                key,
                &self.source,
                matches!(
                    self.location,
                    TextExtractionLocation::StringTableEntry { .. }
                ),
            );
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum TextExtractionIdentity {
    #[serde(rename = "resolved")]
    Resolved { namespace: String, key: String },
    #[serde(rename = "string_table")]
    StringTable { table_id: String, key: String },
    #[serde(rename = "unresolved")]
    Unresolved { reason: TextUnresolvedReason },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextUnresolvedReason {
    CultureInvariant,
    MissingKey,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum TextExtractionLocation {
    #[serde(rename = "data_table_cell")]
    DataTableCell {
        object_path: String,
        row: String,
        property_path: String,
    },
    #[serde(rename = "string_table_entry")]
    StringTableEntry {
        object_path: String,
        entry_key: String,
    },
    #[serde(rename = "asset_property")]
    AssetProperty {
        object_path: String,
        class_path: String,
        property_path: String,
    },
    /// Text `unreal-code` found in the project's code: a C++ macro, an INI entry or a String
    /// Table CSV row. `file` is the path the gather manifest names; a CSV row has no line.
    #[serde(rename = "code_place")]
    CodePlace {
        file: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        macro_name: String,
        /// The `#define` wrapper the macro was expanded from.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wrapper: Option<String>,
        /// The String Table ID a `LOCTABLE_*` entry belongs to. Such an entry has no wrapper.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        table: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditCapability {
    SourceEditable,
    ReadOnly,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextCoverageGap {
    /// v1.18: absent from older producers; unknown must be treated as text-capable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub may_contain_text: Option<bool>,
    pub object_path: String,
    pub property_path: String,
    pub reason: TextCoverageGapReason,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextCoverageGapReason {
    UnsupportedTextHistory,
    LegacyContainerElementWithoutTypeInformation,
    FeatureUnavailableForEngineVersion,
    PropertyDecoderRejected,
}

pub use crate::gather_coverage::MAX_MISSING_GATHERABLE_TEXT_SAMPLES;

/// The package's decoded text checked against its gatherable text table.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedAssetGatherCoverage {
    pub runtime_sites: u64,
    pub missing: u64,
    pub missing_samples: Vec<SavedAssetMissingGatherableText>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetMissingGatherableText {
    pub namespace: String,
    pub key: String,
    pub source: String,
    pub site: String,
}

pub fn gather_coverage(
    coverage: crate::gather_coverage::GatherCoverage,
) -> SavedAssetGatherCoverage {
    SavedAssetGatherCoverage {
        runtime_sites: coverage.runtime_sites,
        missing: coverage.missing,
        missing_samples: coverage
            .missing_samples
            .into_iter()
            .map(|missing| SavedAssetMissingGatherableText {
                namespace: missing.namespace,
                key: missing.key,
                source: missing.source,
                site: missing.site_description,
            })
            .collect(),
    }
}

pub fn text_occurrence(occurrence: crate::projection::TextOccurrence) -> SavedAssetTextOccurrence {
    SavedAssetTextOccurrence {
        source: occurrence.source,
        dev_notes: occurrence.dev_notes,
        identity: match occurrence.identity {
            TextIdentity::Resolved { namespace, key } => {
                TextExtractionIdentity::Resolved { namespace, key }
            }
            TextIdentity::StringTable { table_id, key } => {
                TextExtractionIdentity::StringTable { table_id, key }
            }
            TextIdentity::Unresolved { reason } => TextExtractionIdentity::Unresolved {
                reason: match reason {
                    TextIdentityReason::CultureInvariant => TextUnresolvedReason::CultureInvariant,
                    TextIdentityReason::MissingKey => TextUnresolvedReason::MissingKey,
                },
            },
        },
        location: match occurrence.location {
            TextLocation::DataTableCell {
                object_path,
                row,
                property_path,
            } => TextExtractionLocation::DataTableCell {
                object_path,
                row,
                property_path,
            },
            TextLocation::StringTableEntry {
                object_path,
                entry_key,
            } => TextExtractionLocation::StringTableEntry {
                object_path,
                entry_key,
            },
            TextLocation::AssetProperty {
                object_path,
                class_path,
                property_path,
            } => TextExtractionLocation::AssetProperty {
                object_path,
                class_path,
                property_path,
            },
        },
        edit_capability: match occurrence.edit_capability {
            TextEditCapability::SourceEditable => EditCapability::SourceEditable,
            TextEditCapability::ReadOnly => EditCapability::ReadOnly,
        },
        gather_editor_only: None,
    }
}

pub fn text_coverage_gap(gap: crate::projection::TextCoverageGap) -> SavedAssetTextCoverageGap {
    SavedAssetTextCoverageGap {
        may_contain_text: Some(gap.may_contain_text),
        object_path: gap.object_path,
        property_path: gap.property_path,
        reason: match gap.reason {
            crate::projection::TextCoverageGapReason::UnsupportedTextHistory => {
                TextCoverageGapReason::UnsupportedTextHistory
            }
            crate::projection::TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation => {
                TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation
            }
            crate::projection::TextCoverageGapReason::FeatureUnavailableForEngineVersion => {
                TextCoverageGapReason::FeatureUnavailableForEngineVersion
            }
            crate::projection::TextCoverageGapReason::PropertyDecoderRejected => {
                TextCoverageGapReason::PropertyDecoderRejected
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projection::{TextCoverageGap, TextOccurrence};

    #[test]
    fn coverage_gap_reasons_round_trip_without_collapsing_legacy_failures() {
        use crate::projection::TextCoverageGapReason as Reason;
        for (reason, expected) in [
            (Reason::UnsupportedTextHistory, "unsupported_text_history"),
            (
                Reason::LegacyContainerElementWithoutTypeInformation,
                "legacy_container_element_without_type_information",
            ),
            (
                Reason::FeatureUnavailableForEngineVersion,
                "feature_unavailable_for_engine_version",
            ),
            (Reason::PropertyDecoderRejected, "property_decoder_rejected"),
        ] {
            let gap = text_coverage_gap(TextCoverageGap {
                may_contain_text: true,
                object_path: "/Game/Fixture/Example.Example".into(),
                property_path: "Values".into(),
                reason,
            });
            let json = serde_json::to_value(&gap).unwrap();
            assert_eq!(json["reason"], expected);
            assert_eq!(
                serde_json::from_value::<SavedAssetTextCoverageGap>(json).unwrap(),
                gap
            );
        }
        assert!(
            serde_json::from_str::<TextCoverageGapReason>("\"legacy_struct_width_guessed\"")
                .is_err()
        );
    }

    #[test]
    fn text_wire_json_preserves_all_variants_and_field_order() {
        let cases = [
            (
                TextIdentity::Resolved {
                    namespace: "Game".to_owned(),
                    key: "Greeting".to_owned(),
                },
                TextLocation::DataTableCell {
                    object_path: "/Game/Fixture/DT.DT".to_owned(),
                    row: "Greeting".to_owned(),
                    property_path: "Text".to_owned(),
                },
                TextEditCapability::SourceEditable,
                concat!(
                    r#"{"source":"Hello","dev_notes":"Note","identity":{"status":"resolved","#,
                    r#""namespace":"Game","key":"Greeting"},"location":{"kind":"data_table_cell","#,
                    r#""object_path":"/Game/Fixture/DT.DT","row":"Greeting","property_path":"Text"},"#,
                    r#""edit_capability":"source_editable"}"#
                ),
            ),
            (
                TextIdentity::StringTable {
                    table_id: "Game".to_owned(),
                    key: "Greeting".to_owned(),
                },
                TextLocation::StringTableEntry {
                    object_path: "/Game/Fixture/ST.ST".to_owned(),
                    entry_key: "Greeting".to_owned(),
                },
                TextEditCapability::SourceEditable,
                concat!(
                    r#"{"source":"Hello","dev_notes":"Note","identity":{"status":"string_table","#,
                    r#""table_id":"Game","key":"Greeting"},"location":{"kind":"string_table_entry","#,
                    r#""object_path":"/Game/Fixture/ST.ST","entry_key":"Greeting"},"#,
                    r#""edit_capability":"source_editable"}"#
                ),
            ),
            (
                TextIdentity::Unresolved {
                    reason: TextIdentityReason::CultureInvariant,
                },
                TextLocation::AssetProperty {
                    object_path: "/Game/Fixture/DA.DA".to_owned(),
                    class_path: "/Script/Engine.DataAsset".to_owned(),
                    property_path: "Text".to_owned(),
                },
                TextEditCapability::ReadOnly,
                concat!(
                    r#"{"source":"Hello","dev_notes":"Note","identity":{"status":"unresolved","#,
                    r#""reason":"culture_invariant"},"location":{"kind":"asset_property","#,
                    r#""object_path":"/Game/Fixture/DA.DA","class_path":"/Script/Engine.DataAsset","#,
                    r#""property_path":"Text"},"edit_capability":"read_only"}"#
                ),
            ),
            (
                TextIdentity::Unresolved {
                    reason: TextIdentityReason::MissingKey,
                },
                TextLocation::StringTableEntry {
                    object_path: "/Game/Fixture/ST.ST".to_owned(),
                    entry_key: String::new(),
                },
                TextEditCapability::ReadOnly,
                concat!(
                    r#"{"source":"Hello","dev_notes":"Note","identity":{"status":"unresolved","#,
                    r#""reason":"missing_key"},"location":{"kind":"string_table_entry","#,
                    r#""object_path":"/Game/Fixture/ST.ST","entry_key":""},"#,
                    r#""edit_capability":"read_only"}"#
                ),
            ),
        ];
        for (identity, location, edit_capability, expected) in cases {
            let wire = text_occurrence(TextOccurrence {
                source: "Hello".to_owned(),
                dev_notes: "Note".to_owned(),
                identity,
                location,
                edit_capability,
            });
            assert_eq!(serde_json::to_string(&wire).expect("text JSON"), expected);
            assert_eq!(
                serde_json::from_str::<SavedAssetTextOccurrence>(expected).expect("text wire"),
                wire
            );
        }

        let gap = text_coverage_gap(TextCoverageGap {
            may_contain_text: true,
            object_path: "/Game/Fixture/DA.DA".to_owned(),
            property_path: "Text".to_owned(),
            reason: crate::projection::TextCoverageGapReason::UnsupportedTextHistory,
        });
        assert_eq!(
            serde_json::to_string(&gap).expect("coverage gap JSON"),
            concat!(
                r#"{"may_contain_text":true,"object_path":"/Game/Fixture/DA.DA","property_path":"Text","#,
                r#""reason":"unsupported_text_history"}"#
            )
        );
    }

    #[test]
    fn missing_dev_notes_still_deserialize_and_serialize_as_an_empty_string() {
        let wire: SavedAssetTextOccurrence = serde_json::from_str(concat!(
            r#"{"source":"Hello","identity":{"status":"unresolved","reason":"missing_key"},"#,
            r#""location":{"kind":"string_table_entry","object_path":"ST","entry_key":""},"#,
            r#""edit_capability":"read_only"}"#
        ))
        .expect("text without notes");
        assert_eq!(
            serde_json::to_string(&wire).expect("text JSON"),
            concat!(
                r#"{"source":"Hello","dev_notes":"","identity":{"status":"unresolved","#,
                r#""reason":"missing_key"},"location":{"kind":"string_table_entry","#,
                r#""object_path":"ST","entry_key":""},"edit_capability":"read_only"}"#
            )
        );
    }
}
