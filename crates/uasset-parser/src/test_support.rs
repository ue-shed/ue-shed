//! Synthetic wire-format builders shared by unit tests.

use crate::archive::{NameRef, Reader};
use crate::version::VersionContext;

pub fn push_i32(bytes: &mut Vec<u8>, value: i32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub fn push_f32(bytes: &mut Vec<u8>, value: f32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub fn push_f64(bytes: &mut Vec<u8>, value: f64) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

pub fn push_fstring(bytes: &mut Vec<u8>, value: &str) {
    let ansi = format!("{value}\0");
    push_i32(bytes, i32::try_from(ansi.len()).expect("fits in i32"));
    bytes.extend_from_slice(ansi.as_bytes());
}

pub fn name_ref(index: i32, number: i32) -> NameRef {
    let mut bytes = Vec::new();
    push_i32(&mut bytes, index);
    push_i32(&mut bytes, number);
    Reader::new(&bytes)
        .read_name_ref("test.NameRef")
        .expect("name ref")
}

pub fn ue5_versions() -> VersionContext {
    VersionContext {
        legacy_file_version: -9,
        legacy_ue3: None,
        ue4: 522,
        ue5: 1018,
        licensee: 0,
        package_flags: crate::version::PackageFlags::from_bits(0),
    }
}

pub struct TypeParam {
    pub type_index: i32,
    pub parameters: Vec<TypeParam>,
}

pub fn write_type_name(bytes: &mut Vec<u8>, param: &TypeParam) {
    push_i32(bytes, param.type_index);
    push_i32(bytes, 0);
    push_i32(
        bytes,
        i32::try_from(param.parameters.len()).expect("fits in i32"),
    );
    for inner in &param.parameters {
        write_type_name(bytes, inner);
    }
}

pub fn write_property_tag(
    bytes: &mut Vec<u8>,
    name_index: i32,
    type_param: &TypeParam,
    flags: u8,
    payload: &[u8],
) {
    push_i32(bytes, name_index);
    push_i32(bytes, 0);
    write_type_name(bytes, type_param);
    push_i32(bytes, i32::try_from(payload.len()).expect("fits in i32"));
    bytes.push(flags);
    bytes.extend_from_slice(payload);
}

pub fn write_property_terminator(bytes: &mut Vec<u8>, none_name_index: i32) {
    push_i32(bytes, none_name_index);
    push_i32(bytes, 0);
}

/// `extras` includes the type-specific fields, HasPropertyGuid and optional extensions.
pub fn write_legacy_property_tag(
    bytes: &mut Vec<u8>,
    name_index: i32,
    type_index: i32,
    extras: &[u8],
    payload: &[u8],
) {
    let size = i32::try_from(payload.len()).expect("payload fits in i32");
    for value in [name_index, 0, type_index, 0, size, 0] {
        push_i32(bytes, value);
    }
    bytes.extend_from_slice(extras);
    bytes.extend_from_slice(payload);
}

pub fn editor_text_version(package: &mut crate::package::Package, version: Option<i32>) {
    let key = crate::archive::Guid {
        a: 0xE4B0_68ED,
        b: 0xF494_42E9,
        c: 0xA231_DA0B,
        d: 0x2E46_BB41,
    };
    package
        .summary
        .custom_versions
        .retain(|entry| entry.key != key);
    if let Some(version) = version {
        package
            .summary
            .custom_versions
            .push(crate::package::CustomVersion {
                key,
                version,
                friendly_name: None,
            });
    }
}

/// Reuses a current fixture's export address; every property byte is synthetic legacy framing.
pub fn legacy_text_package(ue5: i32) -> (Vec<u8>, crate::package::Package) {
    use crate::package::{ObjectPath, Package};
    let seed = include_bytes!(
        "../../../fixtures/unreal-project/Content/Fixture/Text/DA_TextOccurrences.uasset"
    );
    let mut package = Package::parse(seed).expect("header seed");
    let mut export = package
        .exports
        .iter()
        .find(|export| export.is_asset == Some(true))
        .expect("asset export")
        .clone();
    package.names = [
        "None",
        "Value",
        "TextProperty",
        "MapProperty",
        "StructProperty",
        "IntProperty",
        "InstancedStruct",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    package.summary.versions.ue5 = ue5;
    package.summary.custom_versions.clear();
    editor_text_version(&mut package, Some(32));
    let mut extras = vec![0];
    if ue5 >= 1011 {
        extras.push(0);
    }
    let mut properties = Vec::new();
    if ue5 >= 1011 {
        properties.push(0);
    }
    write_legacy_property_tag(&mut properties, 1, 2, &extras, &[0, 0, 0, 0, 12]);
    let mut map_extras = Vec::new();
    for word in [5, 0, 4, 0] {
        push_i32(&mut map_extras, word);
    }
    map_extras.extend_from_slice(&extras);
    let mut map = Vec::new();
    for word in [0, 1, 7] {
        push_i32(&mut map, word);
    }
    map.extend_from_slice(&[0xFF; 24]);
    write_legacy_property_tag(&mut properties, 1, 3, &map_extras, &map);
    let mut struct_extras = Vec::new();
    for word in [6, 0] {
        push_i32(&mut struct_extras, word);
    }
    struct_extras.extend_from_slice(&[0; 16]);
    struct_extras.extend_from_slice(&extras);
    write_legacy_property_tag(&mut properties, 1, 4, &struct_extras, &[]);
    let mut text = vec![0, 0, 0, 0, 0];
    for value in ["Fixture", "Greeting", "Hello"] {
        push_fstring(&mut text, value);
    }
    write_legacy_property_tag(&mut properties, 1, 2, &extras, &text);
    write_legacy_property_tag(&mut properties, 1, 5, &extras, &[0xFF]);
    write_property_terminator(&mut properties, 0);
    push_i32(&mut properties, 0);
    let mut source = vec![0; export.serial_offset.get() as usize];
    source.extend_from_slice(&properties);
    export.serial_size = properties.len() as u64;
    export.class_path = Some(ObjectPath::new("/Script/Engine.DataAsset"));
    package.exports = vec![export];
    (source, package)
}

pub fn write_int_property_tag(bytes: &mut Vec<u8>, name_index: i32, type_index: i32, value: i32) {
    write_property_tag(
        bytes,
        name_index,
        &TypeParam {
            type_index,
            parameters: Vec::new(),
        },
        0,
        &value.to_le_bytes(),
    );
}

pub fn write_object_array_property_tag(
    bytes: &mut Vec<u8>,
    name_index: i32,
    array_type_index: i32,
    object_type_index: i32,
    indices: &[i32],
) {
    let mut payload = Vec::new();
    push_i32(
        &mut payload,
        i32::try_from(indices.len()).expect("fits in i32"),
    );
    for index in indices {
        push_i32(&mut payload, *index);
    }
    write_property_tag(
        bytes,
        name_index,
        &TypeParam {
            type_index: array_type_index,
            parameters: vec![TypeParam {
                type_index: object_type_index,
                parameters: Vec::new(),
            }],
        },
        0,
        &payload,
    );
}

pub fn write_object_property_tag(
    bytes: &mut Vec<u8>,
    name_index: i32,
    type_index: i32,
    index: i32,
) {
    write_property_tag(
        bytes,
        name_index,
        &TypeParam {
            type_index,
            parameters: Vec::new(),
        },
        0,
        &index.to_le_bytes(),
    );
}

/// Builds a synthetic `UDataTable` export serial blob: UObject root properties,
/// zero UObject-guid marker, row count, then each row's name and tagged-property stream.
pub fn write_datatable_export(
    none_name_index: i32,
    root_properties: &[u8],
    rows: &[(i32, &[u8])],
) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.push(0); // class serialization-control extensions
    bytes.extend_from_slice(root_properties);
    write_property_terminator(&mut bytes, none_name_index);
    push_i32(&mut bytes, 0); // UObject object-guid marker
    push_i32(&mut bytes, i32::try_from(rows.len()).expect("fits in i32"));
    for (name_index, row_properties) in rows {
        push_i32(&mut bytes, *name_index);
        push_i32(&mut bytes, 0);
        bytes.extend_from_slice(row_properties);
        write_property_terminator(&mut bytes, none_name_index);
    }
    bytes
}

/// Builds a synthetic UObject export serial blob: extensions byte, tagged
/// properties, and terminator only (no DataTable row payload).
pub fn write_uobject_export(none_name_index: i32, properties: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.push(0); // class serialization-control extensions
    bytes.extend_from_slice(properties);
    write_property_terminator(&mut bytes, none_name_index);
    bytes
}

/// Model package custom versions independently of an engine-version label.
pub fn text_version(package: &mut crate::package::Package, version: Option<i32>, flags: u32) {
    package.summary.versions.package_flags = crate::version::PackageFlags::from_bits(flags);
    package.summary.custom_versions = version
        .into_iter()
        .map(|version| crate::package::CustomVersion {
            key: crate::archive::Guid {
                a: 0x601D1886,
                b: 0xAC644F84,
                c: 0xAA16D3DE,
                d: 0x0DEAC7D6,
            },
            version,
            friendly_name: None,
        })
        .collect();
}
