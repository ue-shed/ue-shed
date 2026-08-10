//! Compact domain projections over decoded saved-package assets.
//!
//! These types deliberately sit beside generic inspection rather than reusing its serialized DTOs.
//! Native and WebAssembly adapters can therefore derive the same small, versioned facts without
//! materializing every property value for consumers that only need text or texture evidence.

use serde::Serialize;

use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, CURVETABLE_CLASS, DecodedAsset, DecodedUObject, SKELETON_CLASS,
    USERDEFINEDSTRUCT_CLASS,
};
use uasset_parser::package::Package;
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyValue, TextHistory, TextValue,
};

/// Exact serialized class path used by `UTexture2D` exports.
pub const TEXTURE2D_CLASS: &str = "/Script/Engine.Texture2D";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextAssetProjection {
    pub occurrences: Vec<TextOccurrence>,
    pub coverage_gaps: Vec<TextCoverageGap>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TextOccurrence {
    pub source: String,
    pub identity: TextIdentity,
    pub location: TextLocation,
    pub edit_capability: TextEditCapability,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TextIdentity {
    Resolved { namespace: String, key: String },
    Unresolved { reason: TextIdentityReason },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextIdentityReason {
    CultureInvariant,
    MissingKey,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextLocation {
    DataTableCell {
        object_path: String,
        row: String,
        property_path: String,
    },
    StringTableEntry {
        object_path: String,
        entry_key: String,
    },
    AssetProperty {
        object_path: String,
        class_path: String,
        property_path: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextEditCapability {
    SourceEditable,
    ReadOnly,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TextCoverageGap {
    pub object_path: String,
    pub property_path: String,
    pub reason: TextCoverageGapReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextCoverageGapReason {
    UnsupportedTextHistory,
}

/// Projects one decoded export into player-facing text facts and explicit coverage gaps.
///
/// `DecodedAsset` remains the parser's rich internal model. This projection never serializes
/// unrelated properties, rows, exports, raw payloads, or package implementation details.
#[must_use]
pub fn project_text_asset(package: &Package, asset: &DecodedAsset) -> TextAssetProjection {
    let mut output = TextAssetProjection {
        occurrences: Vec::new(),
        coverage_gaps: Vec::new(),
    };
    match asset {
        DecodedAsset::StringTable(table) => {
            for entry in &table.entries {
                output.occurrences.push(TextOccurrence {
                    source: entry.source.clone(),
                    identity: identity_for_string_table(&table.namespace, &entry.key),
                    location: TextLocation::StringTableEntry {
                        object_path: table.object_path.to_string(),
                        entry_key: entry.key.clone(),
                    },
                    edit_capability: TextEditCapability::SourceEditable,
                });
            }
        }
        DecodedAsset::DataTable(table) => {
            for row in &table.rows {
                let row_name = resolve_name(package, row.name);
                visit_text_stream(
                    package,
                    &row.properties,
                    "",
                    &|property_path| TextLocation::DataTableCell {
                        object_path: table.object_path.to_string(),
                        row: row_name.clone(),
                        property_path: property_path.to_owned(),
                    },
                    TextEditCapability::SourceEditable,
                    &mut output,
                );
            }
        }
        DecodedAsset::DataAsset(data_asset) => visit_text_stream(
            package,
            &data_asset.properties,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: data_asset.object_path.to_string(),
                class_path: data_asset.class_path.to_string(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::UObject(object) => visit_text_stream(
            package,
            &object.properties,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: object.object_path.to_string(),
                class_path: object.class_path.to_string(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::AnimSequence(sequence) => visit_text_stream(
            package,
            &sequence.properties,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: sequence.object_path.to_string(),
                class_path: ANIM_SEQUENCE_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::CurveTable(table) => visit_text_stream(
            package,
            &table.properties,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: table.object_path.to_string(),
                class_path: CURVETABLE_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::Skeleton(skeleton) => visit_text_stream(
            package,
            &skeleton.properties,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: skeleton.object_path.to_string(),
                class_path: SKELETON_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::Struct(decoded_struct) => visit_text_stream(
            package,
            &decoded_struct.default_values,
            "",
            &|property_path| TextLocation::AssetProperty {
                object_path: decoded_struct.object_path.to_string(),
                class_path: USERDEFINEDSTRUCT_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::Enum(_) => {}
    }
    output
}

fn identity_for_string_table(namespace: &str, key: &str) -> TextIdentity {
    if key.is_empty() {
        TextIdentity::Unresolved {
            reason: TextIdentityReason::MissingKey,
        }
    } else {
        TextIdentity::Resolved {
            namespace: namespace.to_owned(),
            key: key.to_owned(),
        }
    }
}

fn visit_text_stream<F>(
    package: &Package,
    stream: &PropertyStream,
    prefix: &str,
    location: &F,
    edit_capability: TextEditCapability,
    output: &mut TextAssetProjection,
) where
    F: Fn(&str) -> TextLocation,
{
    for property in &stream.records {
        let property_path = append_property_path(prefix, &resolve_name(package, property.name));
        if property_type_is_text(package, property)
            && matches!(property.value, PropertyValue::Raw { .. })
        {
            output.coverage_gaps.push(TextCoverageGap {
                object_path: location(&property_path).object_path().to_owned(),
                property_path: property_path.clone(),
                reason: TextCoverageGapReason::UnsupportedTextHistory,
            });
        }
        visit_text_value(
            package,
            &property.value,
            &property_path,
            location,
            edit_capability,
            output,
        );
    }
}

fn visit_text_value<F>(
    package: &Package,
    value: &PropertyValue,
    path: &str,
    location: &F,
    edit_capability: TextEditCapability,
    output: &mut TextAssetProjection,
) where
    F: Fn(&str) -> TextLocation,
{
    match value {
        PropertyValue::Text(text) => output.occurrences.push(TextOccurrence {
            source: text.source.clone(),
            identity: identity_for_text(text),
            location: location(path),
            edit_capability,
        }),
        PropertyValue::Array(values) | PropertyValue::Set(values) => {
            for (index, value) in values.iter().enumerate() {
                visit_text_value(
                    package,
                    value,
                    &format!("{path}[{index}]"),
                    location,
                    edit_capability,
                    output,
                );
            }
        }
        PropertyValue::Map(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                visit_text_value(
                    package,
                    &entry.key,
                    &format!("{path}{{{index}}}.key"),
                    location,
                    edit_capability,
                    output,
                );
                visit_text_value(
                    package,
                    &entry.value,
                    &format!("{path}{{{index}}}.value"),
                    location,
                    edit_capability,
                    output,
                );
            }
        }
        PropertyValue::Struct(stream) => {
            visit_text_stream(package, stream, path, location, edit_capability, output)
        }
        _ => {}
    }
}

fn identity_for_text(text: &TextValue) -> TextIdentity {
    match &text.history {
        TextHistory::None => TextIdentity::Unresolved {
            reason: TextIdentityReason::CultureInvariant,
        },
        TextHistory::Base { namespace, key } if key.is_empty() => TextIdentity::Unresolved {
            reason: TextIdentityReason::MissingKey,
        },
        TextHistory::Base { namespace, key } => TextIdentity::Resolved {
            namespace: namespace.clone(),
            key: key.clone(),
        },
    }
}

fn property_type_is_text(package: &Package, property: &PropertyRecord) -> bool {
    package
        .resolve_name_str(property.type_name.name)
        .is_some_and(|type_name| type_name == "TextProperty")
}

fn append_property_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_owned()
    } else {
        format!("{prefix}.{name}")
    }
}

fn resolve_name(package: &Package, name: uasset_parser::archive::NameRef) -> String {
    package
        .resolve_name(name)
        .unwrap_or_else(|| format!("<invalid-name:{}>", name.index().get()))
}

impl TextLocation {
    fn object_path(&self) -> &str {
        match self {
            Self::DataTableCell { object_path, .. }
            | Self::StringTableEntry { object_path, .. }
            | Self::AssetProperty { object_path, .. } => object_path,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextureRecord {
    pub object_path: String,
    pub package_file_bytes: Evidence<u64>,
    pub dimensions: Evidence<TextureDimensions>,
    pub source_format: Evidence<String>,
    pub source_mips: Evidence<u64>,
    pub compression: Evidence<String>,
    pub s_rgb: Evidence<bool>,
    pub texture_group: Evidence<String>,
    pub mip_generation: Evidence<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TextureDimensions {
    pub width: u64,
    pub height: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Evidence<T> {
    Available { source: EvidenceSource, value: T },
    Unavailable { reason: EvidenceUnavailableReason },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSource {
    Serialized,
    File,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceUnavailableReason {
    NotSerialized,
    WrongValueKind,
    MissingSource,
}

/// Projects one decoded `Texture2D` export into facts used by Texture Audit.
///
/// A non-texture object returns `None`, so native callers can decode only `Texture2D` exports
/// without emitting unrelated objects from the same package.
#[must_use]
pub fn project_texture_asset(
    package: &Package,
    asset: &DecodedAsset,
    package_file_bytes: u64,
) -> Option<TextureRecord> {
    let DecodedAsset::UObject(object) = asset else {
        return None;
    };
    if object.class_path.as_str() != TEXTURE2D_CLASS {
        return None;
    }
    Some(texture_record_from_object(
        package,
        object,
        package_file_bytes,
    ))
}

fn texture_record_from_object(
    package: &Package,
    object: &DecodedUObject,
    package_file_bytes: u64,
) -> TextureRecord {
    let width = source_integer(package, &object.properties, "SizeX");
    let height = source_integer(package, &object.properties, "SizeY");
    let source = source_properties(package, &object.properties);
    TextureRecord {
        object_path: object.object_path.to_string(),
        package_file_bytes: Evidence::Available {
            source: EvidenceSource::File,
            value: package_file_bytes,
        },
        dimensions: match (&width, &height) {
            (
                Evidence::Available { value: width, .. },
                Evidence::Available { value: height, .. },
            ) => Evidence::Available {
                source: EvidenceSource::Serialized,
                value: TextureDimensions {
                    width: *width,
                    height: *height,
                },
            },
            (Evidence::Unavailable { reason, .. }, _) => Evidence::Unavailable { reason: *reason },
            (_, Evidence::Unavailable { reason, .. }) => Evidence::Unavailable { reason: *reason },
        },
        source_format: source.map_or_else(
            || Evidence::Unavailable {
                reason: EvidenceUnavailableReason::MissingSource,
            },
            |source| serialized_string(package, source, "Format"),
        ),
        source_mips: source_integer(package, &object.properties, "NumMips"),
        compression: serialized_string(package, &object.properties, "CompressionSettings"),
        s_rgb: serialized_boolean(package, &object.properties, "SRGB"),
        texture_group: serialized_string(package, &object.properties, "LODGroup"),
        mip_generation: serialized_string(package, &object.properties, "MipGenSettings"),
    }
}

fn source_properties<'a>(
    package: &'a Package,
    properties: &'a PropertyStream,
) -> Option<&'a PropertyStream> {
    match root_property(package, properties, "Source")?.value {
        PropertyValue::Struct(ref source) => Some(source),
        _ => None,
    }
}

fn source_integer(package: &Package, properties: &PropertyStream, name: &str) -> Evidence<u64> {
    let Some(source) = source_properties(package, properties) else {
        return Evidence::Unavailable {
            reason: EvidenceUnavailableReason::MissingSource,
        };
    };
    serialized_integer(package, source, name)
}

fn serialized_integer(package: &Package, properties: &PropertyStream, name: &str) -> Evidence<u64> {
    let Some(property) = root_property(package, properties, name) else {
        return Evidence::Unavailable {
            reason: EvidenceUnavailableReason::NotSerialized,
        };
    };
    match property.value {
        PropertyValue::Int(value) if value >= 0 => Evidence::Available {
            source: EvidenceSource::Serialized,
            value: value as u64,
        },
        _ => Evidence::Unavailable {
            reason: EvidenceUnavailableReason::WrongValueKind,
        },
    }
}

fn serialized_string(
    package: &Package,
    properties: &PropertyStream,
    name: &str,
) -> Evidence<String> {
    let Some(property) = root_property(package, properties, name) else {
        return Evidence::Unavailable {
            reason: EvidenceUnavailableReason::NotSerialized,
        };
    };
    match property.value {
        PropertyValue::Name(value) | PropertyValue::Enum(value) => Evidence::Available {
            source: EvidenceSource::Serialized,
            value: resolve_name(package, value),
        },
        _ => Evidence::Unavailable {
            reason: EvidenceUnavailableReason::WrongValueKind,
        },
    }
}

fn serialized_boolean(
    package: &Package,
    properties: &PropertyStream,
    name: &str,
) -> Evidence<bool> {
    let Some(property) = root_property(package, properties, name) else {
        return Evidence::Unavailable {
            reason: EvidenceUnavailableReason::NotSerialized,
        };
    };
    match property.value {
        PropertyValue::Bool(value) => Evidence::Available {
            source: EvidenceSource::Serialized,
            value,
        },
        _ => Evidence::Unavailable {
            reason: EvidenceUnavailableReason::WrongValueKind,
        },
    }
}

fn root_property<'a>(
    package: &Package,
    properties: &'a PropertyStream,
    name: &str,
) -> Option<&'a PropertyRecord> {
    properties
        .records
        .iter()
        .find(|property| package.resolve_name_str(property.name) == Some(name))
}
