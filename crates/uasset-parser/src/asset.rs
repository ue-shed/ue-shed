//! Asset-level decoders.
//!
//! The class constants below are dispatch targets, not a list of supported asset types. Any class
//! this module does not specifically claim reaches [`is_generic_uobject_class`], which is a
//! permissive default, and decodes through the generic UObject tagged-property path. Levels rely
//! entirely on that fallback: a `.umap` needs no level-specific decoder, and its actors, components,
//! `Level`, `World`, and `WorldSettings` exports all decode as generic UObjects.
//!
//! The boundary that does exist is native serialization. Classes with a custom `UObject::Serialize`
//! write binary after their tagged properties; that payload is preserved as `tail_bytes` rather than
//! decoded, so a non-zero `tail_bytes` means "undecoded native payload", not "failed parse".

use std::fmt;

use crate::archive::{ArchiveError, ArchiveErrorKind, Guid, NameRef, Span};
use crate::codec::{DecodeContext, decode_property_stream_values};
use crate::package::{Export, ObjectPath, Package, PackageError, PackageIndex};
use crate::property::{
    PropertyError, PropertyErrorKind, PropertyStream, PropertyValue, read_tagged_property_stream,
    read_uobject_tagged_property_stream,
};
use crate::schema::{SchemaProvider, SerializationOperation};

pub struct AssetDecodeContext<'a> {
    pub source: &'a [u8],
    pub package: &'a Package,
    pub schemas: &'a dyn SchemaProvider,
}

pub const DATATABLE_CLASS: &str = "/Script/Engine.DataTable";
pub const COMPOSITE_DATATABLE_CLASS: &str = "/Script/Engine.CompositeDataTable";
pub const CURVETABLE_CLASS: &str = "/Script/Engine.CurveTable";
pub const DATA_ASSET_CLASS: &str = "/Script/Engine.DataAsset";
pub const PRIMARY_DATA_ASSET_CLASS: &str = "/Script/Engine.PrimaryDataAsset";
pub const STRINGTABLE_CLASS: &str = "/Script/Engine.StringTable";
pub const USERDEFINEDENUM_CLASS: &str = "/Script/Engine.UserDefinedEnum";
pub const USERDEFINEDSTRUCT_CLASS: &str = "/Script/CoreUObject.UserDefinedStruct";
pub const SKELETON_CLASS: &str = "/Script/Engine.Skeleton";
pub const ANIM_SEQUENCE_CLASS: &str = "/Script/Engine.AnimSequence";
const MAX_FIELD_DEPTH: usize = 64;
const STRIP_EDITOR_ONLY: u8 = 1;

/// Package/meta exports that share the package file but are not inspectable assets.
const SKIP_UOBJECT_DECODE_CLASSES: &[&str] = &[
    "/Script/CoreUObject.Package",
    "/Script/CoreUObject.MetaData",
    "/Script/Engine.AssetImportData",
];

/// Returns whether `class_path` names a UObject Data Asset type.
///
/// Matches engine base classes and native subclasses whose UClass name ends in
/// `DataAsset` (for example `/Script/E2EFixtures.E2EFixtureScalarsDataAsset`).
pub fn is_data_asset_class(class_path: &str) -> bool {
    matches!(class_path, DATA_ASSET_CLASS | PRIMARY_DATA_ASSET_CLASS)
        || class_path
            .rsplit('.')
            .next()
            .is_some_and(|class_name| class_name.ends_with("DataAsset"))
}

/// Returns whether `class_path` should use the generic UObject property decoder.
///
/// This is a permissive default rather than an allowlist: it returns `true` for every class without
/// a specific decoder, which is why level actors and components decode with no level-specific code.
pub fn is_generic_uobject_class(class_path: &str) -> bool {
    !DataTableDecoder::supports_class(class_path)
        && class_path != CURVETABLE_CLASS
        && class_path != STRINGTABLE_CLASS
        && class_path != USERDEFINEDENUM_CLASS
        && class_path != USERDEFINEDSTRUCT_CLASS
        && class_path != ANIM_SEQUENCE_CLASS
        && !is_data_asset_class(class_path)
        && !SKIP_UOBJECT_DECODE_CLASSES.contains(&class_path)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DataTableKind {
    Plain,
    Composite,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DecodedAsset {
    DataTable(DecodedDataTable),
    CurveTable(DecodedCurveTable),
    StringTable(DecodedStringTable),
    DataAsset(DecodedDataAsset),
    UObject(DecodedUObject),
    Enum(DecodedEnum),
    Struct(DecodedStruct),
    Skeleton(DecodedSkeleton),
    AnimSequence(DecodedAnimSequence),
}

/// A decoded uncooked `UAnimSequence` export.
///
/// Source tracks live in a separately exported animation-data-model object in UE 5.7. This model
/// owns the sequence's tagged properties and the small native trailer that `UAnimationAsset` and
/// `UAnimSequence::Serialize` append around that source-model reference. Cooked compressed streams
/// remain outside the supported saved-package boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedAnimSequence {
    pub object_path: ObjectPath,
    pub object_guid: Option<Guid>,
    pub properties: PropertyStream,
    pub skeleton_guid: Guid,
    pub global_strip_flags: u8,
    pub class_strip_flags: u8,
    pub legacy_raw_track_count: u32,
    pub serialized_compressed_data: bool,
}

/// A decoded `USkeleton` export: its tagged properties plus the
/// `FReferenceSkeleton` bone hierarchy parsed from the export tail.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedSkeleton {
    pub object_path: ObjectPath,
    pub object_guid: Option<Guid>,
    pub properties: PropertyStream,
    pub bones: Vec<SkeletonBone>,
}

/// One bone from a `USkeleton`'s `FReferenceSkeleton` (`FMeshBoneInfo`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkeletonBone {
    pub name: NameRef,
    /// Index into the bone array of this bone's parent; `-1` for the root.
    pub parent_index: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedDataAsset {
    pub object_path: ObjectPath,
    pub class_path: ObjectPath,
    pub object_guid: Option<Guid>,
    pub properties: PropertyStream,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedUObject {
    pub object_path: ObjectPath,
    pub class_path: ObjectPath,
    pub object_guid: Option<Guid>,
    pub properties: PropertyStream,
    /// Unparsed class-specific bytes after the tagged-property stream (and any
    /// object-guid footer). Empty when the export is a plain property object.
    /// Retained rather than decoded so classes with a binary tail (e.g.
    /// `StaticMesh`, `SkeletalMesh`, `Texture2D`) still surface their properties.
    pub tail: Span,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedDataTable {
    pub kind: DataTableKind,
    pub object_path: ObjectPath,
    pub object_guid: Option<Guid>,
    pub row_struct: Option<ObjectPath>,
    pub parent_tables: Vec<ObjectPath>,
    pub properties: PropertyStream,
    pub rows: Vec<DataTableRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DataTableRow {
    pub name: NameRef,
    pub properties: PropertyStream,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedCurveTable {
    pub object_path: ObjectPath,
    pub mode: CurveTableMode,
    pub properties: PropertyStream,
    pub rows: Vec<CurveTableRow>,
}

/// A decoded `UUserDefinedEnum` export.
///
/// The `DisplayNameMap` (`TMap<FName, FText>`) rides in the tagged-property
/// stream and is retained in `properties`; each entry's `display_name` is the
/// resolved value from that map, when present.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedEnum {
    pub object_path: ObjectPath,
    pub cpp_form: EnumCppForm,
    pub properties: PropertyStream,
    pub entries: Vec<EnumEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EnumEntry {
    /// Qualified `FName` for the entry, e.g. `MyEnum::Entry0`.
    pub name: NameRef,
    pub value: i64,
    pub display_name: Option<String>,
}

/// A decoded `UUserDefinedStruct` export.
///
/// Carries the struct's own tagged properties (`Status`, `Guid`), the field
/// schema parsed from `ChildProperties`, the serialized `StructFlags`, and the
/// default-instance property stream.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedStruct {
    pub object_path: ObjectPath,
    pub struct_flags: u32,
    pub properties: PropertyStream,
    pub fields: Vec<StructField>,
    pub default_values: PropertyStream,
}

/// One field from a `UUserDefinedStruct`'s `ChildProperties` (`FProperty`).
#[derive(Clone, Debug, PartialEq)]
pub struct StructField {
    /// On-disk `FName` of the field (GUID-mangled, e.g. `IntValue_2_<hex>`).
    pub name: NameRef,
    /// `FProperty` subclass name, e.g. `IntProperty`, `StructProperty`.
    pub type_name: NameRef,
    /// Resolved struct/enum/class/object path the field references, when any.
    pub referenced_path: Option<ObjectPath>,
    /// Friendly display name from the field's `DisplayName` metadata, when present.
    pub display_name: Option<String>,
}

/// How a `UEnum` was originally declared (`UEnum::ECppForm`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnumCppForm {
    Regular,
    Namespaced,
    EnumClass,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedStringTable {
    pub object_path: ObjectPath,
    pub namespace: String,
    pub entries: Vec<StringTableEntry>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StringTableEntry {
    pub key: String,
    pub source: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CurveTableMode {
    Empty,
    SimpleCurves,
    RichCurves,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CurveTableRow {
    pub name: NameRef,
    pub keys: Vec<CurveKey>,
}

struct SourceCurveTableData {
    mode: CurveTableMode,
    rows: Vec<CurveTableRow>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CurveKey {
    Simple(SimpleCurveKey),
    Rich(RichCurveKey),
}

impl CurveKey {
    #[must_use]
    pub const fn time(self) -> f32 {
        match self {
            Self::Simple(key) => key.time,
            Self::Rich(key) => key.time,
        }
    }

    #[must_use]
    pub const fn value(self) -> f32 {
        match self {
            Self::Simple(key) => key.value,
            Self::Rich(key) => key.value,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimpleCurveKey {
    pub time: f32,
    pub value: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RichCurveKey {
    pub interp_mode: u8,
    pub tangent_mode: u8,
    pub tangent_weight_mode: u8,
    pub time: f32,
    pub value: f32,
    pub arrive_tangent: f32,
    pub arrive_tangent_weight: f32,
    pub leave_tangent: f32,
    pub leave_tangent_weight: f32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetErrorKind {
    MalformedData,
    ResourceLimit,
    UnsupportedFormat,
    UnsupportedVersion,
    UnsupportedCapability,
}

#[derive(Debug)]
pub struct AssetError {
    kind: AssetErrorKind,
    message: String,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
}

impl AssetError {
    fn new(kind: AssetErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            source: None,
        }
    }

    #[must_use]
    pub const fn kind(&self) -> AssetErrorKind {
        self.kind
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for AssetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AssetError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_ref()
            .map(|source| source.as_ref() as &(dyn std::error::Error + 'static))
    }
}

impl From<PackageError> for AssetError {
    fn from(source: PackageError) -> Self {
        let kind = match source.kind() {
            crate::package::PackageErrorKind::MalformedData => AssetErrorKind::MalformedData,
            crate::package::PackageErrorKind::ResourceLimit => AssetErrorKind::ResourceLimit,
            crate::package::PackageErrorKind::UnsupportedFormat => {
                AssetErrorKind::UnsupportedFormat
            }
            crate::package::PackageErrorKind::UnsupportedVersion => {
                AssetErrorKind::UnsupportedVersion
            }
            crate::package::PackageErrorKind::UnsupportedCapability => {
                AssetErrorKind::UnsupportedCapability
            }
        };
        Self {
            kind,
            message: source.to_string(),
            source: Some(Box::new(source)),
        }
    }
}

impl From<PropertyError> for AssetError {
    fn from(source: PropertyError) -> Self {
        let kind = match source.kind() {
            PropertyErrorKind::MalformedData => AssetErrorKind::MalformedData,
            PropertyErrorKind::ResourceLimit => AssetErrorKind::ResourceLimit,
            PropertyErrorKind::UnsupportedVersion => AssetErrorKind::UnsupportedVersion,
            PropertyErrorKind::UnsupportedCapability => AssetErrorKind::UnsupportedCapability,
        };
        Self {
            kind,
            message: source.to_string(),
            source: Some(Box::new(source)),
        }
    }
}

impl From<ArchiveError> for AssetError {
    fn from(source: ArchiveError) -> Self {
        let kind = match source.kind() {
            ArchiveErrorKind::OutOfBounds
            | ArchiveErrorKind::InvalidSeek
            | ArchiveErrorKind::InvalidCount
            | ArchiveErrorKind::MissingNullTerminator
            | ArchiveErrorKind::InvalidString
            | ArchiveErrorKind::InvalidNameReference
            | ArchiveErrorKind::IntegerOverflow => AssetErrorKind::MalformedData,
            ArchiveErrorKind::AllocationLimit => AssetErrorKind::ResourceLimit,
        };
        Self {
            kind,
            message: source.to_string(),
            source: Some(Box::new(source)),
        }
    }
}

pub trait AssetDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool;

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DataTableDecoder;

impl AssetDecoder for DataTableDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        Self::supports_class(class_path.as_str())
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        let kind = if class_path.as_str() == COMPOSITE_DATATABLE_CLASS
            || context
                .schemas
                .class_is_a(class_path, COMPOSITE_DATATABLE_CLASS)
        {
            DataTableKind::Composite
        } else if class_path.as_str() == DATATABLE_CLASS
            || context.schemas.class_is_a(class_path, DATATABLE_CLASS)
        {
            DataTableKind::Plain
        } else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        };
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::DataTable)?;

        let (properties, mut reader) = decode_uobject_properties(export, context)?;
        let decode_context = DecodeContext {
            package: context.package,
            versions: &context.package.summary.versions,
            schemas: context.schemas,
        };
        let row_struct = row_struct_path(context.package, &properties);
        let parent_tables = parent_tables_paths(context.package, &properties);

        let object_guid = consume_inline_object_guid_footer(&mut reader, &export.object_path)?;

        let rows =
            decode_data_table_rows(&mut reader, context, &decode_context, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "DataTable export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }

        Ok(DecodedAsset::DataTable(DecodedDataTable {
            kind,
            object_path: export.object_path.clone(),
            object_guid,
            row_struct,
            parent_tables,
            properties,
            rows,
        }))
    }
}

impl DataTableDecoder {
    fn supports_class(class_path: &str) -> bool {
        matches!(class_path, DATATABLE_CLASS | COMPOSITE_DATATABLE_CLASS)
    }
}

fn decode_data_table_rows(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    decode_context: &DecodeContext<'_>,
    object_path: &ObjectPath,
) -> Result<Vec<DataTableRow>, AssetError> {
    let row_count_offset = reader.tell();
    let row_count = reader.read_i32(&format!("{object_path}.Rows.Count"))?;
    if row_count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative DataTable row count {row_count} at byte {row_count_offset}"),
        ));
    }
    let capacity = reader.checked_vec_capacity::<DataTableRow>(
        usize::try_from(row_count).expect("i32 fits in usize"),
        8,
        &format!("{object_path}.Rows.Count"),
    )?;
    let mut rows = Vec::with_capacity(capacity);
    for index in 0..row_count {
        let row_path = format!("{object_path}.Rows[{index}]");
        let name = reader.read_name_ref(&format!("{row_path}.Name"))?;
        let mut row_properties = read_tagged_property_stream(
            reader,
            &context.package.summary.versions,
            &context.package.names,
            &format!("{row_path}.Value"),
        )?;
        decode_property_stream_values(context.source, &mut row_properties, decode_context)?;
        rows.push(DataTableRow {
            name,
            properties: row_properties,
        });
    }
    Ok(rows)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CurveTableDecoder;

impl AssetDecoder for CurveTableDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == CURVETABLE_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != CURVETABLE_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::CurveTable)?;

        let (properties, mut reader) = decode_uobject_properties(export, context)?;
        let footer_offset = reader.tell();
        let footer = reader.read_i32(&format!("{}.ExportFooter", export.object_path))?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "expected zero CurveTable UObject footer at byte {footer_offset}, got {footer}"
                ),
            ));
        }

        let curve_table = decode_curve_table_data(&mut reader, context, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "CurveTable export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }

        Ok(DecodedAsset::CurveTable(DecodedCurveTable {
            object_path: export.object_path.clone(),
            mode: curve_table.mode,
            properties,
            rows: curve_table.rows,
        }))
    }
}

fn decode_curve_table_data(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    object_path: &ObjectPath,
) -> Result<SourceCurveTableData, AssetError> {
    let row_count_offset = reader.tell();
    let row_count = reader.read_i32(&format!("{object_path}.Rows.Count"))?;
    if row_count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative CurveTable row count {row_count} at byte {row_count_offset}"),
        ));
    }

    let raw_mode = reader.read_u8(&format!("{object_path}.Mode"))?;
    let mode = match raw_mode {
        0 => CurveTableMode::Empty,
        1 => CurveTableMode::SimpleCurves,
        2 => CurveTableMode::RichCurves,
        value => {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("unsupported CurveTable mode {value}"),
            ));
        }
    };
    let capacity = reader.checked_vec_capacity::<CurveTableRow>(
        usize::try_from(row_count).expect("i32 fits in usize"),
        16,
        &format!("{object_path}.Rows.Count"),
    )?;
    let mut rows = Vec::with_capacity(capacity);
    for index in 0..row_count {
        let row_path = format!("{object_path}.Rows[{index}]");
        let name = reader.read_name_ref(&format!("{row_path}.Name"))?;
        let stream = read_tagged_property_stream(
            reader,
            &context.package.summary.versions,
            &context.package.names,
            &format!("{row_path}.Curve"),
        )?;
        let keys = match mode {
            CurveTableMode::Empty => Vec::new(),
            CurveTableMode::SimpleCurves => {
                decode_simple_curve_keys(context.source, context.package, &stream, &row_path)?
            }
            CurveTableMode::RichCurves => {
                decode_rich_curve_keys(context.source, context.package, &stream, &row_path)?
            }
        };
        rows.push(CurveTableRow { name, keys });
    }
    Ok(SourceCurveTableData { mode, rows })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DataAssetDecoder;

