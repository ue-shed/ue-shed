//! Semantic property decoding seam.

use std::fmt;

pub(crate) mod native_values;

use crate::archive::{Guid, Reader};
use crate::package::{Package, PackageIndex};
use crate::property::{
    ColorValue, DataTableRowHandleValue, FrameRangeBound, FrameRangeValue, IntPointValue,
    LinearColorValue, MapEntry, PropertyError, PropertyRecord, PropertyStream, PropertyTagFlags,
    PropertyTypeName, PropertyValue, RangeBoundKind, RawReason, RotatorValue, TextHistory,
    TextValue, VectorValue, read_tagged_property_stream,
};

/// UE `INDEX_NONE` marks a full container replace in map property payloads.
const INDEX_NONE: i32 = -1;
const MAX_PROPERTY_DECODE_DEPTH: usize = 64;
const RICH_CURVE_KEY_SERIALIZED_BYTES: u64 = 27;

#[derive(Clone, Copy)]
struct TypeSpec<'a> {
    name: &'a str,
    tree: &'a PropertyTypeName,
    struct_guid: Option<Guid>,
}

impl TypeSpec<'_> {
    fn is_user_defined_struct(self) -> bool {
        self.name == "StructProperty" && self.struct_guid.is_some_and(|guid| !guid.is_zero())
    }
}

/// Lazily renders the `Property.<name>` breadcrumb used in decode error
/// messages. The property name is resolved from the package name map only when
/// the value is actually formatted — i.e. on the error path — so the happy path
/// pays no allocation for a breadcrumb it never prints.
#[derive(Clone, Copy)]
struct PropertyPath<'a> {
    package: &'a Package,
    name: crate::archive::NameRef,
}

impl fmt::Display for PropertyPath<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Property.")?;
        match self.package.resolve_name_cow(self.name) {
            Some(name) => formatter.write_str(&name),
            None => formatter.write_str("Property"),
        }
    }
}

/// Decodes supported property payloads in place.
///
/// Unsupported property types and legacy codec failures retain their bounded raw spans.
/// Malformed supported payloads in modern records return an error.
///
/// # Errors
///
/// Returns an error for malformed supported modern payloads, primitive-read failures,
/// or resource limits. Legacy failures retain their record boundary as raw values.
pub fn decode_property_stream_values(
    source: &[u8],
    stream: &mut PropertyStream,
    package: &Package,
) -> Result<(), PropertyError> {
    decode_property_stream_values_at_depth(source, stream, package, 0)
}

fn decode_property_stream_values_at_depth(
    source: &[u8],
    stream: &mut PropertyStream,
    package: &Package,
    depth: usize,
) -> Result<(), PropertyError> {
    for record in &mut stream.records {
        decode_property_record(source, record, package, depth)?;
    }
    Ok(())
}

fn decode_property_record(
    source: &[u8],
    record: &mut PropertyRecord,
    package: &Package,
    depth: usize,
) -> Result<(), PropertyError> {
    if let Err(error) = decode_property_record_inner(source, record, package, depth) {
        if !package.summary.versions.uses_legacy_property_tags() && error.raw_reason.is_none() {
            return Err(error);
        }
        let reason = error.raw_reason.clone().unwrap_or_else(|| {
            if error.kind() == crate::property::PropertyErrorKind::UnsupportedVersion {
                RawReason::FeatureUnavailableForEngineVersion(error.to_string())
            } else {
                RawReason::LegacyDecoderRejected(error.to_string())
            }
        });
        record.value = PropertyValue::Raw { reason };
    }
    Ok(())
}

fn decode_property_record_inner(
    source: &[u8],
    record: &mut PropertyRecord,
    package: &Package,
    depth: usize,
) -> Result<(), PropertyError> {
    if record.flags.is_skipped() {
        record.value = PropertyValue::Raw {
            reason: RawReason::DecoderRejected("property serialization was skipped".to_owned()),
        };
        return Ok(());
    }

    let Some(type_name) = package.resolve_name_cow(record.type_name.name) else {
        record.value = PropertyValue::Raw {
            reason: RawReason::DecoderRejected("unresolved property type name".to_owned()),
        };
        return Ok(());
    };

    let reader = Reader::new(source);
    let mut payload = reader.bounded(record.payload, "Property.Payload")?;
    // The name map outlives the whole decode, so resolve names by borrow and
    // render the error breadcrumb lazily — nothing here allocates unless a
    // reader actually fails.
    let path = PropertyPath {
        package,
        name: record.name,
    };

    let legacy = package.summary.versions.uses_legacy_property_tags();
    let decoded = if record.flags.is_binary_or_native() || (legacy && type_name == "StructProperty")
    {
        match decode_binary_or_native_value(
            source,
            depth,
            TypeSpec {
                name: type_name.as_ref(),
                tree: &record.type_name,
                struct_guid: record.struct_guid,
            },
            &mut payload,
            package,
            &path,
        ) {
            Ok(Some(value)) => value,
            Ok(None)
                if matches!(
                    type_name.as_ref(),
                    "ArrayProperty" | "SetProperty" | "MapProperty"
                ) || (legacy && type_name == "StructProperty") =>
            {
                match decode_typed_value(
                    source,
                    TypeSpec {
                        name: type_name.as_ref(),
                        tree: &record.type_name,
                        struct_guid: record.struct_guid,
                    },
                    record.flags,
                    &mut payload,
                    package,
                    &path,
                    depth,
                ) {
                    Ok(Some(value)) => value,
                    Ok(None) => {
                        record.value = PropertyValue::Raw {
                            reason: RawReason::UnsupportedType,
                        };
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                }
            }
            Ok(None) => {
                record.value = PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                };
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    } else {
        match decode_typed_value(
            source,
            TypeSpec {
                name: type_name.as_ref(),
                tree: &record.type_name,
                struct_guid: record.struct_guid,
            },
            record.flags,
            &mut payload,
            package,
            &path,
            depth,
        ) {
            Ok(Some(value)) => value,
            Ok(None) => {
                record.value = PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                };
                return Ok(());
            }
            Err(error) => return Err(error),
        }
    };

    if payload.remaining() != 0 {
        record.value = PropertyValue::Raw {
            reason: RawReason::DecoderRejected(format!(
                "{} trailing bytes left in decoded {type_name} payload",
                payload.remaining()
            )),
        };
        return Ok(());
    }

    record.value = decoded;
    Ok(())
}

fn decode_typed_value(
    source: &[u8],
    type_spec: TypeSpec<'_>,
    flags: PropertyTagFlags,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &(impl fmt::Display + ?Sized),
    depth: usize,
) -> Result<Option<PropertyValue>, PropertyError> {
    // Scalar leaves pass their error breadcrumb as `format_args!`: the reader
    // only stringifies `path` when it actually fails, so the happy path is
    // allocation-free. The container/struct arms below still need an owned
    // `&str` for their deeper recursion, so they materialize `path` once.
    match type_spec.name {
        "BoolProperty" => Ok(Some(PropertyValue::Bool(flags.bool_value()))),
        "Int8Property" => Ok(Some(PropertyValue::Int(i64::from(
            payload.read_i8(&format_args!("{path}.Int8"))?,
        )))),
        "Int16Property" => Ok(Some(PropertyValue::Int(i64::from(
            payload.read_i16(&format_args!("{path}.Int16"))?,
        )))),
        "IntProperty" | "Int32Property" => Ok(Some(PropertyValue::Int(i64::from(
            payload.read_i32(&format_args!("{path}.Int32"))?,
        )))),
        "Int64Property" => Ok(Some(PropertyValue::Int(
            payload.read_i64(&format_args!("{path}.Int64"))?,
        ))),
        "UInt8Property" => Ok(Some(PropertyValue::UInt(u64::from(
            payload.read_u8(&format_args!("{path}.UInt8"))?,
        )))),
        // A `ByteProperty` backed by a `UEnum` serializes its value as the enum
        // entry `FName` (8 bytes); a plain byte serializes as a single `u8`
        // (`UByteProperty::SerializeItem`). The payload size disambiguates.
        "ByteProperty" if payload.remaining() != 1 => Ok(Some(PropertyValue::Enum(
            payload.read_name_ref(&format_args!("{path}.Enum"))?,
        ))),
        "ByteProperty" => Ok(Some(PropertyValue::UInt(u64::from(
            payload.read_u8(&format_args!("{path}.UInt8"))?,
        )))),
        "UInt16Property" => Ok(Some(PropertyValue::UInt(u64::from(
            payload.read_u16(&format_args!("{path}.UInt16"))?,
        )))),
        "UInt32Property" => Ok(Some(PropertyValue::UInt(u64::from(
            payload.read_u32(&format_args!("{path}.UInt32"))?,
        )))),
        "UInt64Property" => Ok(Some(PropertyValue::UInt(
            payload.read_u64(&format_args!("{path}.UInt64"))?,
        ))),
        "FloatProperty" => Ok(Some(PropertyValue::Float(
            payload.read_f32(&format_args!("{path}.Float"))?,
        ))),
        "DoubleProperty" => Ok(Some(PropertyValue::Double(
            payload.read_f64(&format_args!("{path}.Double"))?,
        ))),
        "NameProperty" => Ok(Some(PropertyValue::Name(
            payload.read_name_ref(&format_args!("{path}.Name"))?,
        ))),
        "EnumProperty" => Ok(Some(PropertyValue::Enum(
            payload.read_name_ref(&format_args!("{path}.Enum"))?,
        ))),
        "StrProperty" => Ok(Some(PropertyValue::String(
            payload.read_fstring(&format_args!("{path}.String"))?,
        ))),
        "TextProperty" => {
            let path = path.to_string();
            decode_text_value(payload, package, &path).map(|text| text.map(PropertyValue::Text))
        }
        "ObjectProperty" | "ClassProperty" | "WeakObjectProperty" | "InterfaceProperty" => {
            Ok(Some(PropertyValue::ObjectRef(PackageIndex::from_raw(
                payload.read_i32(&format_args!("{path}.ObjectRef"))?,
            ))))
        }
        "LazyObjectProperty" => Ok(Some(PropertyValue::Guid(
            payload.read_guid(&format_args!("{path}.Guid"))?,
        ))),
        "SoftObjectProperty" | "SoftClassProperty" => {
            let path = path.to_string();
            Ok(Some(PropertyValue::SoftObjectPath(
                decode_soft_object_path(payload, &path, package)?,
            )))
        }
        "ArrayProperty" => {
            let path = path.to_string();
            let serializer = ContainerSerializer::from_tag(package, flags);
            decode_array_value(
                source,
                type_spec.tree,
                payload,
                package,
                &path,
                depth,
                serializer,
            )
            .map(Some)
        }
        "SetProperty" => {
            let path = path.to_string();
            let serializer = ContainerSerializer::from_tag(package, flags);
            decode_set_value(
                source,
                type_spec.tree,
                payload,
                package,
                &path,
                depth,
                serializer,
            )
            .map(Some)
        }
        "MapProperty" => {
            let path = path.to_string();
            let serializer = ContainerSerializer::from_tag(package, flags);
            decode_map_value(
                source,
                type_spec.tree,
                payload,
                package,
                &path,
                depth,
                serializer,
            )
            .map(Some)
        }
        "StructProperty" => {
            let path = path.to_string();
            decode_struct_value(source, type_spec, payload, package, &path, depth).map(Some)
        }
        _ => Ok(None),
    }
}

/// Decodes `FSoftObjectPath` / `TSoftObjectPtr` wire format.
///
/// Editor packages with a package-level soft object path table store a 4-byte
/// index into that table. Inline paths use one asset FName before 1007 and
/// package/asset FNames from 1007, followed by the subpath string.
fn decode_soft_object_path(
    payload: &mut Reader<'_>,
    path: &str,
    package: &Package,
) -> Result<String, PropertyError> {
    // UE 5.7 LinkerLoad.cpp, ADD_SOFTOBJECTPATH_LIST (1008).
    if package.summary.versions.is_at_least_ue5(1008) && !package.soft_object_paths.is_empty() {
        if payload.remaining() != 4 {
            return Err(PropertyError::new(
                crate::property::PropertyErrorKind::MalformedData,
                Some(payload.tell()),
                path,
                format!(
                    "table-backed soft object path payload must be exactly 4 bytes, got {}",
                    payload.remaining()
                ),
            ));
        }
        let index = payload.read_i32(&format_args!("{path}.SoftObjectPathIndex"))?;
        if index < 0 {
            return Err(PropertyError::new(
                crate::property::PropertyErrorKind::MalformedData,
                Some(payload.tell() - 4),
                path,
                format!("soft object path index must be non-negative, got {index}"),
            ));
        }
        let index = usize::try_from(index).map_err(|error| {
            PropertyError::new(
                crate::property::PropertyErrorKind::MalformedData,
                Some(payload.tell()),
                path,
                format!("soft object path index does not fit in usize: {error}"),
            )
        })?;
        return package
            .soft_object_paths
            .get(index)
            .cloned()
            .ok_or_else(|| {
                PropertyError::new(
                    crate::property::PropertyErrorKind::MalformedData,
                    Some(payload.tell()),
                    path,
                    format!(
                        "soft object path index {index} is out of range (table size {})",
                        package.soft_object_paths.len()
                    ),
                )
            });
    }

    // UE 5.3 SoftObjectPath.cpp, FSOFTOBJECTPATH_REMOVE_ASSET_PATH_FNAMES (1007).
    if !package.summary.versions.is_at_least_ue5(1007) {
        let asset = payload.read_name_ref(&format_args!("{path}.AssetPathName"))?;
        let asset = package.resolve_name(asset).ok_or_else(|| {
            unsupported_container_type(payload, path, "soft path", "unresolved asset name")
        })?;
        let subpath = payload.read_fstring(&format_args!("{path}.SubPath"))?;
        return Ok(if asset == "None" {
            String::new()
        } else if subpath.is_empty() {
            asset
        } else {
            format!("{asset}:{subpath}")
        });
    }
    let package_name = payload.read_name_ref(&format_args!("{path}.PackageName"))?;
    let asset_name = payload.read_name_ref(&format_args!("{path}.AssetName"))?;
    let resolve = |name| {
        package.resolve_name(name).ok_or_else(|| {
            unsupported_container_type(payload, path, "soft path", "unresolved name")
        })
    };
    let package_name = resolve(package_name)?;
    let asset_name = resolve(asset_name)?;
    let subpath = if package.summary.versions.uses_legacy_property_tags() {
        payload.read_fstring(&format_args!("{path}.SubPath"))?
    } else {
        payload.read_soft_object_subpath(&format_args!("{path}.SubPath"))?
    };
    if package_name == "None" {
        return Ok(String::new());
    }
    let asset = if asset_name == "None" {
        package_name
    } else {
        format!("{package_name}.{asset_name}")
    };
    Ok(if subpath.is_empty() {
        asset
    } else {
        format!("{asset}:{subpath}")
    })
}

fn decode_binary_or_native_value(
    source: &[u8],
    depth: usize,
    type_spec: TypeSpec<'_>,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &(impl fmt::Display + ?Sized),
) -> Result<Option<PropertyValue>, PropertyError> {
    // Legacy UUserDefinedStruct tags retain a custom GUID even when their short
    // name collides with a native type. Their payload is a tagged field stream.
    if type_spec.is_user_defined_struct() {
        return Ok(None);
    }
    let type_tree = type_spec.tree;
    if type_spec.name == "StructProperty" {
        // Native structs are the only branch that reads, and each read helper
        // wants an owned `&str`; materialize the breadcrumb once here rather
        // than per read.
        let path = path.to_string();
        if let Some(value) = native_values::math_struct(
            resolve_math_struct_name(package, type_tree)
                .as_deref()
                .unwrap_or(""),
            payload,
            package,
            &path,
        )? {
            return Ok(Some(value));
        }
        if let Some(type_path) = resolve_struct_type_path(package, type_tree)
            && let Some(value) =
                native_values::generated_value(source, type_path, payload, package, &path, depth)?
        {
            return Ok(Some(value));
        }
        let struct_name = resolve_struct_type_name(package, type_tree);
        if let Some(name) = &struct_name
            && let Some(value) =
                native_values::known_struct(source, name, payload, package, &path, depth)?
        {
            return Ok(Some(value));
        }
        match struct_name.as_deref() {
            Some("IntPoint") => {
                return Ok(Some(PropertyValue::IntPoint(decode_int_point_value(
                    payload, &path,
                )?)));
            }
            Some("Guid") => {
                return Ok(Some(PropertyValue::Guid(decode_guid_value(
                    payload, &path,
                )?)));
            }
            Some("Color") => {
                return Ok(Some(PropertyValue::Color(decode_color_value(
                    payload, &path,
                )?)));
            }
            Some("LinearColor") => {
                return Ok(Some(PropertyValue::LinearColor(decode_linear_color_value(
                    payload, &path,
                )?)));
            }
            Some("DateTime") => {
                return Ok(Some(PropertyValue::DateTime(decode_date_time_value(
                    payload, &path,
                )?)));
            }
            Some("MovieSceneFrameRange") => {
                return Ok(Some(PropertyValue::FrameRange(decode_frame_range_value(
                    payload, &path,
                )?)));
            }
            _ => {}
        }
    }

    Ok(None)
}

fn decode_date_time_value(payload: &mut Reader<'_>, path: &str) -> Result<i64, PropertyError> {
    if payload.remaining() != 8 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("unsupported FDateTime payload size {}", payload.remaining()),
        ));
    }
    payload
        .read_i64(&format_args!("{path}.Ticks"))
        .map_err(PropertyError::from)
}

