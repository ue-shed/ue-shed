//! Generic tagged-property model and envelope parsing.

use std::fmt;
#[cfg(target_pointer_width = "64")]
use std::mem::size_of;

use crate::archive::{ArchiveError, ArchiveErrorKind, Guid, NameRef, Reader, Span};
use crate::package::PackageIndex;
use crate::version::VersionContext;

mod replay;
pub(crate) use replay::TaggedStreamReplay;

const UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION: i32 = 1011;
const UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME: i32 = 1012;

const TAG_FLAG_HAS_ARRAY_INDEX: u8 = 0x01;
const TAG_FLAG_HAS_PROPERTY_GUID: u8 = 0x02;
const TAG_FLAG_HAS_PROPERTY_EXTENSIONS: u8 = 0x04;
const TAG_FLAG_HAS_BINARY_OR_NATIVE_SERIALIZE: u8 = 0x08;
const TAG_FLAG_BOOL_TRUE: u8 = 0x10;
const TAG_FLAG_SKIPPED_SERIALIZE: u8 = 0x20;

const PROPERTY_EXTENSION_RESERVE_FOR_FUTURE_USE: u8 = 0x01;
const PROPERTY_EXTENSION_OVERRIDABLE_INFORMATION: u8 = 0x02;

const CLASS_EXTENSION_RESERVE_FOR_FUTURE_USE: u8 = 0x01;
const CLASS_EXTENSION_OVERRIDABLE_SERIALIZATION_INFORMATION: u8 = 0x02;
const MAX_PROPERTY_TYPE_DEPTH: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PropertyTypeName {
    pub name: NameRef,
    pub parameters: Vec<PropertyTypeName>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PropertyTagFlags(pub u8);

impl PropertyTagFlags {
    #[must_use]
    pub const fn contains(self, flag: u8) -> bool {
        self.0 & flag == flag
    }

    #[must_use]
    pub const fn bool_value(self) -> bool {
        self.contains(TAG_FLAG_BOOL_TRUE)
    }

    #[must_use]
    pub const fn is_binary_or_native(self) -> bool {
        self.contains(TAG_FLAG_HAS_BINARY_OR_NATIVE_SERIALIZE)
    }

    #[must_use]
    pub const fn is_skipped(self) -> bool {
        self.contains(TAG_FLAG_SKIPPED_SERIALIZE)
    }
}

/// Why a property value stayed raw. Details are `Box<str>` so the reason, and with it
/// `PropertyValue`, stays small: a capacity word per value adds up across every record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RawReason {
    /// The decode filter did not request this property.
    NotRequested,
    UnsupportedType,
    DecoderRejected(Box<str>),
    LegacyDecoderRejected(Box<str>),
    LegacyContainerElementWithoutTypeInformation,
    FeatureUnavailableForEngineVersion(Box<str>),
    UnsupportedTextHistory(i8),
}