impl AssetDecoder for DataAssetDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        is_data_asset_class(class_path.as_str())
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if !is_data_asset_class(class_path.as_str())
            && !context.schemas.class_is_a(class_path, DATA_ASSET_CLASS)
        {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::DataAsset)?;

        let (properties, class_path, object_guid) =
            decode_uobject_asset_properties(export, context)?;

        Ok(DecodedAsset::DataAsset(DecodedDataAsset {
            object_path: export.object_path.clone(),
            class_path,
            object_guid,
            properties,
        }))
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StringTableDecoder;

impl AssetDecoder for StringTableDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == STRINGTABLE_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != STRINGTABLE_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::StringTable)?;

        let (_properties, mut reader) = decode_uobject_properties(export, context)?;
        let footer_offset = reader.tell();
        let footer = reader.read_i32(&format!("{}.ExportFooter", export.object_path))?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "expected zero StringTable UObject footer at byte {footer_offset}, got {footer}"
                ),
            ));
        }

        let data = decode_string_table_data(&mut reader, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "StringTable export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }

        Ok(DecodedAsset::StringTable(DecodedStringTable {
            object_path: export.object_path.clone(),
            namespace: data.namespace,
            entries: data.entries,
        }))
    }
}

struct SourceStringTableData {
    namespace: String,
    entries: Vec<StringTableEntry>,
}

fn decode_string_table_data(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<SourceStringTableData, AssetError> {
    let namespace = reader.read_fstring(&format!("{object_path}.Namespace"))?;
    let entry_count_offset = reader.tell();
    let entry_count = reader.read_i32(&format!("{object_path}.Entries.Count"))?;
    if entry_count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative StringTable entry count {entry_count} at byte {entry_count_offset}"),
        ));
    }
    let capacity = reader.checked_vec_capacity::<StringTableEntry>(
        usize::try_from(entry_count).expect("i32 fits in usize"),
        8,
        &format!("{object_path}.Entries.Count"),
    )?;
    let mut entries = Vec::with_capacity(capacity);
    for index in 0..entry_count {
        let entry_path = format!("{object_path}.Entries[{index}]");
        let key = reader.read_fstring(&format!("{entry_path}.Key"))?;
        let source = reader.read_fstring(&format!("{entry_path}.SourceString"))?;
        entries.push(StringTableEntry { key, source });
    }

    let metadata_count = reader.read_i32(&format!("{object_path}.MetaData.Count"))?;
    if metadata_count != 0 {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!("StringTable metadata map with {metadata_count} entries is not supported yet"),
        ));
    }

    Ok(SourceStringTableData { namespace, entries })
}

#[derive(Clone, Copy, Debug, Default)]
pub struct EnumDecoder;

struct SourceEnumData {
    cpp_form: EnumCppForm,
    entries: Vec<EnumEntry>,
}

fn decode_enum_data(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    properties: &PropertyStream,
    object_path: &ObjectPath,
) -> Result<SourceEnumData, AssetError> {
    // `UEnum::Serialize` writes the names as `int32 Num` followed by
    // `Num` × (`FName`, `int64`) pairs, then a `uint8 CppForm`.
    let count_offset = reader.tell();
    let count = reader.read_i32(&format!("{object_path}.Names.Count"))?;
    if count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative Enum name count {count} at byte {count_offset}"),
        ));
    }
    let capacity = reader.checked_vec_capacity::<(NameRef, i64)>(
        usize::try_from(count).expect("i32 fits in usize"),
        16,
        &format!("{object_path}.Names.Count"),
    )?;
    let mut raw_entries = Vec::with_capacity(capacity);
    for index in 0..count {
        let entry_path = format!("{object_path}.Names[{index}]");
        let name = reader.read_name_ref(&format!("{entry_path}.Name"))?;
        let value = reader.read_i64(&format!("{entry_path}.Value"))?;
        raw_entries.push((name, value));
    }

    let cpp_form_offset = reader.tell();
    let raw_form = reader.read_u8(&format!("{object_path}.CppForm"))?;
    let cpp_form = match raw_form {
        0 => EnumCppForm::Regular,
        1 => EnumCppForm::Namespaced,
        2 => EnumCppForm::EnumClass,
        value => {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("unsupported Enum CppForm {value} at byte {cpp_form_offset}"),
            ));
        }
    };

    let display_names = display_name_map(context.package, properties);
    let entries = raw_entries
        .into_iter()
        .map(|(name, value)| EnumEntry {
            name,
            value,
            display_name: display_names
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, source)| source.clone()),
        })
        .collect();

    Ok(SourceEnumData { cpp_form, entries })
}

impl AssetDecoder for EnumDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == USERDEFINEDENUM_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != USERDEFINEDENUM_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }

        let (properties, mut reader) = decode_uobject_properties(export, context)?;
        let footer_offset = reader.tell();
        let footer = reader.read_i32(&format!("{}.ExportFooter", export.object_path))?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("expected zero Enum UObject footer at byte {footer_offset}, got {footer}"),
            ));
        }

        let data = decode_enum_data(&mut reader, context, &properties, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "Enum export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }

        Ok(DecodedAsset::Enum(DecodedEnum {
            object_path: export.object_path.clone(),
            cpp_form: data.cpp_form,
            properties,
            entries: data.entries,
        }))
    }
}

/// Collects the `DisplayNameMap` (`TMap<FName, FText>`) entries from a decoded
/// `UUserDefinedEnum` property stream as `(qualified name, display string)`
/// pairs. Returns empty when the map is absent or carries unexpected value types.
fn display_name_map(package: &Package, properties: &PropertyStream) -> Vec<(NameRef, String)> {
    let Some(record) = properties
        .records
        .iter()
        .find(|record| package.resolve_name(record.name).as_deref() == Some("DisplayNameMap"))
    else {
        return Vec::new();
    };
    let PropertyValue::Map(entries) = &record.value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let PropertyValue::Name(name) = entry.key else {
                return None;
            };
            let PropertyValue::Text(text) = &entry.value else {
                return None;
            };
            Some((name, text.source.clone()))
        })
        .collect()
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StructDecoder;

impl AssetDecoder for StructDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == USERDEFINEDSTRUCT_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != USERDEFINEDSTRUCT_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }

        let (properties, mut reader) = decode_uobject_properties(export, context)?;

        let footer_offset = reader.tell();
        let footer = reader.read_i32(&format!("{}.ExportFooter", export.object_path))?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "expected zero struct UObject footer at byte {footer_offset}, got {footer}"
                ),
            ));
        }

        let fields = decode_struct_definition(&mut reader, context, &export.object_path)?;
        let struct_flags = decode_struct_flags(&mut reader, &export.object_path)?;
        let default_values =
            decode_struct_default_instance(&mut reader, context, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "struct export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }

        Ok(DecodedAsset::Struct(DecodedStruct {
            object_path: export.object_path.clone(),
            struct_flags,
            properties,
            fields,
            default_values,
        }))
    }
}

fn decode_struct_definition(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    object_path: &ObjectPath,
) -> Result<Vec<StructField>, AssetError> {
    // UStruct::Serialize tail. SuperStruct is an FPackageIndex; user structs
    // have no super, so it is null (0). Children is a TArray<UField*>; user
    // structs carry their members as ChildProperties (FFields), not UFields.
    let _super_struct = reader.read_i32(&format!("{object_path}.SuperStruct"))?;
    let child_count = reader.read_i32(&format!("{object_path}.Children.Count"))?;
    for index in 0..child_count.max(0) {
        reader.read_i32(&format!("{object_path}.Children[{index}]"))?;
    }

    let field_count_offset = reader.tell();
    let field_count = reader.read_i32(&format!("{object_path}.ChildProperties.Count"))?;
    if field_count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative struct field count {field_count} at byte {field_count_offset}"),
        ));
    }
    let capacity = reader.checked_vec_capacity::<StructField>(
        usize::try_from(field_count).expect("fits in usize"),
        1,
        &format!("{object_path}.ChildProperties.Count"),
    )?;
    let mut fields = Vec::with_capacity(capacity);
    for index in 0..field_count {
        let field_path = format!("{object_path}.ChildProperties[{index}]");
        if let Some(field) = read_field(reader, context, &field_path)? {
            fields.push(field);
        }
    }

    // FStructScriptLoader reads the bytecode and serialized-storage sizes.
    // User-defined structs should not carry script, but preserve the legacy
    // rejection boundary if malformed input claims that they do.
    let bytecode_size = reader.read_i32(&format!("{object_path}.ScriptBytecodeSize"))?;
    let storage_size = reader.read_i32(&format!("{object_path}.ScriptStorageSize"))?;
    if bytecode_size != 0 || storage_size != 0 {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!(
                "struct {object_path} carries {storage_size} bytes of script bytecode (unsupported)"
            ),
        ));
    }
    Ok(fields)
}

fn decode_struct_flags(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<u32, AssetError> {
    reader
        .read_u32(&format!("{object_path}.StructFlags"))
        .map_err(Into::into)
}

fn decode_struct_default_instance(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    object_path: &ObjectPath,
) -> Result<PropertyStream, AssetError> {
    let mut default_values = read_tagged_property_stream(
        reader,
        &context.package.summary.versions,
        &context.package.names,
        &format!("{object_path}.DefaultInstance"),
    )?;
    let decode_context = DecodeContext {
        package: context.package,
        versions: &context.package.summary.versions,
        schemas: context.schemas,
    };
    decode_property_stream_values(context.source, &mut default_values, &decode_context)?;
    Ok(default_values)
}

/// Reads one `FField`/`FProperty` as written by `UStruct::SerializeProperties`
/// (and `SerializeSingleField` for inner fields): a leading type `FName`, then
/// `FField::Serialize` (name + flags + optional metadata map), then
/// `FProperty::Serialize`, then any type-specific tail. Returns `None` for a
/// `NAME_None` type (a null inner field).
fn read_field(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &str,
) -> Result<Option<StructField>, AssetError> {
    read_field_at_depth(reader, context, path, 0)
}

fn read_field_at_depth(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &str,
    depth: usize,
) -> Result<Option<StructField>, AssetError> {
    if depth >= MAX_FIELD_DEPTH {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("struct field nesting exceeds depth limit {MAX_FIELD_DEPTH} at {path}"),
        ));
    }
    let type_name = reader.read_name_ref(&format!("{path}.Type"))?;
    let type_str = context.package.resolve_name(type_name).unwrap_or_default();
    if type_str == "None" || type_str.is_empty() {
        return Ok(None);
    }

    // FField::Serialize: name, flags, then (uncooked) the metadata map.
    let name = reader.read_name_ref(&format!("{path}.Name"))?;
    let _flags = reader.read_u32(&format!("{path}.Flags"))?;
    let display_name = read_field_metadata(reader, context, path)?;

    // FProperty::Serialize.
    let _array_dim = reader.read_i32(&format!("{path}.ArrayDim"))?;
    let _element_size = reader.read_i32(&format!("{path}.ElementSize"))?;
    let _property_flags = reader.read_u64(&format!("{path}.PropertyFlags"))?;
    // FProperty::RepIndex is a uint16 (serialized as a default 0 on save).
    let _rep_index = reader.read_u16(&format!("{path}.RepIndex"))?;
    let _rep_notify = reader.read_name_ref(&format!("{path}.RepNotifyFunc"))?;
    let _bp_rep_condition = reader.read_u8(&format!("{path}.BlueprintReplicationCondition"))?;

    // Type-specific tail.
    let referenced_path = read_field_type_tail(reader, context, path, &type_str, depth)?;

    Ok(Some(StructField {
        name,
        type_name,
        referenced_path,
        display_name,
    }))
}