fn decode_int_point_value(
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<IntPointValue, PropertyError> {
    if payload.remaining() != 8 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("unsupported FIntPoint payload size {}", payload.remaining()),
        ));
    }

    Ok(IntPointValue {
        x: payload.read_i32(&format_args!("{path}.X"))?,
        y: payload.read_i32(&format_args!("{path}.Y"))?,
    })
}

fn decode_array_value(
    source: &[u8],
    type_tree: &PropertyTypeName,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    serializer: ContainerSerializer,
) -> Result<PropertyValue, PropertyError> {
    let (inner_type, inner_name) = resolve_inner_type(package, type_tree, path, "ArrayProperty")?;

    let count = payload.read_count(&format_args!("{path}.Count"))?;
    // UE 4.27/5.3 PropertyArray.cpp, VER_UE4_INNER_ARRAY_TAG_INFO;
    // UE 5.7 removes this inner envelope at PROPERTY_TAG_COMPLETE_TYPE_NAME (1012).
    if package.summary.versions.uses_legacy_property_tags() && inner_name == "StructProperty" {
        let name = payload.read_name_ref(&format_args!("{path}.InnerTag.Name"))?;
        let inner_tag = crate::property::read_legacy_property_tag(
            payload,
            &package.summary.versions,
            &package.names,
            name,
            path,
        )?;
        if package.resolve_name(inner_tag.type_name.name).as_deref() != Some("StructProperty") {
            return Err(unsupported_container_type(
                payload,
                path,
                "array inner tag",
                "non-struct",
            ));
        }
        let mut inner_payload = Reader::new(source).bounded(inner_tag.payload, path)?;
        let value = decode_array_elements(
            source,
            TypeSpec {
                name: &inner_name,
                tree: &inner_tag.type_name,
                struct_guid: inner_tag.struct_guid,
            },
            &mut inner_payload,
            package,
            path,
            depth,
            count,
            serializer,
        )?;
        if inner_payload.remaining() != 0 {
            return Err(unsupported_container_type(
                &inner_payload,
                path,
                "array inner payload",
                "trailing bytes",
            ));
        }
        return Ok(value);
    }
    decode_array_elements(
        source,
        TypeSpec {
            name: &inner_name,
            tree: inner_type,
            struct_guid: None,
        },
        payload,
        package,
        path,
        depth,
        count,
        serializer,
    )
}

#[allow(clippy::too_many_arguments)]
fn decode_array_elements(
    source: &[u8],
    inner: TypeSpec<'_>,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    count: usize,
    serializer: ContainerSerializer,
) -> Result<PropertyValue, PropertyError> {
    let capacity = payload.checked_vec_capacity::<PropertyValue>(
        count,
        minimum_serialized_size(inner.name, inner.tree),
        &format!("{path}.Count"),
    )?;
    let mut values = Vec::with_capacity(capacity);
    for index in 0..count {
        let element_path = format!("{path}[{index}]");
        values.push(
            decode_container_element(
                source,
                inner,
                payload,
                package,
                &element_path,
                depth,
                serializer,
            )?
            .ok_or_else(|| {
                unsupported_container_type(payload, &element_path, "array element", inner.name)
            })?,
        );
    }
    Ok(PropertyValue::Array(values))
}

fn decode_set_value(
    source: &[u8],
    type_tree: &PropertyTypeName,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    serializer: ContainerSerializer,
) -> Result<PropertyValue, PropertyError> {
    let (element_type, element_name) = resolve_inner_type(package, type_tree, path, "SetProperty")?;

    let remove_count = payload.read_i32(&format_args!("{path}.ElementsToRemove.Count"))?;
    if remove_count < 0 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("set ElementsToRemove count must be non-negative, got {remove_count}"),
        ));
    }
    payload.checked_vec_capacity::<PropertyValue>(
        usize::try_from(remove_count).expect("non-negative i32 fits in usize"),
        minimum_serialized_size(&element_name, element_type),
        &format!("{path}.ElementsToRemove.Count"),
    )?;
    for index in 0..remove_count {
        let element_path = format!("{path}.ElementsToRemove[{index}]");
        decode_container_element(
            source,
            TypeSpec {
                name: &element_name,
                tree: element_type,
                struct_guid: None,
            },
            payload,
            package,
            &element_path,
            depth,
            serializer,
        )?
        .ok_or_else(|| {
            unsupported_container_type(payload, &element_path, "set element", &element_name)
        })?;
    }

    let count = payload.read_count(&format_args!("{path}.Elements.Count"))?;
    let capacity = payload.checked_vec_capacity::<PropertyValue>(
        count,
        minimum_serialized_size(&element_name, element_type),
        &format!("{path}.Elements.Count"),
    )?;
    let mut values = Vec::with_capacity(capacity);
    for index in 0..count {
        let element_path = format!("{path}.Elements[{index}]");
        values.push(
            decode_container_element(
                source,
                TypeSpec {
                    name: &element_name,
                    tree: element_type,
                    struct_guid: None,
                },
                payload,
                package,
                &element_path,
                depth,
                serializer,
            )?
            .ok_or_else(|| {
                unsupported_container_type(payload, &element_path, "set element", &element_name)
            })?,
        );
    }
    Ok(PropertyValue::Set(values))
}

fn decode_map_value(
    source: &[u8],
    type_tree: &PropertyTypeName,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    serializer: ContainerSerializer,
) -> Result<PropertyValue, PropertyError> {
    let (key_type, key_name) = resolve_map_key_type(package, type_tree, path)?;
    let (value_type, value_name) = resolve_map_value_type(package, type_tree, path)?;

    let keys_to_remove = payload.read_i32(&format_args!("{path}.KeysToRemove.Count"))?;
    if keys_to_remove > 0 {
        payload.checked_vec_capacity::<PropertyValue>(
            usize::try_from(keys_to_remove).expect("positive i32 fits in usize"),
            minimum_serialized_size(&key_name, key_type),
            &format!("{path}.KeysToRemove.Count"),
        )?;
        for index in 0..keys_to_remove {
            let key_path = format!("{path}.KeysToRemove[{index}]");
            decode_container_element(
                source,
                TypeSpec {
                    name: &key_name,
                    tree: key_type,
                    struct_guid: None,
                },
                payload,
                package,
                &key_path,
                depth,
                serializer,
            )?
            .ok_or_else(|| unsupported_container_type(payload, &key_path, "map key", &key_name))?;
        }
    } else if keys_to_remove != 0 && keys_to_remove != INDEX_NONE {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("unexpected map KeysToRemove count {keys_to_remove}"),
        ));
    }

    let count = payload.read_count(&format_args!("{path}.Entries.Count"))?;
    let entry_minimum = minimum_serialized_size(&key_name, key_type)
        .saturating_add(minimum_serialized_size(&value_name, value_type));
    let capacity = payload.checked_vec_capacity::<MapEntry>(
        count,
        entry_minimum,
        &format!("{path}.Entries.Count"),
    )?;
    let mut entries = Vec::with_capacity(capacity);
    for index in 0..count {
        let entry_path = format!("{path}.Entries[{index}]");
        let key_path = format!("{entry_path}.Key");
        let value_path = format!("{entry_path}.Value");
        let key = decode_container_element(
            source,
            TypeSpec {
                name: &key_name,
                tree: key_type,
                struct_guid: None,
            },
            payload,
            package,
            &key_path,
            depth,
            serializer,
        )?
        .ok_or_else(|| unsupported_container_type(payload, &key_path, "map key", &key_name))?;
        let value = decode_container_element(
            source,
            TypeSpec {
                name: &value_name,
                tree: value_type,
                struct_guid: None,
            },
            payload,
            package,
            &value_path,
            depth,
            serializer,
        )?
        .ok_or_else(|| {
            unsupported_container_type(payload, &value_path, "map value", &value_name)
        })?;
        entries.push(MapEntry { key, value });
    }
    Ok(PropertyValue::Map(entries))
}

fn decode_container_element(
    source: &[u8],
    type_spec: TypeSpec<'_>,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    serializer: ContainerSerializer,
) -> Result<Option<PropertyValue>, PropertyError> {
    if type_spec.is_user_defined_struct() {
        return decode_struct_value(source, type_spec, payload, package, path, depth).map(Some);
    }
    if type_spec.name == "StructProperty" {
        let math_name = resolve_math_struct_name(package, type_spec.tree);
        if let Some(value) =
            native_values::math_struct(math_name.as_deref().unwrap_or(""), payload, package, path)?
        {
            return Ok(Some(value));
        }
        if let Some(value) =
            decode_container_binary_struct(math_name.as_deref().unwrap_or(""), payload, path)?
        {
            return Ok(Some(value));
        }
        // UE 4.27/5.3 PropertyMap.cpp and PropertySet.cpp omit struct identities.
        if package.summary.versions.uses_legacy_property_tags()
            && type_spec.tree.parameters.is_empty()
        {
            return decode_struct_value(source, type_spec, payload, package, path, depth)
                .map(Some)
                .map_err(|error| {
                    error.with_raw_reason(RawReason::LegacyContainerElementWithoutTypeInformation)
                });
        }
    }
    // FBoolProperty::SerializeItem writes uint8 in containers (UE 5.7/5.8).
    // Scalar tagged booleans instead carry their value in the tag flags.
    if type_spec.name == "BoolProperty" {
        return Ok(Some(PropertyValue::Bool(payload.read_u8(path)? != 0)));
    }
    if type_spec.name == "StructProperty"
        && resolve_struct_type_name(package, type_spec.tree).as_deref() == Some("RichCurveKey")
    {
        let mut element = payload.take_bounded(RICH_CURVE_KEY_SERIALIZED_BYTES, path)?;
        return native_values::known_struct(
            source,
            "RichCurveKey",
            &mut element,
            package,
            path,
            depth,
        );
    }

    if type_spec.name == "StructProperty"
        && resolve_struct_type_name(package, type_spec.tree).as_deref() == Some("Guid")
    {
        let mut element_payload = payload.take_bounded(16, path)?;
        return Ok(Some(PropertyValue::Guid(
            element_payload.read_guid(&format_args!("{path}.Value"))?,
        )));
    }

    if type_spec.name == "FrameNumber"
        || (type_spec.name == "StructProperty"
            && resolve_struct_type_name(package, type_spec.tree).as_deref() == Some("FrameNumber"))
    {
        let mut element_payload = payload.take_bounded(4, path)?;
        return Ok(Some(PropertyValue::Int(i64::from(
            element_payload.read_i32(&format_args!("{path}.Value"))?,
        ))));
    }

    if matches!(type_spec.name, "SoftObjectProperty" | "SoftClassProperty")
        && package.summary.versions.is_at_least_ue5(1008)
        && !package.soft_object_paths.is_empty()
    {
        let mut element_payload = payload.take_bounded(4, path)?;
        return decode_typed_value(
            source,
            type_spec,
            PropertyTagFlags::default(),
            &mut element_payload,
            package,
            path,
            depth,
        );
    }

    if let Some(byte_count) = fixed_serialized_size(type_spec.name, type_spec.tree) {
        let mut element_payload = payload.take_bounded(
            u64::try_from(byte_count).expect("fixed payload size fits in u64"),
            path,
        )?;
        return decode_typed_value(
            source,
            type_spec,
            PropertyTagFlags::default(),
            &mut element_payload,
            package,
            path,
            depth,
        );
    }

    if type_spec.name == "StructProperty"
        && let Some(struct_name) = unknown_layout_struct_name(package, type_spec.tree)
    {
        match serializer {
            // The owning tag (or a content-package struct identity) proves a tagged stream, so a
            // failure below is malformed data and propagates like any other modern payload.
            ContainerSerializer::Tagged => {}
            _ if is_user_defined_struct_identity(package, type_spec.tree)
                || is_tagged_fallback_native_struct(package, type_spec.tree) => {}
            // Some element type is binary or native and this one has no recipe. A tagged parse
            // could succeed on native bytes by accident (an int64 equal to the `None` name index
            // reads as an empty struct), so the property is skipped without guessing.
            ContainerSerializer::BinaryOrNative => {
                return Err(PropertyError::new(
                    crate::property::PropertyErrorKind::UnsupportedCapability,
                    Some(payload.tell()),
                    path,
                    format!("struct {struct_name} has no known binary or native layout"),
                )
                .with_raw_reason(RawReason::DecoderRejected(format!(
                    "skipped: struct {struct_name} in a container is binary or native \
                     serialized and has no known layout"
                ))));
            }
            // Legacy tags carry no serializer evidence. Keep the tagged attempt they always had,
            // but a failure marks the owning property as skipped instead of failing the export.
            ContainerSerializer::Unknown => return decode_typed_value(
                source,
                type_spec,
                PropertyTagFlags::default(),
                payload,
                package,
                path,
                depth,
            )
            .map_err(|error| {
                if error.raw_reason.is_some()
                    || error.kind() == crate::property::PropertyErrorKind::ResourceLimit
                {
                    return error;
                }
                let reason = RawReason::DecoderRejected(format!(
                    "skipped: struct {struct_name} in a container has no known layout and did not \
                 decode as a tagged stream ({error})"
                ));
                error.with_raw_reason(reason)
            }),
        }
    }

    decode_typed_value(
        source,
        type_spec,
        PropertyTagFlags::default(),
        payload,
        package,
        path,
        depth,
    )
}