impl RawReason {
    #[must_use]
    pub fn detail(&self) -> std::borrow::Cow<'_, str> {
        match self {
            Self::NotRequested => "not requested by the decode filter".into(),
            Self::UnsupportedType => "unsupported type".into(),
            Self::DecoderRejected(detail)
            | Self::LegacyDecoderRejected(detail)
            | Self::FeatureUnavailableForEngineVersion(detail) => (&**detail).into(),
            Self::LegacyContainerElementWithoutTypeInformation => {
                "legacy container struct element has no type information".into()
            }
            Self::UnsupportedTextHistory(history) => {
                format!("unsupported text history {history}").into()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum TextHistory {
    StringTableEntry {
        table_id: String,
        key: String,
    },
    None,
    Base {
        namespace: String,
        key: String,
        dev_notes: String,
    },
    NamedFormat {
        format: Box<TextValue>,
        arguments: Vec<NamedTextFormatArgument>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct TextValue {
    pub source: String,
    pub history: TextHistory,
}

impl TextValue {
    #[must_use]
    pub fn dev_notes(&self) -> Option<&str> {
        match &self.history {
            TextHistory::Base { dev_notes, .. } => Some(dev_notes),
            TextHistory::NamedFormat { format, .. } => format.dev_notes(),
            TextHistory::None | TextHistory::StringTableEntry { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NamedTextFormatArgument {
    pub name: String,
    pub value: TextFormatArgumentValue,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TextFormatArgumentValue {
    Int(i64),
    UInt(u64),
    Float(f32),
    Double(f64),
    Text(Box<TextValue>),
    Gender(u64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct VectorValue {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntPointValue {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RangeBoundKind {
    Exclusive,
    Inclusive,
    Open,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameRangeBound {
    pub kind: RangeBoundKind,
    pub value: i32,
}

/// Native `FMovieSceneFrameRange` value used by sequence and section boundaries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameRangeValue {
    pub lower: FrameRangeBound,
    pub upper: FrameRangeBound,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RotatorValue {
    pub pitch: f64,
    pub yaw: f64,
    pub roll: f64,
}

/// `FColor`: 8-bit sRGB channels. Serialized `B, G, R, A`; stored here by name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ColorValue {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// `FLinearColor`: linear-space float channels serialized `R, G, B, A`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinearColorValue {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DataTableRowHandleValue {
    pub table: PackageIndex,
    pub row_name: NameRef,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MapEntry {
    pub key: PropertyValue,
    pub value: PropertyValue,
}

/// A named field from native serialization, without a fabricated property tag.
#[derive(Clone, Debug, PartialEq)]
pub struct NativeProperty {
    pub name: std::borrow::Cow<'static, str>,
    pub value: PropertyValue,
}

/// Saved type reference, payload span, and optional decoded value of an instanced struct.
#[derive(Clone, Debug, PartialEq)]
pub struct InstancedStructValue {
    pub struct_type: PackageIndex,
    pub payload: Span,
    pub value: Option<Box<PropertyValue>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PropertyValue {
    Bool(bool),
    Float(f32),
    Double(f64),
    Int(i64),
    UInt(u64),
    Name(NameRef),
    Enum(NameRef),
    String(String),
    Text(Box<TextValue>),
    Vector(VectorValue),
    IntPoint(IntPointValue),
    Rotator(RotatorValue),
    Color(ColorValue),
    LinearColor(LinearColorValue),
    DataTableRowHandle(DataTableRowHandleValue),
    /// UE `FDateTime` ticks (100 ns intervals since 0001-01-01).
    DateTime(i64),
    FrameRange(FrameRangeValue),
    ObjectRef(PackageIndex),
    Guid(Guid),
    SoftObjectPath(String),
    Array(Vec<PropertyValue>),
    Set(Vec<PropertyValue>),
    Map(Vec<MapEntry>),
    Struct(Box<PropertyStream>),
    NativeStruct {
        fields: Vec<NativeProperty>,
    },
    InstancedStruct(Box<InstancedStructValue>),
    Raw {
        reason: RawReason,
    },
}

// Keep container elements compact on 64-bit targets.
#[cfg(target_pointer_width = "64")]
const _: () = assert!(size_of::<PropertyValue>() <= 32);

#[derive(Clone, Debug, PartialEq)]
pub struct PropertyRecord {
    pub name: NameRef,
    pub type_name: PropertyTypeName,
    pub array_index: i32,
    pub flags: PropertyTagFlags,
    pub property_guid: Option<Guid>,
    pub struct_guid: Option<Guid>,
    pub extensions: Option<PropertyTagExtensions>,
    pub payload: Span,
    pub value: PropertyValue,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PropertyTagExtensions {
    pub raw_flags: u8,
    pub override_operation: Option<u8>,
    pub experimental_overridable_logic: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PropertyStream {
    pub class_extensions: Option<ClassSerializationControlExtensions>,
    pub records: Vec<PropertyRecord>,
    pub terminator: Span,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassSerializationControlExtensions {
    pub raw_flags: u8,
    pub overridable_operation: Option<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PropertyErrorKind {
    MalformedData,
    ResourceLimit,
    UnsupportedVersion,
    UnsupportedCapability,
}

pub struct PropertyError {
    // Property-value results carry this pointer instead of full diagnostic storage.
    inner: Box<PropertyErrorData>,
}

struct PropertyErrorData {
    kind: PropertyErrorKind,
    offset: Option<u64>,
    path: String,
    detail: String,
    source: Option<ArchiveError>,
    raw_reason: Option<RawReason>,
}

impl PropertyError {
    pub(crate) fn new(
        kind: PropertyErrorKind,
        offset: Option<u64>,
        path: impl fmt::Display,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            inner: Box::new(PropertyErrorData {
                kind,
                offset,
                path: path.to_string(),
                detail: detail.into(),
                source: None,
                raw_reason: None,
            }),
        }
    }

    #[must_use]
    pub const fn kind(&self) -> PropertyErrorKind {
        self.inner.kind
    }

    pub(crate) fn with_raw_reason(mut self, reason: RawReason) -> Self {
        self.inner.raw_reason = Some(reason);
        self
    }

    pub(crate) fn raw_reason(&self) -> Option<&RawReason> {
        self.inner.raw_reason.as_ref()
    }

    #[must_use]
    pub const fn offset(&self) -> Option<u64> {
        self.inner.offset
    }

    #[must_use]
    pub fn path(&self) -> &str {
        &self.inner.path
    }

    #[must_use]
    pub fn detail(&self) -> &str {
        &self.inner.detail
    }
}

impl fmt::Debug for PropertyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PropertyError")
            .field("kind", &self.inner.kind)
            .field("offset", &self.inner.offset)
            .field("path", &self.inner.path)
            .field("detail", &self.inner.detail)
            .field("source", &self.inner.source)
            .field("raw_reason", &self.inner.raw_reason)
            .finish()
    }
}

impl fmt::Display for PropertyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.inner.offset {
            Some(offset) => write!(
                formatter,
                "{:?} at byte {offset} while reading {}: {}",
                self.inner.kind, self.inner.path, self.inner.detail
            ),
            None => write!(
                formatter,
                "{:?} while reading {}: {}",
                self.inner.kind, self.inner.path, self.inner.detail
            ),
        }
    }
}

impl std::error::Error for PropertyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.inner
            .source
            .as_ref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

impl From<ArchiveError> for PropertyError {
    fn from(source: ArchiveError) -> Self {
        let kind = match source.kind() {
            ArchiveErrorKind::OutOfBounds
            | ArchiveErrorKind::InvalidSeek
            | ArchiveErrorKind::InvalidCount
            | ArchiveErrorKind::InvalidBoolean
            | ArchiveErrorKind::MissingNullTerminator
            | ArchiveErrorKind::InvalidString
            | ArchiveErrorKind::InvalidNameReference
            | ArchiveErrorKind::IntegerOverflow => PropertyErrorKind::MalformedData,
            ArchiveErrorKind::AllocationLimit => PropertyErrorKind::ResourceLimit,
        };
        Self {
            inner: Box::new(PropertyErrorData {
                kind,
                offset: Some(source.offset()),
                path: source.path().to_owned(),
                detail: source.detail().to_owned(),
                source: Some(source),
                raw_reason: None,
            }),
        }
    }
}

/// Parses a root UObject versioned tagged-property stream.
///
/// From UE5 1011, root object streams include class serialization-control extensions
/// immediately before the tagged-property array. Struct/row streams do not.
///
/// # Errors
///
/// Returns the same errors as [`read_tagged_property_stream`], plus unsupported
/// class serialization-control extension groups.
pub fn read_uobject_tagged_property_stream(
    reader: &mut Reader<'_>,
    versions: &VersionContext,
    names: &[String],
    path: &(impl fmt::Display + ?Sized),
) -> Result<PropertyStream, PropertyError> {
    validate_tagged_property_versions(versions, reader.tell(), path)?;
    // UE 5.7/5.8 Class.cpp, PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION (1011).
    let class_extensions = versions
        .is_at_least_ue5(UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION)
        .then(|| {
            read_class_serialization_control_extensions(
                reader,
                &format_args!("{path}.SerializationControlExtensions"),
            )
        })
        .transpose()?;
    let mut stream = read_tagged_property_stream(reader, versions, names, path)?;
    stream.class_extensions = class_extensions;
    Ok(stream)
}

/// Parses a versioned tagged-property stream until `NAME_None`.
///
/// The reader must already be bounded to the containing export or row stream.
/// On success, the reader cursor is positioned immediately after the terminator.
///
/// # Errors
///
/// Returns an error for tags outside the legacy/complete-type-name window, malformed name
/// references, malformed type trees, invalid payload sizes, unsupported future
/// extension groups, or any bounded-reader failure.
pub fn read_tagged_property_stream(
    reader: &mut Reader<'_>,
    versions: &VersionContext,
    names: &[String],
    path: &(impl fmt::Display + ?Sized),
) -> Result<PropertyStream, PropertyError> {
    validate_tagged_property_versions(versions, reader.tell(), path)?;
    let legacy = versions.uses_legacy_property_tags();

    let mut records = Vec::new();
    loop {
        let tag_start = reader.tell();
        let name = reader.read_name_ref(&format_args!("{path}.Tag.Name"))?;
        validate_name_ref(names, name, &format_args!("{path}.Tag.Name"))?;
        // The name map owns the base strings for the whole decode, so the
        // terminator check borrows instead of allocating: a name resolves to
        // exactly "None" only when its base is "None" and it is unnumbered.
        // `validate_name_ref` above already bounded the index.
        if name.number() == 0 && names[crate::convert::usize_from_u32(name.index().get())] == "None"
        {
            return Ok(PropertyStream {
                class_extensions: None,
                records,
                terminator: Span::new(tag_start, reader.tell() - tag_start)?,
            });
        }

        // UE 4.27/5.0/5.3 PropertyTag.cpp; UE 5.7 LoadPropertyTagNoFullType,
        // PROPERTY_TAG_COMPLETE_TYPE_NAME (1012).
        if legacy {
            records.push(read_legacy_property_tag(
                reader, versions, names, name, path,
            )?);
            continue;
        }
        let type_name = read_property_type_name(reader, names, &format_args!("{path}.Tag.Type"))?;
        let size_offset = reader.tell();
        let size = reader.read_i32(&format_args!("{path}.Tag.Size"))?;
        if size < 0 {
            return Err(PropertyError::new(
                PropertyErrorKind::MalformedData,
                Some(size_offset),
                format!("{path}.Tag.Size"),
                format!("property payload size must be non-negative, got {size}"),
            ));
        }
        let payload_size = u64::from(crate::convert::u32_from_checked(size));
        let flags = PropertyTagFlags(reader.read_u8(&format_args!("{path}.Tag.Flags"))?);
        let array_index = if flags.contains(TAG_FLAG_HAS_ARRAY_INDEX) {
            reader.read_i32(&format_args!("{path}.Tag.ArrayIndex"))?
        } else {
            0
        };
        let property_guid = flags
            .contains(TAG_FLAG_HAS_PROPERTY_GUID)
            .then(|| reader.read_guid(&format_args!("{path}.Tag.PropertyGuid")))
            .transpose()?;
        let extensions = if flags.contains(TAG_FLAG_HAS_PROPERTY_EXTENSIONS) {
            Some(read_property_extensions(
                reader,
                versions,
                &format_args!("{path}.Tag.PropertyExtensions"),
            )?)
        } else {
            None
        };

        let payload = Span::new(reader.tell(), payload_size)?;
        reader.skip(payload_size, &format_args!("{path}.Tag.Payload"))?;
        records.push(PropertyRecord {
            name,
            type_name,
            array_index,
            flags,
            property_guid,
            struct_guid: None,
            extensions,
            payload,
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        });
    }
}

fn validate_tagged_property_versions(
    versions: &VersionContext,
    offset: u64,
    path: &(impl fmt::Display + ?Sized),
) -> Result<(), PropertyError> {
    if versions.ue4 < 522
        || (!versions.uses_legacy_property_tags()
            && !versions.is_at_least_ue5(UE5_PROPERTY_TAG_COMPLETE_TYPE_NAME))
    {
        return Err(PropertyError::new(
            PropertyErrorKind::UnsupportedVersion,
            Some(offset),
            path,
            "unsupported tagged-property version; resave the package in UE 4.27 or later",
        ));
    }
    Ok(())
}

pub(crate) fn read_legacy_property_tag(
    reader: &mut Reader<'_>,
    versions: &VersionContext,
    names: &[String],
    name: NameRef,
    path: &(impl fmt::Display + ?Sized),
) -> Result<PropertyRecord, PropertyError> {
    validate_name_ref(names, name, &format_args!("{path}.Tag.Name"))?;
    let type_ref = reader.read_name_ref(&format_args!("{path}.Tag.Type"))?;
    validate_name_ref(names, type_ref, path)?;
    let size_offset = reader.tell();
    let size = reader.read_i32(&format_args!("{path}.Tag.Size"))?;
    if size < 0 {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(size_offset),
            path,
            "legacy property payload size must be non-negative",
        ));
    }
    let array_index = reader.read_i32(&format_args!("{path}.Tag.ArrayIndex"))?;
    let mut type_name = PropertyTypeName {
        name: type_ref,
        parameters: Vec::new(),
    };
    let mut flags = PropertyTagFlags::default();
    let mut struct_guid = None;
    if type_ref.number() == 0 {
        let type_text = &names[type_ref.index().get() as usize];
        let parameter_count = match type_text.as_str() {
            "StructProperty" | "ByteProperty" | "EnumProperty" | "ArrayProperty"
            | "SetProperty" | "OptionalProperty" => 1,
            "MapProperty" => 2,
            _ => 0,
        };
        for _ in 0..parameter_count {
            let parameter = reader.read_name_ref(&format_args!("{path}.Tag.TypeParameter"))?;
            // An unresolved struct identity remains evidence, not a malformed tag.
            if type_text != "StructProperty" {
                validate_name_ref(names, parameter, path)?;
            }
            if type_text != "ByteProperty"
                || parameter.number() != 0
                || names
                    .get(parameter.index().get() as usize)
                    .is_none_or(|name| name != "None")
            {
                type_name.parameters.push(PropertyTypeName {
                    name: parameter,
                    parameters: Vec::new(),
                });
            }
        }
        if type_text == "StructProperty" {
            // UE 4.27 PropertyTag.cpp, VER_UE4_STRUCT_GUID_IN_PROPERTY_TAG.
            struct_guid = Some(reader.read_guid(&format_args!("{path}.Tag.StructGuid"))?);
        } else if type_text == "BoolProperty"
            && reader.read_u8(&format_args!("{path}.Tag.BoolVal"))? != 0
        {
            flags.0 |= TAG_FLAG_BOOL_TRUE;
        }
    }
    // UE 4.27 PropertyTag.cpp, VER_UE4_PROPERTY_GUID_IN_PROPERTY_TAG; always present in this window.
    let property_guid = if reader.read_u8(&format_args!("{path}.Tag.HasPropertyGuid"))? != 0 {
        flags.0 |= TAG_FLAG_HAS_PROPERTY_GUID;
        Some(reader.read_guid(&format_args!("{path}.Tag.PropertyGuid"))?)
    } else {
        None
    };
    // UE 5.7 PropertyTag.cpp, PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION (1011).
    let extensions = versions
        .is_at_least_ue5(UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION)
        .then(|| read_property_extensions(reader, versions, path))
        .transpose()?;
    let payload = Span::new(reader.tell(), size as u64)?;
    reader.skip(size as u64, &format_args!("{path}.Tag.Payload"))?;
    Ok(PropertyRecord {
        name,
        type_name,
        array_index,
        flags,
        property_guid,
        struct_guid,
        extensions,
        payload,
        value: PropertyValue::Raw {
            reason: RawReason::UnsupportedType,
        },
    })
}

fn read_class_serialization_control_extensions(
    reader: &mut Reader<'_>,
    path: &(impl fmt::Display + ?Sized),
) -> Result<ClassSerializationControlExtensions, PropertyError> {
    let extension_offset = reader.tell();
    let raw_flags = reader.read_u8(path)?;
    if raw_flags & CLASS_EXTENSION_RESERVE_FOR_FUTURE_USE != 0 {
        return Err(PropertyError::new(
            PropertyErrorKind::UnsupportedCapability,
            Some(extension_offset),
            path,
            "future class serialization-control extension groups are not supported",
        ));
    }
    let overridable_operation = (raw_flags & CLASS_EXTENSION_OVERRIDABLE_SERIALIZATION_INFORMATION
        != 0)
        .then(|| reader.read_u8(&format_args!("{path}.OverridableOperation")))
        .transpose()?;
    Ok(ClassSerializationControlExtensions {
        raw_flags,
        overridable_operation,
    })
}

fn read_property_type_name(
    reader: &mut Reader<'_>,
    names: &[String],
    path: &(impl fmt::Display + ?Sized),
) -> Result<PropertyTypeName, PropertyError> {
    read_property_type_name_at_depth(reader, names, path, 0)
}

fn read_property_type_name_at_depth(
    reader: &mut Reader<'_>,
    names: &[String],
    path: &(impl fmt::Display + ?Sized),
    depth: usize,
) -> Result<PropertyTypeName, PropertyError> {
    if depth >= MAX_PROPERTY_TYPE_DEPTH {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(reader.tell()),
            path.to_string(),
            format!("property type-name nesting exceeds depth limit {MAX_PROPERTY_TYPE_DEPTH}"),
        ));
    }
    // Zero children require no allocation; nonzero counts keep the ordinary budget checks.
    if let Some((name, inner_count)) = reader.try_read_type_header(names.len()) {
        if inner_count == 0 {
            return Ok(PropertyTypeName {
                name,
                parameters: Vec::new(),
            });
        }
        let capacity = reader.checked_vec_capacity::<PropertyTypeName>(
            inner_count,
            12,
            &format_args!("{path}.InnerCount"),
        )?;
        let mut parameters = Vec::with_capacity(capacity);
        for index in 0..inner_count {
            parameters.push(read_property_type_name_at_depth(
                reader,
                names,
                &format_args!("{path}.Parameters[{index}]"),
                depth + 1,
            )?);
        }
        return Ok(PropertyTypeName { name, parameters });
    }
    let name = reader.read_name_ref(&format_args!("{path}.Name"))?;
    validate_name_ref(names, name, &format_args!("{path}.Name"))?;
    let inner_count_offset = reader.tell();
    let inner_count = reader.read_i32(&format_args!("{path}.InnerCount"))?;
    if inner_count < 0 {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(inner_count_offset),
            format!("{path}.InnerCount"),
            format!("type-name inner count must be non-negative, got {inner_count}"),
        ));
    }
    let inner_count = crate::convert::usize_from_checked(inner_count);
    let capacity = reader.checked_vec_capacity::<PropertyTypeName>(
        inner_count,
        12,
        &format_args!("{path}.InnerCount"),
    )?;
    let mut parameters = Vec::with_capacity(capacity);
    for index in 0..inner_count {
        parameters.push(read_property_type_name_at_depth(
            reader,
            names,
            &format_args!("{path}.Parameters[{index}]"),
            depth + 1,
        )?);
    }
    Ok(PropertyTypeName { name, parameters })
}

fn read_property_extensions(
    reader: &mut Reader<'_>,
    versions: &VersionContext,
    path: &(impl fmt::Display + ?Sized),
) -> Result<PropertyTagExtensions, PropertyError> {
    if !versions.is_at_least_ue5(UE5_PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION) {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(reader.tell()),
            path,
            "property tag has extension flag before extension serialization is supported",
        ));
    }
    let extension_offset = reader.tell();
    let raw_flags = reader.read_u8(path)?;
    if raw_flags & PROPERTY_EXTENSION_RESERVE_FOR_FUTURE_USE != 0 {
        return Err(PropertyError::new(
            PropertyErrorKind::UnsupportedCapability,
            Some(extension_offset),
            path,
            "future property-tag extension groups are not supported",
        ));
    }
    let (override_operation, experimental_overridable_logic) =
        if raw_flags & PROPERTY_EXTENSION_OVERRIDABLE_INFORMATION != 0 {
            (
                Some(reader.read_u8(&format_args!("{path}.OverriddenPropertyOperation"))?),
                Some(read_archive_bool(
                    reader,
                    &format_args!("{path}.ExperimentalOverridableLogic"),
                )?),
            )
        } else {
            (None, None)
        };
    Ok(PropertyTagExtensions {
        raw_flags,
        override_operation,
        experimental_overridable_logic,
    })
}

fn read_archive_bool(
    reader: &mut Reader<'_>,
    path: &(impl fmt::Display + ?Sized),
) -> Result<bool, PropertyError> {
    let offset = reader.tell();
    match reader.read_u32(path)? {
        0 => Ok(false),
        1 => Ok(true),
        value => Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(offset),
            path,
            format!("serialized bool must be 0 or 1, got {value}"),
        )),
    }
}

fn validate_name_ref(
    names: &[String],
    name: NameRef,
    path: &(impl fmt::Display + ?Sized),
) -> Result<(), PropertyError> {
    if usize::try_from(name.index().get())
        .ok()
        .is_some_and(|index| index < names.len())
    {
        Ok(())
    } else {
        Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            None,
            path.to_string(),
            format!("name index {} is outside name map", name.index().get()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{ArchiveErrorKind, ArchiveLimits, Reader};
    use crate::test_support::{
        TypeParam, name_ref, push_i32, ue5_versions, write_property_tag, write_property_terminator,
        write_type_name,
    };

    fn names() -> Vec<String> {
        vec![
            "None".into(),
            "IntProperty".into(),
            "EnumProperty".into(),
            "EnumValue".into(),
            "MyEnum::Alpha".into(),
            "ArrayProperty".into(),
            "NameProperty".into(),
            "Shop".into(),
            "Forge".into(),
        ]
    }

    #[test]
    fn tagged_breadcrumbs_are_lazy_but_preserve_failure_paths() {
        struct UnformattedPath;
        impl fmt::Display for UnformattedPath {
            fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                panic!("successful reads must not format diagnostic paths")
            }
        }

        let mut bytes = Vec::new();
        write_property_tag(
            &mut bytes,
            3,
            &TypeParam {
                type_index: 1,
                parameters: Vec::new(),
            },
            0,
            &42_i32.to_le_bytes(),
        );
        write_property_terminator(&mut bytes, 0);
        let stream = read_tagged_property_stream(
            &mut Reader::new(&bytes),
            &ue5_versions(),
            &names(),
            &UnformattedPath,
        )
        .unwrap();
        assert_eq!(stream.records.len(), 1);

        let error = read_tagged_property_stream(
            &mut Reader::new(&bytes[..12]),
            &ue5_versions(),
            &names(),
            &format_args!("Rows[{}].Value", 7),
        )
        .unwrap_err();
        assert_eq!(error.offset(), Some(12));
        assert_eq!(error.path(), "Rows[7].Value.Tag.Type.Name.Number");
    }

    #[test]
    fn reads_tagged_property_stream_with_complete_type_names() {
        let mut bytes = Vec::new();
        let payload = 42_i32.to_le_bytes();
        write_property_tag(
            &mut bytes,
            3,
            &TypeParam {
                type_index: 1,
                parameters: Vec::new(),
            },
            0,
            &payload,
        );
        write_property_terminator(&mut bytes, 0);

        let mut reader = Reader::new(&bytes);
        let stream = read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Test")
            .expect("parse stream");

        assert_eq!(stream.records.len(), 1);
        assert_eq!(stream.records[0].payload.len(), 4);
        assert_eq!(stream.records[0].type_name.name, name_ref(1, 0));
        assert_eq!(reader.tell(), bytes.len() as u64);
    }

    #[test]
    fn reads_optional_tag_fields_and_property_extensions() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, 3); // property name
        push_i32(&mut bytes, 0);
        write_type_name(
            &mut bytes,
            &TypeParam {
                type_index: 1,
                parameters: Vec::new(),
            },
        );
        push_i32(&mut bytes, 4); // payload size
        bytes.push(
            TAG_FLAG_HAS_ARRAY_INDEX
                | TAG_FLAG_HAS_PROPERTY_GUID
                | TAG_FLAG_HAS_PROPERTY_EXTENSIONS,
        );
        push_i32(&mut bytes, 7); // array index
        for value in [1_u32, 2, 3, 4] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.push(PROPERTY_EXTENSION_OVERRIDABLE_INFORMATION);
        bytes.push(9); // override operation
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&42_i32.to_le_bytes());
        write_property_terminator(&mut bytes, 0);

        let mut reader = Reader::new(&bytes);
        let stream = read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Test")
            .expect("parse optional fields");
        let record = &stream.records[0];

        assert_eq!(record.array_index, 7);
        assert_eq!(
            record.property_guid,
            Some(crate::archive::Guid {
                a: 1,
                b: 2,
                c: 3,
                d: 4,
            })
        );
        assert_eq!(
            record.extensions,
            Some(PropertyTagExtensions {
                raw_flags: PROPERTY_EXTENSION_OVERRIDABLE_INFORMATION,
                override_operation: Some(9),
                experimental_overridable_logic: Some(true),
            })
        );
        assert_eq!(record.payload.len(), 4);
        assert_eq!(reader.tell(), bytes.len() as u64);
    }

    #[test]
    fn reads_root_class_serialization_control_extensions() {
        let mut bytes = vec![CLASS_EXTENSION_OVERRIDABLE_SERIALIZATION_INFORMATION, 5];
        write_property_terminator(&mut bytes, 0);
        let mut reader = Reader::new(&bytes);

        let stream =
            read_uobject_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Object")
                .expect("parse root extensions");

        assert_eq!(
            stream.class_extensions,
            Some(ClassSerializationControlExtensions {
                raw_flags: CLASS_EXTENSION_OVERRIDABLE_SERIALIZATION_INFORMATION,
                overridable_operation: Some(5),
            })
        );
        assert!(stream.records.is_empty());
        assert_eq!(reader.tell(), bytes.len() as u64);
    }

    #[test]
    fn rejects_reserved_property_and_class_extension_groups() {
        let mut class_bytes = vec![CLASS_EXTENSION_RESERVE_FOR_FUTURE_USE];
        write_property_terminator(&mut class_bytes, 0);
        let class_error = read_uobject_tagged_property_stream(
            &mut Reader::new(&class_bytes),
            &ue5_versions(),
            &names(),
            "Object",
        )
        .unwrap_err();
        assert_eq!(class_error.kind(), PropertyErrorKind::UnsupportedCapability);

        let mut property_bytes = Vec::new();
        push_i32(&mut property_bytes, 3);
        push_i32(&mut property_bytes, 0);
        write_type_name(
            &mut property_bytes,
            &TypeParam {
                type_index: 1,
                parameters: Vec::new(),
            },
        );
        push_i32(&mut property_bytes, 0);
        property_bytes.push(TAG_FLAG_HAS_PROPERTY_EXTENSIONS);
        property_bytes.push(PROPERTY_EXTENSION_RESERVE_FOR_FUTURE_USE);
        let property_error = read_tagged_property_stream(
            &mut Reader::new(&property_bytes),
            &ue5_versions(),
            &names(),
            "Test",
        )
        .unwrap_err();
        assert_eq!(
            property_error.kind(),
            PropertyErrorKind::UnsupportedCapability
        );
    }

    #[test]
    fn reads_array_property_inner_type_parameters() {
        let mut bytes = Vec::new();
        write_type_name(
            &mut bytes,
            &TypeParam {
                type_index: 5,
                parameters: vec![TypeParam {
                    type_index: 6,
                    parameters: Vec::new(),
                }],
            },
        );
        let mut reader = Reader::new(&bytes);
        let type_name =
            read_property_type_name_for_test(&mut reader, &names()).expect("read type name");
        assert_eq!(type_name.name, name_ref(5, 0));
        assert_eq!(type_name.parameters.len(), 1);
        assert_eq!(type_name.parameters[0].name, name_ref(6, 0));
    }

    #[test]
    fn reads_multiple_records_through_the_terminator() {
        let mut bytes = Vec::new();
        for (name_index, value) in [(3, 10_i32), (4, 20_i32)] {
            write_property_tag(
                &mut bytes,
                name_index,
                &TypeParam {
                    type_index: 1,
                    parameters: Vec::new(),
                },
                0,
                &value.to_le_bytes(),
            );
        }
        write_property_terminator(&mut bytes, 0);
        let mut reader = Reader::new(&bytes);

        let stream = read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Test")
            .expect("parse records");

        assert_eq!(stream.records.len(), 2);
        assert_eq!(stream.records[0].name, name_ref(3, 0));
        assert_eq!(stream.records[1].name, name_ref(4, 0));
        assert_eq!(stream.terminator.len(), 8);
        assert_eq!(reader.tell(), bytes.len() as u64);
    }

    #[test]
    fn rejects_versions_before_the_legacy_window() {
        for ue5 in [0, 1011, 1012] {
            let versions = VersionContext {
                ue4: 521,
                ue5,
                ..ue5_versions()
            };
            for root in [false, true] {
                let mut reader = Reader::new(&[]);
                let result = if root {
                    read_uobject_tagged_property_stream(&mut reader, &versions, &names(), "Test")
                } else {
                    read_tagged_property_stream(&mut reader, &versions, &names(), "Test")
                };
                let error = result.unwrap_err();
                assert_eq!(error.kind(), PropertyErrorKind::UnsupportedVersion);
                assert_eq!(error.offset(), Some(0));
                assert!(error.detail().contains("resave"));
                assert_eq!(reader.tell(), 0);
            }
        }
    }

    #[test]
    fn dispatches_at_each_tag_version_boundary() {
        for ue5 in [0, 999, 1000, 1001, 1010, 1011, 1012, 1013] {
            let versions = VersionContext {
                ue5,
                ..ue5_versions()
            };
            let mut bytes = Vec::new();
            if ue5 >= 1011 {
                bytes.push(0);
            }
            write_property_terminator(&mut bytes, 0);
            let mut reader = Reader::new(&bytes);
            let result =
                read_uobject_tagged_property_stream(&mut reader, &versions, &names(), "Object");
            if ue5 == 999 {
                assert_eq!(
                    result.unwrap_err().kind(),
                    PropertyErrorKind::UnsupportedVersion
                );
            } else {
                let stream = result.unwrap();
                assert!(stream.records.is_empty());
                assert_eq!(stream.class_extensions.is_some(), ue5 >= 1011);
                assert_eq!(reader.tell(), bytes.len() as u64);
            }
        }
    }

    #[test]
    fn legacy_tags_preserve_each_extra_and_bound_the_payload() {
        use crate::test_support::write_legacy_property_tag;
        let names: Vec<String> = [
            "None",
            "Value",
            "StructProperty",
            "BoolProperty",
            "ByteProperty",
            "EnumProperty",
            "ArrayProperty",
            "SetProperty",
            "MapProperty",
            "OptionalProperty",
            "Vector",
            "IntProperty",
            "ExampleEnum",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        for ue5 in [0, 1000, 1009, 1010, 1011] {
            let versions = VersionContext {
                ue5,
                ..ue5_versions()
            };
            for (kind, parameters) in [
                (2, vec![10]),
                (3, vec![]),
                (4, vec![0]),
                (4, vec![12]),
                (5, vec![12]),
                (6, vec![11]),
                (7, vec![11]),
                (8, vec![11, 3]),
                (9, vec![11]),
            ] {
                let mut extras = Vec::new();
                for parameter in &parameters {
                    push_i32(&mut extras, *parameter);
                    push_i32(&mut extras, 0);
                }
                if kind == 2 {
                    for word in [1_i32, 2, 3, 4] {
                        push_i32(&mut extras, word);
                    }
                } else if kind == 3 {
                    extras.push(1);
                }
                extras.push(1);
                for word in [5_i32, 6, 7, 8] {
                    push_i32(&mut extras, word);
                }
                if ue5 == 1011 {
                    extras.extend_from_slice(&[2, 7]);
                    push_i32(&mut extras, 1);
                }
                let payload = if kind == 3 { vec![] } else { vec![0xAB, 0xCD] };
                let mut bytes = Vec::new();
                write_legacy_property_tag(&mut bytes, 1, kind, &extras, &payload);
                bytes[20..24].copy_from_slice(&7_i32.to_le_bytes());
                write_property_terminator(&mut bytes, 0);
                let mut reader = Reader::new(&bytes);
                let stream =
                    read_tagged_property_stream(&mut reader, &versions, &names, "Test").unwrap();
                let record = &stream.records[0];
                assert_eq!(record.array_index, 7);
                assert_eq!(record.payload.len(), payload.len() as u64);
                assert_eq!(record.flags.bool_value(), kind == 3);
                assert_eq!(
                    record.struct_guid,
                    (kind == 2).then_some(Guid {
                        a: 1,
                        b: 2,
                        c: 3,
                        d: 4,
                    })
                );
                assert_eq!(
                    record.property_guid,
                    Some(Guid {
                        a: 5,
                        b: 6,
                        c: 7,
                        d: 8,
                    })
                );
                if ue5 == 1011 {
                    let extensions = record.extensions.as_ref().unwrap();
                    assert_eq!(extensions.raw_flags, 2);
                    assert_eq!(extensions.override_operation, Some(7));
                    assert_eq!(extensions.experimental_overridable_logic, Some(true));
                } else {
                    assert!(record.extensions.is_none());
                }
                let expected = if kind == 4 && parameters == [0] {
                    0
                } else {
                    parameters.len()
                };
                assert_eq!(record.type_name.parameters.len(), expected);
                assert_eq!(reader.tell(), bytes.len() as u64);
            }
        }
    }

    #[test]
    fn legacy_numbered_types_have_no_extras_and_unresolved_structs_are_preserved() {
        use crate::test_support::write_legacy_property_tag;
        let names: Vec<String> = ["None", "Value", "StructProperty"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let versions = VersionContext {
            ue5: 1009,
            ..ue5_versions()
        };
        let mut bytes = Vec::new();
        write_legacy_property_tag(&mut bytes, 1, 2, &[0], &[1, 2]);
        bytes[12..16].copy_from_slice(&1_i32.to_le_bytes());
        let mut extras = Vec::new();
        push_i32(&mut extras, 99);
        push_i32(&mut extras, 0);
        extras.extend_from_slice(&[0; 17]);
        write_legacy_property_tag(&mut bytes, 1, 2, &extras, &[]);
        write_property_terminator(&mut bytes, 0);
        let stream =
            read_tagged_property_stream(&mut Reader::new(&bytes), &versions, &names, "Test")
                .unwrap();
        assert!(stream.records[0].type_name.parameters.is_empty());
        assert_eq!(
            stream.records[1].type_name.parameters[0].name,
            name_ref(99, 0)
        );
    }

    #[test]
    fn legacy_invalid_sizes_and_truncated_extensions_are_rejected() {
        use crate::test_support::write_legacy_property_tag;
        for ue5 in [0, 1010, 1011] {
            let versions = VersionContext {
                ue5,
                ..ue5_versions()
            };
            let mut extras = vec![0];
            if ue5 == 1011 {
                extras.push(0);
            }
            let mut bytes = Vec::new();
            write_legacy_property_tag(&mut bytes, 3, 1, &extras, &[42]);
            for size in [-1_i32, 2] {
                let mut malformed = bytes.clone();
                malformed[16..20].copy_from_slice(&size.to_le_bytes());
                let error = read_tagged_property_stream(
                    &mut Reader::new(&malformed),
                    &versions,
                    &names(),
                    "Test",
                )
                .unwrap_err();
                assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
            }
            for length in [24, 24 + extras.len() - 1] {
                let error = read_tagged_property_stream(
                    &mut Reader::new(&bytes[..length]),
                    &versions,
                    &names(),
                    "Test",
                )
                .unwrap_err();
                assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
            }
        }
    }

    #[test]
    fn rejects_negative_property_type_inner_count() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, 1);
        push_i32(&mut bytes, 0);
        push_i32(&mut bytes, -1);
        let error =
            read_property_type_name_for_test(&mut Reader::new(&bytes), &names()).unwrap_err();

        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert!(error.path().ends_with("InnerCount"));
    }

    #[test]
    fn rejects_overly_deep_property_type_names() {
        fn write_nested_type(bytes: &mut Vec<u8>, depth: usize) {
            push_i32(bytes, 5);
            push_i32(bytes, 0);
            if depth == 0 {
                push_i32(bytes, 0);
            } else {
                push_i32(bytes, 1);
                write_nested_type(bytes, depth - 1);
            }
        }

        let mut bytes = Vec::new();
        write_nested_type(&mut bytes, MAX_PROPERTY_TYPE_DEPTH);
        let mut reader = Reader::new(&bytes);

        let error = read_property_type_name_for_test(&mut reader, &names())
            .expect_err("depth limit should reject nested type names");

        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert!(error.detail().contains("depth limit"));
    }

    #[test]
    fn rejects_negative_property_payload_size() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, 3);
        push_i32(&mut bytes, 0);
        write_type_name(
            &mut bytes,
            &TypeParam {
                type_index: 1,
                parameters: Vec::new(),
            },
        );
        push_i32(&mut bytes, -1);

        let mut reader = Reader::new(&bytes);
        let error = read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Test")
            .expect_err("negative size");
        assert_eq!(error.kind(), PropertyErrorKind::MalformedData);
        assert!(error.path().contains("Tag.Size"));
    }

    #[test]
    fn maps_archive_allocation_limit_as_resource_limit() {
        let limits = ArchiveLimits {
            max_array_elements: 10,
            max_allocation_bytes: 7,
            ..ArchiveLimits::default()
        };
        let bytes = 2_i32.to_le_bytes();
        let archive_error = Reader::with_limits(&bytes, limits)
            .read_tarray::<u32>("Values", 4, |reader, _| reader.read_u32("Value"))
            .unwrap_err();
        assert_eq!(archive_error.kind(), ArchiveErrorKind::AllocationLimit);

        let error = PropertyError::from(archive_error);

        assert_eq!(error.kind(), PropertyErrorKind::ResourceLimit);
        assert_eq!(error.path(), "Values.Count");
    }

    fn read_property_type_name_for_test(
        reader: &mut Reader<'_>,
        names: &[String],
    ) -> Result<PropertyTypeName, PropertyError> {
        read_property_type_name(reader, names, "Test.Type")
    }
}

#[cfg(test)]
fn read_property_type_name_reference(
    reader: &mut Reader<'_>,
    names: &[String],
    path: &(impl fmt::Display + ?Sized),
    depth: usize,
) -> Result<PropertyTypeName, PropertyError> {
    if depth >= MAX_PROPERTY_TYPE_DEPTH {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(reader.tell()),
            path.to_string(),
            format!("property type-name nesting exceeds depth limit {MAX_PROPERTY_TYPE_DEPTH}"),
        ));
    }
    let name = reader.read_name_ref(&format_args!("{path}.Name"))?;
    validate_name_ref(names, name, &format_args!("{path}.Name"))?;
    let inner_count_offset = reader.tell();
    let inner_count = reader.read_i32(&format_args!("{path}.InnerCount"))?;
    if inner_count < 0 {
        return Err(PropertyError::new(
            PropertyErrorKind::MalformedData,
            Some(inner_count_offset),
            format!("{path}.InnerCount"),
            format!("type-name inner count must be non-negative, got {inner_count}"),
        ));
    }
    let inner_count = crate::convert::usize_from_checked(inner_count);
    let capacity = reader.checked_vec_capacity::<PropertyTypeName>(
        inner_count,
        12,
        &format_args!("{path}.InnerCount"),
    )?;
    let mut parameters = Vec::with_capacity(capacity);
    for index in 0..inner_count {
        parameters.push(read_property_type_name_reference(
            reader,
            names,
            &format_args!("{path}.Parameters[{index}]"),
            depth + 1,
        )?);
    }
    Ok(PropertyTypeName { name, parameters })
}