/// Reads the per-type tail of an `FProperty`, returning the struct/enum/class
/// path it references when applicable. Recurses for container inner fields.
fn read_field_type_tail(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &str,
    type_str: &str,
    depth: usize,
) -> Result<Option<ObjectPath>, AssetError> {
    let read_ref = |reader: &mut crate::archive::Reader<'_>,
                    field: &str|
     -> Result<Option<ObjectPath>, AssetError> {
        let raw = reader.read_i32(&format!("{path}.{field}"))?;
        Ok(context.package.resolve_index(PackageIndex::from_raw(raw)))
    };

    match type_str {
        "BoolProperty" => {
            // FieldSize, ByteOffset, ByteMask, FieldMask, BoolSize, NativeBool: u8 each.
            reader.skip(6, &format!("{path}.BoolLayout"))?;
            Ok(None)
        }
        "ByteProperty" => read_ref(reader, "Enum"),
        "EnumProperty" => {
            let enum_ref = read_ref(reader, "Enum")?;
            read_field_at_depth(
                reader,
                context,
                &format!("{path}.UnderlyingProp"),
                depth + 1,
            )?;
            Ok(enum_ref)
        }
        "StructProperty" => read_ref(reader, "Struct"),
        "ObjectProperty" | "WeakObjectProperty" | "LazyObjectProperty" | "SoftObjectProperty" => {
            read_ref(reader, "PropertyClass")
        }
        "ClassProperty" | "SoftClassProperty" => {
            let property_class = read_ref(reader, "PropertyClass")?;
            read_ref(reader, "MetaClass")?;
            Ok(property_class)
        }
        "InterfaceProperty" => read_ref(reader, "InterfaceClass"),
        "ArrayProperty" => {
            read_field_at_depth(reader, context, &format!("{path}.Inner"), depth + 1)?;
            Ok(None)
        }
        "SetProperty" | "OptionalProperty" => {
            read_field_at_depth(reader, context, &format!("{path}.Element"), depth + 1)?;
            Ok(None)
        }
        "MapProperty" => {
            read_field_at_depth(reader, context, &format!("{path}.Key"), depth + 1)?;
            read_field_at_depth(reader, context, &format!("{path}.Value"), depth + 1)?;
            Ok(None)
        }
        "IntProperty" | "Int8Property" | "Int16Property" | "Int64Property" | "UInt16Property"
        | "UInt32Property" | "UInt64Property" | "FloatProperty" | "DoubleProperty"
        | "StrProperty" | "NameProperty" | "TextProperty" => Ok(None),
        other => Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!("struct field property type {other} is not supported yet"),
        )),
    }
}

/// Reads `FField`'s optional metadata map (`bHasMetaData` + `TMap<FName,FString>`)
/// for an uncooked package, returning the `DisplayName` value when present.
fn read_field_metadata(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &str,
) -> Result<Option<String>, AssetError> {
    let has_metadata = reader.read_u32(&format!("{path}.HasMetaData"))?;
    if has_metadata == 0 {
        return Ok(None);
    }
    let count = reader.read_i32(&format!("{path}.MetaData.Count"))?;
    if count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative struct field metadata count {count}"),
        ));
    }
    let mut display_name = None;
    for index in 0..count {
        let key = reader.read_name_ref(&format!("{path}.MetaData[{index}].Key"))?;
        let value = reader.read_fstring(&format!("{path}.MetaData[{index}].Value"))?;
        if context.package.resolve_name(key).as_deref() == Some("DisplayName") {
            display_name = Some(value);
        }
    }
    Ok(display_name)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SkeletonDecoder;

impl AssetDecoder for SkeletonDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == SKELETON_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != SKELETON_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }

        let (properties, mut reader) = decode_uobject_properties(export, context)?;
        // `USkeleton::Serialize` runs `Super::Serialize` (properties + object-guid
        // footer) then `Ar << ReferenceSkeleton`.
        let object_guid = consume_inline_object_guid_footer(&mut reader, &export.object_path)?;

        let bones = decode_skeleton_reference_bones(&mut reader, context, &export.object_path)?;

        Ok(DecodedAsset::Skeleton(DecodedSkeleton {
            object_path: export.object_path.clone(),
            object_guid,
            properties,
            bones,
        }))
    }
}

fn decode_skeleton_reference_bones(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    object_path: &ObjectPath,
) -> Result<Vec<SkeletonBone>, AssetError> {
    // `FReferenceSkeleton` begins with `TArray<FMeshBoneInfo>` (FName Name,
    // i32 ParentIndex, and an editor-only FString ExportName). The legacy
    // contract intentionally stops before RawRefBonePose and later Skeleton data.
    let editor_data_present = !context
        .package
        .summary
        .versions
        .package_flags
        .contains(crate::version::PackageFlags::FILTER_EDITOR_ONLY);
    let count_offset = reader.tell();
    let count = reader.read_i32(&format!("{object_path}.ReferenceSkeleton.Num"))?;
    if count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative reference-skeleton bone count {count} at byte {count_offset}"),
        ));
    }
    let capacity = reader.checked_vec_capacity::<SkeletonBone>(
        usize::try_from(count).expect("i32 fits in usize"),
        if editor_data_present { 16 } else { 12 },
        &format!("{object_path}.ReferenceSkeleton.Num"),
    )?;
    let mut bones = Vec::with_capacity(capacity);
    for index in 0..count {
        let path = format!("{object_path}.ReferenceSkeleton.Bones[{index}]");
        let name = reader.read_name_ref(&format!("{path}.Name"))?;
        let parent_index = reader.read_i32(&format!("{path}.ParentIndex"))?;
        if editor_data_present {
            reader.read_fstring(&format!("{path}.ExportName"))?;
        }
        bones.push(SkeletonBone { name, parent_index });
    }
    Ok(bones)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct AnimSequenceDecoder;

impl AssetDecoder for AnimSequenceDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        class_path.as_str() == ANIM_SEQUENCE_CLASS
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if class_path.as_str() != ANIM_SEQUENCE_CLASS {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }
        validate_anim_sequence_boundary(context.package)?;

        let (properties, mut reader) = decode_uobject_properties(export, context)?;

        // UE 5.7's uncooked trailer is:
        // UObject's optional object-guid footer, UAnimationAsset::SkeletonGuid, FStripDataFlags,
        // the deprecated RawAnimationData array, then bSerializeCompressedData.
        let object_guid = consume_inline_object_guid_footer(&mut reader, &export.object_path)?;
        let skeleton_guid = decode_animation_skeleton_guid(&mut reader, &export.object_path)?;
        let animation_data = decode_anim_sequence_uncooked_data(&mut reader, &export.object_path)?;

        if reader.remaining() != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "AnimSequence export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }
        Ok(DecodedAsset::AnimSequence(DecodedAnimSequence {
            object_path: export.object_path.clone(),
            object_guid,
            properties,
            skeleton_guid,
            global_strip_flags: animation_data.global_strip_flags,
            class_strip_flags: animation_data.class_strip_flags,
            legacy_raw_track_count: animation_data.legacy_raw_track_count,
            serialized_compressed_data: animation_data.serialized_compressed_data,
        }))
    }
}

fn validate_anim_sequence_boundary(package: &Package) -> Result<(), AssetError> {
    let versions = &package.summary.versions;
    if versions.ue4 != crate::version::VersionContext::LATEST_SUPPORTED_UE4
        || versions.ue5 != crate::version::VersionContext::LATEST_SUPPORTED_UE5
    {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedVersion,
            format!(
                "AnimSequence native serialization is verified only for UE 5.7 package versions (ue4={}, ue5={})",
                versions.ue4, versions.ue5
            ),
        ));
    }
    if versions
        .package_flags
        .contains(crate::version::PackageFlags::COOKED)
        || versions
            .package_flags
            .contains(crate::version::PackageFlags::FILTER_EDITOR_ONLY)
    {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            "cooked or editor-data-stripped AnimSequence packages are outside the supported boundary",
        ));
    }
    Ok(())
}

fn decode_animation_skeleton_guid(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<Guid, AssetError> {
    reader
        .read_guid(&format!("{object_path}.SkeletonGuid"))
        .map_err(AssetError::from)
}

struct SourceAnimSequenceData {
    global_strip_flags: u8,
    class_strip_flags: u8,
    legacy_raw_track_count: u32,
    serialized_compressed_data: bool,
}

fn decode_anim_sequence_uncooked_data(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<SourceAnimSequenceData, AssetError> {
    let global_strip_flags = reader
        .read_u8(&format!("{object_path}.StripFlags.Global"))
        .map_err(AssetError::from)?;
    let class_strip_flags = reader
        .read_u8(&format!("{object_path}.StripFlags.Class"))
        .map_err(AssetError::from)?;

    let legacy_raw_track_count = if global_strip_flags & STRIP_EDITOR_ONLY == 0 {
        let count = reader
            .read_i32(&format!("{object_path}.RawAnimationData.Num"))
            .map_err(AssetError::from)?;
        if count < 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("negative legacy animation track count {count}"),
            ));
        }
        u32::try_from(count).expect("non-negative i32 fits in u32")
    } else {
        0
    };
    if legacy_raw_track_count != 0 {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!(
                "legacy raw animation tracks are not supported yet (found {legacy_raw_track_count})"
            ),
        ));
    }

    let serialize_compressed_data = reader
        .read_u32(&format!("{object_path}.SerializeCompressedData"))
        .map_err(AssetError::from)?;
    let serialized_compressed_data = match serialize_compressed_data {
        0 => false,
        1 => true,
        other => {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("invalid archive bool for compressed animation data: {other}"),
            ));
        }
    };
    if serialized_compressed_data {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            "serialized compressed animation data is outside the uncooked editor-package boundary",
        ));
    }

    Ok(SourceAnimSequenceData {
        global_strip_flags,
        class_strip_flags,
        legacy_raw_track_count,
        serialized_compressed_data,
    })
}

/// Consumes a UObject object-guid footer that is followed by more class-specific
/// data (so [`consume_uobject_export_footer`]'s end-of-stream sizing cannot be
/// used). The footer is a `0` `i32` (no guid) or a `1` marker plus an `FGuid`.
fn consume_inline_object_guid_footer(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<Option<Guid>, AssetError> {
    let offset = reader.tell();
    let marker = reader
        .read_i32(&format!("{object_path}.ExportFooter.HasObjectGuid"))
        .map_err(AssetError::from)?;
    match marker {
        0 => Ok(None),
        1 => Ok(Some(
            reader
                .read_guid(&format!("{object_path}.ExportFooter.ObjectGuid"))
                .map_err(AssetError::from)?,
        )),
        other => Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("unexpected object-guid footer marker {other} at byte {offset}"),
        )),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UObjectDecoder;

impl AssetDecoder for UObjectDecoder {
    fn supports(&self, class_path: &ObjectPath) -> bool {
        is_generic_uobject_class(class_path.as_str())
    }

    fn decode(
        &self,
        export: &Export,
        context: &AssetDecodeContext<'_>,
    ) -> Result<DecodedAsset, AssetError> {
        let Some(class_path) = export.class_path.as_ref() else {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("export {} has no resolved class", export.object_path),
            ));
        };
        if !is_generic_uobject_class(class_path.as_str()) {
            return Err(AssetError::new(
                AssetErrorKind::UnsupportedFormat,
                format!("unsupported asset class {class_path}"),
            ));
        }

        let (properties, mut reader) = decode_uobject_properties(export, context)?;
        let (object_guid, tail) =
            consume_uobject_export_footer_lenient(&mut reader, &export.object_path)?;

        Ok(DecodedAsset::UObject(DecodedUObject {
            object_path: export.object_path.clone(),
            class_path: class_path.clone(),
            object_guid,
            properties,
            tail,
        }))
    }
}

/// Attempts to decode one export with the first matching asset adapter.
///
/// Returns `Ok(None)` when the export has no class, zero serial payload, or no
/// adapter applies. Returns an error when a matching adapter rejects malformed
/// payload data.
pub fn decode_export(
    export: &Export,
    context: &AssetDecodeContext<'_>,
) -> Result<Option<DecodedAsset>, AssetError> {
    if export.serial_size == 0 {
        return Ok(None);
    }
    let Some(class_path) = export.class_path.as_ref() else {
        return Ok(None);
    };

    if let Some(decoded) = decode_modeled_export(export, context)? {
        return Ok(Some(decoded));
    }

    if DataTableDecoder.supports(class_path) {
        return DataTableDecoder.decode(export, context).map(Some);
    }
    if CurveTableDecoder.supports(class_path) {
        return CurveTableDecoder.decode(export, context).map(Some);
    }
    if StringTableDecoder.supports(class_path) {
        return StringTableDecoder.decode(export, context).map(Some);
    }
    if DataAssetDecoder.supports(class_path) {
        return DataAssetDecoder.decode(export, context).map(Some);
    }
    if EnumDecoder.supports(class_path) {
        return EnumDecoder.decode(export, context).map(Some);
    }
    if StructDecoder.supports(class_path) {
        return StructDecoder.decode(export, context).map(Some);
    }
    if SkeletonDecoder.supports(class_path) {
        return SkeletonDecoder.decode(export, context).map(Some);
    }
    if AnimSequenceDecoder.supports(class_path) {
        return AnimSequenceDecoder.decode(export, context).map(Some);
    }
    if UObjectDecoder.supports(class_path) {
        return UObjectDecoder.decode(export, context).map(Some);
    }
    Ok(None)
}

