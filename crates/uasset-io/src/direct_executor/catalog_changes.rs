//! What each recent Catalog generation changed, kept beside its manifest so a reader that planned
//! from an earlier generation can tell which entries changed since without reading every entry.
//!
//! Each record names a generation, the inventory digests before and after it, and the entries
//! (packages and sidecars) its refresh changed or removed. Records chain: a generation's record
//! follows the one before it, and its earlier digest is that record's later digest. A reader
//! accepts only an unbroken chain from the digest it planned at to the committed generation, so a
//! missing, overflowed or unreadable record means "cannot say", never a wrong answer. Keeping the
//! log is best effort: a generation whose record is not written breaks the chain.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};

pub(super) const CHANGES_FILE: &str = "changes.json";
const VERSION: u32 = 1;
/// Records kept: refreshes a reader may fall behind by and still read changes.
const MAXIMUM_RECORDS: usize = 32;
/// Paths kept across all records; older records are dropped to stay within it.
const MAXIMUM_PATHS: usize = 16_384;
const MAXIMUM_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChangeRecord {
    pub(super) generation: u64,
    /// The inventory digest of the generation before this one.
    pub(super) base_digest: String,
    /// This generation's inventory digest.
    pub(super) digest: String,
    pub(super) changed: Vec<String>,
    pub(super) removed: Vec<String>,
}

