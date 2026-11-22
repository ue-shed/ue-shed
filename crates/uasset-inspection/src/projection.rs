//! Compact domain projections over decoded saved-package assets.
//!
//! These types deliberately sit beside generic inspection rather than reusing its serialized DTOs.
//! Native and WebAssembly adapters can therefore derive the same small, versioned facts without
//! materializing every property value for consumers that only need text or texture evidence.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fmt::{self, Write};

use serde::Serialize;

use uasset_parser::archive::NameRef;
use uasset_parser::asset::{
    ANIM_SEQUENCE_CLASS, CURVETABLE_CLASS, DecodedAsset, DecodedUObject, PropertyDecodeFilter,
    SKELETON_CLASS, USERDEFINEDENUM_CLASS, USERDEFINEDSTRUCT_CLASS,
};
use uasset_parser::package::Package;
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyTypeName, PropertyValue, RawReason, TextHistory,
    TextValue,
};

// Decoded properties read by text consumers, independently of whether their type holds FText.
const TEXT_PROJECTION_READ_PROPERTIES: &[&str] = &[
    "Nodes",          // project_text_asset
    "GeneratedClass", // crate::blueprint_classes::blueprint_classes
];

/// Materializes tagged properties needed by text projection and Blueprint class identity.
///
/// Blueprint graph pins keep only their `FText` fields: see
/// [`PropertyDecodeFilter::omit_non_text_pin_fields`].
pub struct TextDecodeFilter;

impl PropertyDecodeFilter for TextDecodeFilter {
    fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
        type_may_contain_text(package, &record.type_name)
            || record.struct_guid.is_some_and(|guid| !guid.is_zero())
            || is_text_projection_read_property(package, record.name)
    }

    // Reads only the record's name, type tree and struct GUID, and keeps no state.
    fn depends_only_on_record_header(&self) -> bool {
        true
    }

    // Text projection and Blueprint class identity skip `NotRequested` values entirely.
    fn omit_unrequested_records(&self) -> bool {
        true
    }

    // `decode` declines a record exactly when its type is text-free, it has no user struct GUID,
    // and its name is not read by name. A text-free top-level type is text-free whatever its
    // parameters, and only `StructProperty` tags carry struct GUIDs.
    fn may_decode_tag(&self, package: &Package, name: NameRef, top_type: NameRef) -> bool {
        !package
            .resolve_name_cow(top_type)
            .as_deref()
            .is_some_and(is_text_free_property_type)
            || is_text_projection_read_property(package, name)
    }

    // `project_text_asset` reads only `friendly_name` and `default_text_value` from pins.
    fn omit_non_text_pin_fields(&self) -> bool {
        true
    }
}

fn is_text_projection_read_property(package: &Package, name: NameRef) -> bool {
    package
        .resolve_name_str(name)
        .is_some_and(|name| TEXT_PROJECTION_READ_PROPERTIES.contains(&name))
}

/// The property path of a text literal in a compiled function's script bytecode.
pub const SCRIPT_BYTECODE_PROPERTY_PATH: &str = "ScriptBytecode";

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
    pub dev_notes: String,
    pub identity: TextIdentity,
    pub location: TextLocation,
    pub edit_capability: TextEditCapability,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TextIdentity {
    Resolved { namespace: String, key: String },
    StringTable { table_id: String, key: String },
    Unresolved { reason: TextIdentityReason },
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
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
    /// Unknown layouts remain text-capable; false requires a declared text-free type.
    pub may_contain_text: bool,
    pub object_path: String,
    pub property_path: String,
    pub reason: TextCoverageGapReason,
}

