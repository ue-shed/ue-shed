//! The localization at a point's base, as a file sorted by namespace and key.
//!
//! A review needs a few keys of a target's manifest and archives, which on a large project are
//! hundreds of megabytes. They are parsed once into a lookup kept under the files' revision names,
//! so every review between two gathers shares it and reads only the keys it names, by binary
//! search.
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::localization::{Format, Limits, parse_json};
use crate::package_text_contract::{BaseLocalization, LocalizationRevision};
use crate::store::{Configuration, digest};
use crate::{Result, require};

const MAGIC: &[u8; 8] = b"GTLOOK01";
/// Bumped when the lookup's format or what it keeps changes.
const VERSION: &str = "1";

/// One manifest context of a key: the text gathered there and where.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Context {
    pub source: String,
    pub path: String,
}

/// One culture's archive entry for a key: the translation and the source it was made for.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Translation {
    pub source: String,
    pub translation: String,
}

/// A key at the base: its manifest contexts, and per culture of the lookup its archive entry.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Entry {
    pub contexts: Vec<Context>,
    pub translations: Vec<Option<Translation>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    native_culture: String,
    cultures: Vec<String>,
}

pub(crate) struct Lookup {
    file: File,
    offsets: Vec<u64>,
    pub native_culture: String,
    pub cultures: Vec<String>,
}

/// The lookup for a base's files, built from them when no lookup has their revision names; the
/// flag says whether it was built now.
pub(crate) fn open_or_build(
    configuration: &Configuration,
    base: &BaseLocalization,
) -> Result<(Lookup, bool)> {
    let mut names = vec![
        VERSION.to_owned(),
        base.native_culture.clone(),
        base.manifest.revision.clone(),
    ];
    let mut archives = base
        .archives
        .iter()
        .map(|archive| format!("{}={}", archive.culture, archive.archive.revision))
        .collect::<Vec<_>>();
    archives.sort();
    names.extend(archives);
    let key = digest(names.join("\0").as_bytes());
    let path = configuration
        .cache_root
        .join("localization-lookups")
        .join(&key[..2])
        .join(&key);
    let built = !path.is_file();
    if built {
        build(&path, base)?;
    }
    Ok((open(&path)?, built))
}

/// Decodes a localization file's text: UTF-16 little-endian or UTF-8, with or without a BOM.
fn text(bytes: &[u8], file: &str) -> Result<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        require(
            rest.len() % 2 == 0,
            format!("{file} is not UTF-16").as_str(),
        )?;
        let units = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect::<Vec<_>>();
        return Ok(String::from_utf16(&units).map_err(|_| format!("{file} is not UTF-16"))?);
    }
    let rest = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    Ok(std::str::from_utf8(rest)
        .map_err(|_| format!("{file} is not UTF-8"))?
        .to_owned())
}

type Rows = Vec<(String, String, String, String)>;

/// A file's rows as `(namespace, key, source, path or translation)`.
fn rows(revision: &LocalizationRevision, format: Format) -> Result<Rows> {
    let bytes = fs::read(&revision.file)?;
    let text = text(&bytes, &revision.path)?;
    let document = parse_json(&text, &revision.path, format, &Limits::default())
        .map_err(|diagnostic| format!("{}: {}", revision.path, diagnostic.message))?;
    Ok(document
        .rows
        .into_iter()
        .map(|row| {
            let other = match format {
                Format::Manifest => row.path.unwrap_or_default(),
                _ => row.translation.map(|text| text.text).unwrap_or_default(),
            };
            (row.namespace, row.key, row.source.text, other)
        })
        .collect())
}