/// Decodes a supported asset only when the supplied source model owns its class hierarchy and
/// serialization plan.
///
/// Returning `Ok(None)` is deliberate: callers can use this as a strict equivalence lane with no
/// handwritten class-name fallback, while [`decode_export`] retains compatibility for projects
/// that have not generated models for their native subclasses.
pub fn decode_modeled_export(
    export: &Export,
    context: &AssetDecodeContext<'_>,
) -> Result<Option<DecodedAsset>, AssetError> {
    if export.serial_size == 0 {
        return Ok(None);
    }
    let Some(class_path) = export.class_path.as_ref() else {
        return Ok(None);
    };
    if context.schemas.find_class(class_path).is_none() {
        return Ok(None);
    }

    if context.schemas.class_is_a(class_path, DATATABLE_CLASS) {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::DataTable)?;
        let source = execute_source_serialization(export, context)?;
        let kind = if context
            .schemas
            .class_is_a(class_path, COMPOSITE_DATATABLE_CLASS)
        {
            DataTableKind::Composite
        } else {
            DataTableKind::Plain
        };
        let row_struct = row_struct_path(context.package, &source.properties);
        let parent_tables = parent_tables_paths(context.package, &source.properties);
        let rows = source.rows.ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!("generated serialization layout for {class_path} did not produce rows"),
            )
        })?;
        return Ok(Some(DecodedAsset::DataTable(DecodedDataTable {
            kind,
            object_path: export.object_path.clone(),
            object_guid: source.object_guid,
            row_struct,
            parent_tables,
            properties: source.properties,
            rows,
        })));
    }
    if context.schemas.class_is_a(class_path, CURVETABLE_CLASS) {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::CurveTable)?;
        let mut source = execute_source_serialization(export, context)?;
        let curve_table = source.curve_table.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce CurveTable rows"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::CurveTable(DecodedCurveTable {
            object_path: export.object_path.clone(),
            mode: curve_table.mode,
            properties: source.properties,
            rows: curve_table.rows,
        })));
    }
    if context.schemas.class_is_a(class_path, STRINGTABLE_CLASS) {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::StringTable)?;
        let mut source = execute_source_serialization(export, context)?;
        let string_table = source.string_table.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce StringTable data"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::StringTable(DecodedStringTable {
            object_path: export.object_path.clone(),
            namespace: string_table.namespace,
            entries: string_table.entries,
        })));
    }
    if context
        .schemas
        .class_is_a(class_path, USERDEFINEDENUM_CLASS)
    {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::Enum)?;
        let mut source = execute_source_serialization(export, context)?;
        let enum_data = source.enum_data.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce Enum data"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::Enum(DecodedEnum {
            object_path: export.object_path.clone(),
            cpp_form: enum_data.cpp_form,
            properties: source.properties,
            entries: enum_data.entries,
        })));
    }
    if context
        .schemas
        .class_is_a(class_path, USERDEFINEDSTRUCT_CLASS)
    {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::Struct)?;
        let mut source = execute_source_serialization(export, context)?;
        let fields = source.struct_fields.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce Struct fields"
                ),
            )
        })?;
        let struct_flags = source.struct_flags.ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce StructFlags"
                ),
            )
        })?;
        let default_values = source.struct_default_values.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce a default instance"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::Struct(DecodedStruct {
            object_path: export.object_path.clone(),
            struct_flags,
            properties: source.properties,
            fields,
            default_values,
        })));
    }
    if context.schemas.class_is_a(class_path, SKELETON_CLASS) {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::Skeleton)?;
        let mut source = execute_source_serialization(export, context)?;
        let bones = source.skeleton_bones.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce reference-skeleton bones"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::Skeleton(DecodedSkeleton {
            object_path: export.object_path.clone(),
            object_guid: source.object_guid,
            properties: source.properties,
            bones,
        })));
    }
    if context.schemas.class_is_a(class_path, ANIM_SEQUENCE_CLASS) {
        validate_anim_sequence_boundary(context.package)?;
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::AnimSequence)?;
        let mut source = execute_source_serialization(export, context)?;
        let skeleton_guid = source.animation_skeleton_guid.ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce SkeletonGuid"
                ),
            )
        })?;
        let animation_data = source.anim_sequence_data.take().ok_or_else(|| {
            AssetError::new(
                AssetErrorKind::UnsupportedCapability,
                format!(
                    "generated serialization layout for {class_path} did not produce uncooked animation data"
                ),
            )
        })?;
        return Ok(Some(DecodedAsset::AnimSequence(DecodedAnimSequence {
            object_path: export.object_path.clone(),
            object_guid: source.object_guid,
            properties: source.properties,
            skeleton_guid,
            global_strip_flags: animation_data.global_strip_flags,
            class_strip_flags: animation_data.class_strip_flags,
            legacy_raw_track_count: animation_data.legacy_raw_track_count,
            serialized_compressed_data: animation_data.serialized_compressed_data,
        })));
    }
    if context.schemas.class_is_a(class_path, DATA_ASSET_CLASS) {
        validate_source_serialization(context.schemas, class_path, SourcePlanKind::DataAsset)?;
        let source = execute_source_serialization(export, context)?;
        return Ok(Some(DecodedAsset::DataAsset(DecodedDataAsset {
            object_path: export.object_path.clone(),
            class_path: class_path.clone(),
            object_guid: source.object_guid,
            properties: source.properties,
        })));
    }
    Ok(None)
}

struct SourceSerializationOutput {
    properties: PropertyStream,
    object_guid: Option<Guid>,
    rows: Option<Vec<DataTableRow>>,
    curve_table: Option<SourceCurveTableData>,
    enum_data: Option<SourceEnumData>,
    struct_fields: Option<Vec<StructField>>,
    struct_flags: Option<u32>,
    struct_default_values: Option<PropertyStream>,
    skeleton_bones: Option<Vec<SkeletonBone>>,
    animation_skeleton_guid: Option<Guid>,
    anim_sequence_data: Option<SourceAnimSequenceData>,
    string_table: Option<SourceStringTableData>,
}

fn execute_source_serialization(
    export: &Export,
    context: &AssetDecodeContext<'_>,
) -> Result<SourceSerializationOutput, AssetError> {
    let class_path = export.class_path.as_ref().ok_or_else(|| {
        AssetError::new(
            AssetErrorKind::UnsupportedFormat,
            format!("export {} has no resolved class", export.object_path),
        )
    })?;
    let schema = context.schemas.find_class(class_path).ok_or_else(|| {
        AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!("no generated source model owns {class_path}"),
        )
    })?;
    let Some(SerializationOperation::TaggedProperties) = schema.serialization.first() else {
        return Err(unsupported_source_plan(class_path, &schema.serialization));
    };

    let (properties, mut reader) = decode_uobject_properties(export, context)?;
    let decode_context = DecodeContext {
        package: context.package,
        versions: &context.package.summary.versions,
        schemas: context.schemas,
    };
    let mut object_guid = None;
    let mut rows = None;
    let mut curve_table = None;
    let mut enum_data = None;
    let mut struct_fields = None;
    let mut struct_flags = None;
    let mut struct_default_values = None;
    let mut skeleton_bones = None;
    let mut animation_skeleton_guid = None;
    let mut anim_sequence_data = None;
    let mut string_table = None;
    for (index, operation) in schema.serialization.iter().enumerate().skip(1) {
        match operation {
            SerializationOperation::ObjectGuid => {
                let followed_by_native_data = schema.serialization.get(index + 1).is_some();
                object_guid = if followed_by_native_data {
                    consume_inline_object_guid_footer(&mut reader, &export.object_path)?
                } else {
                    consume_uobject_export_footer(&mut reader, &export.object_path)?
                };
            }
            SerializationOperation::DataTableRows {
                row_struct_property,
            } if row_struct_property == "RowStruct" && rows.is_none() => {
                rows = Some(decode_data_table_rows(
                    &mut reader,
                    context,
                    &decode_context,
                    &export.object_path,
                )?);
            }
            SerializationOperation::CurveTableRows if curve_table.is_none() => {
                curve_table = Some(decode_curve_table_data(
                    &mut reader,
                    context,
                    &export.object_path,
                )?);
            }
            SerializationOperation::EnumData if enum_data.is_none() => {
                enum_data = Some(decode_enum_data(
                    &mut reader,
                    context,
                    &properties,
                    &export.object_path,
                )?);
            }
            SerializationOperation::StructDefinition if struct_fields.is_none() => {
                struct_fields = Some(decode_struct_definition(
                    &mut reader,
                    context,
                    &export.object_path,
                )?);
            }
            SerializationOperation::StructFlags if struct_flags.is_none() => {
                struct_flags = Some(decode_struct_flags(&mut reader, &export.object_path)?);
            }
            SerializationOperation::StructDefaultInstance if struct_default_values.is_none() => {
                struct_default_values = Some(decode_struct_default_instance(
                    &mut reader,
                    context,
                    &export.object_path,
                )?);
            }
            SerializationOperation::SkeletonReferenceBones if skeleton_bones.is_none() => {
                skeleton_bones = Some(decode_skeleton_reference_bones(
                    &mut reader,
                    context,
                    &export.object_path,
                )?);
            }
            SerializationOperation::AnimationSkeletonGuid if animation_skeleton_guid.is_none() => {
                animation_skeleton_guid = Some(decode_animation_skeleton_guid(
                    &mut reader,
                    &export.object_path,
                )?);
            }
            SerializationOperation::AnimSequenceUncookedData if anim_sequence_data.is_none() => {
                anim_sequence_data = Some(decode_anim_sequence_uncooked_data(
                    &mut reader,
                    &export.object_path,
                )?);
            }
            SerializationOperation::StringTableData if string_table.is_none() => {
                string_table = Some(decode_string_table_data(&mut reader, &export.object_path)?);
            }
            SerializationOperation::TaggedProperties
            | SerializationOperation::DataTableRows { .. }
            | SerializationOperation::CurveTableRows
            | SerializationOperation::EnumData
            | SerializationOperation::StructDefinition
            | SerializationOperation::StructFlags
            | SerializationOperation::StructDefaultInstance
            | SerializationOperation::SkeletonReferenceBones
            | SerializationOperation::AnimationSkeletonGuid
            | SerializationOperation::AnimSequenceUncookedData
            | SerializationOperation::StringTableData => {
                return Err(unsupported_source_plan(class_path, &schema.serialization));
            }
        }
    }
    let preserves_legacy_opaque_tail = schema
        .serialization
        .contains(&SerializationOperation::SkeletonReferenceBones);
    if reader.remaining() != 0 && !preserves_legacy_opaque_tail {
        if schema
            .serialization
            .contains(&SerializationOperation::AnimSequenceUncookedData)
        {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "AnimSequence export {} left {} trailing bytes",
                    export.object_path,
                    reader.remaining()
                ),
            ));
        }
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!(
                "source-modeled export {} left {} trailing bytes",
                export.object_path,
                reader.remaining()
            ),
        ));
    }

    Ok(SourceSerializationOutput {
        properties,
        object_guid,
        rows,
        curve_table,
        enum_data,
        struct_fields,
        struct_flags,
        struct_default_values,
        skeleton_bones,
        animation_skeleton_guid,
        anim_sequence_data,
        string_table,
    })
}

fn unsupported_source_plan(
    class_path: &ObjectPath,
    operations: &[SerializationOperation],
) -> AssetError {
    AssetError::new(
        AssetErrorKind::UnsupportedCapability,
        format!("generated serialization layout for {class_path} is not supported: {operations:?}"),
    )
}

#[derive(Clone, Copy)]
enum SourcePlanKind {
    AnimSequence,
    CurveTable,
    DataAsset,
    DataTable,
    Enum,
    Skeleton,
    Struct,
    StringTable,
}

fn validate_source_serialization(
    schemas: &dyn SchemaProvider,
    class_path: &ObjectPath,
    expected: SourcePlanKind,
) -> Result<(), AssetError> {
    let Some(schema) = schemas.find_class(class_path) else {
        return Ok(());
    };
    let operations = &schema.serialization;
    let supported = match expected {
        SourcePlanKind::AnimSequence => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::AnimationSkeletonGuid,
                SerializationOperation::AnimSequenceUncookedData
            ]
        ),
        SourcePlanKind::CurveTable => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::CurveTableRows
            ]
        ),
        SourcePlanKind::DataAsset => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid
            ]
        ),
        SourcePlanKind::DataTable => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::DataTableRows { row_struct_property }
            ] if row_struct_property == "RowStruct"
        ),
        SourcePlanKind::Enum => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::EnumData
            ]
        ),
        SourcePlanKind::Struct => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::StructDefinition,
                SerializationOperation::StructFlags,
                SerializationOperation::StructDefaultInstance
            ]
        ),
        SourcePlanKind::Skeleton => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::SkeletonReferenceBones
            ]
        ),
        SourcePlanKind::StringTable => matches!(
            operations.as_slice(),
            [
                SerializationOperation::TaggedProperties,
                SerializationOperation::ObjectGuid,
                SerializationOperation::StringTableData
            ]
        ),
    };
    if !supported {
        return Err(AssetError::new(
            AssetErrorKind::UnsupportedCapability,
            format!(
                "generated serialization layout for {class_path} is not supported: {operations:?}"
            ),
        ));
    }
    Ok(())
}

