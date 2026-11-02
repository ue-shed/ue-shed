//! Bounded retries for saved named/ordered formats with locale-independent text arguments.
use super::*;
use crate::property::{NamedTextFormatArgument, TextFormatArgumentValue};
use std::cell::Cell;
use std::collections::BTreeSet;

pub(super) fn retry_record(
    source: &[u8],
    record: &PropertyRecord,
    package: &Package,
    scope: DecodeScope<'_>,
) -> Option<PropertyValue> {
    let name = package.resolve_name_str(record.type_name.name)?;
    if !matches!(
        name,
        "TextProperty" | "ArrayProperty" | "SetProperty" | "MapProperty"
    ) {
        return None;
    }
    let mut reader = Reader::new(source)
        .bounded(record.payload, "TextFormatProbe")
        .ok()?;
    let budget = Cell::new(crate::archive::ArchiveLimits::default().max_allocation_bytes);
    let value = decode_typed_value(
        source,
        TypeSpec {
            name,
            tree: &record.type_name,
            struct_guid: record.struct_guid,
        },
        record.flags,
        &mut reader,
        package,
        &PropertyPath {
            package,
            name: record.name,
        },
        DecodeScope {
            depth: scope.depth,
            filter: scope.filter,
            formatted_text_budget: Some(&budget),
        },
    )
    .ok()??;
    (reader.remaining() == 0).then_some(value)
}

pub(super) fn read_text(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    budget: &Cell<usize>,
) -> Option<TextValue> {
    if depth >= crate::asset::MAX_TEXT_HISTORY_DEPTH {
        return None;
    }
    let mut probe = reader.clone();
    probe.read_i32(path).ok()?; // FText flags.
    let kind = probe.read_i8(path).ok()?;
    if !matches!(kind, 1 | 2) {
        return decode_text_value(reader, package, path).ok()?;
    }
    // TextHistory.cpp (UE4.27/5.7/5.8): FormatText then native argument map/array.
    // TMap's native serializer uses one TSparseArray count, not property delta framing.
    // FTextHistory_Generated::Serialize in UE5 contributes no bytes.
    let format = Box::new(read_text(&mut probe, package, path, depth + 1, budget)?);
    if matches!(format.history, TextHistory::StringTableEntry { .. }) {
        return None;
    }
    let count = probe.read_count(path).ok()?;
    let value = if kind == 1 {
        let capacity = probe
            .checked_vec_capacity::<NamedTextFormatArgument>(count, 10, path)
            .ok()?;
        let mut arguments = Vec::with_capacity(capacity);
        let mut names = BTreeSet::new();
        for _ in 0..count {
            let name = probe.read_fstring(path).ok()?;
            if !names.insert(name.clone()) {
                return None;
            }
            let value = argument(&mut probe, package, path, depth + 1, budget)?;
            arguments.push(NamedTextFormatArgument { name, value });
        }
        let source = render(
            &format.source,
            |name| match &arguments.iter().find(|arg| arg.name == name)?.value {
                TextFormatArgumentValue::Text(text) => Some(text.as_ref()),
                _ => None,
            },
            budget,
        )?;
        TextValue {
            source,
            history: TextHistory::NamedFormat { format, arguments },
        }
    } else {
        let capacity = probe
            .checked_vec_capacity::<TextFormatArgumentValue>(count, 6, path)
            .ok()?;
        let mut arguments = Vec::with_capacity(capacity);
        for _ in 0..count {
            arguments.push(argument(&mut probe, package, path, depth + 1, budget)?);
        }
        let source = render(
            &format.source,
            |name| {
                if name.is_empty()
                    || (name.len() > 1 && name.starts_with('0'))
                    || !name.bytes().all(|byte| byte.is_ascii_digit())
                {
                    return None;
                }
                match arguments.get(name.parse::<usize>().ok()?)? {
                    TextFormatArgumentValue::Text(text) => Some(text.as_ref()),
                    _ => None,
                }
            },
            budget,
        )?;
        TextValue {
            source,
            history: TextHistory::OrderedFormat { format, arguments },
        }
    };
    *reader = probe;
    Some(value)
}

