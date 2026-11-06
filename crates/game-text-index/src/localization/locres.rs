//! Compiled localization resources (`.locres`, Unreal's `FTextLocalizationResource`).
//!
//! A `.locres` is what the game shows: per namespace and key, the display string and the hash of
//! the source text it was compiled from. Some projects keep no archives, so a culture's `.locres`
//! can be the only record of its translations. The reader follows
//! `FTextLocalizationResource::LoadFromArchive` (`TextLocalizationResource.cpp`) and accounts for
//! every byte: anything Unreal's loader would skip or tolerate silently is `malformed_locres`.
use super::json::JsonDocument;
use super::{Format, JsonRow, Limits, Options, Parsed, Text, columns, failure};
use crate::wtf8::Wtf8Buf;

/// `FTextLocalizationResourceVersion::LocResMagic` as serialized (`FGuid` of four little-endian
/// `uint32`s). Version 0 files have no magic.
pub const MAGIC: [u8; 16] = [
    0x0e, 0x14, 0x74, 0x75, 0x67, 0x4a, 0x03, 0xfc, 0x4a, 0x15, 0x90, 0x9d, 0xc3, 0x37, 0x7f, 0x1b,
];
/// `ELocResVersion::Latest`: 0 legacy, 1 compact, 2 CRC32 key hashes, 3 CityHash64 key hashes.
pub const LATEST_VERSION: u8 = 3;

/// One compiled entry. `namespace` and `text` index the resource's tables.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub namespace: u32,
    pub key: String,
    pub source_hash: u32,
    pub text: u32,
}
/// A decoded resource. Strings are the crate's reversible WTF-8 scalar views, so lone UTF-16
/// surrogates survive.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Resource {
    pub version: u8,
    pub namespaces: Vec<String>,
    /// The display strings: the string table for versions 1 and later, one per entry for 0.
    pub texts: Vec<String>,
    pub entries: Vec<Entry>,
}

/// The hash Unreal stores as an entry's `SourceStringHash`: `FTextLocalizationResource::HashString`,
/// which is `FCrc::StrCrc32<TCHAR>` with base 0. That is the standard CRC-32 (IEEE, reflected) over
/// each UTF-16 code unit widened to four little-endian bytes, stopping at the first NUL.
///
/// Verified for version 3 only: every entry of every Unreal-compiled fixture resource (UE 4.27 and
/// UE 5.x, see `locres_source_hash_matches_the_manifest_source`) carries this hash of its
/// manifest source. No Unreal-compiled resource of versions 0 to 2 is available, so for those the
/// stored hash is exposed but [`source_hash_verified`] is false.
pub fn source_hash(units: &[u16]) -> u32 {
    let mut hasher = crc32fast::Hasher::new();
    for unit in units.iter().take_while(|unit| **unit != 0) {
        let [low, high] = unit.to_le_bytes();
        hasher.update(&[low, high, 0, 0]);
    }
    hasher.finalize()
}
/// [`source_hash`] of a WTF-8 scalar view, as manifest and archive layers hold their text.
pub fn source_hash_of_view(view: &str) -> u32 {
    source_hash(&Wtf8Buf::from_view(view).to_utf16())
}
/// Whether [`source_hash`] was proven against Unreal-compiled resources of this version.
pub fn source_hash_verified(version: u8) -> bool {
    version == 3
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    /// Where the current section ends: the string table's start, or the end of the file.
    end: usize,
    file: &'a str,
}
/// One decoded FString and its length in UTF-16 code units.
struct Str {
    view: String,
    units: usize,
}
impl Reader<'_> {
    fn malformed(&self) -> super::Diagnostic {
        failure(
            self.file,
            "malformed_locres",
            &format!(" at byte offset {}", self.at),
        )
    }
    fn take(&mut self, size: usize) -> Parsed<&[u8]> {
        if size > self.end - self.at {
            return Err(self.malformed());
        }
        let start = self.at;
        self.at += size;
        Ok(&self.bytes[start..self.at])
    }
    fn u32(&mut self) -> Parsed<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
    fn i32(&mut self) -> Parsed<i32> {
        self.u32().map(|value| value as i32)
    }
    fn i64(&mut self) -> Parsed<i64> {
        let bytes = self.take(8)?;
        let mut value = [0; 8];
        value.copy_from_slice(bytes);
        Ok(i64::from_le_bytes(value))
    }
    /// A count of items at least `minimum` bytes each: more than the section can hold is
    /// malformed, more than the reader allows is a limit.
    fn count(&mut self, value: u64, minimum: usize, limit: usize) -> Parsed<usize> {
        if value > ((self.end - self.at) / minimum) as u64 {
            return Err(self.malformed());
        }
        let value = value as usize;
        if value > limit {
            return Err(failure(self.file, "limit_exceeded", ""));
        }
        Ok(value)
    }
    /// `FString` serialization: a positive length is one byte per character (Latin-1), a negative
    /// one UTF-16LE; both count and include a NUL terminator. Zero is the empty string.
    fn string(&mut self) -> Parsed<Str> {
        let length = self.i32()?;
        if length == 0 {
            return Ok(Str {
                view: String::new(),
                units: 0,
            });
        }
        if length > 0 {
            let data = self.take(length as usize)?;
            let (text, terminator) = data.split_at(data.len() - 1);
            if terminator != [0] {
                return Err(self.malformed());
            }
            // Latin-1 scalars are U+0000..U+00FF: never the reserved view range.
            return Ok(Str {
                view: text.iter().map(|byte| char::from(*byte)).collect(),
                units: text.len(),
            });
        }
        let units = length.checked_neg().ok_or_else(|| self.malformed())? as usize;
        let data = self.take(units.checked_mul(2).ok_or_else(|| self.malformed())?)?;
        let (text, terminator) = data.split_at(data.len() - 2);
        if terminator != [0, 0] {
            return Err(self.malformed());
        }
        let units = text
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        Ok(Str {
            view: Wtf8Buf::from_utf16(&units).into_view(),
            units: units.len(),
        })
    }
}

