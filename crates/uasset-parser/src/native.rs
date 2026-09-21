//! Composable layouts for bounded native serialization, independent of asset classes.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::archive::{ArchiveError, NameRef, Reader};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum NativeLayout {
    String,
    Name,
    Int64,
    Int32,
    Float,
    Double,
    Bool,
    UInt8,
    Padding { bytes: u8 },
    Record { fields: Vec<NativeField> },
    Array { element: Box<Self> },
    SizedArray { stride: u32, element: Box<Self> },
    Map { key: Box<Self>, value: Box<Self> },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NativeField {
    pub name: String,
    pub layout: NativeLayout,
}

impl NativeLayout {
    pub fn record(fields: impl IntoIterator<Item = (impl Into<String>, Self)>) -> Self {
        Self::Record {
            fields: fields
                .into_iter()
                .map(|(name, layout)| NativeField {
                    name: name.into(),
                    layout,
                })
                .collect(),
        }
    }

    pub fn array(element: Self) -> Self {
        Self::Array {
            element: Box::new(element),
        }
    }

    pub fn map(key: Self, value: Self) -> Self {
        Self::Map {
            key: Box::new(key),
            value: Box::new(value),
        }
    }

    fn is_fixed_size(&self) -> bool {
        match self {
            Self::String | Self::Array { .. } | Self::SizedArray { .. } | Self::Map { .. } => false,
            Self::Record { fields } => fields.iter().all(|field| field.layout.is_fixed_size()),
            _ => true,
        }
    }

