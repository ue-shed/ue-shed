//! Semantic adapters over reusable source-modeled native layouts.

use super::*;
use crate::native::{NativeError, NativeValue, decode_native};

fn modeled_data(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    cpp_name: &str,
    path: &ObjectPath,
) -> Result<NativeValue, AssetError> {
    let layout = context
        .schemas
        .native_layout(cpp_name)
        .ok_or_else(|| invalid_layout(path, cpp_name))?;
    decode_native(reader, layout, path.as_str()).map_err(|error| match error {
        NativeError::Archive(error) => error.into(),
        NativeError::Layout(message) => invalid_layout(path, &message),
    })
}

fn invalid_layout(path: &ObjectPath, field: &str) -> AssetError {
    AssetError::new(
        AssetErrorKind::UnsupportedCapability,
        format!("{path}: generated native layout has missing or incompatible {field}"),
    )
}

fn field(
    record: &mut NativeValue,
    name: &str,
    path: &ObjectPath,
) -> Result<NativeValue, AssetError> {
    let NativeValue::Record(fields) = record else {
        return Err(invalid_layout(path, name));
    };
    let index = fields
        .iter()
        .position(|(key, _)| key == name)
        .ok_or_else(|| invalid_layout(path, name))?;
    Ok(fields.remove(index).1)
}

fn string(value: NativeValue, path: &ObjectPath) -> Result<String, AssetError> {
    match value {
        NativeValue::String(value) => Ok(value),
        _ => Err(invalid_layout(path, "string")),
    }
}

fn finish_record(record: NativeValue, path: &ObjectPath) -> Result<(), AssetError> {
    match record {
        NativeValue::Record(fields) if fields.is_empty() => Ok(()),
        _ => Err(invalid_layout(path, "unconsumed record fields")),
    }
}

pub(super) fn string_table(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    path: &ObjectPath,
) -> Result<SourceStringTableData, AssetError> {
    let mut data = modeled_data(reader, context, "FStringTable", path)?;
    let namespace = string(field(&mut data, "Namespace", path)?, path)?;
    let NativeValue::Array(raw_entries) = field(&mut data, "Entries", path)? else {
        return Err(invalid_layout(path, "Entries"));
    };
    let mut entries = Vec::with_capacity(raw_entries.len());
    for mut entry in raw_entries {
        let key = string(field(&mut entry, "Key", path)?, path)?;
        let source = string(field(&mut entry, "SourceString", path)?, path)?;
        finish_record(entry, path)?;
        entries.push(StringTableEntry { key, source });
    }
    let NativeValue::Map(raw_metadata) = field(&mut data, "MetaData", path)? else {
        return Err(invalid_layout(path, "MetaData"));
    };
    let mut metadata = std::collections::BTreeMap::new();
    for (key, values) in raw_metadata {
        let key = string(key, path)?;
        let NativeValue::Map(values) = values else {
            return Err(invalid_layout(path, "MetaData.Value"));
        };
        let mut fields = std::collections::BTreeMap::new();
        for (name, value) in values {
            let NativeValue::Name(name) = name else {
                return Err(invalid_layout(path, "MetaData.Name"));
            };
            fields.insert(
                metadata_name(context.package, name, path)?,
                string(value, path)?,
            );
        }
        metadata.insert(key, fields);
    }
    finish_record(data, path)?;
    Ok(SourceStringTableData {
        namespace,
        entries,
        metadata,
    })
}

pub(super) fn metadata_name(
    package: &Package,
    name: NameRef,
    path: &ObjectPath,
) -> Result<String, AssetError> {
    package.resolve_name(name).ok_or_else(|| {
        AssetError::new(
            AssetErrorKind::MalformedData,
            format!("{path}.MetaData: unresolved metadata name {name:?}"),
        )
    })
}

pub(super) fn enumeration(
    reader: &mut crate::archive::Reader<'_>,
    context: &AssetDecodeContext<'_>,
    properties: &PropertyStream,
    path: &ObjectPath,
) -> Result<SourceEnumData, AssetError> {
    let mut data = modeled_data(reader, context, "UEnum", path)?;
    let NativeValue::Array(raw_entries) = field(&mut data, "Names", path)? else {
        return Err(invalid_layout(path, "Names"));
    };
    let NativeValue::UInt8(raw_form) = field(&mut data, "CppForm", path)? else {
        return Err(invalid_layout(path, "CppForm"));
    };
    let cpp_form = enum_cpp_form(raw_form, reader.tell().saturating_sub(1))?;
    let display_names = display_name_map(context.package, properties);
    let mut entries = Vec::with_capacity(raw_entries.len());
    for mut entry in raw_entries {
        let NativeValue::Name(name) = field(&mut entry, "Name", path)? else {
            return Err(invalid_layout(path, "Name"));
        };
        let NativeValue::Int64(value) = field(&mut entry, "Value", path)? else {
            return Err(invalid_layout(path, "Value"));
        };
        finish_record(entry, path)?;
        entries.push(EnumEntry {
            name,
            value,
            display_name: display_names
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.clone()),
        });
    }
    finish_record(data, path)?;
    Ok(SourceEnumData { cpp_form, entries })
}