/// Decodes a compiled `.locres`, versions 0 to 3. Namespace and key hashes are skipped; texts
/// resolve through the string table. Every byte is accounted for: the namespaces end exactly where
/// the string table starts, and the table ends at the end of the file. A namespace/key pair may
/// appear once, and every text index must name a table string.
pub fn parse_locres(bytes: &[u8], file: &str, limits: &Limits) -> Parsed<Resource> {
    if bytes.len() as u64 > limits.max_file_bytes {
        return Err(failure(file, "limit_exceeded", ""));
    }
    let mut reader = Reader {
        bytes,
        at: 0,
        end: bytes.len(),
        file,
    };
    // LoadFromArchive: no magic (including files shorter than it) means a legacy resource.
    let mut version = 0;
    if bytes.starts_with(&MAGIC) {
        reader.at = MAGIC.len();
        version = reader.take(1)?[0];
        if version > LATEST_VERSION {
            return Err(failure(file, "unsupported_version", ""));
        }
    }
    let mut resource = Resource {
        version,
        ..Resource::default()
    };
    let mut units = Vec::<usize>::new();
    let mut identity_bytes = 0usize;
    let mut identity = |view: &str, units: usize| -> Parsed<()> {
        identity_bytes = identity_bytes.saturating_add(view.len() + 128 + units * 2);
        if identity_bytes > limits.max_identity_bytes {
            return Err(failure(file, "limit_exceeded", ""));
        }
        Ok(())
    };
    let mut table = false;
    if version >= 1 {
        let offset = reader.i64()?;
        let header_end = reader.at;
        if offset != -1 {
            if offset < header_end as i64 || offset > bytes.len() as i64 {
                return Err(reader.malformed());
            }
            reader.at = offset as usize;
            let raw = reader.i32()?;
            if raw < 0 {
                return Err(reader.malformed());
            }
            let minimum = if version >= 2 { 8 } else { 4 };
            let count = reader.count(raw as u64, minimum, limits.max_entries)?;
            resource.texts.reserve(count);
            units.reserve(count);
            for _ in 0..count {
                let text = reader.string()?;
                if version >= 2 {
                    // How many entries share this string; Unreal only uses it to free strings.
                    reader.i32()?;
                }
                resource.texts.push(text.view);
                units.push(text.units);
            }
            if reader.at != bytes.len() {
                return Err(reader.malformed());
            }
            table = true;
            reader.end = offset as usize;
        }
        reader.at = header_end;
    }
    if version >= 2 {
        // The total entry count, which Unreal only uses to reserve its map.
        reader.u32()?;
    }
    let hashes = if version >= 2 { 4 } else { 0 };
    let raw = u64::from(reader.u32()?);
    let namespaces = reader.count(raw, hashes + 8, limits.max_entries)?;
    resource.namespaces.reserve(namespaces);
    for _ in 0..namespaces {
        reader.take(hashes)?;
        let namespace = reader.string()?;
        identity(&namespace.view, namespace.units)?;
        let raw = u64::from(reader.u32()?);
        let keys = reader.count(
            raw,
            hashes + 12,
            limits.max_entries - resource.entries.len(),
        )?;
        let index = resource.namespaces.len() as u32;
        resource.namespaces.push(namespace.view);
        resource.entries.reserve(keys);
        for _ in 0..keys {
            reader.take(hashes)?;
            let key = reader.string()?;
            identity(&key.view, key.units)?;
            let source_hash = reader.u32()?;
            let text = if version >= 1 {
                let text = reader.i32()?;
                if !table || text < 0 || text as usize >= resource.texts.len() {
                    return Err(reader.malformed());
                }
                text as u32
            } else {
                let text = reader.string()?;
                resource.texts.push(text.view);
                units.push(text.units);
                (resource.texts.len() - 1) as u32
            };
            let record = namespace.units + key.units + units[text as usize];
            if record.saturating_mul(2) > limits.max_record_bytes {
                return Err(failure(file, "limit_exceeded", ""));
            }
            resource.entries.push(Entry {
                namespace: index,
                key: key.view,
                source_hash,
                text,
            });
        }
    }
    if reader.at != reader.end {
        return Err(reader.malformed());
    }
    // Unreal keeps one entry per namespace and key; a second one is not a resource it wrote.
    let mut order = (0..resource.entries.len()).collect::<Vec<_>>();
    let name = |row: usize| {
        let entry = &resource.entries[row];
        (&resource.namespaces[entry.namespace as usize], &entry.key)
    };
    order.sort_unstable_by(|a, z| name(*a).cmp(&name(*z)));
    if order.windows(2).any(|pair| name(pair[0]) == name(pair[1])) {
        return Err(failure(file, "malformed_locres", ""));
    }
    Ok(resource)
}