fn build(path: &Path, base: &BaseLocalization) -> Result<()> {
    let _span = crate::scan_timings::Span::new("point.localization_build");
    let mut files = vec![(&base.manifest, Format::Manifest)];
    files.extend(
        base.archives
            .iter()
            .map(|archive| (&archive.archive, Format::Archive)),
    );
    // A few files at a time: each is large, and parsing is the whole cost.
    let parsed = std::thread::scope(|scope| -> Result<Vec<Rows>> {
        let mut results = Vec::with_capacity(files.len());
        for batch in files.chunks(4) {
            let handles = batch
                .iter()
                .map(|(revision, format)| scope.spawn(move || rows(revision, *format)))
                .collect::<Vec<_>>();
            for handle in handles {
                results.push(
                    handle
                        .join()
                        .map_err(|_| "a localization parse panicked")??,
                );
            }
        }
        Ok(results)
    })?;
    let cultures = base
        .archives
        .iter()
        .map(|archive| archive.culture.clone())
        .collect::<Vec<_>>();
    let mut entries = BTreeMap::<(String, String), Entry>::new();
    let mut parsed = parsed.into_iter();
    for (namespace, key, source, path) in parsed.next().unwrap_or_default() {
        entries
            .entry((namespace, key))
            .or_default()
            .contexts
            .push(Context { source, path });
    }
    for (culture, rows) in parsed.enumerate() {
        for (namespace, key, source, translation) in rows {
            let entry = entries.entry((namespace, key)).or_default();
            entry.translations.resize(cultures.len(), None);
            entry.translations[culture] = Some(Translation {
                source,
                translation,
            });
        }
    }
    fs::create_dir_all(path.parent().ok_or("no parent")?)?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut out = BufWriter::new(File::create(&temporary)?);
    let header = serde_json::to_vec(&Header {
        native_culture: base.native_culture.clone(),
        cultures: cultures.clone(),
    })?;
    out.write_all(MAGIC)?;
    out.write_all(&u32::try_from(header.len())?.to_le_bytes())?;
    out.write_all(&header)?;
    out.write_all(&(entries.len() as u64).to_le_bytes())?;
    let start = (MAGIC.len() + 4 + header.len() + 8 + entries.len() * 8) as u64;
    let mut bodies = Vec::with_capacity(entries.len());
    let mut offset = start;
    for ((namespace, key), mut entry) in entries {
        entry.translations.resize(cultures.len(), None);
        let body = serde_json::to_vec(&entry)?;
        let mut record = Vec::with_capacity(12 + namespace.len() + key.len() + body.len());
        for part in [namespace.as_bytes(), key.as_bytes(), &body] {
            record.extend_from_slice(&u32::try_from(part.len())?.to_le_bytes());
            record.extend_from_slice(part);
        }
        out.write_all(&offset.to_le_bytes())?;
        offset += record.len() as u64;
        bodies.push(record);
    }
    for record in bodies {
        out.write_all(&record)?;
    }
    out.into_inner()
        .map_err(|error| error.into_error())?
        .sync_all()?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn open(path: &PathBuf) -> Result<Lookup> {
    let mut file = File::open(path)?;
    let mut magic = [0; 8];
    file.read_exact(&mut magic)?;
    require(&magic == MAGIC, "not a localization lookup")?;
    let length = read_u32(&mut file)? as usize;
    let mut header = vec![0; length];
    file.read_exact(&mut header)?;
    let header: Header = serde_json::from_slice(&header)?;
    let mut count = [0; 8];
    file.read_exact(&mut count)?;
    let count = usize::try_from(u64::from_le_bytes(count))?;
    let mut offsets = vec![0; count * 8];
    file.read_exact(&mut offsets)?;
    let offsets = offsets
        .as_chunks::<8>()
        .0
        .iter()
        .map(|bytes| u64::from_le_bytes(*bytes))
        .collect();
    Ok(Lookup {
        file,
        offsets,
        native_culture: header.native_culture,
        cultures: header.cultures,
    })
}

fn read_u32(file: &mut File) -> Result<u32> {
    let mut bytes = [0; 4];
    file.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_part(file: &mut File) -> Result<Vec<u8>> {
    let length = read_u32(file)? as usize;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

impl Lookup {
    /// A key's entry at the base, or none when neither the manifest nor an archive has it.
    pub fn find(&mut self, namespace: &str, key: &str) -> Result<Option<Entry>> {
        let wanted = (namespace.as_bytes(), key.as_bytes());
        let (mut low, mut high) = (0, self.offsets.len());
        while low < high {
            let middle = low + (high - low) / 2;
            self.file.seek(SeekFrom::Start(self.offsets[middle]))?;
            let found_namespace = read_part(&mut self.file)?;
            let found_key = read_part(&mut self.file)?;
            match (found_namespace.as_slice(), found_key.as_slice()).cmp(&wanted) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => {
                    return Ok(Some(serde_json::from_slice(&read_part(&mut self.file)?)?));
                }
            }
        }
        Ok(None)
    }

    /// Whether a culture other than the native one has a translation in an entry.
    pub fn translated(&self, entry: &Entry, culture: usize) -> bool {
        self.cultures[culture] != self.native_culture
            && entry.translations[culture]
                .as_ref()
                .is_some_and(|translation| !translation.translation.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_text_contract::CultureArchive;

    fn revision(path: &Path, name: &str, revision: &str) -> LocalizationRevision {
        LocalizationRevision {
            path: name.into(),
            file: path.to_string_lossy().into_owned(),
            revision: revision.into(),
        }
    }

    #[test]
    fn a_lookup_finds_each_key_and_is_built_once() -> Result<()> {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/unreal-project/Content/Localization/FixtureGame");
        let cache = std::env::temp_dir().join(format!("gt-lookup-{}", std::process::id()));
        let configuration = Configuration {
            cache_root: cache.clone(),
            project_key: "project".into(),
            target_key: "target".into(),
            shared_project: false,
            view_prefix: None,
        };
        let base = BaseLocalization {
            native_culture: "en".into(),
            manifest: revision(&fixture.join("FixtureGame.manifest"), "m", "m#1"),
            archives: ["de", "en", "fr"]
                .iter()
                .map(|culture| CultureArchive {
                    culture: (*culture).into(),
                    archive: revision(
                        &fixture.join(culture).join("FixtureGame.archive"),
                        culture,
                        &format!("{culture}#1"),
                    ),
                })
                .collect(),
        };
        let (mut lookup, built) = open_or_build(&configuration, &base)?;
        assert!(built);
        // Every manifest key is found, with its contexts.
        let text = text(&fs::read(&base.manifest.file)?, "m")?;
        let document = parse_json(&text, "m", Format::Manifest, &Limits::default())
            .map_err(|diagnostic| diagnostic.message)?;
        assert!(!document.rows.is_empty());
        for row in &document.rows {
            let entry = lookup
                .find(&row.namespace, &row.key)?
                .ok_or("a manifest key")?;
            assert!(entry.contexts.iter().any(|c| c.source == row.source.text));
            assert_eq!(entry.translations.len(), 3);
        }
        assert_eq!(lookup.find("No such namespace", "nor key")?, None);
        let (_, again) = open_or_build(&configuration, &base)?;
        assert!(!again);
        let _ = fs::remove_dir_all(cache);
        Ok(())
    }
}
