use super::*;
use crate::localization::columns::LocalLayer;
use crate::localization::{Diagnostic, parse_bytes, parse_json};
use crate::snapshot::integers;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// A test entry in UTF-16 code units, so lone surrogates can be written.
#[derive(Clone)]
pub(crate) struct Sample {
    pub namespace: Vec<u16>,
    pub key: Vec<u16>,
    pub source_hash: u32,
    pub text: Vec<u16>,
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn sample(namespace: &str, key: &str, source_hash: u32, text: &[u16]) -> Sample {
    Sample {
        namespace: units(namespace),
        key: units(key),
        source_hash,
        text: text.to_vec(),
    }
}
fn samples() -> Vec<Sample> {
    vec![
        sample("ST_Hex", "kills", 0xdead_beef, &units("Jumlah Bunuh")),
        sample("ST_Hex", "alive", 1, &units("Waktu Hidup")),
        // Latin-1 is written one byte per character.
        sample("ST_Hex", "cafe", 2, &units("Caf\u{e9}")),
        sample(
            "",
            "Greeting",
            3,
            &units("\u{3053}\u{3093}\u{306b}\u{3061}\u{306f} \u{1f600}"),
        ),
        // A lone high surrogate, as Unreal's UTF-16 strings may hold.
        sample("Shared", "Lone", 4, &[0x41, 0xd800, 0x42]),
        sample("Shared", "Same", 5, &units("Jumlah Bunuh")),
        sample("Shared", "Empty", 6, &[]),
    ]
}

/// Writes the layouts `FTextLocalizationResource::SaveToArchive` produces (and version 0's).
pub(crate) fn encode(version: u8, entries: &[Sample]) -> Vec<u8> {
    let mut out = Vec::new();
    fn fstring(out: &mut Vec<u8>, value: &[u16]) {
        if value.is_empty() {
            out.extend_from_slice(&0i32.to_le_bytes());
        } else if value.iter().all(|unit| *unit <= 0xff) {
            out.extend_from_slice(&(value.len() as i32 + 1).to_le_bytes());
            out.extend(value.iter().map(|unit| *unit as u8));
            out.push(0);
        } else {
            out.extend_from_slice(&(-(value.len() as i32) - 1).to_le_bytes());
            out.extend(value.iter().flat_map(|unit| unit.to_le_bytes()));
            out.extend_from_slice(&[0, 0]);
        }
    }
    let mut texts = Vec::<Vec<u16>>::new();
    for entry in entries {
        if !texts.contains(&entry.text) {
            texts.push(entry.text.clone());
        }
    }
    let mut namespaces = Vec::<Vec<u16>>::new();
    for entry in entries {
        if !namespaces.contains(&entry.namespace) {
            namespaces.push(entry.namespace.clone());
        }
    }
    let mut offset_at = 0;
    if version >= 1 {
        out.extend_from_slice(&MAGIC);
        out.push(version);
        offset_at = out.len();
        out.extend_from_slice(&[0; 8]);
    }
    if version >= 2 {
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    }
    out.extend_from_slice(&(namespaces.len() as u32).to_le_bytes());
    for namespace in &namespaces {
        if version >= 2 {
            out.extend_from_slice(&0x1234u32.to_le_bytes());
        }
        fstring(&mut out, namespace);
        let keys = entries
            .iter()
            .filter(|entry| &entry.namespace == namespace)
            .collect::<Vec<_>>();
        out.extend_from_slice(&(keys.len() as u32).to_le_bytes());
        for entry in keys {
            if version >= 2 {
                out.extend_from_slice(&0x5678u32.to_le_bytes());
            }
            fstring(&mut out, &entry.key);
            out.extend_from_slice(&entry.source_hash.to_le_bytes());
            if version >= 1 {
                let index = texts.iter().position(|text| *text == entry.text);
                out.extend_from_slice(&(index.unwrap_or(0) as i32).to_le_bytes());
            } else {
                fstring(&mut out, &entry.text);
            }
        }
    }
    if version >= 1 {
        let offset = out.len() as i64;
        out[offset_at..offset_at + 8].copy_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(&(texts.len() as i32).to_le_bytes());
        for text in &texts {
            fstring(&mut out, text);
            if version >= 2 {
                let shared = entries.iter().filter(|entry| entry.text == *text).count();
                out.extend_from_slice(&(shared as i32).to_le_bytes());
            }
        }
    }
    out
}

fn view(units: &[u16]) -> String {
    Wtf8Buf::from_utf16(units).into_view()
}
fn parse(bytes: &[u8]) -> Parsed<Resource> {
    parse_locres(bytes, "Game.locres", &Limits::default())
}
fn code(result: Parsed<Resource>) -> String {
    result.map_or_else(|error| error.code, |_| "succeeded".into())
}
/// The resource's entries as `(namespace, key, source hash, text)` views.
fn rows(resource: &Resource) -> Vec<(String, String, u32, String)> {
    resource
        .entries
        .iter()
        .map(|entry| {
            (
                resource.namespaces[entry.namespace as usize].clone(),
                entry.key.clone(),
                entry.source_hash,
                resource.texts[entry.text as usize].clone(),
            )
        })
        .collect()
}

/// The strings of one layer domain, by ID.
fn strings(layer: &LocalLayer, domain: &str) -> Vec<String> {
    let mut values = Vec::new();
    for i in 0.. {
        let Some(column) = layer
            .columns
            .iter()
            .find(|column| column.entry.name == format!("{domain}.b{i}"))
        else {
            break;
        };
        let bytes = column.bytes.as_slice();
        let word = |at: usize| {
            u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]) as usize
        };
        let count = word(0);
        let data = 4 + (count + 1) * 4;
        for j in 0..count {
            let value = bytes[data + word(4 + j * 4)..data + word(8 + j * 4)].to_vec();
            values.push(Wtf8Buf::from_bytes(value).unwrap().into_view());
        }
    }
    values
}
fn column(layer: &LocalLayer, name: &str) -> Vec<u32> {
    let column = layer
        .columns
        .iter()
        .find(|column| column.entry.name == name)
        .unwrap_or_else(|| panic!("{name} absent"));
    integers(&column.bytes).unwrap()
}
fn meta(layer: &LocalLayer) -> serde_json::Value {
    let column = layer
        .columns
        .iter()
        .find(|column| column.entry.name == "file.meta")
        .unwrap();
    serde_json::from_slice(&column.bytes).unwrap()
}
/// The layer's rows as `(namespace, key, source hash, translation)`, sorted, with the source empty.
fn layer_rows(layer: &LocalLayer) -> Vec<(String, String, u32, String)> {
    let identity = strings(layer, "identity");
    let sources = strings(layer, "source");
    let translations = strings(layer, "translation");
    let options = column(layer, "entry.options");
    let source = column(layer, "entry.source");
    let translation = column(layer, "entry.translation");
    let hashes = column(layer, "entry.source-hash");
    let namespaces = column(layer, "entry.namespace");
    let keys = column(layer, "entry.key");
    assert_eq!(hashes.len(), keys.len());
    let mut rows = (0..keys.len())
        .map(|row| {
            assert_eq!(sources[source[row] as usize], "");
            let text = if options[row] & 128 != 0 {
                sources[source[row] as usize].clone()
            } else {
                translations[translation[row] as usize].clone()
            };
            (
                identity[namespaces[row] as usize].clone(),
                identity[keys[row] as usize].clone(),
                hashes[row],
                text,
            )
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows
}
fn locres_options() -> Options {
    Options {
        format: Format::Locres,
        po_format: None,
        collapse_mode: None,
    }
}

fn workspace() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .unwrap()
}
fn find(root: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            find(&path, found);
        } else if path.extension().is_some_and(|e| e == "locres") {
            found.push(path);
        }
    }
}
/// A manifest or archive's rows by `(namespace, key)`: `(source, translation)`.
fn json_rows(path: &Path, format: Format) -> BTreeMap<(String, String), (String, String)> {
    let bytes = fs::read(path).unwrap();
    let text = match bytes.strip_prefix(&[0xff, 0xfe]) {
        Some(rest) => String::from_utf16(
            &rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_le_bytes(*pair))
                .collect::<Vec<_>>(),
        )
        .unwrap(),
        None => String::from_utf8(bytes).unwrap(),
    };
    let document = parse_json(&text, "fixture", format, &Limits::default()).unwrap();
    document
        .rows
        .into_iter()
        .map(|row| {
            (
                (row.namespace, row.key),
                (
                    row.source.text,
                    row.translation.map(|text| text.text).unwrap_or_default(),
                ),
            )
        })
        .collect()
}