/// A resource as a culture layer, shaped like an archive's: namespace, key and the display string
/// as the translation, with no source text, plus each entry's source hash (`entry.source-hash`).
pub(super) fn layer(
    bytes: &[u8],
    file: &str,
    options: &Options,
    limits: &Limits,
) -> Parsed<columns::LocalLayer> {
    let _span = crate::scan_timings::Span::new("localization.parse_locres");
    debug_assert_eq!(options.format, Format::Locres);
    let resource = parse_locres(bytes, file, limits)?;
    let hashes = resource
        .entries
        .iter()
        .map(|entry| entry.source_hash)
        .collect::<Vec<_>>();
    let document = JsonDocument {
        rows: resource
            .entries
            .into_iter()
            .enumerate()
            .map(|(ordinal, entry)| JsonRow {
                ordinal,
                namespace: resource.namespaces[entry.namespace as usize].clone(),
                key: entry.key,
                source: Text {
                    text: String::new(),
                    extra: serde_json::Map::new(),
                },
                translation: Some(Text {
                    text: resource.texts[entry.text as usize].clone(),
                    extra: serde_json::Map::new(),
                }),
                path: None,
                optional: None,
                metadata: None,
                dev_notes: None,
            })
            .collect(),
        namespaces: resource.namespaces,
    };
    columns::build_locres(document, resource.version, &hashes, file, options, limits)
}

#[cfg(test)]
pub(crate) mod tests;