impl TextCoverageGap {
    /// Gather tables may omit editor-only graph sites; they cannot prove skipped pins complete.
    #[must_use]
    pub fn is_graph_pin_gap(&self) -> bool {
        self.may_contain_text
            && (self.property_path == "Pins" || self.property_path.starts_with("Pins["))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextCoverageGapReason {
    UnsupportedTextHistory,
    LegacyContainerElementWithoutTypeInformation,
    FeatureUnavailableForEngineVersion,
    PropertyDecoderRejected,
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
                    dev_notes: string_table_notes(
                        &entry.dev_notes,
                        table
                            .metadata
                            .get(&entry.key)
                            .and_then(|metadata| metadata.get("Comment").map(String::as_str)),
                    ),
                    identity: identity_for_string_table(&table.namespace, &entry.key),
                    location: TextLocation::StringTableEntry {
                        object_path: table.object_path.as_str().to_owned(),
                        entry_key: entry.key.clone(),
                    },
                    edit_capability: TextEditCapability::SourceEditable,
                });
            }
        }
        DecodedAsset::DataTable(table) => {
            for row in &table.rows {
                let row_name = resolve_name(package, row.name).into_owned();
                visit_text_stream(
                    package,
                    &row.properties,
                    &mut String::new(),
                    &|property_path| TextLocation::DataTableCell {
                        object_path: table.object_path.as_str().to_owned(),
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
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: data_asset.object_path.as_str().to_owned(),
                class_path: data_asset.class_path.as_str().to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::UObject(object) => {
            // If a graph's Nodes array itself was rejected, none of its pin streams can be
            // proven covered. Gather tables need not contain those editor-only occurrences.
            if object.properties.records.iter().any(|property| {
                package.resolve_name_str(property.name) == Some("Nodes")
                    && !matches!(property.value, PropertyValue::Array(_))
            }) && (object.class_path.as_str() == uasset_parser::asset::ED_GRAPH_CLASS
                || package.exports.iter().any(|export| {
                    export.object_path == object.object_path
                        && uasset_parser::asset::is_blueprint_owned_export(package, export)
                }))
            {
                output.coverage_gaps.push(TextCoverageGap {
                    may_contain_text: true,
                    object_path: object.object_path.as_str().to_owned(),
                    property_path: "Pins".to_owned(),
                    reason: TextCoverageGapReason::PropertyDecoderRejected,
                });
            }
            if package.summary.versions.uses_legacy_property_tags() && !object.tail.is_empty() {
                output.coverage_gaps.push(TextCoverageGap {
                    may_contain_text: legacy_tail_may_contain_text(package, object),
                    object_path: object.object_path.as_str().to_owned(),
                    property_path: String::new(),
                    reason: TextCoverageGapReason::FeatureUnavailableForEngineVersion,
                });
            }
            visit_text_stream(
                package,
                &object.properties,
                &mut String::new(),
                &|property_path| TextLocation::AssetProperty {
                    object_path: object.object_path.as_str().to_owned(),
                    class_path: object.class_path.as_str().to_owned(),
                    property_path: property_path.to_owned(),
                },
                TextEditCapability::ReadOnly,
                &mut output,
            );
            if let Some(native) = &object.native_data {
                visit_text_value(
                    package,
                    native,
                    TextType::default(),
                    &mut String::from("NativeData"),
                    &|property_path| TextLocation::AssetProperty {
                        object_path: object.object_path.as_str().to_owned(),
                        class_path: object.class_path.as_str().to_owned(),
                        property_path: property_path.to_owned(),
                    },
                    TextEditCapability::ReadOnly,
                    &mut output,
                );
            }
        }
        DecodedAsset::Function(function) => {
            let object = &function.object;
            visit_text_stream(
                package,
                &object.properties,
                &mut String::new(),
                &|property_path| TextLocation::AssetProperty {
                    object_path: object.object_path.as_str().to_owned(),
                    class_path: object.class_path.as_str().to_owned(),
                    property_path: property_path.to_owned(),
                },
                TextEditCapability::ReadOnly,
                &mut output,
            );
            // A compiled function's text literals. Unreal gathers each id once per function
            // (`[Script Bytecode]` sites), so a literal the compiler emitted twice is one place.
            // Distinct literals are distinct places, `ScriptBytecode[N]` in first-emission order,
            // so two keys with the same source in one function stay two occurrences.
            let mut seen = HashSet::new();
            for text in &function.script_texts {
                let literal = (identity_for_text(text), text.source.as_str());
                if seen.contains(&literal) {
                    continue;
                }
                let identity = literal.0.clone();
                let index = seen.len();
                seen.insert(literal);
                output.occurrences.push(TextOccurrence {
                    source: text.source.clone(),
                    dev_notes: text.dev_notes().unwrap_or_default().to_owned(),
                    identity,
                    location: TextLocation::AssetProperty {
                        object_path: object.object_path.as_str().to_owned(),
                        class_path: object.class_path.as_str().to_owned(),
                        property_path: format!("{SCRIPT_BYTECODE_PROPERTY_PATH}[{index}]"),
                    },
                    edit_capability: TextEditCapability::ReadOnly,
                });
            }
        }
        DecodedAsset::BlueprintGraphNode(node) => {
            if !node.tail.is_empty() {
                output.coverage_gaps.push(TextCoverageGap {
                    may_contain_text: true,
                    object_path: node.object_path.as_str().to_owned(),
                    property_path: "Pins".to_owned(),
                    reason: TextCoverageGapReason::PropertyDecoderRejected,
                });
            }
            visit_text_stream(
                package,
                &node.properties,
                &mut String::new(),
                &|property_path| TextLocation::AssetProperty {
                    object_path: node.object_path.as_str().to_owned(),
                    class_path: node.class_path.as_str().to_owned(),
                    property_path: property_path.to_owned(),
                },
                TextEditCapability::ReadOnly,
                &mut output,
            );
            for (index, pin) in node.pins.iter().enumerate() {
                let Some(pin) = pin else { continue };
                for (field, text) in [
                    ("DefaultTextValue", &pin.default_text_value),
                    ("PinFriendlyName", &pin.friendly_name),
                ] {
                    // Every pin stores an empty FText, even when its type is not text.
                    if (matches!(text.history, TextHistory::None) && text.source.is_empty())
                        || is_formatted(text)
                    {
                        continue;
                    }
                    output.occurrences.push(TextOccurrence {
                        source: text.source.clone(),
                        dev_notes: text.dev_notes().unwrap_or_default().to_owned(),
                        identity: identity_for_text(text),
                        location: TextLocation::AssetProperty {
                            object_path: node.object_path.as_str().to_owned(),
                            class_path: node.class_path.as_str().to_owned(),
                            property_path: format!("Pins[{index}].{field}"),
                        },
                        edit_capability: TextEditCapability::ReadOnly,
                    });
                }
            }
        }
        DecodedAsset::AnimSequence(sequence) => visit_text_stream(
            package,
            &sequence.properties,
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: sequence.object_path.as_str().to_owned(),
                class_path: ANIM_SEQUENCE_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::CurveTable(table) => visit_text_stream(
            package,
            &table.properties,
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: table.object_path.as_str().to_owned(),
                class_path: CURVETABLE_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::Skeleton(skeleton) => visit_text_stream(
            package,
            &skeleton.properties,
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: skeleton.object_path.as_str().to_owned(),
                class_path: SKELETON_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        DecodedAsset::Struct(decoded_struct) => visit_text_stream(
            package,
            &decoded_struct.default_values,
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: decoded_struct.object_path.as_str().to_owned(),
                class_path: USERDEFINEDSTRUCT_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
        // DisplayNameMap (`TMap<FName, FText>`) carries the entries' player-facing names.
        DecodedAsset::Enum(decoded_enum) => visit_text_stream(
            package,
            &decoded_enum.properties,
            &mut String::new(),
            &|property_path| TextLocation::AssetProperty {
                object_path: decoded_enum.object_path.as_str().to_owned(),
                class_path: USERDEFINEDENUM_CLASS.to_owned(),
                property_path: property_path.to_owned(),
            },
            TextEditCapability::ReadOnly,
            &mut output,
        ),
    }
    output
}

fn string_table_notes(dev_notes: &str, comment: Option<&str>) -> String {
    let notes = (!dev_notes.trim().is_empty()).then_some(dev_notes);
    let comment = comment.filter(|value| !value.trim().is_empty());
    match (notes, comment) {
        (Some(notes), Some(comment)) if notes != comment => format!("{notes}\n\n{comment}"),
        (Some(notes), _) => notes.to_owned(),
        (None, Some(comment)) => comment.to_owned(),
        (None, None) => String::new(),
    }
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

/// Visits a property stream whose owner's path is in `path`. Each property appends its segment
/// to the shared buffer and truncates it again, so nested values allocate no intermediate paths.
fn visit_text_stream<F>(
    package: &Package,
    stream: &PropertyStream,
    path: &mut String,
    location: &F,
    edit_capability: TextEditCapability,
    output: &mut TextAssetProjection,
) where
    F: Fn(&str) -> TextLocation,
{
    let prefix_len = path.len();
    for property in &stream.records {
        if !may_hold_text_facts(&property.value) {
            continue;
        }
        push_property_segment(path, &resolve_name(package, property.name));
        if property_type_is_text(package, property)
            && matches!(
                &property.value,
                PropertyValue::Raw { reason } if matches!(reason, RawReason::UnsupportedType)
            )
        {
            output.coverage_gaps.push(TextCoverageGap {
                may_contain_text: true,
                object_path: location(path).object_path().to_owned(),
                property_path: path.clone(),
                reason: TextCoverageGapReason::UnsupportedTextHistory,
            });
        }
        visit_text_value(
            package,
            &property.value,
            TextType {
                name: Some(&property.type_name),
                user_defined: property.struct_guid.is_some_and(|guid| !guid.is_zero()),
            },
            path,
            location,
            edit_capability,
            output,
        );
        path.truncate(prefix_len);
    }
}

/// Whether visiting `value` can record an occurrence or coverage gap. Skip scalar leaves,
/// omitted values and empty containers before constructing their property paths.
fn may_hold_text_facts(value: &PropertyValue) -> bool {
    match value {
        PropertyValue::Raw {
            reason: RawReason::NotRequested,
        } => false,
        PropertyValue::Text(_) | PropertyValue::Raw { .. } => true,
        PropertyValue::Array(values) | PropertyValue::Set(values) => !values.is_empty(),
        PropertyValue::Map(entries) => !entries.is_empty(),
        PropertyValue::Struct(stream) => !stream.records.is_empty(),
        PropertyValue::NativeStruct { fields } => !fields.is_empty(),
        PropertyValue::InstancedStruct(instance) => instance
            .value
            .as_ref()
            .is_some_and(|value| may_hold_text_facts(value)),
        PropertyValue::Bool(_)
        | PropertyValue::Float(_)
        | PropertyValue::Double(_)
        | PropertyValue::Int(_)
        | PropertyValue::UInt(_)
        | PropertyValue::Name(_)
        | PropertyValue::Enum(_)
        | PropertyValue::String(_)
        | PropertyValue::Vector(_)
        | PropertyValue::IntPoint(_)
        | PropertyValue::Rotator(_)
        | PropertyValue::Color(_)
        | PropertyValue::LinearColor(_)
        | PropertyValue::DataTableRowHandle(_)
        | PropertyValue::DateTime(_)
        | PropertyValue::FrameRange(_)
        | PropertyValue::ObjectRef(_)
        | PropertyValue::Guid(_)
        | PropertyValue::SoftObjectPath(_) => false,
    }
}

#[derive(Clone, Copy, Default)]
struct TextType<'a> {
    name: Option<&'a PropertyTypeName>,
    user_defined: bool,
}

impl<'a> TextType<'a> {
    fn element(self, index: usize) -> Self {
        Self {
            name: self.name.and_then(|ty| ty.parameters.get(index)),
            user_defined: self.user_defined,
        }
    }
}

fn visit_text_value<F>(
    package: &Package,
    value: &PropertyValue,
    type_info: TextType<'_>,
    path: &mut String,
    location: &F,
    edit_capability: TextEditCapability,
    output: &mut TextAssetProjection,
) where
    F: Fn(&str) -> TextLocation,
{
    let TextType {
        name: type_name,
        user_defined,
    } = type_info;
    match value {
        PropertyValue::Text(text) if is_formatted(text) => {}
        PropertyValue::Text(text) => output.occurrences.push(TextOccurrence {
            source: text.source.clone(),
            dev_notes: text.dev_notes().unwrap_or_default().to_owned(),
            identity: identity_for_text(text),
            location: location(path),
            edit_capability,
        }),
        PropertyValue::Raw { reason } => {
            let reason = match reason {
                RawReason::NotRequested => None,
                RawReason::LegacyContainerElementWithoutTypeInformation => {
                    Some(TextCoverageGapReason::LegacyContainerElementWithoutTypeInformation)
                }
                RawReason::FeatureUnavailableForEngineVersion(_) => {
                    Some(TextCoverageGapReason::FeatureUnavailableForEngineVersion)
                }
                RawReason::UnsupportedTextHistory(_) => {
                    Some(TextCoverageGapReason::UnsupportedTextHistory)
                }
                RawReason::LegacyDecoderRejected(_) | RawReason::DecoderRejected(_) => {
                    Some(TextCoverageGapReason::PropertyDecoderRejected)
                }
                RawReason::UnsupportedType
                    if type_name.is_none_or(|ty| {
                        package.resolve_name_cow(ty.name).as_deref() != Some("TextProperty")
                    }) =>
                {
                    Some(TextCoverageGapReason::PropertyDecoderRejected)
                }
                _ => None,
            };
            if let Some(reason) = reason {
                output.coverage_gaps.push(TextCoverageGap {
                    may_contain_text: user_defined
                        || type_name.is_none_or(|ty| type_may_contain_text(package, ty)),
                    object_path: location(path).object_path().to_owned(),
                    property_path: path.clone(),
                    reason,
                });
            }
        }
        PropertyValue::Array(values) | PropertyValue::Set(values) => {
            let prefix_len = path.len();
            for (index, value) in values.iter().enumerate() {
                if !may_hold_text_facts(value) {
                    continue;
                }
                push_formatted(path, format_args!("[{index}]"));
                visit_text_value(
                    package,
                    value,
                    type_info.element(0),
                    path,
                    location,
                    edit_capability,
                    output,
                );
                path.truncate(prefix_len);
            }
        }
        PropertyValue::Map(entries) => {
            let prefix_len = path.len();
            for (index, entry) in entries.iter().enumerate() {
                if !may_hold_text_facts(&entry.key) && !may_hold_text_facts(&entry.value) {
                    continue;
                }
                push_formatted(path, format_args!("{{{index}}}.key"));
                visit_text_value(
                    package,
                    &entry.key,
                    type_info.element(0),
                    path,
                    location,
                    edit_capability,
                    output,
                );
                path.truncate(prefix_len);
                push_formatted(path, format_args!("{{{index}}}.value"));
                visit_text_value(
                    package,
                    &entry.value,
                    type_info.element(1),
                    path,
                    location,
                    edit_capability,
                    output,
                );
                path.truncate(prefix_len);
            }
        }
        PropertyValue::Struct(stream) => {
            visit_text_stream(package, stream, path, location, edit_capability, output)
        }
        PropertyValue::NativeStruct { fields } => {
            let prefix_len = path.len();
            for field in fields {
                if !may_hold_text_facts(&field.value) {
                    continue;
                }
                push_property_segment(path, &field.name);
                visit_text_value(
                    package,
                    &field.value,
                    TextType::default(),
                    path,
                    location,
                    TextEditCapability::ReadOnly,
                    output,
                );
                path.truncate(prefix_len);
            }
        }
        PropertyValue::InstancedStruct(instance) => {
            let Some(value) = &instance.value else {
                return;
            };
            let prefix_len = path.len();
            push_property_segment(path, "Value");
            visit_text_value(
                package,
                value,
                TextType::default(),
                path,
                location,
                TextEditCapability::ReadOnly,
                output,
            );
            path.truncate(prefix_len);
        }
        _ => {}
    }
}

fn legacy_tail_may_contain_text(package: &Package, object: &DecodedUObject) -> bool {
    // UE 4.27 Components/StaticMeshComponent.cpp UStaticMeshComponent::Serialize and
    // operator<<(FStaticMeshComponentLODInfo&): LOD build GUIDs, vertex colors, painted vertices;
    // InstancedStaticMesh.cpp UInstancedStaticMeshComponent::Serialize: cooked bool and bulk
    // numeric instance/custom data; HierarchicalInstancedStaticMesh.cpp ::Serialize: cluster
    // tree bulk data; Components/SplineMeshComponent.cpp ::Serialize adds no saved data.
    // Their UObject/ActorComponent/PrimitiveComponent bases add no native FText. Restrict this
    // proof to exact native owners, including saved Blueprint-only inheritance. Imported
    // content classes and unknown native subclasses stay text-capable.
    let native_class = package
        .exports
        .iter()
        .find(|export| export.object_path == object.object_path)
        .and_then(|export| uasset_parser::asset::saved_native_class(package, export))
        .unwrap_or(object.class_path.as_str());
    !(package.summary.versions.ue5 == 0
        && matches!(
            native_class,
            "/Script/Engine.StaticMeshComponent"
                | "/Script/Engine.InstancedStaticMeshComponent"
                | "/Script/Engine.HierarchicalInstancedStaticMeshComponent"
                | "/Script/Engine.SplineMeshComponent"
                // UE 4.27 / 5.7 World.cpp, UWorld::Serialize: persistent level and
                // reference arrays only in saved packages (PIE viewport/origin data is numeric).
                | "/Script/Engine.World"
        ))
}

/// Property types that hold no `FText` whatever their type parameters.
fn is_text_free_property_type(name: &str) -> bool {
    matches!(
        name,
        "BoolProperty"
            | "ByteProperty"
            | "EnumProperty"
            | "IntProperty"
            | "Int8Property"
            | "Int16Property"
            | "Int64Property"
            | "UInt16Property"
            | "UInt32Property"
            | "UInt64Property"
            | "FloatProperty"
            | "DoubleProperty"
            | "NameProperty"
            | "StrProperty"
            | "ObjectProperty"
            | "ClassProperty"
            | "WeakObjectProperty"
            | "LazyObjectProperty"
            | "SoftObjectProperty"
            | "SoftClassProperty"
            | "InterfaceProperty"
            | "DelegateProperty"
            | "MulticastDelegateProperty"
            | "MulticastInlineDelegateProperty"
            | "MulticastSparseDelegateProperty"
            | "FieldPathProperty"
    )
}

/// Unknown structs stay text-capable. Core math and paths use fixed native layouts
/// (NoExportTypes.h / SoftObjectPath.cpp, UE 4.27 and 5.7). User struct GUIDs override names.
fn type_may_contain_text(package: &Package, ty: &PropertyTypeName) -> bool {
    match package.resolve_name_cow(ty.name).as_deref() {
        Some(name) if is_text_free_property_type(name) => false,
        Some("ArrayProperty" | "SetProperty" | "OptionalProperty") => ty
            .parameters
            .first()
            .is_none_or(|inner| type_may_contain_text(package, inner)),
        Some("MapProperty") => {
            ty.parameters.len() != 2
                || ty
                    .parameters
                    .iter()
                    .any(|inner| type_may_contain_text(package, inner))
        }
        Some("StructProperty") => {
            let Some(inner) = ty.parameters.first() else {
                return true;
            };
            if package.resolve_name_cow(inner.name).as_deref() == Some("MovieSceneFloatChannel")
                && inner.parameters.first().is_none_or(|module| {
                    package.resolve_name_cow(module.name).as_deref() == Some("/Script/MovieScene")
                })
            {
                // UE 4.27 / 5.7 MovieSceneFloatChannel.cpp ::Serialize stores numeric
                // curves/defaults only, even if its custom version has no decoder here.
                return false;
            }
            if package.resolve_name_cow(inner.name).as_deref() == Some("EdGraphPinType")
                && inner.parameters.first().is_none_or(|module| {
                    package.resolve_name_cow(module.name).as_deref() == Some("/Script/Engine")
                })
            {
                // EdGraphPin.cpp FEdGraphPinType::Serialize stores types/references/flags,
                // not the pin's separate DefaultTextValue or friendly name.
                return false;
            }
            // Qualified project structs must not acquire an engine type's exemption.
            if inner.parameters.first().is_some_and(|module| {
                package.resolve_name_cow(module.name).as_deref() != Some("/Script/CoreUObject")
            }) {
                return true;
            }
            !matches!(
                package.resolve_name_cow(inner.name).as_deref(),
                Some(
                    "Guid"
                        | "SoftObjectPath"
                        | "SoftClassPath"
                        | "Vector"
                        | "Vector2D"
                        | "Vector4"
                        | "Rotator"
                        | "Quat"
                        | "Plane"
                        | "Matrix"
                        | "Box"
                        | "Box2D"
                        | "IntPoint"
                        | "IntVector"
                        | "Color"
                        | "LinearColor"
                        | "DateTime"
                        | "Timespan"
                        | "FrameNumber"
                        | "FrameRate"
                        // UE 5.7 / 5.8 CoreUObject/Public/UObject/NoExportTypes.h: numeric math structs.
                        | "Vector3f"
                        | "Vector3d"
                        | "Vector2f"
                        | "Vector4f"
                        | "Vector4d"
                        | "Quat4f"
                        | "Quat4d"
                        | "Rotator3f"
                        | "Rotator3d"
                        | "Box3f"
                        | "Box3d"
                        | "Box2f"
                        | "Plane4f"
                        | "Plane4d"
                        | "Matrix44f"
                        | "Matrix44d"
                        | "Transform"
                        | "Transform3f"
                        | "Transform3d"
                        | "FrameTime"
                        | "IntVector2"
                        | "IntVector4"
                        | "Int32Point"
                        | "Int64Point"
                        | "UintPoint"
                        | "Uint32Point"
                        | "Uint64Point"
                        | "Int32Vector2"
                        | "Int64Vector2"
                        | "Uint32Vector2"
                        | "Uint64Vector2"
                        | "UintVector2"
                        | "Int32Vector"
                        | "Int64Vector"
                        | "Uint32Vector"
                        | "Uint64Vector"
                        | "UintVector"
                        | "Int32Vector4"
                        | "Int64Vector4"
                        | "Uint32Vector4"
                        | "Uint64Vector4"
                        | "UintVector4"
                )
            )
        }
        _ => true,
    }
}

#[must_use]
pub fn text_feature_version_gap(
    context: &uasset_parser::asset::AssetDecodeContext<'_>,
    export: &uasset_parser::package::Export,
    error: &uasset_parser::asset::AssetError,
) -> Option<TextCoverageGap> {
    let package = context.package;
    if uasset_parser::asset::is_blueprint_graph_node_export(context, export)
        || export
            .class_path
            .as_ref()
            .is_some_and(|class_path| class_path.as_str() == uasset_parser::asset::ED_GRAPH_CLASS)
        // An unreadable Blueprint-owned container can hide custom graph membership entirely.
        // Its children cannot be proven unrelated to native pins without reading Nodes.
        || (uasset_parser::asset::is_blueprint_owned_export(package, export)
            && package.exports.iter().any(|child| {
                package.resolve_index_str(child.outer_index) == Some(export.object_path.as_str())
            }))
    {
        return Some(TextCoverageGap {
            may_contain_text: true,
            object_path: export.object_path.as_str().to_owned(),
            property_path: "Pins".to_owned(),
            reason: if error.kind() == uasset_parser::asset::AssetErrorKind::UnsupportedVersion {
                TextCoverageGapReason::FeatureUnavailableForEngineVersion
            } else {
                TextCoverageGapReason::PropertyDecoderRejected
            },
        });
    }
    (package.summary.versions.uses_legacy_property_tags()
        && error.kind() == uasset_parser::asset::AssetErrorKind::UnsupportedVersion)
        .then(|| TextCoverageGap {
            may_contain_text: true,
            object_path: export.object_path.as_str().to_owned(),
            property_path: String::new(),
            reason: TextCoverageGapReason::FeatureUnavailableForEngineVersion,
        })
}

/// Whether `text` is the saved result of `FText::Format`. Unreal doesn't gather it: a format
/// history has no text ID (`FTextHistory_Generated::GetTextId`), so `GatherTextInstance` skips it,
/// and its pattern is gathered where it is defined. Reporting it under the pattern's key would show
/// every filled-in result as a different text for one key.
fn is_formatted(text: &TextValue) -> bool {
    matches!(
        text.history,
        TextHistory::NamedFormat { .. } | TextHistory::OrderedFormat { .. }
    )
}

fn identity_for_text(text: &TextValue) -> TextIdentity {
    match &text.history {
        TextHistory::None => TextIdentity::Unresolved {
            reason: TextIdentityReason::CultureInvariant,
        },
        TextHistory::Base { namespace, key, .. } if key.is_empty() => TextIdentity::Unresolved {
            reason: TextIdentityReason::MissingKey,
        },
        TextHistory::Base { namespace, key, .. } => TextIdentity::Resolved {
            namespace: namespace.clone(),
            key: key.clone(),
        },
        TextHistory::NamedFormat { format, .. } | TextHistory::OrderedFormat { format, .. } => {
            identity_for_text(format)
        }
        TextHistory::StringTableEntry { table_id, key } => TextIdentity::StringTable {
            table_id: table_id.clone(),
            key: key.clone(),
        },
    }
}

fn property_type_is_text(package: &Package, property: &PropertyRecord) -> bool {
    package
        .resolve_name_str(property.type_name.name)
        .is_some_and(|type_name| type_name == "TextProperty")
}

/// Appends `name` as the next property segment: `name` at the root, `.name` below it.
fn push_property_segment(path: &mut String, name: &str) {
    if !path.is_empty() {
        path.push('.');
    }
    path.push_str(name);
}

fn push_formatted(path: &mut String, segment: fmt::Arguments<'_>) {
    path.write_fmt(segment)
        .unwrap_or_else(|_| unreachable!("writing to a String cannot fail"));
}

fn resolve_name(package: &Package, name: uasset_parser::archive::NameRef) -> Cow<'_, str> {
    package
        .resolve_name_cow(name)
        .unwrap_or_else(|| Cow::Owned(format!("<invalid-name:{}>", name.index().get())))
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
        object_path: object.object_path.as_str().to_owned(),
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
            value: resolve_name(package, value).into_owned(),
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

#[cfg(test)]
mod string_table_notes_tests {
    use super::string_table_notes;

    #[test]
    fn preserves_comment_metadata_and_dev_notes_without_duplicates() {
        assert_eq!(
            string_table_notes("", Some("Translator context")),
            "Translator context"
        );
        assert_eq!(
            string_table_notes("Dev notes", Some("Comment")),
            "Dev notes\n\nComment"
        );
        assert_eq!(string_table_notes("Same", Some("Same")), "Same");
        assert_eq!(string_table_notes("", Some("  ")), "");
        assert_eq!(string_table_notes("Notes", None), "Notes");
    }
}