#[test]
fn every_fixture_resource_follows_unreals_compile_rule_and_hashes_its_manifest_source() {
    let mut paths = Vec::new();
    find(&workspace().join("fixtures"), &mut paths);
    assert!(paths.len() >= 13, "fixture resources: {paths:?}");
    let mut entries = 0;
    for path in paths {
        let name = path.display().to_string();
        let resource = parse(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(resource.version, 3, "{name}");
        assert!(source_hash_verified(resource.version));
        let culture = path.parent().unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        let manifest = json_rows(
            &culture.parent().unwrap().join(format!("{stem}.manifest")),
            Format::Manifest,
        );
        let archive = json_rows(&culture.join(format!("{stem}.archive")), Format::Archive);
        // 4.27 leaves untranslated entries out, so only the native culture is never empty.
        if culture.ends_with("en") {
            assert!(!resource.entries.is_empty(), "{name}");
        }
        for (namespace, key, hash, text) in rows(&resource) {
            let id = (namespace, key);
            let (source, _) = manifest
                .get(&id)
                .unwrap_or_else(|| panic!("{name}: {id:?} is not in the manifest"));
            // Unreal compiles a translation only when it was made from the current source and is
            // not empty; otherwise the resource holds the source itself.
            let expected = match archive.get(&id) {
                Some((archived, translation)) if archived == source && !translation.is_empty() => {
                    translation
                }
                _ => source,
            };
            assert_eq!(&text, expected, "{name}: {id:?}");
            assert_eq!(
                hash,
                source_hash_of_view(source),
                "{name}: {id:?} source hash"
            );
            entries += 1;
        }
        // The layer holds the same rows, with each source hash on its own row.
        let layer = parse_bytes(
            &fs::read(&path).unwrap(),
            "fixture",
            &locres_options(),
            &Limits::default(),
        )
        .unwrap();
        let mut expected = rows(&resource);
        expected.sort();
        assert_eq!(layer_rows(&layer), expected, "{name}");
        let meta = meta(&layer);
        assert_eq!(meta["format"], "locres");
        assert_eq!(meta["hasSourceText"], false);
        assert_eq!(meta["locresVersion"], 3);
        assert_eq!(meta["sourceHashVerified"], true);
        assert_eq!(meta["count"], resource.entries.len());
    }
    assert!(entries > 100, "{entries} fixture entries");
}

#[test]
fn the_source_hash_is_crc32_over_four_byte_units_and_stops_at_nul() {
    assert_eq!(source_hash(&[]), 0);
    // CRC-32 of "a\0\0\0", the four-byte TCHAR spelling of "a".
    assert_eq!(source_hash(&units("a")), crc32fast::hash(b"a\0\0\0"));
    assert_eq!(source_hash(&units("ab\0cd")), source_hash(&units("ab")));
    // Lone surrogates and pairs hash as their code units.
    assert_eq!(
        source_hash_of_view(&view(&[0xd800])),
        crc32fast::hash(&[0x00, 0xd8, 0, 0])
    );
    assert_eq!(
        source_hash_of_view("\u{1f600}"),
        crc32fast::hash(&[0x3d, 0xd8, 0, 0, 0x00, 0xde, 0, 0])
    );
    assert!(!source_hash_verified(0) && !source_hash_verified(1) && !source_hash_verified(2));
}

#[test]
fn every_version_round_trips_ansi_utf16_lone_surrogates_and_shared_strings() {
    let samples = samples();
    let expected = samples
        .iter()
        .map(|entry| {
            (
                view(&entry.namespace),
                view(&entry.key),
                entry.source_hash,
                view(&entry.text),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        Wtf8Buf::from_view(&expected[4].3).to_utf16(),
        [0x41, 0xd800, 0x42]
    );
    for version in 0..=3 {
        let bytes = encode(version, &samples);
        let resource = parse(&bytes).unwrap();
        assert_eq!(resource.version, version);
        assert_eq!(rows(&resource), expected, "version {version}");
        if version >= 1 {
            // "Jumlah Bunuh" is stored once and both entries name it.
            assert_eq!(resource.texts.len(), samples.len() - 1);
            assert_eq!(resource.entries[0].text, resource.entries[5].text);
        } else {
            assert_eq!(resource.texts.len(), samples.len());
        }
        let layer = parse_bytes(&bytes, "x", &locres_options(), &Limits::default()).unwrap();
        let mut sorted = expected.clone();
        sorted.sort();
        assert_eq!(layer_rows(&layer), sorted, "version {version}");
        assert_eq!(meta(&layer)["sourceHashVerified"], version == 3);
    }
}

#[test]
fn an_empty_resource_has_no_entries() {
    for version in 0..=3 {
        let resource = parse(&encode(version, &[])).unwrap();
        assert_eq!(resource.version, version);
        assert!(resource.entries.is_empty());
        let layer = parse_bytes(
            &encode(version, &[]),
            "x",
            &locres_options(),
            &Limits::default(),
        )
        .unwrap();
        assert_eq!(meta(&layer)["count"], 0);
    }
    // A compact resource without a string table, as Unreal writes no table for no texts.
    let mut bytes = MAGIC.to_vec();
    bytes.push(1);
    bytes.extend_from_slice(&(-1i64).to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    assert!(parse(&bytes).unwrap().entries.is_empty());
}

#[test]
fn every_truncation_and_trailing_byte_is_malformed() {
    for version in 0..=3 {
        let bytes = encode(version, &samples());
        for length in 0..bytes.len() {
            assert_eq!(
                code(parse(&bytes[..length])),
                "malformed_locres",
                "version {version}, {length} of {} bytes",
                bytes.len()
            );
        }
        let mut padded = bytes.clone();
        padded.push(0);
        assert_eq!(code(parse(&padded)), "malformed_locres");
    }
    // Bytes between the namespaces and the string table are not accounted for.
    let bytes = encode(1, &samples());
    let offset = i64::from_le_bytes(bytes[17..25].try_into().unwrap()) as usize;
    let mut gap = bytes[..offset].to_vec();
    gap.push(0);
    gap.extend_from_slice(&bytes[offset..]);
    gap[17..25].copy_from_slice(&(offset as i64 + 1).to_le_bytes());
    assert_eq!(code(parse(&gap)), "malformed_locres");
    // A string without its terminator.
    let mut unterminated = encode(0, &[sample("N", "K", 0, &units("text"))]);
    let last = unterminated.len() - 1;
    unterminated[last] = b'!';
    assert_eq!(code(parse(&unterminated)), "malformed_locres");
}

#[test]
fn a_newer_version_is_unsupported() {
    let mut bytes = encode(3, &samples());
    bytes[16] = 4;
    let error = parse(&bytes).unwrap_err();
    assert_eq!(error.code, "unsupported_version");
}

#[test]
fn a_namespace_and_key_appear_once() {
    let entry = sample("N", "K", 0, &units("a"));
    let again = sample("N", "K", 0, &units("b"));
    for version in 0..=3 {
        let error = parse(&encode(version, &[entry.clone(), again.clone()])).unwrap_err();
        assert_eq!(error.code, "malformed_locres");
        assert_eq!(
            error.recovery,
            "Recompile the localization target's resources in Unreal, then read the file again."
        );
    }
    // The same key in another namespace is a different entry.
    let other = sample("M", "K", 0, &units("b"));
    assert_eq!(parse(&encode(2, &[entry, other])).unwrap().entries.len(), 2);
}

#[test]
fn a_text_index_outside_the_string_table_is_malformed() {
    for version in 1..=3 {
        let bytes = encode(version, &[sample("N", "K", 0, &units("a"))]);
        let offset = i64::from_le_bytes(bytes[17..25].try_into().unwrap()) as usize;
        // The single entry's text index is the four bytes just before the string table.
        for index in [1i32, -1, i32::MAX] {
            let mut changed = bytes.clone();
            changed[offset - 4..offset].copy_from_slice(&index.to_le_bytes());
            assert_eq!(
                code(parse(&changed)),
                "malformed_locres",
                "{version} {index}"
            );
        }
        // No string table at all: the namespaces run to the end of the file.
        let mut tableless = bytes[..offset].to_vec();
        tableless[17..25].copy_from_slice(&(-1i64).to_le_bytes());
        assert_eq!(code(parse(&tableless)), "malformed_locres");
    }
    // A table offset inside the header or past the end.
    let bytes = encode(3, &samples());
    for offset in [0i64, 24, bytes.len() as i64 + 1, i64::MIN] {
        let mut changed = bytes.clone();
        changed[17..25].copy_from_slice(&offset.to_le_bytes());
        assert_eq!(code(parse(&changed)), "malformed_locres", "{offset}");
    }
}

#[test]
fn reader_limits_apply() {
    let bytes = encode(3, &samples());
    let check = |limits: Limits| -> Diagnostic { parse_locres(&bytes, "x", &limits).unwrap_err() };
    let defaults = Limits::default;
    for limits in [
        Limits {
            max_file_bytes: bytes.len() as u64 - 1,
            ..defaults()
        },
        Limits {
            max_entries: samples().len() - 1,
            ..defaults()
        },
        Limits {
            max_record_bytes: 2 * ("ST_Hex".len() + "kills".len() + "Jumlah Bunuh".len()) - 1,
            ..defaults()
        },
        Limits {
            max_identity_bytes: 256,
            ..defaults()
        },
    ] {
        assert_eq!(check(limits.clone()).code, "limit_exceeded", "{limits:?}");
    }
    // Exactly at each bound is allowed.
    let exact = Limits {
        max_file_bytes: bytes.len() as u64,
        max_entries: samples().len(),
        ..defaults()
    };
    assert!(parse_locres(&bytes, "x", &exact).is_ok());
    // A count larger than the file can hold is malformed, not a limit.
    let mut huge = MAGIC.to_vec();
    huge.push(3);
    huge.extend_from_slice(&(-1i64).to_le_bytes());
    huge.extend_from_slice(&0u32.to_le_bytes());
    huge.extend_from_slice(&u32::MAX.to_le_bytes());
    assert_eq!(code(parse(&huge)), "malformed_locres");
}
