//! Reuse tag metadata only after matching the next stream's serialized headers.
use std::fmt;
use std::ops::Range;

use super::{
    PropertyStream, PropertyTagFlags, PropertyTypeName, PropertyValue, RawReason,
    TAG_FLAG_BOOL_TRUE,
};
use crate::archive::{Reader, Span};
use crate::version::VersionContext;

// This bounds optional acceleration metadata, never which streams the parser accepts.
const MAX_HEADER_BYTES: usize = 16 * 1024;

struct Tag<'a> {
    range: Range<usize>,
    expected: &'a [u8],
    flags_offset: usize,
}

pub(crate) struct TaggedStreamReplay<'a> {
    start: u64,
    bytes: &'a [u8],
    tags: Vec<Tag<'a>>,
    terminator: Range<usize>,
    prefix_len: usize,
    stream: PropertyStream,
}

impl<'a> TaggedStreamReplay<'a> {
    /// Capture an undecoded, successfully parsed struct/row stream. Its package, names and
    /// version must stay borrowed for the replay's lifetime; values are decoded on every use.
    pub(crate) fn new(
        source: &'a [u8],
        start: u64,
        versions: &VersionContext,
        stream: &PropertyStream,
    ) -> Option<Self> {
        if versions.uses_legacy_property_tags() || stream.records.len() > MAX_HEADER_BYTES / 12 {
            return None;
        }
        let bytes = source
            .get(usize::try_from(start).ok()?..usize::try_from(stream.terminator.end()).ok()?)?;
        let relative = |offset: u64| usize::try_from(offset.checked_sub(start)?).ok();
        let terminator = relative(stream.terminator.offset())?..bytes.len();
        let prefix_len = stream.class_extensions.as_ref().map_or(0, |extensions| {
            1 + usize::from(extensions.overridable_operation.is_some())
        });
        let mut header_bytes = terminator.len().checked_add(prefix_len)?;
        let mut tags = Vec::with_capacity(stream.records.len());
        let mut position = prefix_len;
        for record in &stream.records {
            if !matches!(
                record.value,
                PropertyValue::Raw {
                    reason: RawReason::UnsupportedType
                }
            ) {
                return None;
            }
            let range = position..relative(record.payload.offset())?;
            let expected = bytes.get(range.clone())?;
            header_bytes = header_bytes.checked_add(expected.len())?;
            if header_bytes > MAX_HEADER_BYTES {
                return None;
            }
            // Name (8 bytes), complete type tree, payload size (4 bytes), then flags.
            let flags_offset = 12_usize.checked_add(type_bytes(&record.type_name)?)?;
            if *expected.get(flags_offset)? != record.flags.0 {
                return None;
            }
            tags.push(Tag {
                range,
                expected,
                flags_offset,
            });
            position = relative(record.payload.end())?;
        }
        if position != terminator.start {
            return None;
        }
        Some(Self {
            start,
            bytes,
            tags,
            terminator,
            prefix_len,
            stream: stream.clone(),
        })
    }