/// How a container's struct elements were written, as recorded by the container's own tag.
///
/// UE 5.7/5.8 `FArrayProperty`, `FSetProperty` and `FMapProperty::UseBinaryOrNativeSerialization`
/// delegate to the inner, element, key and value properties, and `FPropertyTag` saves the result
/// as `HasBinaryOrNativeSerialize` from `PROPERTY_TAG_COMPLETE_TYPE_NAME` (1012). Scalars never
/// set it, so a clear flag proves every struct element is a tagged stream. A set flag does not
/// prove the opposite: a native `Serialize` may return `false` and fall back to tagged data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ContainerSerializer {
    /// Complete-type-name tag without the flag.
    Tagged,
    /// The flag is set: some element type (for maps, the key or the value) is binary or native.
    BinaryOrNative,
    /// Legacy tags record no serializer evidence.
    Unknown,
}

impl ContainerSerializer {
    fn from_tag(package: &Package, flags: PropertyTagFlags) -> Self {
        if package.summary.versions.uses_legacy_property_tags() {
            Self::Unknown
        } else if flags.is_binary_or_native() {
            Self::BinaryOrNative
        } else {
            Self::Tagged
        }
    }
}

/// Native structs whose `WithSerializer` sets the container flag but whose `Serialize` returns
/// `false`, so `UScriptStruct::SerializeItem` falls back to tagged properties. Each entry is
/// checked against the UE 5.7 and 5.8 source; the bytes alone cannot show the fallback.
///
/// - `FAnimNotifyEvent::Serialize` (AnimTypes.cpp) only records a custom version.
const TAGGED_FALLBACK_NATIVE_STRUCTS: &[(&str, &str)] = &[("/Script/Engine", "AnimNotifyEvent")];

fn is_tagged_fallback_native_struct(package: &Package, type_tree: &PropertyTypeName) -> bool {
    let Some(identity) = type_tree.parameters.first() else {
        return false;
    };
    let name = package.resolve_name_cow(identity.name);
    let module = identity
        .parameters
        .first()
        .and_then(|module| package.resolve_name_cow(module.name));
    match (module, name) {
        (Some(module), Some(name)) => TAGGED_FALLBACK_NATIVE_STRUCTS
            .iter()
            .any(|(known_module, known_name)| module == *known_module && name == *known_name),
        _ => false,
    }
}

/// Whether a complete struct identity names a struct saved in a content package. Only
/// `UserDefinedStruct`s live outside `/Script/` modules, and they always serialize tagged.
fn is_user_defined_struct_identity(package: &Package, type_tree: &PropertyTypeName) -> bool {
    type_tree
        .parameters
        .first()
        .and_then(|identity| identity.parameters.first())
        .and_then(|module| package.resolve_name_cow(module.name))
        .is_some_and(|module| module.starts_with('/') && !module.starts_with("/Script/"))
}

/// Decodes `/Script/CoreUObject` structs that have no per-element tag inside containers.
///
/// FIntPoint, FColor and FLinearColor are `immutable` in UE 5.7/5.8 NoExportTypes.h, so
/// UScriptStruct::SerializeItem writes them with SerializeBin: X/Y as `int32`, B/G/R/A bytes,
/// and R/G/B/A `float`. A top-level tag says so with its binary flag; container elements do not.
fn decode_container_binary_struct(
    name: &str,
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<Option<PropertyValue>, PropertyError> {
    let size = match name {
        "IntPoint" => 8,
        "Color" => 4,
        "LinearColor" => 16,
        _ => return Ok(None),
    };
    let mut element = payload.take_bounded(size, path)?;
    Ok(Some(match name {
        "IntPoint" => PropertyValue::IntPoint(decode_int_point_value(&mut element, path)?),
        "Color" => PropertyValue::Color(decode_color_value(&mut element, path)?),
        _ => PropertyValue::LinearColor(decode_linear_color_value(&mut element, path)?),
    }))
}

/// Returns the struct name of a container element whose layout the reader has no recipe for.
///
/// Math and core binary structs, source-generated layouts and handwritten native structs are
/// known; anything else is attempted as a tagged stream.
fn unknown_layout_struct_name(package: &Package, type_tree: &PropertyTypeName) -> Option<String> {
    let name = resolve_struct_type_name(package, type_tree)?;
    if resolve_struct_type_path(package, type_tree).is_some()
        || native_values::is_known_struct(&name)
    {
        return None;
    }
    Some(name.into_owned())
}

fn unsupported_container_type(
    payload: &Reader<'_>,
    path: &str,
    role: &str,
    type_name: &str,
) -> PropertyError {
    PropertyError::new(
        crate::property::PropertyErrorKind::MalformedData,
        Some(payload.tell()),
        path,
        format!("unsupported {role} type {type_name}"),
    )
}

fn minimum_serialized_size(type_name: &str, type_tree: &PropertyTypeName) -> usize {
    fixed_serialized_size(type_name, type_tree).unwrap_or(1)
}

fn fixed_serialized_size(type_name: &str, type_tree: &PropertyTypeName) -> Option<usize> {
    match type_name {
        "Int8Property" | "UInt8Property" => Some(1),
        "ByteProperty" => Some(if type_tree.parameters.is_empty() {
            1
        } else {
            8
        }),
        "Int16Property" | "UInt16Property" => Some(2),
        "IntProperty" | "Int32Property" | "UInt32Property" | "FloatProperty" | "ObjectProperty"
        | "ClassProperty" | "WeakObjectProperty" | "InterfaceProperty" => Some(4),
        "Int64Property" | "UInt64Property" | "DoubleProperty" | "NameProperty" | "EnumProperty" => {
            Some(8)
        }
        "LazyObjectProperty" => Some(16),
        _ => None,
    }
}

fn resolve_inner_type<'a>(
    package: &Package,
    type_tree: &'a PropertyTypeName,
    path: &str,
    property_kind: &str,
) -> Result<(&'a PropertyTypeName, String), PropertyError> {
    let Some(inner_type) = type_tree.parameters.first() else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            format!("{property_kind} is missing its inner type parameter"),
        ));
    };
    let Some(inner_name) = package.resolve_name(inner_type.name) else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            format!("{property_kind} has an unresolved inner type name"),
        ));
    };
    Ok((inner_type, inner_name))
}

fn resolve_map_key_type<'a>(
    package: &Package,
    type_tree: &'a PropertyTypeName,
    path: &str,
) -> Result<(&'a PropertyTypeName, String), PropertyError> {
    let Some(key_type) = type_tree.parameters.first() else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            "MapProperty is missing its key type parameter",
        ));
    };
    let Some(key_name) = package.resolve_name(key_type.name) else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            "MapProperty has an unresolved key type name",
        ));
    };
    Ok((key_type, key_name))
}

fn resolve_map_value_type<'a>(
    package: &Package,
    type_tree: &'a PropertyTypeName,
    path: &str,
) -> Result<(&'a PropertyTypeName, String), PropertyError> {
    let Some(value_type) = type_tree.parameters.get(1) else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            "MapProperty is missing its value type parameter",
        ));
    };
    let Some(value_name) = package.resolve_name(value_type.name) else {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(0),
            path,
            "MapProperty has an unresolved value type name",
        ));
    };
    Ok((value_type, value_name))
}

fn decode_struct_value(
    source: &[u8],
    type_spec: TypeSpec<'_>,
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
) -> Result<PropertyValue, PropertyError> {
    if depth >= MAX_PROPERTY_DECODE_DEPTH {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("property value nesting exceeds depth limit {MAX_PROPERTY_DECODE_DEPTH}"),
        ));
    }
    let type_tree = type_spec.tree;
    let struct_name = resolve_struct_type_name(package, type_tree);
    if !type_spec.is_user_defined_struct() {
        if let Some(value) = native_values::math_struct(
            resolve_math_struct_name(package, type_tree)
                .as_deref()
                .unwrap_or(""),
            payload,
            package,
            path,
        )? {
            return Ok(value);
        }
        if let Some(type_path) = resolve_struct_type_path(package, type_tree)
            && let Some(value) =
                native_values::generated_value(source, type_path, payload, package, path, depth)?
        {
            return Ok(value);
        }
        if let Some(name) = &struct_name
            && let Some(value) =
                native_values::known_struct(source, name, payload, package, path, depth)?
        {
            return Ok(value);
        }
    }
    let mut stream =
        read_tagged_property_stream(payload, &package.summary.versions, &package.names, path)?;
    decode_property_stream_values_at_depth(source, &mut stream, package, depth + 1)?;
    if !type_spec.is_user_defined_struct() && struct_name.as_deref() == Some("DataTableRowHandle") {
        return decode_data_table_row_handle(&stream, package, path);
    }
    Ok(PropertyValue::Struct(stream))
}

fn decode_data_table_row_handle(
    stream: &PropertyStream,
    package: &Package,
    path: &str,
) -> Result<PropertyValue, PropertyError> {
    let mut table = None;
    let mut row_name = None;
    for record in &stream.records {
        match package.resolve_name(record.name).as_deref() {
            Some("DataTable") => match record.value {
                PropertyValue::ObjectRef(value) => table = Some(value),
                _ => {
                    return Err(PropertyError::new(
                        crate::property::PropertyErrorKind::MalformedData,
                        Some(record.payload.offset()),
                        path,
                        "FDataTableRowHandle.DataTable is not an object reference",
                    ));
                }
            },
            Some("RowName") => match record.value {
                PropertyValue::Name(value) => row_name = Some(value),
                _ => {
                    return Err(PropertyError::new(
                        crate::property::PropertyErrorKind::MalformedData,
                        Some(record.payload.offset()),
                        path,
                        "FDataTableRowHandle.RowName is not a name",
                    ));
                }
            },
            _ => {}
        }
    }
    let table = table.ok_or_else(|| {
        PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            None,
            path,
            "FDataTableRowHandle is missing DataTable",
        )
    })?;
    let row_name = row_name.ok_or_else(|| {
        PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            None,
            path,
            "FDataTableRowHandle is missing RowName",
        )
    })?;
    Ok(PropertyValue::DataTableRowHandle(DataTableRowHandleValue {
        table,
        row_name,
    }))
}

fn decode_text_value(
    payload: &mut Reader<'_>,
    package: &Package,
    path: &str,
) -> Result<Option<TextValue>, PropertyError> {
    let _flags = payload.read_i32(&format_args!("{path}.Flags"))?;
    let history_type = payload.read_i8(&format_args!("{path}.HistoryType"))?;

    if history_type == -1 {
        // UE 4.27/5.3 Text.cpp, Dev-Editor CultureInvariantTextSerializationKeyStability (32).
        let has_culture_invariant = package.summary.has_culture_invariant_text()
            && read_archive_bool(payload, &format!("{path}.CultureInvariant"))?;
        let source = if has_culture_invariant {
            payload.read_fstring(&format_args!("{path}.CultureInvariantString"))?
        } else {
            String::new()
        };
        return Ok(Some(TextValue {
            source,
            history: TextHistory::None,
        }));
    }

    if history_type == 0 {
        let namespace = payload.read_fstring(&format_args!("{path}.Namespace"))?;
        let key = payload.read_fstring(&format_args!("{path}.Key"))?;
        let source = payload.read_fstring(&format_args!("{path}.SourceString"))?;
        let dev_notes = if package.summary.has_text_dev_notes() {
            payload.read_fstring(&format_args!("{path}.DevNotes"))?
        } else {
            String::new()
        };
        return Ok(Some(TextValue {
            source,
            history: TextHistory::Base {
                namespace,
                key,
                dev_notes,
            },
        }));
    }

    // `ETextHistoryType::StringTableEntry` is index 11 in UE 5.7. Its
    // serializer writes an FName table ID followed by an FString-backed
    // FTextKey. The source/display string belongs to the referenced table and
    // is intentionally not present in this property payload.
    if history_type == 11 {
        let table_id_ref = payload.read_name_ref(&format_args!("{path}.TableId"))?;
        let table_id = package.resolve_name(table_id_ref).ok_or_else(|| {
            PropertyError::new(
                crate::property::PropertyErrorKind::MalformedData,
                Some(payload.tell().saturating_sub(8)),
                path,
                "string-table text has an unresolved table ID",
            )
        })?;
        let key = payload.read_fstring(&format_args!("{path}.Key"))?;
        return Ok(Some(TextValue {
            source: String::new(),
            history: TextHistory::StringTableEntry { table_id, key },
        }));
    }

    Err(PropertyError::new(
        crate::property::PropertyErrorKind::UnsupportedCapability,
        Some(payload.tell() - 1),
        path,
        format!("unsupported text history {history_type}"),
    )
    .with_raw_reason(RawReason::UnsupportedTextHistory(history_type)))
}

fn decode_guid_value(
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<crate::archive::Guid, PropertyError> {
    if payload.remaining() != 16 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("unsupported FGuid payload size {}", payload.remaining()),
        ));
    }
    payload.read_guid(path).map_err(PropertyError::from)
}

fn decode_frame_range_value(
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<FrameRangeValue, PropertyError> {
    if payload.remaining() != 10 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!(
                "unsupported FMovieSceneFrameRange payload size {}",
                payload.remaining()
            ),
        ));
    }

    Ok(FrameRangeValue {
        lower: decode_frame_range_bound(payload, &format!("{path}.LowerBound"))?,
        upper: decode_frame_range_bound(payload, &format!("{path}.UpperBound"))?,
    })
}