fn decode_uobject_asset_properties(
    export: &Export,
    context: &AssetDecodeContext<'_>,
) -> Result<(PropertyStream, ObjectPath, Option<Guid>), AssetError> {
    let class_path = export.class_path.clone().ok_or_else(|| {
        AssetError::new(
            AssetErrorKind::UnsupportedFormat,
            format!("export {} has no resolved class", export.object_path),
        )
    })?;
    let (properties, mut reader) = decode_uobject_properties(export, context)?;
    let object_guid = consume_uobject_export_footer(&mut reader, &export.object_path)?;
    Ok((properties, class_path, object_guid))
}

/// `UAssetImportData::Serialize` writes a JSON `FString` *before* its parent's
/// tagged-property stream when editor data is present (uncooked packages). Every
/// `*ImportData` sub-object (`FbxStaticMeshImportData`, `InterchangeAssetImportData`,
/// …) inherits this, so the property stream does not start at byte 0 of the export.
fn is_asset_import_data_class(class_path: &str) -> bool {
    class_path
        .rsplit('.')
        .next()
        .is_some_and(|leaf| leaf.ends_with("ImportData"))
}

fn decode_uobject_properties<'a>(
    export: &'a Export,
    context: &'a AssetDecodeContext<'a>,
) -> Result<(PropertyStream, crate::archive::Reader<'a>), AssetError> {
    let mut reader = context.package.export_reader(context.source, export)?;

    // Consume the leading `UAssetImportData` JSON blob before the property stream.
    let editor_data_present = !context
        .package
        .summary
        .versions
        .package_flags
        .contains(crate::version::PackageFlags::FILTER_EDITOR_ONLY);
    if editor_data_present
        && export
            .class_path
            .as_ref()
            .is_some_and(|class| is_asset_import_data_class(class.as_str()))
    {
        reader
            .read_fstring(&format!("{}.AssetImportData.Json", export.object_path))
            .map_err(AssetError::from)?;
    }

    let mut properties = read_uobject_tagged_property_stream(
        &mut reader,
        &context.package.summary.versions,
        &context.package.names,
        export.object_path.as_str(),
    )?;
    let decode_context = DecodeContext {
        package: context.package,
        versions: &context.package.summary.versions,
        schemas: context.schemas,
    };
    decode_property_stream_values(context.source, &mut properties, &decode_context)?;
    Ok((properties, reader))
}

/// UE5 editor exports may append a zero `i32` object-guid slot after tagged
/// properties (see `FLazyObjectPtr::PossiblySerializeObjectGuid`).
fn consume_uobject_export_footer(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<Option<Guid>, AssetError> {
    if reader.remaining() == 4 {
        let offset = reader.tell();
        let footer = reader
            .read_i32(&format!("{object_path}.ExportFooter"))
            .map_err(AssetError::from)?;
        if footer != 0 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!("expected zero UObject export footer at byte {offset}, got {footer}"),
            ));
        }
        return Ok(None);
    }
    if reader.remaining() == 20 {
        let offset = reader.tell();
        let has_guid = reader
            .read_i32(&format!("{object_path}.ExportFooter.HasObjectGuid"))
            .map_err(AssetError::from)?;
        if has_guid != 1 {
            return Err(AssetError::new(
                AssetErrorKind::MalformedData,
                format!(
                    "expected UObject export footer object-guid marker 1 at byte {offset}, got {has_guid}"
                ),
            ));
        }
        let guid = reader
            .read_guid(&format!("{object_path}.ExportFooter.ObjectGuid"))
            .map_err(AssetError::from)?;
        return Ok(Some(guid));
    }
    if reader.remaining() != 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!(
                "UObject export {object_path} left {} trailing bytes",
                reader.remaining()
            ),
        ));
    }
    Ok(None)
}

/// Like [`consume_uobject_export_footer`], but never fails on unexpected trailing
/// bytes: classes with a binary tail (`StaticMesh`, `Texture2D`, …) keep
/// arbitrary data after their properties. A canonical object-guid footer (a zero
/// `i32`, or a `1` marker + `FGuid`) is consumed and reported; anything else is
/// returned verbatim as a raw tail [`Span`] for callers to surface or ignore.
fn consume_uobject_export_footer_lenient(
    reader: &mut crate::archive::Reader<'_>,
    object_path: &ObjectPath,
) -> Result<(Option<Guid>, Span), AssetError> {
    let start = reader.tell();
    let empty = Span::new(start, 0).map_err(AssetError::from)?;
    match reader.remaining() {
        0 => Ok((None, empty)),
        4 => {
            let footer = reader
                .read_i32(&format!("{object_path}.ExportFooter"))
                .map_err(AssetError::from)?;
            if footer == 0 {
                Ok((None, empty))
            } else {
                Ok((None, Span::new(start, 4).map_err(AssetError::from)?))
            }
        }
        20 => {
            let has_guid = reader
                .read_i32(&format!("{object_path}.ExportFooter.HasObjectGuid"))
                .map_err(AssetError::from)?;
            if has_guid == 1 {
                let guid = reader
                    .read_guid(&format!("{object_path}.ExportFooter.ObjectGuid"))
                    .map_err(AssetError::from)?;
                Ok((Some(guid), empty))
            } else {
                Ok((None, Span::new(start, 20).map_err(AssetError::from)?))
            }
        }
        remaining => Ok((None, Span::new(start, remaining).map_err(AssetError::from)?)),
    }
}

fn decode_simple_curve_keys(
    source: &[u8],
    package: &Package,
    stream: &PropertyStream,
    path: &str,
) -> Result<Vec<CurveKey>, AssetError> {
    let Some(record) = stream
        .records
        .iter()
        .find(|record| package.resolve_name(record.name).as_deref() == Some("Keys"))
    else {
        return Ok(Vec::new());
    };
    if package.resolve_name(record.type_name.name).as_deref() != Some("ArrayProperty") {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("{path}.Keys is not an ArrayProperty"),
        ));
    }

    let reader = crate::archive::Reader::new(source);
    let mut payload = reader
        .bounded(record.payload, &format_args!("{path}.Keys.Payload"))
        .map_err(AssetError::from)?;
    let count = payload.read_i32(&format_args!("{path}.Keys.Count"))?;
    if count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative SimpleCurve key count {count}"),
        ));
    }
    let capacity = payload.checked_vec_capacity::<CurveKey>(
        usize::try_from(count).expect("i32 fits in usize"),
        8,
        &format_args!("{path}.Keys.Count"),
    )?;
    let mut keys = Vec::with_capacity(capacity);
    for index in 0..count {
        keys.push(CurveKey::Simple(SimpleCurveKey {
            time: payload.read_f32(&format_args!("{path}.Keys[{index}].Time"))?,
            value: payload.read_f32(&format_args!("{path}.Keys[{index}].Value"))?,
        }));
    }
    if payload.remaining() != 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!(
                "{path}.Keys left {} trailing bytes after SimpleCurve key decode",
                payload.remaining()
            ),
        ));
    }
    Ok(keys)
}

fn decode_rich_curve_keys(
    source: &[u8],
    package: &Package,
    stream: &PropertyStream,
    path: &str,
) -> Result<Vec<CurveKey>, AssetError> {
    let Some(record) = stream
        .records
        .iter()
        .find(|record| package.resolve_name(record.name).as_deref() == Some("Keys"))
    else {
        return Ok(Vec::new());
    };
    if package.resolve_name(record.type_name.name).as_deref() != Some("ArrayProperty") {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("{path}.Keys is not an ArrayProperty"),
        ));
    }

    let reader = crate::archive::Reader::new(source);
    let mut payload = reader
        .bounded(record.payload, &format_args!("{path}.Keys.Payload"))
        .map_err(AssetError::from)?;
    let count = payload.read_i32(&format_args!("{path}.Keys.Count"))?;
    if count < 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!("negative RichCurve key count {count}"),
        ));
    }
    let capacity = payload.checked_vec_capacity::<CurveKey>(
        usize::try_from(count).expect("i32 fits in usize"),
        27,
        &format_args!("{path}.Keys.Count"),
    )?;
    let mut keys = Vec::with_capacity(capacity);
    for index in 0..count {
        keys.push(CurveKey::Rich(RichCurveKey {
            interp_mode: payload.read_u8(&format_args!("{path}.Keys[{index}].InterpMode"))?,
            tangent_mode: payload.read_u8(&format_args!("{path}.Keys[{index}].TangentMode"))?,
            tangent_weight_mode: payload
                .read_u8(&format_args!("{path}.Keys[{index}].TangentWeightMode"))?,
            time: payload.read_f32(&format_args!("{path}.Keys[{index}].Time"))?,
            value: payload.read_f32(&format_args!("{path}.Keys[{index}].Value"))?,
            arrive_tangent: payload
                .read_f32(&format_args!("{path}.Keys[{index}].ArriveTangent"))?,
            arrive_tangent_weight: payload
                .read_f32(&format_args!("{path}.Keys[{index}].ArriveTangentWeight"))?,
            leave_tangent: payload.read_f32(&format_args!("{path}.Keys[{index}].LeaveTangent"))?,
            leave_tangent_weight: payload
                .read_f32(&format_args!("{path}.Keys[{index}].LeaveTangentWeight"))?,
        }));
    }
    if payload.remaining() != 0 {
        return Err(AssetError::new(
            AssetErrorKind::MalformedData,
            format!(
                "{path}.Keys left {} trailing bytes after RichCurve key decode",
                payload.remaining()
            ),
        ));
    }
    Ok(keys)
}

fn parent_tables_paths(package: &Package, properties: &PropertyStream) -> Vec<ObjectPath> {
    let Some(record) = properties
        .records
        .iter()
        .find(|record| package.resolve_name(record.name).as_deref() == Some("ParentTables"))
    else {
        return Vec::new();
    };
    let PropertyValue::Array(entries) = &record.value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|value| {
            let PropertyValue::ObjectRef(index) = value else {
                return None;
            };
            if *index == PackageIndex::Null {
                None
            } else {
                package.resolve_index(*index)
            }
        })
        .collect()
}

