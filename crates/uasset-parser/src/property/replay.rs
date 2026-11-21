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
    plan: crate::codec::ReplayDecodePlan,
}

pub(crate) struct TaggedStreamReplay<'a> {
    start: u64,
    bytes: &'a [u8],
    tags: Vec<Tag<'a>>,
    terminator: Range<usize>,
    prefix_len: usize,
    stream: PropertyStream,
    plan_package: Option<&'a crate::package::Package>,
    /// The host filter every replayed record is decoded under, fixed for the replay's life.
    plan_filter: Option<&'a dyn crate::asset::PropertyDecodeFilter>,
    plans_ready: bool,
    /// How many records were not declined by header-only filter plans (independent of omission).
    requested_count: usize,
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
                plan: crate::codec::ReplayDecodePlan::Ordinary,
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
            plan_package: None,
            plan_filter: None,
            plans_ready: false,
            requested_count: 0,
        })
    }

    /// Prepares semantic plans against `package`, for records decoded under `filter`. Every
    /// replayed record must be decoded with this same filter.
    pub(crate) fn with_decode_plans(
        mut self,
        package: &'a crate::package::Package,
        filter: Option<&'a dyn crate::asset::PropertyDecodeFilter>,
    ) -> Self {
        self.plan_package = Some(package);
        self.plan_filter = filter;
        self
    }

    // Cold, never-reused layouts do not need semantic plans. Plans are independent of whether
    // the current decode permits omitting declined records; callers pass `omit_unrequested`.
    fn prepare_plans(&mut self) {
        if !self.plans_ready {
            if let Some(package) = self.plan_package {
                for (tag, record) in self.tags.iter_mut().zip(&self.stream.records) {
                    tag.plan = crate::codec::ReplayDecodePlan::prepare_filtered(
                        package,
                        record,
                        self.plan_filter,
                    );
                }
            }
            self.requested_count = self
                .tags
                .iter()
                .filter(|tag| !matches!(tag.plan, crate::codec::ReplayDecodePlan::NotRequested))
                .count();
            self.plans_ready = true;
        }
    }

    /// A matched stream whose every record the filter declined and omits: its headers were all
    /// validated, and nothing is built or decoded for them.
    fn empty_stream(&self, terminator: Span) -> PropertyStream {
        PropertyStream {
            class_extensions: self.stream.class_extensions.clone(),
            records: Vec::new(),
            terminator,
        }
    }

    /// Whether a record with this plan is left out of replayed streams without being built.
    #[inline]
    fn omits(omit_unrequested: bool, plan: crate::codec::ReplayDecodePlan) -> bool {
        omit_unrequested && matches!(plan, crate::codec::ReplayDecodePlan::NotRequested)
    }

    /// A miss leaves the cursor untouched so the ordinary parser owns every diagnostic.
    #[cfg(test)]
    pub(crate) fn try_read(
        &mut self,
        reader: &mut Reader<'_>,
        path: &(impl fmt::Display + ?Sized),
    ) -> Option<PropertyStream> {
        self.try_read_with(reader, path, false, |_, _| {
            Ok::<(), super::PropertyError>(())
        })
        .and_then(Result::ok)
    }

    /// Check every header before invoking the decoder on each record in its final slot.
    pub(crate) fn try_read_with<E>(
        &mut self,
        reader: &mut Reader<'_>,
        path: &(impl fmt::Display + ?Sized),
        omit_unrequested: bool,
        mut decode: impl FnMut(
            &mut super::PropertyRecord,
            crate::codec::ReplayDecodePlan,
        ) -> Result<(), E>,
    ) -> Option<Result<PropertyStream, E>> {
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
            if flags == 24 && actual.len() == 25 {
                let word = |bytes: &[u8], offset| {
                    bytes
                        .get(offset..offset + 8)?
                        .try_into()
                        .ok()
                        .map(u64::from_ne_bytes)
                };
                let changed = (word(actual, 0)? ^ word(tag.expected, 0)?)
                    | (word(actual, 8)? ^ word(tag.expected, 8)?)
                    | (word(actual, 16)? ^ word(tag.expected, 16)?);
                if changed != 0 || (actual[24] ^ tag.expected[24]) & !TAG_FLAG_BOOL_TRUE != 0 {
                    return None;
                }
            } else if (*actual.get(flags)? ^ *tag.expected.get(flags)?) & !TAG_FLAG_BOOL_TRUE != 0
                || actual.get(..flags)? != tag.expected.get(..flags)?
                || actual.get(flags + 1..)? != tag.expected.get(flags + 1..)?
            {
                return None;
            }
        }
        self.prepare_plans();
        let relocate = |span: Span| {
            Span::new(
                start.checked_add(span.offset().checked_sub(self.start)?)?,
                span.len(),
            )
            .ok()
        };
        let terminator = relocate(self.stream.terminator)?;
        if omit_unrequested && self.requested_count == 0 {
            *reader = probe;
            return Some(Ok(self.empty_stream(terminator)));
        }
        let capacity = if omit_unrequested {
            self.requested_count
        } else {
            self.tags.len()
        };
        let mut records = Vec::with_capacity(capacity);
        for (record, tag) in self.stream.records.iter().zip(&self.tags) {
            // Declined headers were validated above; their records are never built when omitting.
            if Self::omits(omit_unrequested, tag.plan) {
                continue;
            }
            let record = super::PropertyRecord {
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
            };
            records.push(record);
            if let Some(record) = records.last_mut() {
                if let Err(error) = decode(record, tag.plan) {
                    *reader = probe;
                    return Some(Err(error));
                }
                if omit_unrequested && crate::codec::is_not_requested(record) {
                    records.pop();
                }
            }
        }
        let stream = PropertyStream {
            class_extensions: self.stream.class_extensions.clone(),
            records,
            terminator,
        };
        *reader = probe;
        Some(Ok(stream))
    }

    /// Validates an entire stream before values are decoded, allowing only payload size and
    /// bool value to vary. Every saved header, size and the terminator are checked before any
    /// record is built, so a miss allocates nothing and leaves the cursor untouched.
    ///
    /// On a match, returns the advanced reader and terminator span, with each record's current
    /// payload span and flags byte in `spans`.
    fn match_variable<'r>(
        &self,
        reader: &Reader<'r>,
        path: &(impl fmt::Display + ?Sized),
        spans: &mut [(Span, u8)],
    ) -> Option<(Reader<'r>, Span)> {
        let mut probe = reader.clone();
        let prefix = probe.read_bytes(self.prefix_len, path).ok()?;
        if prefix != self.bytes.get(..self.prefix_len)? {
            return None;
        }
        for (tag, slot) in self.tags.iter().zip(spans.iter_mut()) {
            let actual = probe.read_bytes(tag.expected.len(), path).ok()?;
            let flags = tag.flags_offset;
            let size_offset = flags.checked_sub(4)?;
            if actual.get(..size_offset)? != tag.expected.get(..size_offset)?
                || (*actual.get(flags)? ^ *tag.expected.get(flags)?) & !TAG_FLAG_BOOL_TRUE != 0
                || actual.get(flags + 1..)? != tag.expected.get(flags + 1..)?
            {
                return None;
            }
            let size = i32::from_le_bytes(actual.get(size_offset..flags)?.try_into().ok()?);
            let size = u64::try_from(size).ok()?;
            let payload = Span::new(probe.tell(), size).ok()?;
            probe.skip(size, path).ok()?;
            *slot = (payload, *actual.get(flags)?);
        }
        let start = probe.tell();
        let expected = self.bytes.get(self.terminator.clone())?;
        if probe.read_bytes(expected.len(), path).ok()? != expected {
            return None;
        }
        let terminator = Span::new(start, u64::try_from(expected.len()).ok()?).ok()?;
        Some((probe, terminator))
    }

    /// [`TaggedStreamReplay::try_read_variable_with`] without plans or decoding: every record
    /// keeps an undecoded value, as the ordinary reader returns it.
    #[cfg(test)]
    pub(crate) fn try_read_variable(
        &self,
        reader: &mut Reader<'_>,
        path: &(impl fmt::Display + ?Sized),
    ) -> Option<PropertyStream> {
        let mut spans = vec![(Span::default(), 0_u8); self.tags.len()];
        let (probe, terminator) = self.match_variable(reader, path, &mut spans)?;
        let records = self
            .stream
            .records
            .iter()
            .zip(&spans)
            .map(|(original, &(payload, flags))| super::PropertyRecord {
                name: original.name,
                type_name: original.type_name.clone(),
                array_index: original.array_index,
                flags: PropertyTagFlags(flags),
                property_guid: original.property_guid,
                struct_guid: original.struct_guid,
                extensions: original.extensions.clone(),
                payload,
                value: PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                },
            })
            .collect();
        *reader = probe;
        Some(PropertyStream {
            class_extensions: self.stream.class_extensions.clone(),
            records,
            terminator,
        })
    }

    /// Matches a stream with the same headers and other payload sizes, then decodes each kept
    /// record in its final slot. A miss allocates nothing and leaves the cursor untouched.
    pub(crate) fn try_read_variable_with<E>(
        &mut self,
        reader: &mut Reader<'_>,
        path: &(impl fmt::Display + ?Sized),
        omit_unrequested: bool,
        mut decode: impl FnMut(
            &mut super::PropertyRecord,
            crate::codec::ReplayDecodePlan,
        ) -> Result<(), E>,
    ) -> Option<Result<PropertyStream, E>> {
        // Small layouts, nearly all of them, keep their spans on the stack.
        const STACK_TAGS: usize = 64;
        let count = self.tags.len();
        let mut stack = [(Span::default(), 0_u8); STACK_TAGS];
        let mut heap = Vec::new();
        let spans: &mut [(Span, u8)] = if count <= STACK_TAGS {
            &mut stack[..count]
        } else {
            heap.resize(count, (Span::default(), 0_u8));
            &mut heap
        };
        let (probe, terminator) = self.match_variable(reader, path, spans)?;
        self.prepare_plans();
        if omit_unrequested && self.requested_count == 0 {
            *reader = probe;
            return Some(Ok(self.empty_stream(terminator)));
        }
        let capacity = if omit_unrequested {
            self.requested_count
        } else {
            self.tags.len()
        };
        let mut records = Vec::with_capacity(capacity);
        for ((original, tag), &(payload, flags)) in
            self.stream.records.iter().zip(&self.tags).zip(spans.iter())
        {
            if Self::omits(omit_unrequested, tag.plan) {
                continue;
            }
            records.push(super::PropertyRecord {
                name: original.name,
                type_name: original.type_name.clone(),
                array_index: original.array_index,
                flags: PropertyTagFlags(flags),
                property_guid: original.property_guid,
                struct_guid: original.struct_guid,
                extensions: original.extensions.clone(),
                payload,
                value: PropertyValue::Raw {
                    reason: RawReason::UnsupportedType,
                },
            });
            if let Some(record) = records.last_mut() {
                if let Err(error) = decode(record, tag.plan) {
                    *reader = probe;
                    return Some(Err(error));
                }
                if omit_unrequested && crate::codec::is_not_requested(record) {
                    records.pop();
                }
            }
        }
        *reader = probe;
        Some(Ok(PropertyStream {
            class_extensions: self.stream.class_extensions.clone(),
            records,
            terminator,
        }))
    }
}