fn decode_frame_range_bound(
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<FrameRangeBound, PropertyError> {
    let offset = payload.tell();
    let kind = match payload.read_u8(&format_args!("{path}.Type"))? {
        0 => RangeBoundKind::Exclusive,
        1 => RangeBoundKind::Inclusive,
        2 => RangeBoundKind::Open,
        value => {
            return Err(PropertyError::new(
                crate::property::PropertyErrorKind::MalformedData,
                Some(offset),
                path,
                format!("invalid range-bound type {value}"),
            ));
        }
    };
    let value = payload.read_i32(&format_args!("{path}.Value"))?;
    Ok(FrameRangeBound { kind, value })
}

/// `FColor` serializes its channels in `B, G, R, A` byte order.
fn decode_color_value(payload: &mut Reader<'_>, path: &str) -> Result<ColorValue, PropertyError> {
    if payload.remaining() != 4 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!("unsupported FColor payload size {}", payload.remaining()),
        ));
    }
    let b = payload.read_u8(&format_args!("{path}.B"))?;
    let g = payload.read_u8(&format_args!("{path}.G"))?;
    let r = payload.read_u8(&format_args!("{path}.R"))?;
    let a = payload.read_u8(&format_args!("{path}.A"))?;
    Ok(ColorValue { r, g, b, a })
}

/// `FLinearColor` serializes four `f32` channels in `R, G, B, A` order.
fn decode_linear_color_value(
    payload: &mut Reader<'_>,
    path: &str,
) -> Result<LinearColorValue, PropertyError> {
    if payload.remaining() != 16 {
        return Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(payload.tell()),
            path,
            format!(
                "unsupported FLinearColor payload size {}",
                payload.remaining()
            ),
        ));
    }
    Ok(LinearColorValue {
        r: payload.read_f32(&format_args!("{path}.R"))?,
        g: payload.read_f32(&format_args!("{path}.G"))?,
        b: payload.read_f32(&format_args!("{path}.B"))?,
        a: payload.read_f32(&format_args!("{path}.A"))?,
    })
}

fn resolve_struct_type_path(
    package: &Package,
    type_tree: &PropertyTypeName,
) -> Option<&'static str> {
    let identity = type_tree.parameters.first()?;
    let name = package.resolve_name_cow(identity.name)?;
    let module = package.resolve_name_cow(identity.parameters.first()?.name)?;
    native_values::property_type_path(&module, &name)
}

fn resolve_math_struct_name<'a>(
    package: &'a Package,
    type_tree: &PropertyTypeName,
) -> Option<std::borrow::Cow<'a, str>> {
    let identity = type_tree.parameters.first()?;
    if let Some(module) = identity.parameters.first()
        && package.resolve_name_cow(module.name).as_deref() != Some("/Script/CoreUObject")
    {
        return None;
    }
    package.resolve_name_cow(identity.name)
}

fn resolve_struct_type_name<'a>(
    package: &'a Package,
    type_tree: &PropertyTypeName,
) -> Option<std::borrow::Cow<'a, str>> {
    package.resolve_name_cow(type_tree.parameters.first()?.name)
}