fn argument(
    reader: &mut Reader<'_>,
    package: &Package,
    path: &str,
    depth: usize,
    budget: &Cell<usize>,
) -> Option<TextFormatArgumentValue> {
    // Text.cpp FFormatArgumentValue::ToFormattedString uses the current locale
    // for numeric arguments. Preserve those histories raw rather than inventing a locale.
    if reader.read_i8(path).ok()? != 4 {
        return None;
    }
    Some(TextFormatArgumentValue::Text(Box::new(read_text(
        reader, package, path, depth, budget,
    )?)))
}

fn append(output: &mut String, value: &str, budget: &Cell<usize>) -> Option<()> {
    let remaining = budget.get().checked_sub(value.len())?;
    output.try_reserve(value.len()).ok()?;
    output.push_str(value);
    budget.set(remaining);
    Some(())
}

fn render<'a>(
    format: &str,
    lookup: impl Fn(&str) -> Option<&'a TextValue>,
    budget: &Cell<usize>,
) -> Option<String> {
    // UE4.27/5.7/5.8 TextFormatter.cpp: a pipe only begins a modifier at a token
    // boundary and before an identifier followed by '('. Pipes in category paths
    // such as "{0}|{1}" are literal text. Never evaluate locale-dependent modifiers.
    let mut output = String::new();
    let mut tail = format;
    while !tail.is_empty() {
        if let Some(rest) = tail.strip_prefix('`') {
            let escaped = rest.chars().next()?;
            if !matches!(escaped, '`' | '{' | '}' | '|') {
                return None;
            }
            append(&mut output, &rest[..escaped.len_utf8()], budget)?;
            tail = &rest[escaped.len_utf8()..];
        } else if let Some(argument) = tail.strip_prefix('{') {
            let end = argument.find('}')?;
            let name = &argument[..end];
            if name.is_empty() || name.contains(['{', '`']) {
                return None;
            }
            let text = lookup(name)?;
            if matches!(text.history, TextHistory::StringTableEntry { .. }) {
                return None;
            }
            // Braces and pipes in replacement text are never a new format program.
            append(&mut output, &text.source, budget)?;
            tail = &argument[end + 1..];
        } else {
            if let Some(modifier) = tail.strip_prefix('|')
                && modifier
                    .find(|c: char| c != '_' && !c.is_alphanumeric())
                    .is_some_and(|end| end > 0 && modifier[end..].starts_with('('))
            {
                return None;
            }
            let end = tail.find(['{', '`']).unwrap_or(tail.len());
            let literal = &tail[..end];
            if literal.contains('}') {
                return None;
            }
            append(&mut output, literal, budget)?;
            tail = &tail[end..];
        }
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::Span;
    use crate::package::test_package;
    use crate::test_support::{editor_text_version, name_ref, push_fstring, push_i32};

    fn package(version: i32) -> Package {
        let mut package = test_package(
            [
                "None",
                "Value",
                "TextProperty",
                "ArrayProperty",
                "MapProperty",
                "StrProperty",
                "IntProperty",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        package.summary.versions.ue5 = version;
        package
    }

    fn base(source: &str) -> Vec<u8> {
        let mut bytes = vec![0; 5];
        for value in ["Fixture", "SyntheticKey", source] {
            push_fstring(&mut bytes, value);
        }
        bytes
    }

    fn format(kind: i8, template: &str, arguments: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = vec![0; 4];
        bytes.push(kind as u8);
        bytes.extend_from_slice(&base(template));
        push_i32(&mut bytes, i32::try_from(arguments.len()).unwrap());
        for (name, text) in arguments {
            if kind == 1 {
                push_fstring(&mut bytes, name);
            }
            bytes.push(4);
            bytes.extend_from_slice(text);
        }
        bytes
    }

    fn record(bytes: &[u8], kind: i32, parameters: &[i32]) -> PropertyRecord {
        PropertyRecord {
            name: name_ref(1, 0),
            type_name: PropertyTypeName {
                name: name_ref(kind, 0),
                parameters: parameters
                    .iter()
                    .map(|index| PropertyTypeName {
                        name: name_ref(*index, 0),
                        parameters: vec![],
                    })
                    .collect(),
            },
            array_index: 0,
            flags: PropertyTagFlags::default(),
            property_guid: None,
            struct_guid: None,
            extensions: None,
            payload: Span::new(0, bytes.len() as u64).unwrap(),
            value: PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
        }
    }

    fn decode(bytes: &[u8], kind: i32, parameters: &[i32], package: &Package) -> PropertyValue {
        let mut record = record(bytes, kind, parameters);
        decode_property_record(bytes, &mut record, package, DecodeScope::root(None)).unwrap();
        record.value
    }

    #[test]
    fn named_and_ordered_formats_preserve_their_typed_history_and_render_text_once() {
        for version in [0, 1017, 1018] {
            let package = package(version);
            for kind in [1, 2] {
                let (template, names) = if kind == 1 {
                    ("<{A}> {B}", ["A", "B"])
                } else {
                    ("<{0}> {1}", ["0", "1"])
                };
                let bytes = format(
                    kind,
                    template,
                    &[(names[0], base("{B}")), (names[1], base("second"))],
                );
                let PropertyValue::Text(text) = decode(&bytes, 2, &[], &package) else {
                    panic!("text");
                };
                assert_eq!(text.source, "<{B}> second");
                assert_eq!(text.dev_notes(), Some(""));
                match text.history {
                    TextHistory::NamedFormat { format, arguments } if kind == 1 => {
                        assert_eq!(format.source, template);
                        assert_eq!(arguments.len(), 2);
                    }
                    TextHistory::OrderedFormat { format, arguments } if kind == 2 => {
                        assert_eq!(format.source, template);
                        assert_eq!(arguments.len(), 2);
                    }
                    _ => panic!("history kind"),
                }
                for end in 5..bytes.len() {
                    assert_eq!(
                        decode(&bytes[..end], 2, &[], &package),
                        PropertyValue::Raw {
                            reason: RawReason::UnsupportedTextHistory(kind)
                        }
                    );
                }
                let mut trailing = bytes.clone();
                trailing.push(0);
                assert_eq!(
                    decode(&trailing, 2, &[], &package),
                    PropertyValue::Raw {
                        reason: RawReason::UnsupportedTextHistory(kind)
                    }
                );
            }
        }
    }

    #[test]
    fn complete_container_retry_handles_empty_argument_lists_and_preserves_later_failures() {
        let package = package(1018);
        let empty = format(2, "Literal", &[]);
        let mut array = vec![];
        push_i32(&mut array, 2);
        array.extend_from_slice(&empty);
        array.extend_from_slice(&base("Next"));
        let PropertyValue::Array(values) = decode(&array, 3, &[2], &package) else {
            panic!("array");
        };
        assert!(matches!(&values[0], PropertyValue::Text(text) if text.source == "Literal"));
        assert!(matches!(&values[1], PropertyValue::Text(text) if text.source == "Next"));
        let mut malformed = vec![];
        push_i32(&mut malformed, 2);
        malformed.extend_from_slice(&empty);
        malformed.extend_from_slice(&[0; 5]);
        push_i32(&mut malformed, i32::MAX);
        assert_eq!(
            decode(&malformed, 3, &[2], &package),
            PropertyValue::Raw {
                reason: RawReason::UnsupportedTextHistory(2)
            }
        );

        let mut map = vec![];
        push_i32(&mut map, 1);
        push_fstring(&mut map, "Removed");
        push_i32(&mut map, 2);
        for (key, value) in [("First", empty), ("Second", base("Tail"))] {
            push_fstring(&mut map, key);
            map.extend_from_slice(&value);
        }
        let PropertyValue::Map(entries) = decode(&map, 4, &[5, 2], &package) else {
            panic!("map");
        };
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].key, PropertyValue::String("Second".into()));
        assert!(matches!(&entries[1].value, PropertyValue::Text(text) if text.source == "Tail"));
    }

    #[test]
    fn none_history_culture_flag_is_versioned_inside_formatted_arguments() {
        for editor_version in [31, 32] {
            let mut package = package(0);
            editor_text_version(&mut package, Some(editor_version));
            let mut none = vec![0; 4];
            none.push(255);
            if editor_version >= 32 {
                push_i32(&mut none, 0);
            }
            let bytes = format(2, "A{0}B", &[("0", none)]);
            let PropertyValue::Text(text) = decode(&bytes, 2, &[], &package) else {
                panic!("text");
            };
            assert_eq!(text.source, "AB");
        }
    }

    #[test]
    fn locale_dependent_arguments_complex_grammar_unknown_keys_and_depth_remain_raw() {
        let package = package(1018);
        for template in [
            "{0}|plural(one=a,other=b)",
            "`x{0}",
            "{0}`",
            "{missing}",
            "{0",
            "0}",
        ] {
            let bytes = format(2, template, &[("0", base("value"))]);
            assert_eq!(
                decode(&bytes, 2, &[], &package),
                PropertyValue::Raw {
                    reason: RawReason::UnsupportedTextHistory(2)
                }
            );
        }
        for kind in [1, 2] {
            let mut bytes = format(kind, if kind == 1 { "{A}" } else { "{0}" }, &[]);
            bytes.truncate(bytes.len() - 4);
            push_i32(&mut bytes, 1);
            if kind == 1 {
                push_fstring(&mut bytes, "A");
            }
            bytes.push(0);
            bytes.extend_from_slice(&42_i64.to_le_bytes());
            assert_eq!(
                decode(&bytes, 2, &[], &package),
                PropertyValue::Raw {
                    reason: RawReason::UnsupportedTextHistory(kind)
                }
            );
        }
        let duplicate = format(1, "{A}", &[("A", base("first")), ("A", base("second"))]);
        assert_eq!(
            decode(&duplicate, 2, &[], &package),
            PropertyValue::Raw {
                reason: RawReason::UnsupportedTextHistory(1)
            }
        );
        let mut nested = base("Leaf");
        for _ in 0..crate::asset::MAX_TEXT_HISTORY_DEPTH {
            nested = format(2, "{0}", &[("0", nested)]);
        }
        assert_eq!(
            decode(&nested, 2, &[], &package),
            PropertyValue::Raw {
                reason: RawReason::UnsupportedTextHistory(2)
            }
        );
        let budget = Cell::new(4);
        assert!(render("12345", |_| None, &budget).is_none());
        let budget = Cell::new(8);
        assert_eq!(render("1234", |_| None, &budget), Some("1234".into()));
        assert!(render("12345", |_| None, &budget).is_none());
    }

    #[test]
    fn literal_pipes_and_default_escapes_follow_unreal_token_boundaries() {
        for version in [0, 1008, 1017, 1018] {
            let package = package(version);
            for (template, expected) in [
                ("{0}|{1}", "Left|Right"),
                ("{0}|Group|{1}", "Left|Group|Right"),
                ("`{literal`} `{0`} {0} `| ``", "{literal} {0} Left | `"),
                (
                    "Plain |plural(one=a,other=b) {0}",
                    "Plain |plural(one=a,other=b) Left",
                ),
                ("{0}|", "Left|"),
            ] {
                let bytes = format(2, template, &[("0", base("Left")), ("1", base("Right"))]);
                let PropertyValue::Text(text) = decode(&bytes, 2, &[], &package) else {
                    panic!("{template}")
                };
                assert_eq!(text.source, expected);
                for end in 5..bytes.len() {
                    assert!(matches!(
                        decode(&bytes[..end], 2, &[], &package),
                        PropertyValue::Raw { .. }
                    ));
                }
            }
            for template in [
                "{0}|plural(one=a,other=b)",
                "{0}|custom(x)",
                "|gender(a,b,c)",
            ] {
                assert!(matches!(
                    decode(
                        &format(2, template, &[("0", base("Left"))]),
                        2,
                        &[],
                        &package
                    ),
                    PropertyValue::Raw { .. }
                ));
            }
        }
    }
}