    /// A miss leaves the cursor untouched so the ordinary parser owns every diagnostic.
    pub(crate) fn try_read(
        &self,
        reader: &mut Reader<'_>,
        path: &(impl fmt::Display + ?Sized),
    ) -> Option<PropertyStream> {
        if u64::try_from(self.bytes.len()).ok()? > reader.remaining() {
            return None;
        }
        let start = reader.tell();
        let mut probe = reader.clone();
        let bytes = probe.read_bytes(self.bytes.len(), path).ok()?;
        if bytes.get(..self.prefix_len)? != self.bytes.get(..self.prefix_len)?
            || bytes.get(self.terminator.clone())? != self.bytes.get(self.terminator.clone())?
        {
            return None;
        }
        for tag in &self.tags {
            let actual = bytes.get(tag.range.clone())?;
            let flags = tag.flags_offset;
            // Bool values live in this flag, not in the payload. Other flag changes may
            // alter header shape and must return to the ordinary parser.
            if (*actual.get(flags)? ^ *tag.expected.get(flags)?) & !TAG_FLAG_BOOL_TRUE != 0
                || actual.get(..flags)? != tag.expected.get(..flags)?
                || actual.get(flags + 1..)? != tag.expected.get(flags + 1..)?
            {
                return None;
            }
        }
        let relocate = |span: Span| {
            Span::new(
                start.checked_add(span.offset().checked_sub(self.start)?)?,
                span.len(),
            )
            .ok()
        };
        let mut records = Vec::with_capacity(self.stream.records.len());
        for (record, tag) in self.stream.records.iter().zip(&self.tags) {
            records.push(super::PropertyRecord {
                name: record.name,
                type_name: record.type_name.clone(),
                array_index: record.array_index,
                flags: PropertyTagFlags(*bytes.get(tag.range.start + tag.flags_offset)?),
                property_guid: record.property_guid,
                struct_guid: record.struct_guid,
                extensions: record.extensions.clone(),
                payload: relocate(record.payload)?,
                value: PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                },
            });
        }
        let stream = PropertyStream {
            class_extensions: self.stream.class_extensions.clone(),
            records,
            terminator: relocate(self.stream.terminator)?,
        };
        *reader = probe;
        Some(stream)
    }
}