#[cfg(test)]
mod type_prefix_tests {
    use super::*;
    use crate::archive::ArchiveLimits;

    fn check(wire: &[u8], offset: usize, length: usize, depth: usize, limits: ArchiveLimits) {
        let mut bytes = vec![0x55; offset];
        bytes.extend(wire);
        bytes.extend([0x33; 8]);
        let mut actual = Reader::with_limits(&bytes, limits)
            .bounded(Span::new(offset as u64, length as u64).unwrap(), "Bound")
            .unwrap();
        let mut expected = actual.clone();
        let names = ["None", "IntProperty", "ArrayProperty"]
            .map(str::to_owned)
            .to_vec();
        let a = read_property_type_name_at_depth(&mut actual, &names, "Type", depth);
        let b = read_property_type_name_reference(&mut expected, &names, "Type", depth);
        assert_eq!(
            format!("{a:?}"),
            format!("{b:?}"),
            "wire={wire:02x?} offset={offset} length={length} depth={depth}"
        );
        assert_eq!(actual.tell(), expected.tell());
    }

    #[test]
    fn grouped_type_prefix_keeps_names_counts_depths_bounds_and_failure_priority() {
        let mut cases = Vec::new();
        for index in [i32::MIN, -1, 0, 1, 2, 3, i32::MAX] {
            for number in [-1i32, 0, 1, i32::MAX] {
                for count in [i32::MIN, -1, 0, 1, 2, i32::MAX] {
                    let mut bytes = Vec::new();
                    bytes.extend(index.to_le_bytes());
                    bytes.extend(number.to_le_bytes());
                    bytes.extend(count.to_le_bytes());
                    for _ in 0..2 {
                        bytes.extend(1i32.to_le_bytes());
                        bytes.extend(0i32.to_le_bytes());
                        bytes.extend(0i32.to_le_bytes());
                    }
                    cases.push(bytes);
                }
            }
        }
        let nested: Vec<u8> = [(2i32, 1i32), (2, 1), (1, 0)]
            .into_iter()
            .flat_map(|(name, count)| {
                [name.to_le_bytes(), 0i32.to_le_bytes(), count.to_le_bytes()].concat()
            })
            .collect();
        for i in 0..nested.len() {
            for mask in [1, 128, 255] {
                let mut bytes = nested.clone();
                bytes[i] ^= mask;
                cases.push(bytes);
            }
        }
        cases.push(nested);
        for bytes in cases {
            for offset in [0, 1, 7] {
                for length in [0, 4, 7, 8, 11, 12, 15, 24, bytes.len()] {
                    for depth in [0, 63, 64] {
                        check(&bytes, offset, length, depth, ArchiveLimits::default());
                    }
                }
            }
            let limits = ArchiveLimits {
                max_array_elements: 0,
                max_allocation_bytes: 0,
                ..ArchiveLimits::default()
            };
            check(&bytes, 1, bytes.len(), 0, limits);
        }
    }
}
