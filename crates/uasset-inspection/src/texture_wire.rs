//! Saved texture wire models and pure conversions from portable texture evidence.

use serde::{Deserialize, Serialize};

use crate::projection::{Evidence, EvidenceSource, EvidenceUnavailableReason, TextureRecord};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedAssetTextureRecord {
    pub object_path: String,
    pub package_file_bytes: TextureEvidence<u64>,
    pub dimensions: TextureEvidence<TextureDimensions>,
    pub source_format: TextureEvidence<String>,
    pub source_mips: TextureEvidence<u64>,
    pub compression: TextureEvidence<String>,
    pub s_rgb: TextureEvidence<bool>,
    pub texture_group: TextureEvidence<String>,
    pub mip_generation: TextureEvidence<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum TextureEvidence<T> {
    #[serde(rename = "available")]
    Available {
        source: TextureEvidenceSource,
        value: T,
    },
    #[serde(rename = "unavailable")]
    Unavailable { reason: TextureUnavailableReason },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TextureEvidenceSource {
    Serialized,
    File,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TextureUnavailableReason {
    NotSerialized,
    WrongValueKind,
    MissingSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TextureDimensions {
    pub width: u64,
    pub height: u64,
}

pub fn texture_record(record: TextureRecord) -> SavedAssetTextureRecord {
    SavedAssetTextureRecord {
        object_path: record.object_path,
        package_file_bytes: texture_evidence(record.package_file_bytes),
        dimensions: texture_evidence(record.dimensions),
        source_format: texture_evidence(record.source_format),
        source_mips: texture_evidence(record.source_mips),
        compression: texture_evidence(record.compression),
        s_rgb: texture_evidence(record.s_rgb),
        texture_group: texture_evidence(record.texture_group),
        mip_generation: texture_evidence(record.mip_generation),
    }
}

fn texture_evidence<T>(value: Evidence<T>) -> TextureEvidence<T::Wire>
where
    T: TextureWire,
{
    match value {
        Evidence::Available { source, value } => TextureEvidence::Available {
            source: match source {
                EvidenceSource::Serialized => TextureEvidenceSource::Serialized,
                EvidenceSource::File => TextureEvidenceSource::File,
            },
            value: value.into_wire(),
        },
        Evidence::Unavailable { reason } => TextureEvidence::Unavailable {
            reason: match reason {
                EvidenceUnavailableReason::NotSerialized => TextureUnavailableReason::NotSerialized,
                EvidenceUnavailableReason::WrongValueKind => {
                    TextureUnavailableReason::WrongValueKind
                }
                EvidenceUnavailableReason::MissingSource => TextureUnavailableReason::MissingSource,
            },
        },
    }
}

trait TextureWire {
    type Wire;

    fn into_wire(self) -> Self::Wire;
}

impl TextureWire for u64 {
    type Wire = u64;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for String {
    type Wire = String;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for bool {
    type Wire = bool;

    fn into_wire(self) -> Self::Wire {
        self
    }
}

impl TextureWire for crate::projection::TextureDimensions {
    type Wire = TextureDimensions;

    fn into_wire(self) -> Self::Wire {
        TextureDimensions {
            width: self.width,
            height: self.height,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texture_wire_json_preserves_all_evidence_variants_and_field_order() {
        let wire = texture_record(TextureRecord {
            object_path: "/Game/Fixture/T.T".to_owned(),
            package_file_bytes: Evidence::Available {
                source: EvidenceSource::File,
                value: 4096,
            },
            dimensions: Evidence::Available {
                source: EvidenceSource::Serialized,
                value: crate::projection::TextureDimensions {
                    width: 300,
                    height: 180,
                },
            },
            source_format: Evidence::Available {
                source: EvidenceSource::Serialized,
                value: "TSF_BGRA8".to_owned(),
            },
            source_mips: Evidence::Unavailable {
                reason: EvidenceUnavailableReason::NotSerialized,
            },
            compression: Evidence::Unavailable {
                reason: EvidenceUnavailableReason::WrongValueKind,
            },
            s_rgb: Evidence::Available {
                source: EvidenceSource::Serialized,
                value: false,
            },
            texture_group: Evidence::Unavailable {
                reason: EvidenceUnavailableReason::MissingSource,
            },
            mip_generation: Evidence::Available {
                source: EvidenceSource::Serialized,
                value: "TMGS_FromTextureGroup".to_owned(),
            },
        });
        let expected = concat!(
            r#"{"object_path":"/Game/Fixture/T.T","package_file_bytes":{"status":"available","#,
            r#""source":"file","value":4096},"dimensions":{"status":"available","#,
            r#""source":"serialized","value":{"width":300,"height":180}},"#,
            r#""source_format":{"status":"available","source":"serialized","value":"TSF_BGRA8"},"#,
            r#""source_mips":{"status":"unavailable","reason":"not_serialized"},"#,
            r#""compression":{"status":"unavailable","reason":"wrong_value_kind"},"#,
            r#""s_rgb":{"status":"available","source":"serialized","value":false},"#,
            r#""texture_group":{"status":"unavailable","reason":"missing_source"},"#,
            r#""mip_generation":{"status":"available","source":"serialized","#,
            r#""value":"TMGS_FromTextureGroup"}}"#
        );
        assert_eq!(
            serde_json::to_string(&wire).expect("texture JSON"),
            expected
        );
        assert_eq!(
            serde_json::from_str::<SavedAssetTextureRecord>(expected).expect("texture wire"),
            wire
        );
    }
}