fn type_bytes(name: &PropertyTypeName) -> Option<usize> {
    name.parameters
        .iter()
        .try_fold(12_usize, |size, parameter| {
            size.checked_add(type_bytes(parameter)?)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::decode_property_stream_values;
    use crate::package::test_package;
    use crate::property::read_tagged_property_stream;
    use crate::test_support::{
        TypeParam, push_i32, ue5_versions, write_property_tag, write_property_terminator,
    };

    fn names() -> Vec<String> {
        [
            "None",
            "Count",
            "IntProperty",
            "Enabled",
            "BoolProperty",
            "Values",
            "ArrayProperty",
        ]
        .map(str::to_owned)
        .into()
    }

    fn row(count: i32, enabled: bool, values: &[i32]) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_property_tag(
            &mut bytes,
            1,
            &TypeParam {
                type_index: 2,
                parameters: Vec::new(),
            },
            0,
            &count.to_le_bytes(),
        );
        write_property_tag(
            &mut bytes,
            3,
            &TypeParam {
                type_index: 4,
                parameters: Vec::new(),
            },
            if enabled { TAG_FLAG_BOOL_TRUE } else { 0 },
            &[],
        );
        let mut payload = Vec::new();
        push_i32(&mut payload, i32::try_from(values.len()).unwrap());
        for value in values {
            push_i32(&mut payload, *value);
        }
        write_property_tag(
            &mut bytes,
            5,
            &TypeParam {
                type_index: 6,
                parameters: vec![TypeParam {
                    type_index: 2,
                    parameters: Vec::new(),
                }],
            },
            0,
            &payload,
        );
        write_property_terminator(&mut bytes, 0);
        bytes
    }

    #[test]
    fn replays_headers_but_reads_current_values_flags_and_absolute_spans() {
        let first = row(42, false, &[1, 2]);
        let second = row(7, true, &[-1, 99]);
        let third = row(9, false, &[3, 4, 5]);
        let bytes: Vec<_> = first.iter().chain(&second).chain(&third).copied().collect();
        let mut reader = Reader::new(&bytes);
        let first =
            read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Row").unwrap();
        let replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &first).unwrap();
        let mut normal = reader.clone();
        let mut expected =
            read_tagged_property_stream(&mut normal, &ue5_versions(), &names(), "Row").unwrap();
        let mut actual = replay.try_read(&mut reader, "Row").unwrap();
        assert_eq!(actual, expected);
        assert_eq!(reader.tell(), normal.tell());
        let package = test_package(names());
        decode_property_stream_values(&bytes, &mut actual, &package).unwrap();
        decode_property_stream_values(&bytes, &mut expected, &package).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(actual.records[0].value, PropertyValue::Int(7));
        assert_eq!(actual.records[1].value, PropertyValue::Bool(true));
        assert_eq!(
            actual.records[2].value,
            PropertyValue::Array(vec![PropertyValue::Int(-1), PropertyValue::Int(99)])
        );

        let position = reader.tell();
        assert!(replay.try_read(&mut reader, "Row").is_none());
        assert_eq!(reader.tell(), position);
        assert!(read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Row").is_ok());
    }

    #[test]
    fn root_class_extensions_are_matched_and_relocated_with_the_stream() {
        use crate::property::read_uobject_tagged_property_stream;
        let mut first = vec![0];
        first.extend(row(42, false, &[1, 2]));
        let mut second = vec![0];
        second.extend(row(7, true, &[-1, 99]));
        let mut changed = vec![2, 1]; // Overridable serialization, operation 1.
        changed.extend(row(9, false, &[3, 4]));
        let bytes: Vec<_> = first
            .iter()
            .chain(&second)
            .chain(&changed)
            .copied()
            .collect();
        let mut reader = Reader::new(&bytes);
        let initial =
            read_uobject_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Object")
                .unwrap();
        let replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
        let mut normal = reader.clone();
        let expected =
            read_uobject_tagged_property_stream(&mut normal, &ue5_versions(), &names(), "Object")
                .unwrap();
        assert_eq!(replay.try_read(&mut reader, "Object").unwrap(), expected);
        assert_eq!(reader.tell(), normal.tell());
        let position = reader.tell();
        assert!(replay.try_read(&mut reader, "Object").is_none());
        assert_eq!(reader.tell(), position);
        let changed =
            read_uobject_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Object")
                .unwrap();
        assert_eq!(
            changed.class_extensions.unwrap().overridable_operation,
            Some(1)
        );
    }

    #[test]
    fn truncations_and_corruptions_match_the_ordinary_parser_and_cursor() {
        let first = row(42, false, &[1, 2]);
        let second = row(7, true, &[-1, 99]);
        let mut mutations: Vec<Vec<u8>> = (0..second.len())
            .map(|end| second[..end].to_vec())
            .collect();
        for offset in 0..second.len() {
            for mask in [1, 0x80, 0xff] {
                let mut bytes = second.clone();
                bytes[offset] ^= mask;
                mutations.push(bytes);
            }
        }
        for mutation in mutations {
            let bytes: Vec<_> = first.iter().chain(&mutation).copied().collect();
            let mut reader = Reader::new(&bytes);
            let initial =
                read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Row").unwrap();
            let replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
            let mut normal = reader.clone();
            let expected =
                read_tagged_property_stream(&mut normal, &ue5_versions(), &names(), "Row");
            let actual = match replay.try_read(&mut reader, "Row") {
                Some(stream) => Ok(stream),
                None => read_tagged_property_stream(&mut reader, &ue5_versions(), &names(), "Row"),
            };
            match (actual, expected) {
                (Ok(actual), Ok(expected)) => assert_eq!(actual, expected),
                (Err(actual), Err(expected)) => {
                    assert_eq!(format!("{actual:?}"), format!("{expected:?}"))
                }
                (actual, expected) => {
                    panic!("replay differs: actual={actual:?}, expected={expected:?}")
                }
            }
            assert_eq!(reader.tell(), normal.tell());
        }
    }

    #[test]
    fn replay_budget_does_not_limit_ordinary_streams() {
        let mut bytes = Vec::new();
        for value in 0_i32..700 {
            write_property_tag(
                &mut bytes,
                1,
                &TypeParam {
                    type_index: 2,
                    parameters: Vec::new(),
                },
                0,
                &value.to_le_bytes(),
            );
        }
        write_property_terminator(&mut bytes, 0);
        let stream =
            read_tagged_property_stream(&mut Reader::new(&bytes), &ue5_versions(), &names(), "Row")
                .unwrap();
        assert_eq!(stream.records.len(), 700);
        assert!(TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &stream).is_none());
    }
}