    fn minimum_size(&self, depth: usize) -> Result<usize, NativeError> {
        if depth > 32 {
            return Err(NativeError::Layout(
                "native layout exceeds nesting limit".into(),
            ));
        }
        Ok(match self {
            Self::String => 4,
            Self::Name | Self::Int64 => 8,
            Self::Double => 8,
            Self::Int32 | Self::Float | Self::Bool => 4,
            Self::UInt8 => 1,
            Self::Padding { bytes } if *bytes > 0 => usize::from(*bytes),
            Self::Padding { .. } => {
                return Err(NativeError::Layout("zero-size native padding".into()));
            }
            Self::Record { fields } => {
                if fields.is_empty() || fields.len() > 256 {
                    return Err(NativeError::Layout(
                        "native record requires 1..=256 fields".into(),
                    ));
                }
                let mut size = 0_usize;
                for (index, field) in fields.iter().enumerate() {
                    if field.name.is_empty()
                        || fields[..index]
                            .iter()
                            .any(|previous| previous.name == field.name)
                    {
                        return Err(NativeError::Layout(
                            "native record field names must be nonempty and unique".into(),
                        ));
                    }
                    size = size
                        .checked_add(field.layout.minimum_size(depth + 1)?)
                        .ok_or_else(|| NativeError::Layout("native record size overflow".into()))?;
                }
                size
            }
            Self::Array { element } => {
                element.minimum_size(depth + 1)?;
                4
            }
            Self::SizedArray { stride, element } => {
                if element.minimum_size(depth + 1)? != *stride as usize || !element.is_fixed_size()
                {
                    return Err(NativeError::Layout(
                        "native sized array stride disagrees with its layout".into(),
                    ));
                }
                8
            }
            Self::Map { key, value } => {
                key.minimum_size(depth + 1)?;
                value.minimum_size(depth + 1)?;
                4
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum NativeValue {
    String(String),
    Name(NameRef),
    Int64(i64),
    Int32(i32),
    Float(f32),
    Double(f64),
    Bool(bool),
    UInt8(u8),
    Padding,
    Record(Vec<(String, Self)>),
    Array(Vec<Self>),
    Map(Vec<(Self, Self)>),
}

#[derive(Debug)]
pub enum NativeError {
    Archive(ArchiveError),
    Layout(String),
}

impl fmt::Display for NativeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Archive(error) => error.fmt(formatter),
            Self::Layout(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for NativeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Archive(error) => Some(error),
            Self::Layout(_) => None,
        }
    }
}

impl From<ArchiveError> for NativeError {
    fn from(error: ArchiveError) -> Self {
        Self::Archive(error)
    }
}

/// Reads one layout, leaving framing and interpretation to its caller.
/// Invalid layouts fail before consuming any package bytes.
pub fn decode_native(
    reader: &mut Reader<'_>,
    layout: &NativeLayout,
    path: &str,
) -> Result<NativeValue, NativeError> {
    layout.minimum_size(0)?;
    decode(reader, layout, &path)
}

// Erasing the breadcrumb type lets recursive format_args! borrow its parents without
// building Strings or creating unbounded generic type nesting.
fn decode(
    reader: &mut Reader<'_>,
    layout: &NativeLayout,
    path: &dyn fmt::Display,
) -> Result<NativeValue, NativeError> {
    Ok(match layout {
        NativeLayout::String => NativeValue::String(reader.read_fstring(path)?),
        NativeLayout::Name => NativeValue::Name(reader.read_name_ref(path)?),
        NativeLayout::Int64 => NativeValue::Int64(reader.read_i64(path)?),
        NativeLayout::Int32 => NativeValue::Int32(reader.read_i32(path)?),
        NativeLayout::Float => NativeValue::Float(reader.read_f32(path)?),
        NativeLayout::Double => NativeValue::Double(reader.read_f64(path)?),
        NativeLayout::Bool => NativeValue::Bool(reader.read_bool(path)?),
        NativeLayout::UInt8 => NativeValue::UInt8(reader.read_u8(path)?),
        NativeLayout::Padding { bytes } => {
            reader.read_bytes(usize::from(*bytes), path)?;
            NativeValue::Padding
        }
        NativeLayout::Record { fields } => {
            let capacity =
                reader.checked_vec_capacity::<(String, NativeValue)>(fields.len(), 0, path)?;
            let mut values = Vec::with_capacity(capacity);
            for field in fields {
                values.push((
                    field.name.clone(),
                    decode(
                        reader,
                        &field.layout,
                        &format_args!("{path}.{}", field.name),
                    )?,
                ));
            }
            NativeValue::Record(values)
        }
        NativeLayout::Array { element } => decode_array(reader, element, path)?,
        NativeLayout::SizedArray { stride, element } => {
            let actual = reader.read_u32(&format_args!("{path}.ElementSize"))?;
            if actual != *stride {
                return Err(NativeError::Layout(format!(
                    "{path}: unsupported native array element size {actual}, expected {stride}"
                )));
            }
            decode_array(reader, element, path)?
        }
        NativeLayout::Map { key, value } => {
            let count = reader.read_count(&format_args!("{path}.Count"))?;
            let minimum = key
                .minimum_size(0)?
                .checked_add(value.minimum_size(0)?)
                .ok_or_else(|| NativeError::Layout("native map entry size overflow".into()))?;
            let capacity =
                reader.checked_vec_capacity::<(NativeValue, NativeValue)>(count, minimum, path)?;
            let mut values = Vec::with_capacity(capacity);
            for index in 0..count {
                values.push((
                    decode(reader, key, &format_args!("{path}[{index}].Key"))?,
                    decode(reader, value, &format_args!("{path}[{index}].Value"))?,
                ));
            }
            NativeValue::Map(values)
        }
    })
}

fn decode_array(
    reader: &mut Reader<'_>,
    element: &NativeLayout,
    path: &dyn fmt::Display,
) -> Result<NativeValue, NativeError> {
    let count = reader.read_count(&format_args!("{path}.Count"))?;
    let capacity =
        reader.checked_vec_capacity::<NativeValue>(count, element.minimum_size(0)?, path)?;
    let mut values = Vec::with_capacity(capacity);
    for index in 0..count {
        values.push(decode(reader, element, &format_args!("{path}[{index}]"))?);
    }
    Ok(NativeValue::Array(values))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{ArchiveErrorKind, ArchiveLimits};
    use crate::test_support::{push_fstring, push_i32};

    #[test]
    fn native_breadcrumbs_are_lazy_but_preserve_nested_failures() {
        struct UnformattedPath;
        impl fmt::Display for UnformattedPath {
            fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
                panic!("successful reads must not format diagnostic paths")
            }
        }

        let layout = NativeLayout::record([(
            "Values",
            NativeLayout::map(
                NativeLayout::UInt8,
                NativeLayout::SizedArray {
                    stride: 4,
                    element: Box::new(NativeLayout::record([("Active", NativeLayout::Bool)])),
                },
            ),
        )]);
        let mut bytes = Vec::new();
        push_i32(&mut bytes, 1); // Map count.
        bytes.push(9); // Key.
        push_i32(&mut bytes, 4); // Sized-array stride.
        push_i32(&mut bytes, 1); // Array count.
        push_i32(&mut bytes, 1); // Active.
        layout.minimum_size(0).unwrap();
        let mut reader = Reader::new(&bytes);
        decode(&mut reader, &layout, &UnformattedPath).unwrap();
        assert_eq!(reader.remaining(), 0);

        bytes[13..17].copy_from_slice(&2_i32.to_le_bytes());
        let NativeError::Archive(error) =
            decode_native(&mut Reader::new(&bytes), &layout, "Native").unwrap_err()
        else {
            panic!("expected invalid bool")
        };
        assert_eq!(error.kind(), ArchiveErrorKind::InvalidBoolean);
        assert_eq!(error.offset(), 13);
        assert_eq!(error.path(), "Native.Values[0].Value[0].Active");

        bytes[9..13].copy_from_slice(&(-1_i32).to_le_bytes());
        let NativeError::Archive(error) =
            decode_native(&mut Reader::new(&bytes), &layout, "Native").unwrap_err()
        else {
            panic!("expected invalid count")
        };
        assert_eq!(error.kind(), ArchiveErrorKind::InvalidCount);
        assert_eq!(error.offset(), 9);
        assert_eq!(error.path(), "Native.Values[0].Value.Count");

        bytes[5..9].copy_from_slice(&8_u32.to_le_bytes());
        let NativeError::Layout(message) =
            decode_native(&mut Reader::new(&bytes), &layout, "Native").unwrap_err()
        else {
            panic!("expected stride mismatch")
        };
        assert_eq!(
            message,
            "Native.Values[0].Value: unsupported native array element size 8, expected 4"
        );
    }

    #[test]
    fn nested_maps_share_the_same_bounded_reader() {
        let mut bytes = Vec::new();
        push_i32(&mut bytes, 1);
        push_fstring(&mut bytes, "Prompt");
        push_i32(&mut bytes, 1);
        push_fstring(&mut bytes, "Comment");
        push_fstring(&mut bytes, "Shown on pause");
        let layout = NativeLayout::map(
            NativeLayout::String,
            NativeLayout::map(NativeLayout::String, NativeLayout::String),
        );
        let mut reader = Reader::new(&bytes);
        let value = decode_native(&mut reader, &layout, "Metadata").unwrap();
        assert_eq!(
            value,
            NativeValue::Map(vec![(
                NativeValue::String("Prompt".into()),
                NativeValue::Map(vec![(
                    NativeValue::String("Comment".into()),
                    NativeValue::String("Shown on pause".into())
                )])
            )])
        );
        assert_eq!(reader.remaining(), 0);
        for end in 0..bytes.len() {
            assert!(
                decode_native(&mut Reader::new(&bytes[..end]), &layout, "Metadata").is_err(),
                "accepted truncation at {end}"
            );
        }
    }

    #[test]
    fn rejects_counts_and_allocations_before_reading_elements() {
        let layout = NativeLayout::array(NativeLayout::UInt8);
        for count in [-1_i32, i32::MAX] {
            assert!(
                decode_native(&mut Reader::new(&count.to_le_bytes()), &layout, "Values").is_err()
            );
        }
        let bytes = [1, 0, 0, 0, 7];
        let limits = ArchiveLimits {
            max_allocation_bytes: 1,
            ..ArchiveLimits::default()
        };
        let error =
            decode_native(&mut Reader::with_limits(&bytes, limits), &layout, "Values").unwrap_err();
        assert!(
            matches!(error, NativeError::Archive(error) if error.kind() == ArchiveErrorKind::AllocationLimit)
        );
    }

    #[test]
    fn rejects_invalid_layouts_before_consuming_bytes() {
        let mut deep = NativeLayout::UInt8;
        for _ in 0..34 {
            deep = NativeLayout::array(deep);
        }
        for layout in [
            deep,
            NativeLayout::SizedArray {
                stride: 4,
                element: Box::new(NativeLayout::String),
            },
            NativeLayout::SizedArray {
                stride: 8,
                element: Box::new(NativeLayout::Int32),
            },
            NativeLayout::Padding { bytes: 0 },
            NativeLayout::record([
                ("value", NativeLayout::UInt8),
                ("value", NativeLayout::UInt8),
            ]),
        ] {
            let mut reader = Reader::new(&[0; 100]);
            assert!(matches!(
                decode_native(&mut reader, &layout, "Value"),
                Err(NativeError::Layout(_))
            ));
            assert_eq!(reader.tell(), 0);
        }
    }
}