impl ChangeRecord {
    fn paths(&self) -> usize {
        self.changed.len() + self.removed.len()
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChangeLog {
    version: u32,
    records: Vec<ChangeRecord>,
}

fn read(directory: &Path) -> Option<ChangeLog> {
    let mut bytes = Vec::new();
    File::open(directory.join(CHANGES_FILE))
        .ok()?
        .take(MAXIMUM_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAXIMUM_BYTES {
        return None;
    }
    serde_json::from_slice::<ChangeLog>(&bytes)
        .ok()
        .filter(|log| log.version == VERSION)
}

/// Appends `record` after the records it follows, dropping the oldest beyond the bounds. A
/// record too large to keep, or one that does not follow the last record, starts a new log.
pub(super) fn append(directory: &Path, record: ChangeRecord) -> std::io::Result<()> {
    let mut records = read(directory).map_or_else(Vec::new, |log| log.records);
    if records.last().is_none_or(|last| {
        last.generation.checked_add(1) != Some(record.generation)
            || last.digest != record.base_digest
    }) {
        records.clear();
    }
    if record.paths() <= MAXIMUM_PATHS {
        records.push(record);
    }
    let excess = records.len().saturating_sub(MAXIMUM_RECORDS);
    records.drain(..excess);
    let mut kept = records.iter().map(ChangeRecord::paths).sum::<usize>();
    let mut dropped = 0;
    while kept > MAXIMUM_PATHS {
        kept -= records[dropped].paths();
        dropped += 1;
    }
    records.drain(..dropped);
    let mut file = AtomicWriteFile::open(directory.join(CHANGES_FILE))?;
    serde_json::to_writer(
        &mut file,
        &ChangeLog {
            version: VERSION,
            records,
        },
    )?;
    file.write_all(b"\n")?;
    file.commit()
}

/// Forgets every record, as when a generation's changes cannot be kept.
pub(super) fn clear(directory: &Path) {
    match fs::remove_file(directory.join(CHANGES_FILE)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        // An unremovable log could still chain past this generation; an empty one cannot.
        Err(_) => {
            let _ = fs::write(directory.join(CHANGES_FILE), b"");
        }
    }
}

/// The entries changed or removed after the generation whose inventory digest was `since`, up to
/// generation `generation` with digest `digest`; `None` when the records cannot say exactly.
pub(super) fn since(
    directory: &Path,
    since: &str,
    generation: u64,
    digest: &str,
) -> Option<BTreeSet<String>> {
    let log = read(directory)?;
    let mut paths = BTreeSet::new();
    let mut expected = (generation, digest);
    for record in log.records.iter().rev() {
        if (record.generation, record.digest.as_str()) != expected {
            return None;
        }
        paths.extend(record.changed.iter().chain(&record.removed).cloned());
        if record.base_digest == since {
            return Some(paths);
        }
        expected = (record.generation.checked_sub(1)?, &record.base_digest);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(generation: u64, base: &str, digest: &str, changed: &[&str]) -> ChangeRecord {
        ChangeRecord {
            generation,
            base_digest: base.to_owned(),
            digest: digest.to_owned(),
            changed: changed.iter().map(|path| (*path).to_owned()).collect(),
            removed: Vec::new(),
        }
    }

    fn set(paths: &[&str]) -> Option<BTreeSet<String>> {
        Some(paths.iter().map(|path| (*path).to_owned()).collect())
    }

    #[test]
    fn records_chain_from_a_digest_to_the_committed_generation() {
        let directory =
            std::env::temp_dir().join(format!("ue-shed-catalog-changes-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        assert_eq!(since(&directory, "a", 2, "b"), None);
        append(&directory, record(2, "a", "b", &["Content/A.uasset"])).unwrap();
        append(&directory, record(3, "b", "c", &["Content/B.uexp"])).unwrap();
        let mut removal = record(4, "c", "b", &[]);
        removal.removed.push("Content/B.uexp".to_owned());
        append(&directory, removal).unwrap();
        assert_eq!(since(&directory, "c", 4, "b"), set(&["Content/B.uexp"]));
        // A reverted inventory chains to the latest generation it was at.
        assert_eq!(since(&directory, "b", 4, "b"), set(&["Content/B.uexp"]));
        assert_eq!(
            since(&directory, "a", 4, "b"),
            set(&["Content/A.uasset", "Content/B.uexp"])
        );
        // Another generation or digest than the last record's, or an unknown start, cannot say.
        assert_eq!(since(&directory, "a", 5, "b"), None);
        assert_eq!(since(&directory, "a", 4, "c"), None);
        assert_eq!(since(&directory, "z", 4, "b"), None);
        // A record that does not follow the last one starts the log again.
        append(&directory, record(6, "b", "d", &["Content/C.uasset"])).unwrap();
        assert_eq!(since(&directory, "b", 6, "d"), set(&["Content/C.uasset"]));
        assert_eq!(since(&directory, "a", 6, "d"), None);
        // Records too large to keep break the chain.
        let large = (0..=MAXIMUM_PATHS).map(|i| format!("Content/{i}.uasset"));
        let mut large_record = record(7, "d", "e", &[]);
        large_record.changed = large.collect();
        append(&directory, large_record).unwrap();
        assert_eq!(since(&directory, "d", 7, "e"), None);
        append(&directory, record(8, "e", "f", &[])).unwrap();
        assert_eq!(since(&directory, "e", 8, "f"), set(&[]));
        assert_eq!(since(&directory, "d", 8, "f"), None);
        clear(&directory);
        assert_eq!(since(&directory, "e", 8, "f"), None);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn the_log_keeps_its_newest_records_within_its_bounds() {
        let directory = std::env::temp_dir().join(format!(
            "ue-shed-catalog-changes-bounds-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        for generation in 1..=(MAXIMUM_RECORDS as u64 + 5) {
            append(
                &directory,
                record(
                    generation,
                    &format!("d{}", generation - 1),
                    &format!("d{generation}"),
                    &["Content/A.uasset"],
                ),
            )
            .unwrap();
        }
        let last = MAXIMUM_RECORDS as u64 + 5;
        let oldest = last - MAXIMUM_RECORDS as u64 + 1;
        assert_eq!(read(&directory).unwrap().records.len(), MAXIMUM_RECORDS);
        assert!(
            since(
                &directory,
                &format!("d{}", oldest - 1),
                last,
                &format!("d{last}")
            )
            .is_some()
        );
        assert!(
            since(
                &directory,
                &format!("d{}", oldest - 2),
                last,
                &format!("d{last}")
            )
            .is_none()
        );
        fs::remove_dir_all(&directory).unwrap();
    }
}