/// Tries every replay's exact layout first, then every replay's variable-width layout, so a
/// later exact match is never shadowed by an earlier replay's costlier variable match.
/// Returns the matching replay's slot. A miss leaves the cursor untouched.
pub(crate) fn read_with_any<E>(
    replays: &mut [TaggedStreamReplay<'_>],
    reader: &mut Reader<'_>,
    path: &(impl fmt::Display + ?Sized),
    omit_unrequested: bool,
    decode: impl FnMut(&mut super::PropertyRecord, crate::codec::ReplayDecodePlan) -> Result<(), E>
    + Copy,
) -> Option<(usize, Result<PropertyStream, E>)> {
    for (slot, replay) in replays.iter_mut().enumerate() {
        if let Some(stream) = replay.try_read_with(reader, path, omit_unrequested, decode) {
            return Some((slot, stream));
        }
    }
    for (slot, replay) in replays.iter_mut().enumerate() {
        if let Some(stream) = replay.try_read_variable_with(reader, path, omit_unrequested, decode)
        {
            return Some((slot, stream));
        }
    }
    None
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

    pub(super) fn names() -> Vec<String> {
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

    pub(super) fn row(count: i32, enabled: bool, values: &[i32]) -> Vec<u8> {
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
        let mut replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &first).unwrap();
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
        let mut replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
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
            let mut replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
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

#[cfg(test)]
mod variable_replay_tests {
    use super::*;
    use crate::codec::decode_property_stream_values;
    use crate::package::test_package;
    use crate::property::read_tagged_property_stream;
    use crate::test_support::ue5_versions;

    #[test]
    fn variable_payloads_preserve_current_values_flags_metadata_spans_and_cursor() {
        let first = super::tests::row(42, false, &[1, 2]);
        let second = super::tests::row(7, true, &[-1, 99, 2, 3]);
        let third = super::tests::row(9, false, &[]);
        let bytes: Vec<_> = first.iter().chain(&second).chain(&third).copied().collect();
        let package = test_package(super::tests::names());
        let mut reader = Reader::new(&bytes);
        let initial =
            read_tagged_property_stream(&mut reader, &ue5_versions(), &package.names, "Row")
                .unwrap();
        let replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
        for _ in 0..2 {
            let mut normal = reader.clone();
            let mut expected =
                read_tagged_property_stream(&mut normal, &ue5_versions(), &package.names, "Row")
                    .unwrap();
            let mut actual = replay
                .try_read_variable(&mut reader, "Row")
                .expect("variable-width match");
            assert_eq!(actual, expected);
            assert_eq!(reader.tell(), normal.tell());
            decode_property_stream_values(&bytes, &mut actual, &package).unwrap();
            decode_property_stream_values(&bytes, &mut expected, &package).unwrap();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn variable_replay_mutations_match_full_parse_diagnostics_and_transactional_cursor() {
        let first = super::tests::row(42, false, &[1, 2]);
        let second = super::tests::row(7, true, &[-1, 99, 2, 3]);
        let mut mutations: Vec<Vec<u8>> = (0..=second.len())
            .map(|end| second[..end].to_vec())
            .collect();
        for offset in 0..second.len() {
            for mask in [1, 2, 4, 8, 16, 32, 64, 128, 255] {
                let mut bytes = second.clone();
                bytes[offset] ^= mask;
                mutations.push(bytes);
            }
        }
        let package = test_package(super::tests::names());
        for mutation in mutations {
            let bytes: Vec<_> = first.iter().chain(&mutation).copied().collect();
            let mut reader = Reader::new(&bytes);
            let initial =
                read_tagged_property_stream(&mut reader, &ue5_versions(), &package.names, "Row")
                    .unwrap();
            let replay = TaggedStreamReplay::new(&bytes, 0, &ue5_versions(), &initial).unwrap();
            let position = reader.tell();
            let mut normal = reader.clone();
            let mut expected =
                read_tagged_property_stream(&mut normal, &ue5_versions(), &package.names, "Row");
            let mut actual = match replay.try_read_variable(&mut reader, "Row") {
                Some(stream) => Ok(stream),
                None => {
                    assert_eq!(reader.tell(), position);
                    read_tagged_property_stream(&mut reader, &ue5_versions(), &package.names, "Row")
                }
            };
            assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
            assert_eq!(reader.tell(), normal.tell());
            if let (Ok(actual), Ok(expected)) = (&mut actual, &mut expected) {
                let a = decode_property_stream_values(&bytes, actual, &package);
                let b = decode_property_stream_values(&bytes, expected, &package);
                assert_eq!(format!("{a:?}|{actual:?}"), format!("{b:?}|{expected:?}"));
            }
        }
    }
}

#[cfg(test)]
mod transactional_replay_tests {
    use super::*;
    use crate::asset::PropertyDecodeFilter;
    use crate::codec::{DecodeScope, ReplayDecodePlan, decode_replayed_property_record};
    use crate::package::{Package, test_package};
    use crate::property::{PropertyError, PropertyRecord, read_tagged_property_stream};
    use crate::test_support::ue5_versions;

    fn learn<'a>(bytes: &'a [u8], start: u64) -> TaggedStreamReplay<'a> {
        let names = super::tests::names();
        let mut reader = Reader::new(bytes);
        reader.seek(start, "Row").unwrap();
        let stream =
            read_tagged_property_stream(&mut reader, &ue5_versions(), &names, "Row").unwrap();
        TaggedStreamReplay::new(bytes, start, &ue5_versions(), &stream).unwrap()
    }

    fn keep(_: &mut PropertyRecord, _: ReplayDecodePlan) -> Result<(), PropertyError> {
        Ok(())
    }

    #[test]
    fn variable_misses_leave_the_cursor_and_later_exact_layouts_win() {
        let short = super::tests::row(1, false, &[1]);
        let long = super::tests::row(2, true, &[1, 2, 3]);
        let target = super::tests::row(3, false, &[4, 5, 6]);
        let bytes: Vec<_> = short.iter().chain(&long).chain(&target).copied().collect();
        let mut replays = vec![learn(&bytes, 0), learn(&bytes, short.len() as u64)];
        let start = (short.len() + long.len()) as u64;

        // The first replay matches only by width; the second matches every byte.
        let mut reader = Reader::new(&bytes);
        reader.seek(start, "Row").unwrap();
        let (slot, stream) =
            read_with_any(&mut replays, &mut reader, "Row", false, keep).expect("a match");
        assert_eq!(slot, 1, "an exact layout is preferred over a variable one");
        assert_eq!(reader.tell(), bytes.len() as u64);
        let mut ordinary = Reader::new(&bytes);
        ordinary.seek(start, "Row").unwrap();
        let expected = read_tagged_property_stream(
            &mut ordinary,
            &ue5_versions(),
            &super::tests::names(),
            "Row",
        )
        .unwrap();
        assert_eq!(stream.unwrap(), expected);

        // Every truncation and corruption either matches the ordinary parse or misses without
        // moving the cursor.
        for end in start as usize..bytes.len() {
            for flip in [None, Some(end.saturating_sub(1))] {
                let mut mutated = bytes[..end].to_vec();
                if let Some(offset) = flip.filter(|offset| *offset >= start as usize) {
                    mutated[offset] ^= 0x5a;
                }
                let mut replay = learn(&bytes, 0);
                let mut reader = Reader::new(&mutated);
                reader.seek(start, "Row").unwrap();
                match replay.try_read_variable_with(&mut reader, "Row", false, keep) {
                    None => assert_eq!(reader.tell(), start),
                    Some(stream) => {
                        let mut ordinary = Reader::new(&mutated);
                        ordinary.seek(start, "Row").unwrap();
                        let expected = read_tagged_property_stream(
                            &mut ordinary,
                            &ue5_versions(),
                            &super::tests::names(),
                            "Row",
                        );
                        assert_eq!(
                            format!("{:?}", stream.unwrap()),
                            format!("{:?}", expected.unwrap())
                        );
                        assert_eq!(reader.tell(), ordinary.tell());
                    }
                }
            }
        }
    }

    /// Declines integers and arrays by header, optionally omitting them.
    struct DeclineCounts {
        omit: bool,
    }

    impl PropertyDecodeFilter for DeclineCounts {
        fn decode(&self, package: &Package, record: &PropertyRecord) -> bool {
            package.resolve_name_str(record.type_name.name) == Some("BoolProperty")
        }

        fn depends_only_on_record_header(&self) -> bool {
            true
        }

        fn omit_unrequested_records(&self) -> bool {
            self.omit
        }
    }

    #[test]
    fn omitting_replays_build_only_requested_records_on_exact_and_variable_matches() {
        let package = test_package(super::tests::names());
        let first = super::tests::row(1, false, &[1, 2]);
        let exact = super::tests::row(5, true, &[3, 4]);
        let variable = super::tests::row(6, false, &[7, 8, 9]);
        let bytes: Vec<_> = first
            .iter()
            .chain(&exact)
            .chain(&variable)
            .copied()
            .collect();
        for omit in [false, true] {
            let filter = DeclineCounts { omit };
            let mut replay = learn(&bytes, 0).with_decode_plans(&package, Some(&filter));
            let decode = |record: &mut PropertyRecord, plan| {
                decode_replayed_property_record(
                    &bytes,
                    record,
                    &package,
                    DecodeScope::root(Some(&filter)),
                    plan,
                )
            };
            let mut reader = Reader::new(&bytes);
            reader.seek(first.len() as u64, "Row").unwrap();
            let exact_stream = replay
                .try_read_with(&mut reader, "Row", omit, decode)
                .unwrap()
                .unwrap();
            let variable_stream = replay
                .try_read_variable_with(&mut reader, "Row", omit, decode)
                .unwrap()
                .unwrap();
            assert_eq!(reader.tell(), bytes.len() as u64);
            for (stream, flag) in [(exact_stream, true), (variable_stream, false)] {
                let names: Vec<_> = stream
                    .records
                    .iter()
                    .map(|record| package.resolve_name_str(record.name).unwrap())
                    .collect();
                if omit {
                    assert_eq!(names, ["Enabled"]);
                } else {
                    assert_eq!(names, ["Count", "Enabled", "Values"]);
                    assert!(crate::codec::is_not_requested(&stream.records[0]));
                }
                let enabled = stream
                    .records
                    .iter()
                    .find(|record| package.resolve_name_str(record.name) == Some("Enabled"))
                    .unwrap();
                assert_eq!(enabled.value, PropertyValue::Bool(flag));
            }
        }

        // Declining every record yields an empty, validated stream.
        struct DeclineAll;
        impl PropertyDecodeFilter for DeclineAll {
            fn decode(&self, _: &Package, _: &PropertyRecord) -> bool {
                false
            }
            fn depends_only_on_record_header(&self) -> bool {
                true
            }
            fn omit_unrequested_records(&self) -> bool {
                true
            }
        }
        let mut replay = learn(&bytes, 0).with_decode_plans(&package, Some(&DeclineAll));
        let mut reader = Reader::new(&bytes);
        reader.seek(first.len() as u64, "Row").unwrap();
        let stream = replay
            .try_read_with(&mut reader, "Row", true, keep)
            .unwrap()
            .unwrap();
        assert!(stream.records.is_empty());
        assert_eq!(stream.terminator.end(), (first.len() + exact.len()) as u64);
        let stream = replay
            .try_read_variable_with(&mut reader, "Row", true, keep)
            .unwrap()
            .unwrap();
        assert!(stream.records.is_empty());
        assert_eq!(stream.terminator.end(), bytes.len() as u64);
        // A corrupted terminator still misses.
        let mut corrupted = bytes.clone();
        let last = corrupted.len() - 8;
        corrupted[last] ^= 1;
        let mut reader = Reader::new(&corrupted);
        reader
            .seek((first.len() + exact.len()) as u64, "Row")
            .unwrap();
        assert!(
            replay
                .try_read_variable_with(&mut reader, "Row", true, keep)
                .is_none()
        );
        assert_eq!(reader.tell(), (first.len() + exact.len()) as u64);
    }
}