fn read_archive_bool(reader: &mut Reader<'_>, path: &str) -> Result<bool, PropertyError> {
    let offset = reader.tell();
    match reader.read_u32(path)? {
        0 => Ok(false),
        1 => Ok(true),
        value => Err(PropertyError::new(
            crate::property::PropertyErrorKind::MalformedData,
            Some(offset),
            path,
            format!("serialized bool must be 0 or 1, got {value}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{Guid, Reader, Span};
    use crate::package::test_package;
    use crate::property::{
        ColorValue, LinearColorValue, PropertyError, PropertyErrorKind, PropertyRecord,
        PropertyStream, PropertyTagFlags, PropertyTypeName, PropertyValue, RawReason, RotatorValue,
        TextHistory, TextValue, VectorValue, read_tagged_property_stream,
    };
    use crate::test_support::{
        TypeParam, push_f32, push_f64, push_fstring, push_i32, ue5_versions, write_property_tag,
        write_property_terminator,
    };

    fn decode_record(
        names: Vec<String>,
        type_index: i32,
        type_params: Vec<PropertyTypeName>,
        flags: PropertyTagFlags,
        payload: &[u8],
    ) -> PropertyValue {
        decode_record_result(names, type_index, type_params, flags, payload).expect("decode record")
    }

    fn decode_record_result(
        names: Vec<String>,
        type_index: i32,
        type_params: Vec<PropertyTypeName>,
        flags: PropertyTagFlags,
        payload: &[u8],
    ) -> Result<PropertyValue, PropertyError> {
        decode_record_with_package(test_package(names), type_index, type_params, flags, payload)
    }

    fn decode_record_with_package(
        package: Package,
        type_index: i32,
        type_params: Vec<PropertyTypeName>,
        flags: PropertyTagFlags,
        payload: &[u8],
    ) -> Result<PropertyValue, PropertyError> {
        let source = payload.to_vec();
        let record = PropertyRecord {
            name: crate::test_support::name_ref(0, 0),
            type_name: PropertyTypeName {
                name: crate::test_support::name_ref(type_index, 0),
                parameters: type_params,
            },
            array_index: 0,
            flags,
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, source.len() as u64).expect("payload span"),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        };
        let mut record = record;
        decode_property_record(&source, &mut record, &package, 0)?;
        Ok(record.value)
    }

    fn decode_stream(payload: &[u8]) -> PropertyStream {
        let bytes = payload.to_vec();
        let names = vec![
            "None".into(),
            "NestedInt".into(),
            "IntProperty".into(),
            "NestedVector".into(),
            "StructProperty".into(),
            "Vector".into(),
        ];
        let mut reader = Reader::new(&bytes);
        let mut stream =
            read_tagged_property_stream(&mut reader, &ue5_versions(), &names, "Test.Struct")
                .expect("parse struct stream");
        let package = test_package(names);
        decode_property_stream_values(&bytes, &mut stream, &package).expect("decode struct");
        stream
    }

    fn versioned_package(names: &[&str], ue5: i32) -> Package {
        let mut package = test_package(names.iter().map(|name| (*name).to_owned()).collect());
        package.summary.versions.ue5 = ue5;
        package
    }

    fn legacy_extras(parameters: &[i32], struct_tag: bool, ue5: i32) -> Vec<u8> {
        let mut extras = Vec::new();
        for parameter in parameters {
            push_i32(&mut extras, *parameter);
            push_i32(&mut extras, 0);
        }
        if struct_tag {
            extras.extend_from_slice(&[0; 16]);
        }
        extras.push(0);
        if ue5 >= 1011 {
            extras.push(0);
        }
        extras
    }

    #[test]
    fn legacy_codec_failure_keeps_the_next_record_at_its_boundary() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1000, 1010, 1011] {
            let package = versioned_package(&["None", "Value", "IntProperty"], ue5);
            let mut bytes = Vec::new();
            let extras = legacy_extras(&[], false, ue5);
            write_legacy_property_tag(&mut bytes, 1, 2, &extras, &[0xFF]);
            write_legacy_property_tag(&mut bytes, 1, 2, &extras, &42_i32.to_le_bytes());
            write_property_terminator(&mut bytes, 0);
            let mut reader = Reader::new(&bytes);
            let mut stream = read_tagged_property_stream(
                &mut reader,
                &package.summary.versions,
                &package.names,
                "Test",
            )
            .unwrap();
            decode_property_stream_values(&bytes, &mut stream, &package).unwrap();
            assert!(matches!(
                stream.records[0].value,
                PropertyValue::Raw {
                    reason: RawReason::LegacyDecoderRejected(_)
                }
            ));
            assert_eq!(stream.records[0].payload.len(), 1);
            assert_eq!(stream.records[1].value, PropertyValue::Int(42));
            assert_eq!(reader.tell(), bytes.len() as u64);
        }
    }

    #[test]
    fn math_struct_components_and_array_strides_follow_lwc_and_inner_tag_gates() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1003, 1004, 1005, 1011, 1012, 1013] {
            for (name, components) in [
                ("Vector", 3),
                ("Vector2D", 2),
                ("Vector4", 4),
                ("Rotator", 3),
                ("Quat", 4),
                ("Plane", 4),
                ("Box", 6),
                ("Box2D", 4),
                ("Matrix", 16),
            ] {
                let package = versioned_package(
                    &["None", "Value", "StructProperty", "ArrayProperty", name],
                    ue5,
                );
                let mut element = Vec::new();
                for index in 0..components {
                    if ue5 >= 1004 {
                        push_f64(&mut element, f64::from(index) + 0.25);
                    } else {
                        push_f32(&mut element, index as f32 + 0.25);
                    }
                }
                if matches!(name, "Box" | "Box2D") {
                    element.push(1);
                }
                let struct_type = PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: vec![PropertyTypeName {
                        name: crate::test_support::name_ref(4, 0),
                        parameters: vec![],
                    }],
                };
                let scalar = decode_record_with_package(
                    package.clone(),
                    2,
                    struct_type.parameters.clone(),
                    PropertyTagFlags(0),
                    &element,
                )
                .unwrap();
                assert!(
                    !matches!(scalar, PropertyValue::Raw { .. }),
                    "{name}, {ue5}"
                );
                let mut array = Vec::new();
                push_i32(&mut array, 2);
                let mut elements = element.clone();
                elements.extend_from_slice(&element);
                if ue5 < 1012 {
                    write_legacy_property_tag(
                        &mut array,
                        1,
                        2,
                        &legacy_extras(&[4], true, ue5),
                        &elements,
                    );
                } else {
                    array.extend_from_slice(&elements);
                }
                let inner = if ue5 < 1012 {
                    PropertyTypeName {
                        name: crate::test_support::name_ref(2, 0),
                        parameters: vec![],
                    }
                } else {
                    struct_type
                };
                let value = decode_record_with_package(
                    package.clone(),
                    3,
                    vec![inner.clone()],
                    PropertyTagFlags(0),
                    &array,
                )
                .unwrap();
                assert_eq!(
                    value,
                    PropertyValue::Array(vec![scalar.clone(), scalar]),
                    "{name}, {ue5}"
                );
                array.pop();
                let malformed = decode_record_with_package(
                    package,
                    3,
                    vec![inner],
                    PropertyTagFlags(0),
                    &array,
                );
                if ue5 < 1012 {
                    assert!(matches!(malformed.unwrap(), PropertyValue::Raw { .. }));
                } else {
                    assert!(malformed.is_err());
                }
            }
        }
    }

    #[test]
    fn complete_math_identities_do_not_match_a_project_module() {
        for name in ["Vector", "Quat", "Box", "Box2D", "Matrix"] {
            let package = versioned_package(&["StructProperty", name, "/Script/Fixture"], 1012);
            let value = decode_record_with_package(
                package,
                0,
                vec![PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: vec![PropertyTypeName {
                        name: crate::test_support::name_ref(2, 0),
                        parameters: vec![],
                    }],
                }],
                PropertyTagFlags(0x08),
                &[0; 49],
            )
            .unwrap();
            assert_eq!(
                value,
                PropertyValue::Raw {
                    reason: RawReason::UnsupportedType
                }
            );
        }
    }

    #[test]
    fn legacy_user_defined_guids_preserve_colliding_scalar_and_array_text() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1000, 1009, 1011] {
            for name in [
                "Vector",
                "Vector2D",
                "Quat",
                "Guid",
                "RichCurveKey",
                "DataTableRowHandle",
            ] {
                let package = versioned_package(
                    &[
                        "None",
                        "Value",
                        "StructProperty",
                        "ArrayProperty",
                        name,
                        "Caption",
                        "TextProperty",
                        "IntProperty",
                    ],
                    ue5,
                );
                let mut text = Vec::new();
                push_i32(&mut text, 0);
                text.push(0); // FTextHistory::Base
                for value in ["Fixture", "Caption", "Hello"] {
                    push_fstring(&mut text, value);
                }
                if package.summary.has_text_dev_notes() {
                    push_fstring(&mut text, "Translator note");
                }
                let mut fields = Vec::new();
                write_legacy_property_tag(
                    &mut fields,
                    5,
                    6,
                    &legacy_extras(&[], false, ue5),
                    &text,
                );
                write_property_terminator(&mut fields, 0);
                let mut struct_extras = legacy_extras(&[4], true, ue5);
                struct_extras[8..24].fill(1); // UUserDefinedStruct::GetCustomGuid
                for array in [false, true] {
                    let mut bytes = Vec::new();
                    if array {
                        let mut payload = Vec::new();
                        push_i32(&mut payload, 2);
                        let mut elements = fields.clone();
                        elements.extend_from_slice(&fields);
                        write_legacy_property_tag(&mut payload, 1, 2, &struct_extras, &elements);
                        write_legacy_property_tag(
                            &mut bytes,
                            1,
                            3,
                            &legacy_extras(&[2], false, ue5),
                            &payload,
                        );
                    } else {
                        write_legacy_property_tag(&mut bytes, 1, 2, &struct_extras, &fields);
                    }
                    write_legacy_property_tag(
                        &mut bytes,
                        1,
                        7,
                        &legacy_extras(&[], false, ue5),
                        &42_i32.to_le_bytes(),
                    );
                    write_property_terminator(&mut bytes, 0);
                    let mut reader = Reader::new(&bytes);
                    let mut stream = read_tagged_property_stream(
                        &mut reader,
                        &package.summary.versions,
                        &package.names,
                        "Test",
                    )
                    .unwrap();
                    decode_property_stream_values(&bytes, &mut stream, &package).unwrap();
                    let values = match &stream.records[0].value {
                        PropertyValue::Array(values) if array => values.iter().collect::<Vec<_>>(),
                        value if !array => vec![value],
                        value => panic!("{name}, {ue5}: expected struct array, got {value:?}"),
                    };
                    assert_eq!(values.len(), if array { 2 } else { 1 });
                    for value in values {
                        let PropertyValue::Struct(nested) = value else {
                            panic!("{name}, {ue5}: expected tagged struct, got {value:?}");
                        };
                        assert_eq!(nested.records.len(), 1);
                        assert_eq!(
                            nested.records[0].value,
                            PropertyValue::Text(TextValue {
                                source: "Hello".into(),
                                history: TextHistory::Base {
                                    namespace: "Fixture".into(),
                                    key: "Caption".into(),
                                    dev_notes: if package.summary.has_text_dev_notes() {
                                        "Translator note".into()
                                    } else {
                                        String::new()
                                    }
                                }
                            }),
                            "{name}, {ue5}, array={array}"
                        );
                    }
                    assert_eq!(stream.records[1].value, PropertyValue::Int(42));
                    assert_eq!(reader.tell(), bytes.len() as u64);
                }
            }
        }
    }

    #[test]
    fn legacy_transform_members_keep_tagged_framing_and_versioned_components() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1003, 1004, 1005] {
            let package = versioned_package(
                &[
                    "None",
                    "Value",
                    "StructProperty",
                    "Transform",
                    "Quat",
                    "Vector",
                    "Rotation",
                    "Translation",
                    "Scale3D",
                ],
                ue5,
            );
            let mut bytes = Vec::new();
            for (field, kind, count) in [(6, 4, 4), (7, 5, 3), (8, 5, 3)] {
                let mut payload = Vec::new();
                for _ in 0..count {
                    if ue5 >= 1004 {
                        push_f64(&mut payload, 1.25);
                    } else {
                        push_f32(&mut payload, 1.25);
                    }
                }
                write_legacy_property_tag(
                    &mut bytes,
                    field,
                    2,
                    &legacy_extras(&[kind], true, ue5),
                    &payload,
                );
            }
            write_property_terminator(&mut bytes, 0);
            let value = decode_record_with_package(
                package,
                2,
                vec![PropertyTypeName {
                    name: crate::test_support::name_ref(3, 0),
                    parameters: vec![],
                }],
                PropertyTagFlags(0),
                &bytes,
            )
            .unwrap();
            let PropertyValue::Struct(stream) = value else {
                panic!("Transform must stay tagged");
            };
            assert_eq!(stream.records.len(), 3);
            assert!(matches!(
                stream.records[0].value,
                PropertyValue::NativeStruct { .. }
            ));
            for record in &stream.records[1..] {
                assert_eq!(
                    record.value,
                    PropertyValue::Vector(VectorValue {
                        x: 1.25,
                        y: 1.25,
                        z: 1.25,
                    })
                );
            }
        }
    }

    #[test]
    fn soft_path_name_and_table_gates_include_empty_tables() {
        for ue5 in [0, 1006, 1007, 1008, 1009] {
            for table in [false, true] {
                let mut package = versioned_package(
                    &[
                        "SoftObjectProperty",
                        "/Game/Fixture.Asset",
                        "/Game/Fixture",
                        "Asset",
                        "None",
                    ],
                    ue5,
                );
                if table {
                    package.soft_object_paths = vec!["/Game/Fixture.Asset:Child".into()];
                }
                let mut bytes = Vec::new();
                if ue5 >= 1008 && table {
                    push_i32(&mut bytes, 0);
                } else {
                    let names = if ue5 < 1007 {
                        vec![1, 0]
                    } else {
                        vec![2, 0, 3, 0]
                    };
                    for word in names {
                        push_i32(&mut bytes, word);
                    }
                    push_fstring(&mut bytes, "Child");
                }
                let value = decode_record_with_package(
                    package.clone(),
                    0,
                    vec![],
                    PropertyTagFlags(0),
                    &bytes,
                )
                .unwrap();
                assert_eq!(
                    value,
                    PropertyValue::SoftObjectPath("/Game/Fixture.Asset:Child".into())
                );
                if ue5 >= 1008 && table {
                    let invalid = decode_record_with_package(
                        package,
                        0,
                        vec![],
                        PropertyTagFlags(0),
                        &(-1_i32).to_le_bytes(),
                    )
                    .unwrap();
                    assert!(matches!(
                        invalid,
                        PropertyValue::Raw {
                            reason: RawReason::LegacyDecoderRejected(_)
                        }
                    ));
                }
            }
        }
    }

    #[test]
    fn culture_invariant_text_uses_editor_custom_versions_in_both_legacy_lanes() {
        use crate::test_support::editor_text_version;
        for ue5 in [0, 1009] {
            for version in [None, Some(31), Some(32), Some(33)] {
                for invariant in [false, true] {
                    let mut package = versioned_package(&["TextProperty"], ue5);
                    editor_text_version(&mut package, version);
                    let gated = version.is_some_and(|version| version >= 32);
                    let mut bytes = vec![0, 0, 0, 0, 255];
                    if gated {
                        push_i32(&mut bytes, i32::from(invariant));
                        if invariant {
                            push_fstring(&mut bytes, "Invariant");
                        }
                    }
                    let value =
                        decode_record_with_package(package, 0, vec![], PropertyTagFlags(0), &bytes)
                            .unwrap();
                    assert_eq!(
                        value,
                        PropertyValue::Text(TextValue {
                            source: if gated && invariant {
                                "Invariant".into()
                            } else {
                                String::new()
                            },
                            history: TextHistory::None,
                        })
                    );
                }
            }
        }
    }

    #[test]
    fn legacy_map_and_set_structs_attempt_tagged_streams_and_never_guess_widths() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1009, 1010, 1011] {
            for (kind, parameters) in [(4, vec![2]), (5, vec![2, 3]), (5, vec![3, 2])] {
                let package = versioned_package(
                    &[
                        "None",
                        "Value",
                        "StructProperty",
                        "IntProperty",
                        "SetProperty",
                        "MapProperty",
                    ],
                    ue5,
                );
                for tagged in [true, false] {
                    let mut nested = Vec::new();
                    if tagged {
                        write_legacy_property_tag(
                            &mut nested,
                            1,
                            3,
                            &legacy_extras(&[], false, ue5),
                            &7_i32.to_le_bytes(),
                        );
                        write_property_terminator(&mut nested, 0);
                    } else {
                        nested.extend_from_slice(&[0xFF; 24]);
                    }
                    let mut payload = Vec::new();
                    push_i32(&mut payload, 0);
                    push_i32(&mut payload, 1);
                    for parameter in &parameters {
                        if *parameter == 2 {
                            payload.extend_from_slice(&nested);
                        } else {
                            push_i32(&mut payload, 42);
                        }
                    }
                    let mut bytes = Vec::new();
                    write_legacy_property_tag(
                        &mut bytes,
                        1,
                        kind,
                        &legacy_extras(&parameters, false, ue5),
                        &payload,
                    );
                    write_legacy_property_tag(
                        &mut bytes,
                        1,
                        3,
                        &legacy_extras(&[], false, ue5),
                        &99_i32.to_le_bytes(),
                    );
                    write_property_terminator(&mut bytes, 0);
                    let mut reader = Reader::new(&bytes);
                    let mut stream = read_tagged_property_stream(
                        &mut reader,
                        &package.summary.versions,
                        &package.names,
                        "Test",
                    )
                    .unwrap();
                    decode_property_stream_values(&bytes, &mut stream, &package).unwrap();
                    if tagged {
                        assert!(!matches!(
                            stream.records[0].value,
                            PropertyValue::Raw { .. }
                        ));
                    } else {
                        assert_eq!(
                            stream.records[0].value,
                            PropertyValue::Raw {
                                reason: RawReason::LegacyContainerElementWithoutTypeInformation
                            }
                        );
                    }
                    assert_eq!(stream.records[1].value, PropertyValue::Int(99));
                    assert_eq!(reader.tell(), bytes.len() as u64);
                }
            }
        }
    }

    #[test]
    fn complete_tags_keep_errors_for_malformed_container_structs() {
        for ue5 in [1012, 1013] {
            let package = versioned_package(&["SetProperty", "StructProperty"], ue5);
            let mut payload = Vec::new();
            push_i32(&mut payload, 0);
            push_i32(&mut payload, 1);
            payload.extend_from_slice(&[0xFF; 24]);
            let error = decode_record_with_package(
                package,
                0,
                vec![PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: vec![],
                }],
                PropertyTagFlags(0),
                &payload,
            )
            .unwrap_err();
            assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        }
    }

    fn type_tree(index: i32, parameters: Vec<PropertyTypeName>) -> PropertyTypeName {
        PropertyTypeName {
            name: crate::test_support::name_ref(index, 0),
            parameters,
        }
    }

    #[test]
    fn complete_container_elements_decode_core_binary_structs() {
        for ue5 in [1012, 1018] {
            let package = versioned_package(
                &[
                    "SetProperty",
                    "ArrayProperty",
                    "MapProperty",
                    "StructProperty",
                    "IntPoint",
                    "Color",
                    "LinearColor",
                    "/Script/CoreUObject",
                    "IntProperty",
                ],
                ue5,
            );
            let core = |index| type_tree(3, vec![type_tree(index, vec![type_tree(7, vec![])])]);
            let decode = |kind, parameters, payload: &[u8]| {
                decode_record_with_package(
                    package.clone(),
                    kind,
                    parameters,
                    PropertyTagFlags(0),
                    payload,
                )
            };

            // TSet<FIntPoint>: ElementsToRemove, Elements, then 8 bytes per element.
            let mut set = Vec::new();
            for value in [0, 2, 1, -2, 3, 4] {
                push_i32(&mut set, value);
            }
            assert_eq!(
                decode(0, vec![core(4)], &set).unwrap(),
                PropertyValue::Set(vec![
                    PropertyValue::IntPoint(IntPointValue { x: 1, y: -2 }),
                    PropertyValue::IntPoint(IntPointValue { x: 3, y: 4 }),
                ])
            );
            set.pop();
            assert!(decode(0, vec![core(4)], &set).is_err(), "truncated set");

            // TArray<FColor> keeps the B, G, R, A byte order.
            let mut colors = Vec::new();
            push_i32(&mut colors, 1);
            colors.extend_from_slice(&[1, 2, 3, 4]);
            assert_eq!(
                decode(1, vec![core(5)], &colors).unwrap(),
                PropertyValue::Array(vec![PropertyValue::Color(ColorValue {
                    r: 3,
                    g: 2,
                    b: 1,
                    a: 4
                })])
            );

            // TArray<FLinearColor> is four floats per element, never a tagged stream.
            let mut linear = Vec::new();
            push_i32(&mut linear, 2);
            for value in [0.25_f32, 0.5, 0.75, 1.0, -1.0, 2.0, 0.0, 0.5] {
                push_f32(&mut linear, value);
            }
            assert_eq!(
                decode(1, vec![core(6)], &linear).unwrap(),
                PropertyValue::Array(vec![
                    PropertyValue::LinearColor(LinearColorValue {
                        r: 0.25,
                        g: 0.5,
                        b: 0.75,
                        a: 1.0
                    }),
                    PropertyValue::LinearColor(LinearColorValue {
                        r: -1.0,
                        g: 2.0,
                        b: 0.0,
                        a: 0.5
                    }),
                ])
            );

            // TMap<FIntPoint, int32>: the binary key leaves the value aligned.
            let mut map = Vec::new();
            for value in [0, 1, 5, 6, 7] {
                push_i32(&mut map, value);
            }
            assert_eq!(
                decode(2, vec![core(4), type_tree(8, vec![])], &map).unwrap(),
                PropertyValue::Map(vec![MapEntry {
                    key: PropertyValue::IntPoint(IntPointValue { x: 5, y: 6 }),
                    value: PropertyValue::Int(7),
                }])
            );

            // The same short names from another module are not guessed as binary.
            let project = versioned_package(
                &[
                    "SetProperty",
                    "StructProperty",
                    "IntPoint",
                    "/Script/Project",
                    "None",
                ],
                ue5,
            );
            let mut set = Vec::new();
            for value in [0, 1, 1, 2] {
                push_i32(&mut set, value);
            }
            let value = decode_record_with_package(
                project,
                0,
                vec![type_tree(1, vec![type_tree(2, vec![type_tree(3, vec![])])])],
                PropertyTagFlags(0x08),
                &set,
            )
            .unwrap();
            assert!(matches!(value, PropertyValue::Raw { .. }), "{value:?}");
        }
    }

    const UNKNOWN_STRUCT_NAMES: &[&str] = &[
        "None",
        "Values",
        "SetProperty",
        "StructProperty",
        "Mystery",
        "/Script/Project",
        "IntProperty",
        "Next",
        "MapProperty",
        "Holder",
        "IntPoint",
        "/Script/CoreUObject",
        "S_Row",
        "/Game/Data/S_Row",
        "AnimNotifyEvent",
        "/Script/Engine",
    ];

    fn struct_param(name: i32, module: i32) -> crate::test_support::TypeParam {
        use crate::test_support::TypeParam;
        TypeParam {
            type_index: 3,
            parameters: vec![TypeParam {
                type_index: name,
                parameters: vec![TypeParam {
                    type_index: module,
                    parameters: vec![],
                }],
            }],
        }
    }

    fn int_param() -> crate::test_support::TypeParam {
        crate::test_support::TypeParam {
            type_index: 6,
            parameters: vec![],
        }
    }

    /// A stream holding one container property `Values` with `flags`, then `Next = 99`.
    fn container_stream(
        container: crate::test_support::TypeParam,
        flags: u8,
        payload: &[u8],
    ) -> (Package, Vec<u8>) {
        let package = versioned_package(UNKNOWN_STRUCT_NAMES, 1018);
        let mut bytes = Vec::new();
        write_property_tag(&mut bytes, 1, &container, flags, payload);
        crate::test_support::write_int_property_tag(&mut bytes, 7, 6, 99);
        write_property_terminator(&mut bytes, 0);
        (package, bytes)
    }

    /// `TSet<Mystery>` with the given elements and container tag flags.
    fn unknown_struct_set(flags: u8, elements: &[&[u8]]) -> (Package, Vec<u8>) {
        let mut payload = Vec::new();
        push_i32(&mut payload, 0);
        push_i32(&mut payload, i32::try_from(elements.len()).unwrap());
        for element in elements {
            payload.extend_from_slice(element);
        }
        container_stream(
            crate::test_support::TypeParam {
                type_index: 2,
                parameters: vec![struct_param(4, 5)],
            },
            flags,
            &payload,
        )
    }

    fn tagged_int_struct(value: i32) -> Vec<u8> {
        let mut element = Vec::new();
        crate::test_support::write_int_property_tag(&mut element, 7, 6, value);
        write_property_terminator(&mut element, 0);
        element
    }

    fn decode_unknown_struct_stream(
        package: &Package,
        bytes: &[u8],
    ) -> Result<PropertyStream, PropertyError> {
        let mut reader = Reader::new(bytes);
        let mut stream = read_tagged_property_stream(
            &mut reader,
            &package.summary.versions,
            &package.names,
            "Test",
        )?;
        decode_property_stream_values(bytes, &mut stream, package)?;
        Ok(stream)
    }

    fn assert_skipped(stream: &PropertyStream) {
        let PropertyValue::Raw {
            reason: RawReason::DecoderRejected(reason),
        } = &stream.records[0].value
        else {
            panic!(
                "expected a skipped property, got {:?}",
                stream.records[0].value
            );
        };
        assert!(reason.starts_with("skipped: struct "), "{reason}");
        assert_eq!(stream.records[1].value, PropertyValue::Int(99));
    }

    #[test]
    fn complete_tags_skip_native_container_structs_without_guessing() {
        // Native bytes that fail as a tagged stream.
        let (package, bytes) = unknown_struct_set(0x08, &[&[0xFF; 24]]);
        assert_skipped(&decode_unknown_struct_stream(&package, &bytes).expect("export survives"));

        // A native int64 equal to the `None` name index is also a valid empty tagged struct.
        // Only the container's binary-or-native flag tells the two apart.
        let native_none = 0_i64.to_le_bytes();
        let (package, bytes) = unknown_struct_set(0x08, &[&native_none]);
        assert_skipped(&decode_unknown_struct_stream(&package, &bytes).expect("export survives"));
        let (package, bytes) = unknown_struct_set(0x00, &[&native_none]);
        let stream = decode_unknown_struct_stream(&package, &bytes).expect("tagged evidence");
        assert!(
            matches!(&stream.records[0].value, PropertyValue::Set(values)
                if matches!(values.as_slice(), [PropertyValue::Struct(inner)] if inner.records.is_empty())),
            "{:?}",
            stream.records[0].value
        );

        // Several native elements: the whole property is skipped, the stream stays aligned.
        let (package, bytes) = unknown_struct_set(0x08, &[&native_none, &7_i64.to_le_bytes()]);
        assert_skipped(&decode_unknown_struct_stream(&package, &bytes).expect("export survives"));
    }

    #[test]
    fn complete_tags_decode_unknown_container_structs_only_with_tagged_evidence() {
        let (first, second) = (tagged_int_struct(5), tagged_int_struct(6));
        let (package, bytes) = unknown_struct_set(0x00, &[&first, &second]);
        let stream = decode_unknown_struct_stream(&package, &bytes).expect("tagged elements");
        let PropertyValue::Set(values) = &stream.records[0].value else {
            panic!("expected a set, got {:?}", stream.records[0].value);
        };
        let ints: Vec<_> = values
            .iter()
            .map(|value| match value {
                PropertyValue::Struct(inner) => inner.records[0].value.clone(),
                other => panic!("expected a tagged struct, got {other:?}"),
            })
            .collect();
        assert_eq!(ints, vec![PropertyValue::Int(5), PropertyValue::Int(6)]);
        assert_eq!(stream.records[1].value, PropertyValue::Int(99));

        // With tagged evidence, bytes that are not a tagged stream are malformed data.
        let (package, bytes) = unknown_struct_set(0x00, &[&[0xFF; 24]]);
        assert!(decode_unknown_struct_stream(&package, &bytes).is_err());

        // A source-checked native struct whose Serialize falls back to tagged data decodes
        // under the binary-or-native flag; the same short name in another module does not.
        let set_of = |name: i32, module: i32| crate::test_support::TypeParam {
            type_index: 2,
            parameters: vec![struct_param(name, module)],
        };
        let mut payload = Vec::new();
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 1);
        payload.extend_from_slice(&tagged_int_struct(5));
        let (package, bytes) = container_stream(set_of(14, 15), 0x08, &payload);
        let stream = decode_unknown_struct_stream(&package, &bytes).expect("tagged fallback");
        assert!(
            matches!(&stream.records[0].value, PropertyValue::Set(values)
                if matches!(values.as_slice(), [PropertyValue::Struct(_)])),
            "{:?}",
            stream.records[0].value
        );
        let (package, bytes) = container_stream(set_of(14, 5), 0x08, &payload);
        assert_skipped(&decode_unknown_struct_stream(&package, &bytes).expect("export survives"));
    }

    #[test]
    fn complete_map_tags_gate_unknown_keys_and_values_on_the_shared_flag() {
        use crate::test_support::TypeParam;
        let map = |key: TypeParam, value: TypeParam| TypeParam {
            type_index: 8,
            parameters: vec![key, value],
        };
        let entries = |pairs: &[(&[u8], &[u8])]| {
            let mut payload = Vec::new();
            push_i32(&mut payload, 0);
            push_i32(&mut payload, i32::try_from(pairs.len()).unwrap());
            for (key, value) in pairs {
                payload.extend_from_slice(key);
                payload.extend_from_slice(value);
            }
            payload
        };
        let decode = |container: TypeParam, flags: u8, payload: &[u8]| {
            let (package, bytes) = container_stream(container, flags, payload);
            decode_unknown_struct_stream(&package, &bytes).expect("export survives")
        };
        let native = 0_i64.to_le_bytes();
        let seven = 7_i32.to_le_bytes();

        // TMap<Mystery, int32>: a set flag can only come from the struct key.
        assert_skipped(&decode(
            map(struct_param(4, 5), int_param()),
            0x08,
            &entries(&[(&native, &seven), (&native, &seven)]),
        ));

        // TMap<FIntPoint, Mystery>: the binary key sets the flag, so the value is unproven.
        let point = [1_i32.to_le_bytes(), 2_i32.to_le_bytes()].concat();
        let value = tagged_int_struct(5);
        assert_skipped(&decode(
            map(struct_param(10, 11), struct_param(4, 5)),
            0x08,
            &entries(&[(&point, &value)]),
        ));

        // A user-defined struct is always tagged, even next to a binary key.
        let stream = decode(
            map(struct_param(10, 11), struct_param(12, 13)),
            0x08,
            &entries(&[(&point, &value)]),
        );
        let PropertyValue::Map(decoded) = &stream.records[0].value else {
            panic!("expected a map, got {:?}", stream.records[0].value);
        };
        assert_eq!(
            decoded[0].key,
            PropertyValue::IntPoint(IntPointValue { x: 1, y: 2 })
        );
        assert!(matches!(&decoded[0].value, PropertyValue::Struct(inner)
            if inner.records[0].value == PropertyValue::Int(5)));

        // TMap<int32, Mystery> without the flag: every value is a tagged stream.
        let (five, six) = (tagged_int_struct(5), tagged_int_struct(6));
        let stream = decode(
            map(int_param(), struct_param(4, 5)),
            0x00,
            &entries(&[(&seven, &five), (&seven, &six)]),
        );
        assert!(
            matches!(&stream.records[0].value, PropertyValue::Map(entries) if entries.len() == 2),
            "{:?}",
            stream.records[0].value
        );
        assert_eq!(stream.records[1].value, PropertyValue::Int(99));
    }

    #[test]
    fn native_container_struct_inside_a_tagged_struct_skips_only_the_inner_property() {
        use crate::test_support::TypeParam;
        // A tagged struct holding a binary-flagged container of a natively serialized struct.
        // Only the container is skipped; the struct and the outer stream survive.
        let (package, inner) = unknown_struct_set(0x08, &[&[0xFF; 24]]);
        let mut bytes = Vec::new();
        write_property_tag(
            &mut bytes,
            9,
            &TypeParam {
                type_index: 3,
                parameters: vec![TypeParam {
                    type_index: 9,
                    parameters: vec![TypeParam {
                        type_index: 5,
                        parameters: vec![],
                    }],
                }],
            },
            0,
            &inner,
        );
        write_property_terminator(&mut bytes, 0);
        let stream = decode_unknown_struct_stream(&package, &bytes).expect("export survives");
        let PropertyValue::Struct(holder) = &stream.records[0].value else {
            panic!(
                "expected the holder struct, got {:?}",
                stream.records[0].value
            );
        };
        assert!(matches!(holder.records[0].value, PropertyValue::Raw { .. }));
        assert_eq!(holder.records[1].value, PropertyValue::Int(99));
    }

    #[test]
    fn legacy_native_features_keep_their_existing_version_messages() {
        for ue5 in [0, 1009, 1011] {
            for (name, message) in [
                ("InstancedStruct", "InstancedStruct"),
                ("InstancedPropertyBag", "property bags"),
                ("EdGraphPinType", "pin type"),
                ("MovieSceneFloatChannel", "native numeric channels"),
            ] {
                let package = versioned_package(&["StructProperty", name], ue5);
                let value = decode_record_with_package(
                    package,
                    0,
                    vec![PropertyTypeName {
                        name: crate::test_support::name_ref(1, 0),
                        parameters: vec![],
                    }],
                    PropertyTagFlags(0),
                    &[],
                )
                .unwrap();
                let PropertyValue::Raw {
                    reason: RawReason::FeatureUnavailableForEngineVersion(detail),
                } = value
                else {
                    panic!("expected version coverage gap for {name}");
                };
                assert!(detail.contains(message), "{detail}");
            }
        }
    }

    #[test]
    fn legacy_bool_byte_and_enum_payloads_share_the_existing_codecs() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1009, 1011] {
            let package = versioned_package(
                &[
                    "None",
                    "Value",
                    "BoolProperty",
                    "ByteProperty",
                    "EnumProperty",
                    "ExampleEnum",
                    "Choice",
                ],
                ue5,
            );
            let mut bytes = Vec::new();
            for value in [0, 1] {
                let mut extras = vec![value];
                extras.extend_from_slice(&legacy_extras(&[], false, ue5));
                write_legacy_property_tag(&mut bytes, 1, 2, &extras, &[]);
            }
            write_legacy_property_tag(&mut bytes, 1, 3, &legacy_extras(&[0], false, ue5), &[7]);
            let mut enum_value = Vec::new();
            push_i32(&mut enum_value, 6);
            push_i32(&mut enum_value, 0);
            for kind in [3, 4] {
                write_legacy_property_tag(
                    &mut bytes,
                    1,
                    kind,
                    &legacy_extras(&[5], false, ue5),
                    &enum_value,
                );
            }
            write_property_terminator(&mut bytes, 0);
            let mut stream = read_tagged_property_stream(
                &mut Reader::new(&bytes),
                &package.summary.versions,
                &package.names,
                "Test",
            )
            .unwrap();
            decode_property_stream_values(&bytes, &mut stream, &package).unwrap();
            let values: Vec<_> = stream
                .records
                .into_iter()
                .map(|record| record.value)
                .collect();
            assert_eq!(
                values,
                vec![
                    PropertyValue::Bool(false),
                    PropertyValue::Bool(true),
                    PropertyValue::UInt(7),
                    PropertyValue::Enum(crate::test_support::name_ref(6, 0)),
                    PropertyValue::Enum(crate::test_support::name_ref(6, 0)),
                ]
            );
        }
    }

    #[test]
    fn legacy_text_dev_notes_follow_the_custom_version_and_editor_filter() {
        use crate::test_support::text_version;
        use crate::version::PackageFlags;
        for ue5 in [0, 1009] {
            for version in [259, 260, 261] {
                for filtered in [false, true] {
                    let mut package = versioned_package(&["TextProperty"], ue5);
                    let flags = if filtered {
                        PackageFlags::FILTER_EDITOR_ONLY
                    } else {
                        0
                    };
                    text_version(&mut package, Some(version), flags);
                    let notes = version >= 260 && !filtered;
                    let mut payload = vec![0, 0, 0, 0, 0];
                    for value in ["Fixture", "Greeting", "Hello"] {
                        push_fstring(&mut payload, value);
                    }
                    if notes {
                        push_fstring(&mut payload, "Context");
                    }
                    let value = decode_record_with_package(
                        package.clone(),
                        0,
                        vec![],
                        PropertyTagFlags(0),
                        &payload,
                    )
                    .unwrap();
                    assert_eq!(
                        value,
                        PropertyValue::Text(TextValue {
                            source: "Hello".into(),
                            history: TextHistory::Base {
                                namespace: "Fixture".into(),
                                key: "Greeting".into(),
                                dev_notes: if notes {
                                    "Context".into()
                                } else {
                                    String::new()
                                },
                            },
                        })
                    );
                    payload.pop();
                    assert!(matches!(
                        decode_record_with_package(
                            package,
                            0,
                            vec![],
                            PropertyTagFlags(0),
                            &payload,
                        )
                        .unwrap(),
                        PropertyValue::Raw {
                            reason: RawReason::LegacyDecoderRejected(_)
                        }
                    ));
                }
            }
        }
    }

    #[test]
    fn unsupported_histories_in_text_containers_keep_a_specific_raw_reason() {
        for ue5 in [0, 1009, 1011, 1012] {
            let package = versioned_package(&["ArrayProperty", "TextProperty"], ue5);
            let mut payload = vec![];
            push_i32(&mut payload, 2);
            payload.extend_from_slice(&[0, 0, 0, 0, 12]);
            let value = decode_record_with_package(
                package,
                0,
                vec![PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: vec![],
                }],
                PropertyTagFlags(0),
                &payload,
            )
            .unwrap();
            assert_eq!(
                value,
                PropertyValue::Raw {
                    reason: RawReason::UnsupportedTextHistory(12)
                }
            );
        }
    }

    #[test]
    fn boolean_containers_consume_value_bytes_and_reject_truncation() {
        let boolean = PropertyTypeName {
            name: crate::test_support::name_ref(1, 0),
            parameters: vec![],
        };
        for (kind, prefix, params, expected) in [
            (
                "ArrayProperty",
                vec![3],
                vec![boolean.clone()],
                PropertyValue::Array(vec![
                    PropertyValue::Bool(false),
                    PropertyValue::Bool(true),
                    PropertyValue::Bool(true),
                ]),
            ),
            (
                "SetProperty",
                vec![0, 3],
                vec![boolean.clone()],
                PropertyValue::Set(vec![
                    PropertyValue::Bool(false),
                    PropertyValue::Bool(true),
                    PropertyValue::Bool(true),
                ]),
            ),
            (
                "MapProperty",
                vec![-1, 1],
                vec![boolean.clone(), boolean.clone()],
                PropertyValue::Map(vec![MapEntry {
                    key: PropertyValue::Bool(false),
                    value: PropertyValue::Bool(true),
                }]),
            ),
        ] {
            let mut payload = Vec::new();
            for count in prefix {
                push_i32(&mut payload, count);
            }
            payload.extend(if kind == "MapProperty" {
                &[0, 1][..]
            } else {
                &[0, 1, 255][..]
            });
            let names = vec![kind.into(), "BoolProperty".into()];
            assert_eq!(
                decode_record(
                    names.clone(),
                    0,
                    params.clone(),
                    PropertyTagFlags(0),
                    &payload
                ),
                expected,
                "{kind}"
            );
            payload.pop();
            assert!(
                decode_record_result(names, 0, params, PropertyTagFlags(0), &payload).is_err(),
                "{kind}"
            );
        }
        let oversized = i32::MAX.to_le_bytes();
        assert!(
            decode_record_result(
                vec!["ArrayProperty".into(), "BoolProperty".into()],
                0,
                vec![boolean],
                PropertyTagFlags(0),
                &oversized
            )
            .is_err()
        );
    }

    #[test]
    fn decodes_enum_payload_as_name_literal() {
        let names = vec!["None".into(), "EnumProperty".into(), "MyEnum::Alpha".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 0);

        let package = test_package(names.clone());
        let value = decode_record(names, 1, Vec::new(), PropertyTagFlags(0), &payload);
        let PropertyValue::Enum(name) = value else {
            panic!("expected enum, got {value:?}");
        };
        assert_eq!(package.resolve_name(name), Some("MyEnum::Alpha".to_owned()));
    }

    #[test]
    fn decodes_scalar_property_matrix() {
        let cases: Vec<(&str, Vec<u8>, PropertyValue)> = vec![
            (
                "Int8Property",
                (-7_i8).to_le_bytes().to_vec(),
                PropertyValue::Int(-7),
            ),
            (
                "Int16Property",
                (-1234_i16).to_le_bytes().to_vec(),
                PropertyValue::Int(-1234),
            ),
            (
                "Int64Property",
                (-9_876_543_210_i64).to_le_bytes().to_vec(),
                PropertyValue::Int(-9_876_543_210),
            ),
            (
                "UInt8Property",
                250_u8.to_le_bytes().to_vec(),
                PropertyValue::UInt(250),
            ),
            (
                "UInt16Property",
                60_000_u16.to_le_bytes().to_vec(),
                PropertyValue::UInt(60_000),
            ),
            (
                "UInt32Property",
                3_000_000_000_u32.to_le_bytes().to_vec(),
                PropertyValue::UInt(3_000_000_000),
            ),
            (
                "UInt64Property",
                9_000_000_000_u64.to_le_bytes().to_vec(),
                PropertyValue::UInt(9_000_000_000),
            ),
            (
                "FloatProperty",
                1.25_f32.to_le_bytes().to_vec(),
                PropertyValue::Float(1.25),
            ),
            (
                "DoubleProperty",
                (-2.5_f64).to_le_bytes().to_vec(),
                PropertyValue::Double(-2.5),
            ),
        ];

        for (type_name, payload, expected) in cases {
            assert_eq!(
                decode_record(
                    vec![type_name.into()],
                    0,
                    Vec::new(),
                    PropertyTagFlags(0),
                    &payload,
                ),
                expected,
                "{type_name}",
            );
        }

        assert_eq!(
            decode_record(
                vec!["BoolProperty".into()],
                0,
                Vec::new(),
                PropertyTagFlags(0x10),
                &[],
            ),
            PropertyValue::Bool(true)
        );
        assert_eq!(
            decode_record(
                vec!["BoolProperty".into()],
                0,
                Vec::new(),
                PropertyTagFlags(0),
                &[],
            ),
            PropertyValue::Bool(false)
        );

        let mut name_payload = Vec::new();
        push_i32(&mut name_payload, 1);
        push_i32(&mut name_payload, 2);
        assert_eq!(
            decode_record(
                vec!["NameProperty".into(), "Value".into()],
                0,
                Vec::new(),
                PropertyTagFlags(0),
                &name_payload,
            ),
            PropertyValue::Name(crate::test_support::name_ref(1, 2))
        );

        let mut string_payload = Vec::new();
        push_fstring(&mut string_payload, "hello");
        assert_eq!(
            decode_record(
                vec!["StrProperty".into()],
                0,
                Vec::new(),
                PropertyTagFlags(0),
                &string_payload,
            ),
            PropertyValue::String("hello".into())
        );

        for type_name in ["ObjectProperty", "ClassProperty", "InterfaceProperty"] {
            assert_eq!(
                decode_record(
                    vec![type_name.into()],
                    0,
                    Vec::new(),
                    PropertyTagFlags(0),
                    &(-3_i32).to_le_bytes(),
                ),
                PropertyValue::ObjectRef(PackageIndex::from_raw(-3)),
                "{type_name}",
            );
        }
    }

    #[test]
    fn decodes_weak_object_payload_as_package_index() {
        let names = vec!["WeakObjectProperty".into()];
        let payload = (-2_i32).to_le_bytes();

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);

        assert_eq!(value, PropertyValue::ObjectRef(PackageIndex::from_raw(-2)));
    }

    #[test]
    fn decodes_lazy_object_payload_as_guid() {
        let names = vec!["LazyObjectProperty".into()];
        let mut payload = Vec::new();
        for value in [1_u32, 2, 3, 4] {
            payload.extend_from_slice(&value.to_le_bytes());
        }

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);

        assert_eq!(
            value,
            PropertyValue::Guid(crate::archive::Guid {
                a: 1,
                b: 2,
                c: 3,
                d: 4
            })
        );
    }

    #[test]
    fn decodes_empty_text_payload() {
        let names = vec!["TextProperty".into()];
        let payload = [0, 0, 0, 0, 0xFF, 0, 0, 0, 0];
        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::Text(TextValue {
                source: String::new(),
                history: TextHistory::None,
            })
        );
    }

    #[test]
    fn decodes_keyed_text_payload() {
        let names = vec!["TextProperty".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // flags
        payload.push(0); // Base history
        push_fstring(&mut payload, ""); // namespace
        push_fstring(&mut payload, "deadbeef");
        push_fstring(&mut payload, "Hello");

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::Text(TextValue {
                source: "Hello".to_owned(),
                history: TextHistory::Base {
                    namespace: String::new(),
                    key: "deadbeef".to_owned(),
                    dev_notes: String::new(),
                },
            })
        );
    }

    #[test]
    fn keyed_text_dev_notes_follow_custom_version_and_editor_filter() {
        use crate::test_support::text_version;
        use crate::version::PackageFlags;
        for (version, flags, notes) in [
            (None, 0, None),
            (Some(259), 0, None),
            (Some(260), 0, Some("Translator: greeting, not a command")),
            (Some(261), 0, Some("")),
            (Some(260), PackageFlags::FILTER_EDITOR_ONLY, None),
            (
                Some(260),
                PackageFlags::FILTER_EDITOR_ONLY | PackageFlags::COOKED,
                None,
            ),
        ] {
            let mut package = test_package(vec!["TextProperty".into()]);
            text_version(&mut package, version, flags);
            let mut payload = vec![0, 0, 0, 0, 0];
            for value in ["Fixture", "Greeting", "Hello"] {
                push_fstring(&mut payload, value);
            }
            if let Some(notes) = notes {
                if notes.is_empty() {
                    push_i32(&mut payload, 0);
                } else {
                    push_fstring(&mut payload, notes);
                }
            }
            let decode = |bytes: &[u8]| {
                decode_record_with_package(
                    package.clone(),
                    0,
                    Vec::new(),
                    PropertyTagFlags(0),
                    bytes,
                )
            };
            assert_eq!(
                decode(&payload).unwrap(),
                PropertyValue::Text(TextValue {
                    source: "Hello".into(),
                    history: TextHistory::Base {
                        namespace: "Fixture".into(),
                        key: "Greeting".into(),
                        dev_notes: notes.unwrap_or_default().into()
                    },
                })
            );
            // A valid text must consume exactly the versioned payload.
            let mut trailing = payload.clone();
            trailing.extend_from_slice(&0_i32.to_le_bytes());
            assert!(matches!(
                decode(&trailing).unwrap(),
                PropertyValue::Raw { .. }
            ));
            if notes.is_some() {
                assert!(decode(&payload[..payload.len() - 1]).is_err());
            }
        }
        let mut package = test_package(vec!["TextProperty".into()]);
        text_version(&mut package, Some(260), 0);
        let mut payload = vec![0, 0, 0, 0, 0];
        for value in ["Fixture", "Key", "Hello"] {
            push_fstring(&mut payload, value);
        }
        assert!(
            decode_record_with_package(package, 0, Vec::new(), PropertyTagFlags(0), &payload)
                .is_err()
        );
    }

    #[test]
    fn decodes_string_table_text_payload() {
        let names = vec![
            "TextProperty".into(),
            "/Game/Fixture/Text/ST_Game.ST_Game".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // flags
        payload.push(11); // StringTableEntry history
        push_i32(&mut payload, 1); // table ID name index
        push_i32(&mut payload, 0); // table ID name number
        push_fstring(&mut payload, "PromptContinue");

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::Text(TextValue {
                source: String::new(),
                history: TextHistory::StringTableEntry {
                    table_id: "/Game/Fixture/Text/ST_Game.ST_Game".to_owned(),
                    key: "PromptContinue".to_owned(),
                },
            })
        );
    }

    #[test]
    fn decodes_name_array_payload() {
        let names = vec![
            "ArrayProperty".into(),
            "NameProperty".into(),
            "Alpha".into(),
            "Beta".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 3);
        push_i32(&mut payload, 0);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0),
            &payload,
        );
        let PropertyValue::Array(values) = value else {
            panic!("expected array, got {value:?}");
        };
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn decodes_native_frame_number_array_payload() {
        let names = vec![
            "ArrayProperty".into(),
            "StructProperty".into(),
            "FrameNumber".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 3);
        for frame in [0, 48_000, 96_000] {
            push_i32(&mut payload, frame);
        }

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: vec![PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: Vec::new(),
                }],
            }],
            PropertyTagFlags(0x08),
            &payload,
        );

        assert_eq!(
            value,
            PropertyValue::Array(vec![
                PropertyValue::Int(0),
                PropertyValue::Int(48_000),
                PropertyValue::Int(96_000),
            ])
        );
    }

    #[test]
    fn consumes_native_rich_curve_key_array_elements_without_desynchronizing() {
        let names = vec![
            "ArrayProperty".into(),
            "StructProperty".into(),
            "RichCurveKey".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 1);
        payload.extend_from_slice(&[1, 2, 3]);
        for value in [4.0_f32, 5.0, 6.0, 7.0, 8.0, 9.0] {
            push_f32(&mut payload, value);
        }

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: vec![PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: Vec::new(),
                }],
            }],
            PropertyTagFlags(0x08),
            &payload,
        );

        let PropertyValue::Array(values) = value else {
            panic!("array");
        };
        let PropertyValue::NativeStruct { fields } = &values[0] else {
            panic!("native key");
        };
        assert_eq!(fields.len(), 9);
        assert_eq!(fields[3].name, "Time");
        assert_eq!(fields[3].value, PropertyValue::Float(4.0));
        assert_eq!(fields[8].value, PropertyValue::Float(9.0));
    }

    #[test]
    fn rejects_absurd_array_count_before_allocating_values() {
        let names = vec!["Value".into(), "ArrayProperty".into(), "IntProperty".into()];
        let payload = i32::MAX.to_le_bytes();

        let error = decode_record_result(
            names,
            1,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(2, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0),
            &payload,
        )
        .expect_err("absurd array count should fail");

        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert_eq!(error.path(), "Property.Value.Count");
        assert!(error.detail().contains("exceeds element limit"));
    }

    #[test]
    fn decodes_nested_struct_and_binary_vector_payloads() {
        let mut struct_bytes = Vec::new();
        let int_payload = 7_i32.to_le_bytes();
        write_property_tag(
            &mut struct_bytes,
            1,
            &TypeParam {
                type_index: 2,
                parameters: Vec::new(),
            },
            0,
            &int_payload,
        );
        let mut vector_payload = Vec::new();
        push_f64(&mut vector_payload, 1.0);
        push_f64(&mut vector_payload, 2.0);
        push_f64(&mut vector_payload, 3.0);
        write_property_tag(
            &mut struct_bytes,
            3,
            &TypeParam {
                type_index: 4,
                parameters: vec![TypeParam {
                    type_index: 5,
                    parameters: Vec::new(),
                }],
            },
            0x08, // binary/native
            &vector_payload,
        );
        write_property_terminator(&mut struct_bytes, 0);

        let stream = decode_stream(&struct_bytes);
        assert_eq!(stream.records.len(), 2);
        assert_eq!(stream.records[0].value, PropertyValue::Int(7));
        assert_eq!(
            stream.records[1].value,
            PropertyValue::Vector(VectorValue {
                x: 1.0,
                y: 2.0,
                z: 3.0,
            })
        );
    }

    #[test]
    fn rejects_overly_deep_nested_struct_values() {
        fn nested_struct_payload(depth: usize) -> Vec<u8> {
            let mut bytes = Vec::new();
            if depth > 0 {
                let child = nested_struct_payload(depth - 1);
                write_property_tag(
                    &mut bytes,
                    3,
                    &TypeParam {
                        type_index: 4,
                        parameters: Vec::new(),
                    },
                    0,
                    &child,
                );
            }
            write_property_terminator(&mut bytes, 0);
            bytes
        }

        let bytes = nested_struct_payload(MAX_PROPERTY_DECODE_DEPTH + 1);
        let names = vec![
            "None".into(),
            "NestedInt".into(),
            "IntProperty".into(),
            "NestedStruct".into(),
            "StructProperty".into(),
        ];
        let mut reader = Reader::new(&bytes);
        let mut stream =
            read_tagged_property_stream(&mut reader, &ue5_versions(), &names, "Test.Struct")
                .expect("parse struct stream");
        let package = test_package(names);

        let error = decode_property_stream_values(&bytes, &mut stream, &package)
            .expect_err("depth limit should reject nested struct values");

        assert_eq!(
            error.kind(),
            crate::property::PropertyErrorKind::MalformedData
        );
        assert!(error.detail().contains("depth limit"));
    }

    #[test]
    fn reports_raw_when_enum_payload_has_trailing_bytes() {
        let names = vec!["EnumProperty".into(), "MyEnum::Alpha".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, 1);
        push_i32(&mut payload, 0);
        payload.push(0xFF);

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert!(matches!(
            value,
            PropertyValue::Raw {
                reason: RawReason::DecoderRejected(_),
            }
        ));
    }

    #[test]
    fn decodes_enum_backed_byte_property_as_name() {
        // An enum-backed ByteProperty serializes its value as an 8-byte FName.
        let names = vec!["ByteProperty".into(), "TC_Masks".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, 1); // name index -> names[1]
        push_i32(&mut payload, 0); // name number

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::Enum(crate::test_support::name_ref(1, 0))
        );
    }

    #[test]
    fn decodes_plain_byte_property_as_uint() {
        // A ByteProperty with no underlying enum serializes as a single u8.
        let names = vec!["ByteProperty".into()];
        let payload = vec![0x2A];

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(value, PropertyValue::UInt(0x2A));
    }

    #[test]
    fn decodes_plain_byte_array_elements_as_single_bytes() {
        let names = vec!["ArrayProperty".into(), "ByteProperty".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, 3);
        payload.extend_from_slice(&[1, 2, 3]);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0),
            &payload,
        );

        assert_eq!(
            value,
            PropertyValue::Array(vec![
                PropertyValue::UInt(1),
                PropertyValue::UInt(2),
                PropertyValue::UInt(3),
            ])
        );
    }

    #[test]
    fn decodes_populated_soft_object_path_payload() {
        let names = vec![
            "SoftObjectProperty".into(),
            "/Engine/EngineResources/DefaultTexture".into(),
            "DefaultTexture".into(),
        ];
        let mut payload = Vec::new();
        for word in [1, 0, 2, 0] {
            push_i32(&mut payload, word);
        }
        push_fstring(&mut payload, "");

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::SoftObjectPath(
                "/Engine/EngineResources/DefaultTexture.DefaultTexture".into()
            )
        );
    }

    #[test]
    fn decodes_soft_object_path_with_subpath() {
        let names = vec![
            "SoftObjectProperty".into(),
            "/Game/MyPackage".into(),
            "MyAsset".into(),
        ];
        let mut payload = Vec::new();
        for word in [1, 0, 2, 0] {
            push_i32(&mut payload, word);
        }
        push_fstring(&mut payload, "SubObject");

        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &payload);
        assert_eq!(
            value,
            PropertyValue::SoftObjectPath("/Game/MyPackage.MyAsset:SubObject".into())
        );
    }

    #[test]
    fn decodes_indexed_soft_object_path_payload() {
        let names = vec!["SoftObjectProperty".into()];
        let mut package = test_package(names);
        package.soft_object_paths = vec![
            String::new(),
            "/Engine/EngineResources/DefaultTexture.DefaultTexture".into(),
        ];
        let payload = 1_i32.to_le_bytes();
        let source = payload.to_vec();
        let mut record = PropertyRecord {
            name: crate::test_support::name_ref(0, 0),
            type_name: PropertyTypeName {
                name: crate::test_support::name_ref(0, 0),
                parameters: Vec::new(),
            },
            array_index: 0,
            flags: PropertyTagFlags(0),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, source.len() as u64).expect("payload span"),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        };
        decode_property_record(&source, &mut record, &package, 0).expect("decode");
        assert_eq!(
            record.value,
            PropertyValue::SoftObjectPath(
                "/Engine/EngineResources/DefaultTexture.DefaultTexture".into()
            )
        );
    }

    #[test]
    fn rejects_invalid_table_backed_soft_object_payloads() {
        fn decode(payload: &[u8]) -> Result<PropertyValue, PropertyError> {
            let names = vec!["SoftObjectProperty".into()];
            let mut package = test_package(names);
            package.soft_object_paths = vec![String::new(), "/Game/Valid.Valid".into()];
            let source = payload.to_vec();
            let mut record = PropertyRecord {
                name: crate::test_support::name_ref(0, 0),
                type_name: PropertyTypeName {
                    name: crate::test_support::name_ref(0, 0),
                    parameters: Vec::new(),
                },
                array_index: 0,
                flags: PropertyTagFlags(0),
                property_guid: None,
                struct_guid: None,
                extensions: None,
                payload: Span::new(0, source.len() as u64).expect("payload span"),
                value: PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                },
            };
            decode_property_record(&source, &mut record, &package, 0)?;
            Ok(record.value)
        }

        for payload in [
            Vec::new(),
            vec![0; 3],
            vec![0; 5],
            (-1_i32).to_le_bytes().to_vec(),
            2_i32.to_le_bytes().to_vec(),
        ] {
            let error = decode(&payload).unwrap_err();
            assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        }

        assert_eq!(
            decode(&0_i32.to_le_bytes()).unwrap(),
            PropertyValue::SoftObjectPath(String::new())
        );
    }

    #[test]
    fn decodes_indexed_soft_object_path_array_elements() {
        let names = vec!["ArrayProperty".into(), "SoftObjectProperty".into()];
        let mut package = test_package(names);
        package.soft_object_paths = vec![
            String::new(),
            "/Game/Characters/Hero.Hero".into(),
            "/Game/Characters/Villain.Villain".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 1);
        push_i32(&mut payload, 2);
        let source = payload.to_vec();
        let mut record = PropertyRecord {
            name: crate::test_support::name_ref(0, 0),
            type_name: PropertyTypeName {
                name: crate::test_support::name_ref(0, 0),
                parameters: vec![PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: Vec::new(),
                }],
            },
            array_index: 0,
            flags: PropertyTagFlags(0),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, source.len() as u64).expect("payload span"),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        };

        decode_property_record(&source, &mut record, &package, 0).expect("decode");

        assert_eq!(
            record.value,
            PropertyValue::Array(vec![
                PropertyValue::SoftObjectPath("/Game/Characters/Hero.Hero".into()),
                PropertyValue::SoftObjectPath("/Game/Characters/Villain.Villain".into()),
            ])
        );
    }

    #[test]
    fn decodes_name_set_payload() {
        let names = vec![
            "SetProperty".into(),
            "NameProperty".into(),
            "Alpha".into(),
            "Beta".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // ElementsToRemove
        push_i32(&mut payload, 2); // Elements
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 3);
        push_i32(&mut payload, 0);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0),
            &payload,
        );
        let PropertyValue::Set(values) = value else {
            panic!("expected set, got {value:?}");
        };
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn consumes_set_elements_to_remove_and_rejects_negative_counts() {
        let names = vec!["SetProperty".into(), "IntProperty".into()];
        let element_type = vec![PropertyTypeName {
            name: crate::test_support::name_ref(1, 0),
            parameters: Vec::new(),
        }];
        let mut payload = Vec::new();
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 10);
        push_i32(&mut payload, 11);
        push_i32(&mut payload, 1);
        push_i32(&mut payload, 42);

        assert_eq!(
            decode_record(
                names.clone(),
                0,
                element_type.clone(),
                PropertyTagFlags(0),
                &payload,
            ),
            PropertyValue::Set(vec![PropertyValue::Int(42)])
        );

        let error = decode_record_result(
            names,
            0,
            element_type,
            PropertyTagFlags(0),
            &(-1_i32).to_le_bytes(),
        )
        .unwrap_err();
        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert!(error.detail().contains("ElementsToRemove"));
    }

    #[test]
    fn decodes_int_to_string_map_payload() {
        let names = vec![
            "MapProperty".into(),
            "IntProperty".into(),
            "StrProperty".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // KeysToRemove
        push_i32(&mut payload, 2); // Entries
        push_i32(&mut payload, 1);
        push_fstring(&mut payload, "one");
        push_i32(&mut payload, 2);
        push_fstring(&mut payload, "two");

        let value = decode_record(
            names,
            0,
            vec![
                PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: Vec::new(),
                },
                PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: Vec::new(),
                },
            ],
            PropertyTagFlags(0),
            &payload,
        );
        let PropertyValue::Map(entries) = value else {
            panic!("expected map, got {value:?}");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, PropertyValue::Int(1));
        assert_eq!(entries[0].value, PropertyValue::String("one".into()));
        assert_eq!(entries[1].key, PropertyValue::Int(2));
        assert_eq!(entries[1].value, PropertyValue::String("two".into()));
    }

    #[test]
    fn decodes_name_to_guid_map_payload() {
        let names = vec![
            "MapProperty".into(),
            "NameProperty".into(),
            "StructProperty".into(),
            "Guid".into(),
            "Widget".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // KeysToRemove
        push_i32(&mut payload, 1); // Entries
        push_i32(&mut payload, 4); // Name index
        push_i32(&mut payload, 0); // Name number
        for component in [1_u32, 2, 3, 4] {
            payload.extend_from_slice(&component.to_le_bytes());
        }

        let value = decode_record(
            names,
            0,
            vec![
                PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: Vec::new(),
                },
                PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: vec![PropertyTypeName {
                        name: crate::test_support::name_ref(3, 0),
                        parameters: Vec::new(),
                    }],
                },
            ],
            PropertyTagFlags(0),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::Map(vec![MapEntry {
                key: PropertyValue::Name(crate::test_support::name_ref(4, 0)),
                value: PropertyValue::Guid(Guid {
                    a: 1,
                    b: 2,
                    c: 3,
                    d: 4,
                }),
            }])
        );
    }

    #[test]
    fn decodes_map_with_full_replace_marker() {
        let names = vec![
            "MapProperty".into(),
            "IntProperty".into(),
            "IntProperty".into(),
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, INDEX_NONE); // KeysToRemove = full replace
        push_i32(&mut payload, 1); // Entries
        push_i32(&mut payload, 42);
        push_i32(&mut payload, 7);

        let value = decode_record(
            names,
            0,
            vec![
                PropertyTypeName {
                    name: crate::test_support::name_ref(1, 0),
                    parameters: Vec::new(),
                },
                PropertyTypeName {
                    name: crate::test_support::name_ref(2, 0),
                    parameters: Vec::new(),
                },
            ],
            PropertyTagFlags(0),
            &payload,
        );
        let PropertyValue::Map(entries) = value else {
            panic!("expected map, got {value:?}");
        };
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, PropertyValue::Int(42));
        assert_eq!(entries[0].value, PropertyValue::Int(7));
    }

    #[test]
    fn consumes_map_keys_to_remove_before_entries() {
        let names = vec![
            "MapProperty".into(),
            "IntProperty".into(),
            "IntProperty".into(),
        ];
        let types = vec![
            PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            },
            PropertyTypeName {
                name: crate::test_support::name_ref(2, 0),
                parameters: Vec::new(),
            },
        ];
        let mut payload = Vec::new();
        push_i32(&mut payload, 2);
        push_i32(&mut payload, 10);
        push_i32(&mut payload, 11);
        push_i32(&mut payload, 1);
        push_i32(&mut payload, 42);
        push_i32(&mut payload, 7);

        assert_eq!(
            decode_record(names, 0, types, PropertyTagFlags(0), &payload),
            PropertyValue::Map(vec![MapEntry {
                key: PropertyValue::Int(42),
                value: PropertyValue::Int(7),
            }])
        );
    }

    #[test]
    fn rejects_invalid_negative_map_remove_count() {
        let names = vec![
            "MapProperty".into(),
            "IntProperty".into(),
            "IntProperty".into(),
        ];
        let types = vec![
            PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            },
            PropertyTypeName {
                name: crate::test_support::name_ref(2, 0),
                parameters: Vec::new(),
            },
        ];

        let error = decode_record_result(
            names,
            0,
            types,
            PropertyTagFlags(0),
            &(-2_i32).to_le_bytes(),
        )
        .unwrap_err();
        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert!(error.detail().contains("KeysToRemove"));
    }

    #[test]
    fn reports_raw_for_unsupported_property_type() {
        let names = vec!["DelegateProperty".into()];
        let value = decode_record(names, 0, Vec::new(), PropertyTagFlags(0), &[0x01]);
        assert!(matches!(
            value,
            PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            }
        ));
    }

    #[test]
    fn decodes_fvector_from_float_layout() {
        let names = vec!["StructProperty".into(), "Vector".into()];
        let mut payload = Vec::new();
        push_f32(&mut payload, 4.0);
        push_f32(&mut payload, 5.0);
        push_f32(&mut payload, 6.0);

        let mut package = test_package(names);
        package.summary.versions.ue5 = 1003;
        let value = decode_record_with_package(
            package,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        )
        .unwrap();
        assert_eq!(
            value,
            PropertyValue::Vector(VectorValue {
                x: 4.0,
                y: 5.0,
                z: 6.0,
            })
        );
    }

    #[test]
    fn preserves_fvector_double_precision() {
        let names = vec!["StructProperty".into(), "Vector".into()];
        let expected = [
            16_777_217.25,
            -9_007_199_254_740_991.0,
            1.000_000_000_000_000_2,
        ];
        let mut payload = Vec::new();
        for component in expected {
            push_f64(&mut payload, component);
        }

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );

        assert_eq!(
            value,
            PropertyValue::Vector(VectorValue {
                x: expected[0],
                y: expected[1],
                z: expected[2],
            })
        );
    }

    #[test]
    fn decodes_fint_point_from_native_layout() {
        let names = vec!["StructProperty".into(), "IntPoint".into()];
        let mut payload = Vec::new();
        push_i32(&mut payload, -12);
        push_i32(&mut payload, 34);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::IntPoint(IntPointValue { x: -12, y: 34 })
        );
    }

    #[test]
    fn decodes_movie_scene_frame_range_from_native_layout() {
        let names = vec!["StructProperty".into(), "MovieSceneFrameRange".into()];
        let mut payload = Vec::new();
        payload.push(1); // inclusive lower bound
        push_i32(&mut payload, 0);
        payload.push(0); // exclusive upper bound
        push_i32(&mut payload, 120_000);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );

        assert_eq!(
            value,
            PropertyValue::FrameRange(FrameRangeValue {
                lower: FrameRangeBound {
                    kind: RangeBoundKind::Inclusive,
                    value: 0,
                },
                upper: FrameRangeBound {
                    kind: RangeBoundKind::Exclusive,
                    value: 120_000,
                },
            })
        );
    }

    #[test]
    fn decodes_date_time_from_native_ticks() {
        let names = vec!["StructProperty".into(), "DateTime".into()];
        let ticks = 638_853_408_000_000_000_i64;
        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &ticks.to_le_bytes(),
        );

        assert_eq!(value, PropertyValue::DateTime(ticks));
    }

    #[test]
    fn decodes_frotator_from_double_layout() {
        let names = vec!["StructProperty".into(), "Rotator".into()];
        let mut payload = Vec::new();
        push_f64(&mut payload, 10.0);
        push_f64(&mut payload, 20.0);
        push_f64(&mut payload, 30.0);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::Rotator(RotatorValue {
                pitch: 10.0,
                yaw: 20.0,
                roll: 30.0,
            })
        );
    }

    #[test]
    fn decodes_fguid_from_native_layout() {
        let names = vec!["StructProperty".into(), "Guid".into()];
        let mut payload = Vec::new();
        for component in [1_u32, 2, 3, 4] {
            payload.extend_from_slice(&component.to_le_bytes());
        }

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::Guid(Guid {
                a: 1,
                b: 2,
                c: 3,
                d: 4,
            })
        );
    }

    #[test]
    fn decodes_fcolor_from_bgra_byte_order() {
        let names = vec!["StructProperty".into(), "Color".into()];
        // Wire order is B, G, R, A.
        let payload = [10_u8, 20, 30, 255];

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::Color(ColorValue {
                r: 30,
                g: 20,
                b: 10,
                a: 255,
            })
        );
    }

    #[test]
    fn decodes_flinearcolor_from_rgba_floats() {
        let names = vec!["StructProperty".into(), "LinearColor".into()];
        let mut payload = Vec::new();
        push_f32(&mut payload, 0.25);
        push_f32(&mut payload, 0.5);
        push_f32(&mut payload, 0.75);
        push_f32(&mut payload, 1.0);

        let value = decode_record(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &payload,
        );
        assert_eq!(
            value,
            PropertyValue::LinearColor(LinearColorValue {
                r: 0.25,
                g: 0.5,
                b: 0.75,
                a: 1.0,
            })
        );
    }

    #[test]
    fn rejects_frotator_with_unexpected_payload_size() {
        let names = vec!["StructProperty".into(), "Rotator".into()];
        let error = decode_record_result(
            names,
            0,
            vec![PropertyTypeName {
                name: crate::test_support::name_ref(1, 0),
                parameters: Vec::new(),
            }],
            PropertyTagFlags(0x08),
            &[0x00, 0x01, 0x02],
        )
        .expect_err("odd rotator size");
        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
    }
}