fn row_struct_path(package: &Package, properties: &PropertyStream) -> Option<ObjectPath> {
    let record = properties
        .records
        .iter()
        .find(|record| package.resolve_name(record.name).as_deref() == Some("RowStruct"))?;
    let PropertyValue::ObjectRef(index) = record.value else {
        return None;
    };
    if index == PackageIndex::Null {
        None
    } else {
        package.resolve_index(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{ArchiveErrorKind, ArchiveLimits, Reader};
    use crate::package::{test_export, test_import, test_package};
    use crate::property::PropertyValue;
    use crate::schema::{
        ClassSchema, SchemaProvider, SerializationOperation, SourceModel, StructSchema,
        embedded_source_model,
    };
    use crate::test_support::{
        TypeParam, name_ref, push_f32, push_fstring, push_i32, write_datatable_export,
        write_int_property_tag, write_object_array_property_tag, write_object_property_tag,
        write_property_tag, write_property_terminator, write_uobject_export,
    };

    struct EmptySchemas;

    impl SchemaProvider for EmptySchemas {
        fn find_struct(&self, _path: &ObjectPath) -> Option<&StructSchema> {
            None
        }

        fn find_class(&self, _path: &ObjectPath) -> Option<&ClassSchema> {
            None
        }
    }

    fn names() -> Vec<String> {
        vec![
            "None".into(),
            "IntProperty".into(),
            "IntValue".into(),
            "Row_Alpha".into(),
            "ObjectProperty".into(),
            "RowStruct".into(),
            "E2EFixtureScalarsRow".into(),
            "Script/E2EFixtures".into(),
            "ArrayProperty".into(),
            "ParentTables".into(),
            "DT_Scalars".into(),
            "DT_Scalars2".into(),
            "Game/E2EFixture/Data".into(),
            "ArrayProperty".into(),
            "Keys".into(),
        ]
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

        let error = AssetError::from(archive_error);

        assert_eq!(error.kind(), AssetErrorKind::ResourceLimit);
    }

    #[test]
    fn rejects_absurd_datatable_row_count_before_allocating_rows() {
        let mut export_bytes = write_datatable_export(0, &[], &[]);
        const DATATABLE_ROW_COUNT_OFFSET: usize = 1 + 8 + 4;
        export_bytes[DATATABLE_ROW_COUNT_OFFSET..DATATABLE_ROW_COUNT_OFFSET + 4]
            .copy_from_slice(&i32::MAX.to_le_bytes());

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = DataTableDecoder
            .decode(&export, &context)
            .expect_err("absurd row count");

        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("Rows.Count"));
        assert!(error.message().contains("exceeds element limit"));

        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated_error = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects absurd row count");
        assert_eq!(generated_error.kind(), error.kind());
        assert_eq!(generated_error.message(), error.message());
    }

    fn decode_datatable(
        export_bytes: Vec<u8>,
        package: Package,
        export: Export,
    ) -> DecodedDataTable {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };
        let DecodedAsset::DataTable(datatable) = DataTableDecoder
            .decode(&export, &context)
            .expect("decode datatable")
        else {
            panic!("expected DataTable decode");
        };
        datatable
    }

    fn write_curvetable_export(
        none_name_index: i32,
        root_properties: &[u8],
        mode: u8,
        rows: &[(i32, &[u8])],
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(0); // class serialization-control extensions
        bytes.extend_from_slice(root_properties);
        write_property_terminator(&mut bytes, none_name_index);
        push_i32(&mut bytes, 0); // UObject export footer
        push_i32(&mut bytes, i32::try_from(rows.len()).expect("fits in i32"));
        bytes.push(mode);
        for (name_index, row_properties) in rows {
            push_i32(&mut bytes, *name_index);
            push_i32(&mut bytes, 0);
            bytes.extend_from_slice(row_properties);
            write_property_terminator(&mut bytes, none_name_index);
        }
        bytes
    }

    fn decode_curve_table(
        export_bytes: &[u8],
        package: &Package,
        export: &Export,
        schemas: &dyn SchemaProvider,
    ) -> DecodedCurveTable {
        let context = AssetDecodeContext {
            source: export_bytes,
            package,
            schemas,
        };
        let DecodedAsset::CurveTable(curve_table) = CurveTableDecoder
            .decode(export, &context)
            .expect("decode curve table")
        else {
            panic!("expected CurveTable decode");
        };
        curve_table
    }

    fn write_stringtable_export(
        none_name_index: i32,
        namespace: &str,
        entries: &[(&str, &str)],
        metadata_count: i32,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(0); // class serialization-control extensions
        write_property_terminator(&mut bytes, none_name_index);
        push_i32(&mut bytes, 0); // UObject export footer
        push_fstring(&mut bytes, namespace);
        push_i32(
            &mut bytes,
            i32::try_from(entries.len()).expect("fits in i32"),
        );
        for (key, source) in entries {
            push_fstring(&mut bytes, key);
            push_fstring(&mut bytes, source);
        }
        push_i32(&mut bytes, metadata_count);
        bytes
    }

    fn decode_string_table(
        export_bytes: Vec<u8>,
        package: Package,
        export: Export,
    ) -> DecodedStringTable {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };
        let DecodedAsset::StringTable(string_table) = StringTableDecoder
            .decode(&export, &context)
            .expect("decode string table")
        else {
            panic!("expected StringTable decode");
        };
        string_table
    }

    /// Builds a `DisplayNameMap` (`TMap<FName, FText>`) tagged property whose
    /// keys are qualified enum-entry FNames and values are display strings.
    fn write_display_name_map_property(
        bytes: &mut Vec<u8>,
        name_index: i32,
        map_type_index: i32,
        name_type_index: i32,
        text_type_index: i32,
        entries: &[(i32, &str)],
    ) {
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // KeysToRemove
        push_i32(
            &mut payload,
            i32::try_from(entries.len()).expect("fits in i32"),
        );
        for (entry_name_index, display_name) in entries {
            push_i32(&mut payload, *entry_name_index); // FName index
            push_i32(&mut payload, 0); // FName number
            push_i32(&mut payload, 0); // FText flags
            payload.push(0); // FText history type (Base)
            push_fstring(&mut payload, ""); // namespace
            push_fstring(&mut payload, ""); // key
            push_fstring(&mut payload, display_name); // source string
        }
        write_property_tag(
            bytes,
            name_index,
            &TypeParam {
                type_index: map_type_index,
                parameters: vec![
                    TypeParam {
                        type_index: name_type_index,
                        parameters: Vec::new(),
                    },
                    TypeParam {
                        type_index: text_type_index,
                        parameters: Vec::new(),
                    },
                ],
            },
            0,
            &payload,
        );
    }

    /// Builds a synthetic `UUserDefinedEnum` export: extensions byte, optional
    /// tagged properties, terminator, zero UObject footer, then the `UEnum` tail
    /// (`int32 Num`, `Num` × (`FName`, `int64`), `uint8 CppForm`).
    fn write_userdefinedenum_export(
        none_name_index: i32,
        properties: &[u8],
        entries: &[(i32, i64)],
        cpp_form: u8,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(0); // class serialization-control extensions
        bytes.extend_from_slice(properties);
        write_property_terminator(&mut bytes, none_name_index);
        push_i32(&mut bytes, 0); // UObject export footer
        push_i32(
            &mut bytes,
            i32::try_from(entries.len()).expect("fits in i32"),
        );
        for (name_index, value) in entries {
            push_i32(&mut bytes, *name_index); // FName index
            push_i32(&mut bytes, 0); // FName number
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.push(cpp_form);
        bytes
    }

    fn decode_enum(
        export_bytes: &[u8],
        package: &Package,
        export: &Export,
        schemas: &dyn SchemaProvider,
    ) -> DecodedEnum {
        let context = AssetDecodeContext {
            source: export_bytes,
            package,
            schemas,
        };
        let Some(DecodedAsset::Enum(decoded_enum)) =
            decode_export(export, &context).expect("decode enum")
        else {
            panic!("expected Enum decode");
        };
        decoded_enum
    }

    #[test]
    fn decodes_minimal_datatable_with_one_scalar_row() {
        let mut row_properties = Vec::new();
        write_int_property_tag(&mut row_properties, 2, 1, 4243);
        let export_bytes = write_datatable_export(0, &[], &[(3, row_properties.as_slice())]);
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );

        let datatable = decode_datatable(export_bytes, package, export);

        assert_eq!(datatable.kind, DataTableKind::Plain);
        assert!(datatable.parent_tables.is_empty());
        assert_eq!(datatable.rows.len(), 1);
        assert_eq!(datatable.object_path.as_str(), "/Game/Test/DT_Test.DT_Test");
        assert!(datatable.row_struct.is_none());
        let row = &datatable.rows[0];
        assert_eq!(row.name, name_ref(3, 0));
        let value = &row.properties.records[0].value;
        assert_eq!(value, &PropertyValue::Int(4243));
    }

    #[test]
    fn generic_uobject_retains_binary_tail_instead_of_failing() {
        // A class with a binary tail after its tagged properties (e.g. StaticMesh)
        // must still decode: properties surfaced, tail retained as a raw span.
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 7);
        let mut export_bytes = write_uobject_export(0, &properties);
        let tail = [0xAB_u8; 94];
        export_bytes.extend_from_slice(&tail);

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/SM_Test.SM_Test",
            "/Script/Engine.StaticMesh",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::UObject(object)) =
            decode_export(&export, &context).expect("decode should not fail on a binary tail")
        else {
            panic!("expected a generic UObject decode");
        };
        assert_eq!(object.tail.len(), 94);
        assert!(object.object_guid.is_none());
        assert_eq!(object.class_path.as_str(), "/Script/Engine.StaticMesh");
        assert_eq!(object.properties.records[0].value, PropertyValue::Int(7));
    }

    fn write_anim_sequence_export(raw_track_count: i32, serialize_compressed_data: u32) -> Vec<u8> {
        let mut bytes = write_uobject_export(0, &[]);
        push_i32(&mut bytes, 0); // UObject object-guid footer
        for word in [0x1122_3344_u32, 0x5566_7788, 0x99aa_bbcc, 0xddee_ff00] {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.push(0); // FStripDataFlags.GlobalStripFlags
        bytes.push(0); // FStripDataFlags.ClassStripFlags
        push_i32(&mut bytes, raw_track_count);
        bytes.extend_from_slice(&serialize_compressed_data.to_le_bytes());
        bytes
    }

    #[test]
    fn anim_sequence_decoder_consumes_the_uncooked_ue57_native_trailer() {
        let export_bytes = write_anim_sequence_export(0, 0);
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/A_Test.A_Test",
            ANIM_SEQUENCE_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::AnimSequence(sequence)) =
            decode_export(&export, &context).expect("AnimSequence should decode")
        else {
            panic!("expected an AnimSequence decode");
        };
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let Some(DecodedAsset::AnimSequence(generated)) =
            decode_modeled_export(&export, &generated_context)
                .expect("source-modeled AnimSequence should decode")
        else {
            panic!("expected a source-modeled AnimSequence decode");
        };
        assert_eq!(generated, sequence);

        assert_eq!(sequence.object_path.as_str(), "/Game/Test/A_Test.A_Test");
        assert_eq!(sequence.skeleton_guid.a, 0x1122_3344);
        assert_eq!(sequence.skeleton_guid.d, 0xddee_ff00);
        assert_eq!(sequence.global_strip_flags, 0);
        assert_eq!(sequence.class_strip_flags, 0);
        assert_eq!(sequence.legacy_raw_track_count, 0);
        assert!(!sequence.serialized_compressed_data);
        assert!(sequence.object_guid.is_none());
    }

    #[test]
    fn anim_sequence_decoder_rejects_compressed_payloads_at_the_uncooked_boundary() {
        let export_bytes = write_anim_sequence_export(0, 1);
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/A_Test.A_Test",
            ANIM_SEQUENCE_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = decode_export(&export, &context).expect_err("compressed data is unsupported");
        assert_eq!(error.kind(), AssetErrorKind::UnsupportedCapability);
        assert!(error.message().contains("compressed animation data"));

        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("source-modeled compressed data is unsupported");
        assert_eq!(generated.kind(), error.kind());
        assert_eq!(generated.message(), error.message());
    }

    #[test]
    fn source_modeled_anim_sequence_preserves_supported_error_boundaries() {
        let mut trailing = write_anim_sequence_export(0, 0);
        trailing.push(0xff);
        let cases = [
            write_anim_sequence_export(-1, 0),
            write_anim_sequence_export(1, 0),
            write_anim_sequence_export(0, 2),
            trailing,
        ];
        for export_bytes in cases {
            let package = test_package(vec!["None".into()]);
            let export = test_export(
                export_bytes.len() as u64,
                "/Game/Test/A_Test.A_Test",
                ANIM_SEQUENCE_CLASS,
            );
            let legacy_schemas = EmptySchemas;
            let legacy_context = AssetDecodeContext {
                source: &export_bytes,
                package: &package,
                schemas: &legacy_schemas,
            };
            let generated_context = AssetDecodeContext {
                source: &export_bytes,
                package: &package,
                schemas: embedded_source_model(),
            };

            let legacy = AnimSequenceDecoder
                .decode(&export, &legacy_context)
                .expect_err("legacy path rejects unsupported animation data");
            let generated = decode_modeled_export(&export, &generated_context)
                .expect_err("source-modeled path rejects unsupported animation data");
            assert_eq!(generated.kind(), legacy.kind());
            assert_eq!(generated.message(), legacy.message());
        }
    }

    #[test]
    fn decodes_the_real_ue57_anim_sequence_fixture() {
        let bytes = include_bytes!(
            "../../../fixtures/unreal-project/Content/Fixture/Animation/A_FixtureMotion.uasset"
        );
        let package = Package::parse(bytes).expect("parse animation fixture package");
        let export = package
            .exports
            .iter()
            .find(|export| {
                export.class_path.as_ref().map(ObjectPath::as_str) == Some(ANIM_SEQUENCE_CLASS)
            })
            .expect("AnimSequence export");
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::AnimSequence(sequence)) =
            decode_export(export, &context).expect("decode real AnimSequence")
        else {
            panic!("expected an AnimSequence decode");
        };
        let generated_context = AssetDecodeContext {
            source: bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let Some(DecodedAsset::AnimSequence(generated)) =
            decode_modeled_export(export, &generated_context)
                .expect("source-modeled real AnimSequence decode")
        else {
            panic!("expected a source-modeled AnimSequence decode");
        };
        assert_eq!(generated, sequence);

        assert!(!sequence.skeleton_guid.is_zero());
        assert_eq!(sequence.global_strip_flags, 0);
        assert_eq!(sequence.class_strip_flags, 0);
        assert_eq!(sequence.legacy_raw_track_count, 0);
        assert!(!sequence.serialized_compressed_data);
        assert!(sequence.object_guid.is_none());
        assert!(sequence.properties.records.iter().any(|record| {
            package.resolve_name(record.name).as_deref() == Some("SequenceLength")
                && record.value == PropertyValue::Float(2.0)
        }));
    }

    #[test]
    fn skeleton_decoder_parses_reference_skeleton_bones() {
        // USkeleton tail = object-guid footer, then FReferenceSkeleton:
        // i32 count, then per bone (FName Name, i32 ParentIndex, FString ExportName).
        let bone_names = vec!["None".to_string(), "root".to_string(), "child".to_string()];
        let mut export_bytes = write_uobject_export(0, &[]);
        push_i32(&mut export_bytes, 0); // object-guid footer (no guid)
        push_i32(&mut export_bytes, 2); // bone count
        push_i32(&mut export_bytes, 1); // bone[0].Name -> "root"
        push_i32(&mut export_bytes, 0); // bone[0].Name.Number
        push_i32(&mut export_bytes, -1); // bone[0].ParentIndex (root)
        push_fstring(&mut export_bytes, "root");
        push_i32(&mut export_bytes, 2); // bone[1].Name -> "child"
        push_i32(&mut export_bytes, 0);
        push_i32(&mut export_bytes, 0); // bone[1].ParentIndex -> root
        push_fstring(&mut export_bytes, "child");
        export_bytes.extend_from_slice(&[1, 2, 3, 4]); // compatibility-opaque pose/later tail

        let package = test_package(bone_names);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/SKEL_Test.SKEL_Test",
            SKELETON_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::Skeleton(skeleton)) =
            decode_export(&export, &context).expect("skeleton should decode")
        else {
            panic!("expected a Skeleton decode");
        };
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let Some(DecodedAsset::Skeleton(generated)) =
            decode_modeled_export(&export, &generated_context)
                .expect("generated Skeleton should decode")
        else {
            panic!("expected a generated Skeleton decode");
        };
        assert_eq!(generated, skeleton);
        assert_eq!(skeleton.bones.len(), 2);
        assert_eq!(skeleton.bones[0].parent_index, -1);
        assert_eq!(skeleton.bones[1].parent_index, 0);
        assert_eq!(
            package.resolve_name(skeleton.bones[0].name).as_deref(),
            Some("root")
        );
        assert_eq!(
            package.resolve_name(skeleton.bones[1].name).as_deref(),
            Some("child")
        );
    }

    #[test]
    fn source_modeled_skeleton_preserves_negative_bone_count_error() {
        let mut export_bytes = write_uobject_export(0, &[]);
        push_i32(&mut export_bytes, 0); // object-guid footer
        push_i32(&mut export_bytes, -1); // invalid bone count
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/SKEL_Test.SKEL_Test",
            SKELETON_CLASS,
        );
        let legacy_schemas = EmptySchemas;
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &legacy_schemas,
        };
        let legacy = SkeletonDecoder
            .decode(&export, &legacy_context)
            .expect_err("legacy path rejects negative bone count");
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects negative bone count");
        assert_eq!(generated.kind(), legacy.kind());
        assert_eq!(generated.message(), legacy.message());
    }

    #[test]
    fn asset_import_data_skips_leading_json_before_property_stream() {
        // UAssetImportData subclasses serialize a JSON FString before their tagged
        // properties. The decoder must consume it so the property stream aligns.
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 9);
        let mut export_bytes = Vec::new();
        push_fstring(&mut export_bytes, "{\"SourceData\":[]}");
        export_bytes.extend_from_slice(&write_uobject_export(0, &properties));

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/SM_Test.SM_Test.FbxStaticMeshImportData_0",
            "/Script/UnrealEd.FbxStaticMeshImportData",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::UObject(object)) = decode_export(&export, &context)
            .expect("import-data export with a leading JSON blob should decode")
        else {
            panic!("expected a generic UObject decode");
        };
        assert_eq!(object.properties.records[0].value, PropertyValue::Int(9));
    }

    #[test]
    fn generic_uobject_consumes_zero_footer_without_tail() {
        // A plain property object (no class tail) still consumes its canonical
        // zero object-guid footer and reports an empty tail.
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 7);
        let mut export_bytes = write_uobject_export(0, &properties);
        push_i32(&mut export_bytes, 0); // canonical zero object-guid footer

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/O_Test.O_Test",
            "/Script/Engine.SomePlainObject",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let Some(DecodedAsset::UObject(object)) = decode_export(&export, &context).expect("decode")
        else {
            panic!("expected a generic UObject decode");
        };
        assert_eq!(object.tail.len(), 0);
        assert!(object.object_guid.is_none());
    }

    #[test]
    fn decodes_datatable_row_struct_from_root_object_ref() {
        let mut root_properties = Vec::new();
        // Import index 0 serializes as package index -1.
        write_object_property_tag(&mut root_properties, 5, 4, -1);

        let mut package = test_package(names());
        package.imports.push(test_import(
            "/Script/E2EFixtures.E2EFixtureScalarsRow",
            "/Script/CoreUObject.ScriptStruct",
            6,
            Some(7),
        ));

        let export_bytes = write_datatable_export(0, &root_properties, &[]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );

        let datatable = decode_datatable(export_bytes, package, export);

        assert_eq!(
            datatable.row_struct.as_ref().map(ObjectPath::as_str),
            Some("/Script/E2EFixtures.E2EFixtureScalarsRow")
        );
        assert!(datatable.rows.is_empty());
    }

    #[test]
    fn rejects_invalid_datatable_object_guid_marker() {
        let mut export_bytes = write_datatable_export(0, &[], &[]);
        // Layout: u8 extensions, None terminator (8 bytes), then i32 object-guid marker.
        let marker_offset = 1 + 8;
        export_bytes[marker_offset] = 2;

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = DataTableDecoder
            .decode(&export, &context)
            .expect_err("invalid marker");
        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("object-guid footer marker"));
    }

    #[test]
    fn decodes_datatable_object_guid_before_rows() {
        let mut export_bytes = write_datatable_export(0, &[], &[]);
        let marker_offset = 1 + 8;
        export_bytes[marker_offset] = 1;
        export_bytes.splice(marker_offset + 4..marker_offset + 4, 1_u8..=16);

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );

        let datatable = decode_datatable(export_bytes, package, export);

        assert!(datatable.object_guid.is_some());
        assert!(datatable.rows.is_empty());
    }

    #[test]
    fn rejects_trailing_datatable_export_bytes() {
        let mut export_bytes = write_datatable_export(0, &[], &[]);
        export_bytes.push(0xFF);

        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = DataTableDecoder
            .decode(&export, &context)
            .expect_err("trailing bytes");
        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("trailing bytes"));
    }

    #[test]
    fn decodes_composite_datatable_parent_tables() {
        let mut root_properties = Vec::new();
        write_object_property_tag(&mut root_properties, 5, 4, -1);
        write_object_array_property_tag(&mut root_properties, 9, 8, 4, &[-2, -3]);

        let mut package = test_package(names());
        package.imports.push(test_import(
            "/Script/E2EFixtures.E2EFixtureScalarsRow",
            "/Script/CoreUObject.ScriptStruct",
            6,
            Some(7),
        ));
        package.imports.push(test_import(
            "/Game/E2EFixture/Data/DT_Scalars.DT_Scalars",
            "/Script/Engine.DataTable",
            10,
            Some(12),
        ));
        package.imports.push(test_import(
            "/Game/E2EFixture/Data/DT_Scalars2.DT_Scalars2",
            "/Script/Engine.DataTable",
            11,
            Some(12),
        ));

        let export_bytes = write_datatable_export(0, &root_properties, &[]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/E2EFixture/Data/CDT_E2EFixture.CDT_E2EFixture",
            "/Script/Engine.CompositeDataTable",
        );

        let datatable = decode_datatable(export_bytes, package, export);

        assert_eq!(datatable.kind, DataTableKind::Composite);
        assert_eq!(datatable.parent_tables.len(), 2);
        assert!(
            datatable
                .parent_tables
                .iter()
                .any(|path| path.as_str().contains("DT_Scalars")),
            "expected DT_Scalars parent, got {:?}",
            datatable.parent_tables
        );
        assert!(
            datatable
                .parent_tables
                .iter()
                .any(|path| path.as_str().contains("DT_Scalars2")),
            "expected DT_Scalars2 parent, got {:?}",
            datatable.parent_tables
        );
    }

    #[test]
    fn decodes_rich_curve_table_keys() {
        let mut keys_payload = Vec::new();
        push_i32(&mut keys_payload, 1);
        keys_payload.push(3); // RCIM_Cubic
        keys_payload.push(2); // RCTM_Break
        keys_payload.push(3); // RCTWM_WeightedBoth
        push_f32(&mut keys_payload, 1.5);
        push_f32(&mut keys_payload, 42.25);
        push_f32(&mut keys_payload, -0.5);
        push_f32(&mut keys_payload, 0.25);
        push_f32(&mut keys_payload, 0.75);
        push_f32(&mut keys_payload, 0.5);

        let mut curve_properties = Vec::new();
        write_property_tag(
            &mut curve_properties,
            14,
            &TypeParam {
                type_index: 13,
                parameters: Vec::new(),
            },
            0,
            &keys_payload,
        );

        let export_bytes = write_curvetable_export(0, &[], 2, &[(3, curve_properties.as_slice())]);
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/CT_Test.CT_Test",
            CURVETABLE_CLASS,
        );

        let empty_schemas = EmptySchemas;
        let legacy = decode_curve_table(&export_bytes, &package, &export, &empty_schemas);
        let generated =
            decode_curve_table(&export_bytes, &package, &export, embedded_source_model());
        assert_eq!(generated, legacy);
        let curve_table = generated;

        assert_eq!(curve_table.mode, CurveTableMode::RichCurves);
        assert_eq!(curve_table.rows.len(), 1);
        assert_eq!(curve_table.rows[0].name, name_ref(3, 0));
        assert_eq!(
            curve_table.rows[0].keys,
            vec![CurveKey::Rich(RichCurveKey {
                interp_mode: 3,
                tangent_mode: 2,
                tangent_weight_mode: 3,
                time: 1.5,
                value: 42.25,
                arrive_tangent: -0.5,
                arrive_tangent_weight: 0.25,
                leave_tangent: 0.75,
                leave_tangent_weight: 0.5,
            })]
        );
    }

    #[test]
    fn source_modeled_curve_table_preserves_malformed_row_checks() {
        let mut export_bytes = write_curvetable_export(0, &[], 0, &[]);
        const ROW_COUNT_OFFSET: usize = 1 + 8 + 4;
        export_bytes[ROW_COUNT_OFFSET..ROW_COUNT_OFFSET + 4]
            .copy_from_slice(&(-1_i32).to_le_bytes());
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/CT_Bad.CT_Bad",
            CURVETABLE_CLASS,
        );
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &EmptySchemas,
        };
        let legacy = CurveTableDecoder
            .decode(&export, &legacy_context)
            .expect_err("legacy path rejects negative rows");
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects negative rows");

        assert_eq!(generated.kind(), legacy.kind());
        assert_eq!(generated.message(), legacy.message());
    }

    #[test]
    fn decodes_string_table_entries() {
        let export_bytes = write_stringtable_export(
            0,
            "ST_Simple",
            &[
                ("HELLO", "Hello from string table"),
                ("FAREWELL", "Goodbye from string table"),
            ],
            0,
        );
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/ST_Simple.ST_Simple",
            STRINGTABLE_CLASS,
        );

        let string_table = decode_string_table(export_bytes, package, export);

        assert_eq!(
            string_table.object_path.as_str(),
            "/Game/Test/ST_Simple.ST_Simple"
        );
        assert_eq!(string_table.namespace, "ST_Simple");
        assert_eq!(
            string_table.entries,
            vec![
                StringTableEntry {
                    key: "HELLO".to_owned(),
                    source: "Hello from string table".to_owned(),
                },
                StringTableEntry {
                    key: "FAREWELL".to_owned(),
                    source: "Goodbye from string table".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn embedded_and_legacy_string_table_semantics_are_identical() {
        let export_bytes =
            write_stringtable_export(0, "ST_Simple", &[("HELLO", "Hello from string table")], 0);
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/ST_Simple.ST_Simple",
            STRINGTABLE_CLASS,
        );
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let legacy_schemas = EmptySchemas;
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &legacy_schemas,
        };

        let Some(DecodedAsset::StringTable(generated)) =
            decode_modeled_export(&export, &generated_context).expect("generated decode")
        else {
            panic!("expected generated StringTable");
        };
        let Some(DecodedAsset::StringTable(legacy)) =
            decode_export(&export, &legacy_context).expect("legacy decode")
        else {
            panic!("expected legacy StringTable");
        };
        assert_eq!(generated, legacy);
    }

    #[test]
    fn rejects_string_table_metadata_until_supported() {
        let export_bytes = write_stringtable_export(0, "ST_Simple", &[], 1);
        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/ST_Simple.ST_Simple",
            STRINGTABLE_CLASS,
        );
        let legacy_schemas = EmptySchemas;
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &legacy_schemas,
        };
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };

        let legacy = StringTableDecoder
            .decode(&export, &legacy_context)
            .expect_err("metadata unsupported");
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated metadata unsupported");
        assert_eq!(legacy.kind(), AssetErrorKind::UnsupportedCapability);
        assert!(legacy.message().contains("metadata"));
        assert_eq!(generated.kind(), legacy.kind());
        assert_eq!(generated.message(), legacy.message());
    }

    fn enum_names() -> Vec<String> {
        vec![
            "None".into(),                 // 0
            "E_Color::Red".into(),         // 1
            "E_Color::Green".into(),       // 2
            "E_Color::E_Color_MAX".into(), // 3
            "DisplayNameMap".into(),       // 4
            "MapProperty".into(),          // 5
            "NameProperty".into(),         // 6
            "TextProperty".into(),         // 7
        ]
    }

    #[test]
    fn decodes_user_defined_enum_entries() {
        let export_bytes = write_userdefinedenum_export(0, &[], &[(1, 0), (2, 1), (3, 2)], 2);
        let package = test_package(enum_names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/E_Color.E_Color",
            USERDEFINEDENUM_CLASS,
        );

        let legacy_schemas = EmptySchemas;
        let legacy = decode_enum(&export_bytes, &package, &export, &legacy_schemas);
        let decoded = decode_enum(&export_bytes, &package, &export, embedded_source_model());
        assert_eq!(decoded, legacy);

        assert_eq!(decoded.object_path.as_str(), "/Game/Test/E_Color.E_Color");
        assert_eq!(decoded.cpp_form, EnumCppForm::EnumClass);
        assert_eq!(
            decoded.entries,
            vec![
                EnumEntry {
                    name: name_ref(1, 0),
                    value: 0,
                    display_name: None,
                },
                EnumEntry {
                    name: name_ref(2, 0),
                    value: 1,
                    display_name: None,
                },
                EnumEntry {
                    name: name_ref(3, 0),
                    value: 2,
                    display_name: None,
                },
            ]
        );
    }

    #[test]
    fn resolves_user_defined_enum_display_names() {
        let mut properties = Vec::new();
        write_display_name_map_property(&mut properties, 4, 5, 6, 7, &[(1, "Red"), (2, "Green")]);
        let export_bytes =
            write_userdefinedenum_export(0, &properties, &[(1, 0), (2, 1), (3, 2)], 2);
        let package = test_package(enum_names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/E_Color.E_Color",
            USERDEFINEDENUM_CLASS,
        );

        let legacy_schemas = EmptySchemas;
        let legacy = decode_enum(&export_bytes, &package, &export, &legacy_schemas);
        let decoded = decode_enum(&export_bytes, &package, &export, embedded_source_model());
        assert_eq!(decoded, legacy);

        assert_eq!(
            decoded
                .entries
                .iter()
                .map(|entry| entry.display_name.clone())
                .collect::<Vec<_>>(),
            vec![Some("Red".to_owned()), Some("Green".to_owned()), None],
        );
    }

    #[test]
    fn rejects_unsupported_enum_cpp_form() {
        let export_bytes = write_userdefinedenum_export(0, &[], &[(1, 0)], 7);
        let package = test_package(enum_names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/E_Color.E_Color",
            USERDEFINEDENUM_CLASS,
        );
        let legacy_schemas = EmptySchemas;
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &legacy_schemas,
        };
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };

        let legacy = EnumDecoder
            .decode(&export, &legacy_context)
            .expect_err("unsupported cpp form");
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated unsupported cpp form");
        assert_eq!(legacy.kind(), AssetErrorKind::MalformedData);
        assert!(legacy.message().contains("CppForm"));
        assert_eq!(generated.kind(), legacy.kind());
        assert_eq!(generated.message(), legacy.message());
    }

    /// Writes one `FProperty` as `UStruct::SerializeProperties` does: type FName,
    /// `FField` (name + flags + empty metadata), `FProperty` base, plus an
    /// optional type-specific tail. Field widths mirror the real `S_E2EFixture`.
    fn write_struct_field(
        bytes: &mut Vec<u8>,
        type_index: i32,
        name_index: i32,
        element_size: i32,
        tail: &[u8],
    ) {
        push_i32(bytes, type_index); // PropertyTypeName FName index
        push_i32(bytes, 0); // ... number
        push_i32(bytes, name_index); // FField NamePrivate index
        push_i32(bytes, 0); // ... number
        push_i32(bytes, 0); // FlagsPrivate (u32)
        push_i32(bytes, 0); // bHasMetaData (archive bool = u32) -> 0
        push_i32(bytes, 1); // ArrayDim
        push_i32(bytes, element_size); // ElementSize
        push_i32(bytes, 0); // PropertyFlags low 32
        push_i32(bytes, 0); // PropertyFlags high 32
        bytes.extend_from_slice(&0u16.to_le_bytes()); // RepIndex (u16)
        push_i32(bytes, 0); // RepNotifyFunc FName index (None)
        push_i32(bytes, 0); // ... number
        bytes.push(0); // BlueprintReplicationCondition (u8)
        bytes.extend_from_slice(tail);
    }

    fn write_userdefinedstruct_export(
        none_name_index: i32,
        fields: &[u8],
        field_count: i32,
        struct_flags: u32,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(0); // class serialization-control extensions
        write_property_terminator(&mut bytes, none_name_index); // struct object tagged props
        push_i32(&mut bytes, 0); // UObject export footer
        push_i32(&mut bytes, 0); // SuperStruct (null)
        push_i32(&mut bytes, 0); // Children count
        push_i32(&mut bytes, field_count); // ChildProperties count
        bytes.extend_from_slice(fields);
        push_i32(&mut bytes, 0); // ScriptBytecodeSize
        push_i32(&mut bytes, 0); // ScriptStorageSize
        bytes.extend_from_slice(&struct_flags.to_le_bytes()); // StructFlags (u32)
        write_property_terminator(&mut bytes, none_name_index); // empty default instance
        bytes
    }

    fn decode_struct(export_bytes: Vec<u8>, package: Package, export: Export) -> DecodedStruct {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };
        let DecodedAsset::Struct(decoded) = StructDecoder
            .decode(&export, &context)
            .expect("decode struct")
        else {
            panic!("expected Struct decode");
        };
        decoded
    }

    #[test]
    fn decodes_user_defined_struct_fields() {
        // names: 0 None, 1 IntProperty, 2 IntValue, 3 BoolProperty, 4 BoolValue
        let package = test_package(vec![
            "None".into(),
            "IntProperty".into(),
            "IntValue".into(),
            "BoolProperty".into(),
            "BoolValue".into(),
        ]);
        let mut fields = Vec::new();
        write_struct_field(&mut fields, 1, 2, 4, &[]);
        // BoolProperty tail: FieldSize, ByteOffset, ByteMask, FieldMask, BoolSize, NativeBool.
        write_struct_field(&mut fields, 3, 4, 1, &[1, 0, 1, 1, 1, 0]);
        let export_bytes = write_userdefinedstruct_export(0, &fields, 2, 0);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/S_Test.S_Test",
            USERDEFINEDSTRUCT_CLASS,
        );

        let decoded = decode_struct(export_bytes.clone(), package.clone(), export.clone());
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let Some(DecodedAsset::Struct(generated)) =
            decode_modeled_export(&export, &generated_context).expect("generated Struct decode")
        else {
            panic!("expected generated Struct decode");
        };
        assert_eq!(generated, decoded);

        assert_eq!(decoded.object_path.as_str(), "/Game/Test/S_Test.S_Test");
        assert_eq!(decoded.struct_flags, 0);
        assert_eq!(decoded.fields.len(), 2);
        assert_eq!(decoded.fields[0].name, name_ref(2, 0));
        assert_eq!(decoded.fields[0].type_name, name_ref(1, 0));
        assert_eq!(decoded.fields[1].name, name_ref(4, 0));
        assert_eq!(decoded.fields[1].type_name, name_ref(3, 0));
        assert!(decoded.default_values.records.is_empty());
    }

    #[test]
    fn rejects_unsupported_struct_field_type() {
        let package = test_package(vec![
            "None".into(),
            "DelegateProperty".into(),
            "OnFire".into(),
        ]);
        let mut fields = Vec::new();
        write_struct_field(&mut fields, 1, 2, 16, &[]);
        let export_bytes = write_userdefinedstruct_export(0, &fields, 1, 0);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/S_Test.S_Test",
            USERDEFINEDSTRUCT_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = StructDecoder
            .decode(&export, &context)
            .expect_err("unsupported field type");
        assert_eq!(error.kind(), AssetErrorKind::UnsupportedCapability);
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects unsupported field type");
        assert_eq!(generated.kind(), error.kind());
        assert_eq!(generated.message(), error.message());
    }

    #[test]
    fn rejects_overly_deep_struct_field_nesting() {
        fn write_nested_array_field(bytes: &mut Vec<u8>, depth: usize) {
            if depth == 0 {
                write_struct_field(bytes, 3, 2, 4, &[]);
                return;
            }

            let mut inner = Vec::new();
            write_nested_array_field(&mut inner, depth - 1);
            write_struct_field(bytes, 1, 2, 16, &inner);
        }

        let package = test_package(vec![
            "None".into(),
            "ArrayProperty".into(),
            "Value".into(),
            "IntProperty".into(),
        ]);
        let mut fields = Vec::new();
        write_nested_array_field(&mut fields, MAX_FIELD_DEPTH);
        let export_bytes = write_userdefinedstruct_export(0, &fields, 1, 0);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/S_Test.S_Test",
            USERDEFINEDSTRUCT_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = StructDecoder
            .decode(&export, &context)
            .expect_err("field depth limit should reject nested array fields");

        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("depth limit"));
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects excessive field nesting");
        assert_eq!(generated.kind(), error.kind());
        assert_eq!(generated.message(), error.message());
    }

    #[test]
    fn rejects_unsupported_asset_class() {
        let export_bytes = write_datatable_export(0, &[], &[]);
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/BP_Test.BP_Test",
            "/Script/Engine.Blueprint",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = DataTableDecoder
            .decode(&export, &context)
            .expect_err("unsupported class");
        assert_eq!(error.kind(), AssetErrorKind::UnsupportedFormat);
    }

    #[test]
    fn recognizes_data_asset_class_paths() {
        assert!(is_data_asset_class(DATA_ASSET_CLASS));
        assert!(is_data_asset_class(PRIMARY_DATA_ASSET_CLASS));
        assert!(is_data_asset_class(
            "/Script/E2EFixtures.E2EFixtureScalarsDataAsset"
        ));
        assert!(!is_data_asset_class(DATATABLE_CLASS));
        assert!(!is_data_asset_class("/Script/Engine.Blueprint"));
    }

    #[test]
    fn recognizes_generic_uobject_class_paths() {
        assert!(is_generic_uobject_class("/Script/Engine.Blueprint"));
        assert!(is_generic_uobject_class(
            "/Script/SWAG_RemoteControlDataTable.SWAG_RemoteControlDataTableLibrary"
        ));
        assert!(!is_generic_uobject_class(DATATABLE_CLASS));
        assert!(!is_generic_uobject_class(
            "/Script/E2EFixtures.E2EFixtureScalarsDataAsset"
        ));
        assert!(!is_generic_uobject_class("/Script/CoreUObject.Package"));
    }

    fn decode_uobject(export_bytes: Vec<u8>, package: Package, export: Export) -> DecodedUObject {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };
        let DecodedAsset::UObject(object) = UObjectDecoder
            .decode(&export, &context)
            .expect("decode uobject")
        else {
            panic!("expected UObject decode");
        };
        object
    }

    #[test]
    fn decodes_generic_uobject_with_scalar_properties() {
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 4243);
        let export_bytes = write_uobject_export(0, &properties);
        let package = test_package(vec!["None".into(), "IntProperty".into(), "IntValue".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/BP_Test.Default__BP_Test_C",
            "/Script/Engine.BlueprintGeneratedClass",
        );

        let object = decode_uobject(export_bytes, package, export);

        assert_eq!(
            object.object_path.as_str(),
            "/Game/Test/BP_Test.Default__BP_Test_C"
        );
        assert_eq!(
            object.class_path.as_str(),
            "/Script/Engine.BlueprintGeneratedClass"
        );
        assert_eq!(object.properties.records.len(), 1);
        assert_eq!(object.properties.records[0].value, PropertyValue::Int(4243));
    }

    #[test]
    fn decode_export_prefers_datatable_over_uobject() {
        let export_bytes = write_datatable_export(0, &[], &[]);
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            "/Script/Engine.DataTable",
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let decoded = decode_export(&export, &context)
            .expect("decode export")
            .expect("matched decoder");
        assert!(matches!(decoded, DecodedAsset::DataTable(_)));
    }

    #[test]
    fn embedded_source_model_strictly_decodes_datatable_and_primary_data_asset() {
        let table_bytes = write_datatable_export(0, &[], &[]);
        let table_package = test_package(names());
        let table_export = test_export(
            table_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            DATATABLE_CLASS,
        );
        let table_context = AssetDecodeContext {
            source: &table_bytes,
            package: &table_package,
            schemas: embedded_source_model(),
        };
        assert!(matches!(
            decode_modeled_export(&table_export, &table_context).expect("generated DataTable"),
            Some(DecodedAsset::DataTable(_))
        ));

        let data_asset_bytes = write_uobject_export(0, &[]);
        let data_asset_package = test_package(vec!["None".into()]);
        let data_asset_export = test_export(
            data_asset_bytes.len() as u64,
            "/Game/Test/PDA_Test.PDA_Test",
            PRIMARY_DATA_ASSET_CLASS,
        );
        let data_asset_context = AssetDecodeContext {
            source: &data_asset_bytes,
            package: &data_asset_package,
            schemas: embedded_source_model(),
        };
        assert!(matches!(
            decode_modeled_export(&data_asset_export, &data_asset_context)
                .expect("generated PrimaryDataAsset"),
            Some(DecodedAsset::DataAsset(_))
        ));
    }

    #[test]
    fn embedded_and_legacy_primary_data_asset_semantics_are_identical() {
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 4243);
        let export_bytes = write_uobject_export(0, &properties);
        let package = test_package(vec!["None".into(), "IntProperty".into(), "IntValue".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/PDA_Test.PDA_Test",
            PRIMARY_DATA_ASSET_CLASS,
        );
        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let legacy_schemas = EmptySchemas;
        let legacy_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &legacy_schemas,
        };

        let Some(DecodedAsset::DataAsset(generated)) =
            decode_modeled_export(&export, &generated_context).expect("generated decode")
        else {
            panic!("expected generated DataAsset");
        };
        let Some(DecodedAsset::DataAsset(legacy)) =
            decode_export(&export, &legacy_context).expect("legacy decode")
        else {
            panic!("expected legacy DataAsset");
        };
        assert_eq!(generated, legacy);
    }

    #[test]
    fn source_modeled_datatable_preserves_malformed_input_checks() {
        let mut export_bytes = write_datatable_export(0, &[], &[]);
        export_bytes[1 + 8] = 2;
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            DATATABLE_CLASS,
        );
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };

        let error = decode_modeled_export(&export, &context).expect_err("invalid GUID marker");
        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("object-guid footer marker"));
    }

    #[test]
    fn source_modeled_dispatch_rejects_an_unrecognized_serialization_plan() {
        let export_bytes = write_datatable_export(0, &[], &[]);
        let package = test_package(names());
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DT_Test.DT_Test",
            DATATABLE_CLASS,
        );
        let model = SourceModel {
            schema_version: crate::schema::SOURCE_MODEL_SCHEMA_VERSION,
            engine_version: "test".to_owned(),
            classes: vec![ClassSchema {
                path: ObjectPath::new(DATATABLE_CLASS),
                cpp_name: "UDataTable".to_owned(),
                super_path: Some(ObjectPath::new("/Script/CoreUObject.Object")),
                fields: Vec::new(),
                serialization: vec![
                    SerializationOperation::TaggedProperties,
                    SerializationOperation::ObjectGuid,
                ],
            }],
            structs: Vec::new(),
        };
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &model,
        };

        let error = decode_modeled_export(&export, &context).expect_err("unsupported plan");
        assert_eq!(error.kind(), AssetErrorKind::UnsupportedCapability);
        assert!(error.message().contains("generated serialization layout"));
    }

    fn decode_data_asset(
        export_bytes: Vec<u8>,
        package: Package,
        export: Export,
    ) -> DecodedDataAsset {
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };
        let DecodedAsset::DataAsset(data_asset) = DataAssetDecoder
            .decode(&export, &context)
            .expect("decode data asset")
        else {
            panic!("expected DataAsset decode");
        };
        data_asset
    }

    #[test]
    fn decodes_minimal_primary_data_asset_with_scalar_properties() {
        let mut properties = Vec::new();
        write_int_property_tag(&mut properties, 2, 1, 4243);
        let export_bytes = write_uobject_export(0, &properties);
        let package = test_package(vec!["None".into(), "IntProperty".into(), "IntValue".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DA_Test.DA_Test",
            "/Script/E2EFixtures.E2EFixtureScalarsDataAsset",
        );

        let data_asset = decode_data_asset(export_bytes, package, export);

        assert_eq!(
            data_asset.object_path.as_str(),
            "/Game/Test/DA_Test.DA_Test"
        );
        assert_eq!(
            data_asset.class_path.as_str(),
            "/Script/E2EFixtures.E2EFixtureScalarsDataAsset"
        );
        assert_eq!(data_asset.properties.records.len(), 1);
        assert_eq!(
            data_asset.properties.records[0].value,
            PropertyValue::Int(4243)
        );
    }

    #[test]
    fn rejects_trailing_data_asset_export_bytes() {
        let mut export_bytes = write_uobject_export(0, &[]);
        export_bytes.push(0xFF);

        let package = test_package(vec!["None".into()]);
        let export = test_export(
            export_bytes.len() as u64,
            "/Game/Test/DA_Test.DA_Test",
            PRIMARY_DATA_ASSET_CLASS,
        );
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: &schemas,
        };

        let error = DataAssetDecoder
            .decode(&export, &context)
            .expect_err("trailing bytes");
        assert_eq!(error.kind(), AssetErrorKind::MalformedData);
        assert!(error.message().contains("trailing bytes"));

        let generated_context = AssetDecodeContext {
            source: &export_bytes,
            package: &package,
            schemas: embedded_source_model(),
        };
        let generated_error = decode_modeled_export(&export, &generated_context)
            .expect_err("generated path rejects trailing bytes");
        assert_eq!(generated_error.kind(), AssetErrorKind::MalformedData);
        assert!(generated_error.message().contains("trailing bytes"));
    }
}
