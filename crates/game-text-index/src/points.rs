//! Points: the text in a set of files at one revision.
//!
//! A point's manifest names a record for each of its files. A record is one file's package-text
//! columns, keyed by what it was read from, and is written once under the cache root, so every
//! point and every project on the machine shares it. The reader fills records; this module names
//! them and keeps manifests.
use std::fs;
use std::path::PathBuf;

use serde_json::json;

use crate::Result;
use crate::package_text_contract::PointEntry;
use crate::store::{Configuration, atomic_json, digest};

/// A point id: `local`, `depot@<CL>`, `shelved:<CL>` or another short name a host gives.
#[must_use]
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"@:._-".contains(&byte))
}

/// A record's key: the package-text format, the saved-text policy, the file's project-relative
/// path (the record holds it) and the SHA-256 of its bytes.
#[must_use]
pub fn record_key(format: &str, policy_json: &str, path: &str, content: &str) -> String {
    digest([format, policy_json, path, content].join("\0").as_bytes())
}

/// Where a record lives: `records/<k[0..2]>/<k>` under the cache root.
#[must_use]
pub fn record_file(configuration: &Configuration, key: &str) -> PathBuf {
    configuration
        .cache_root
        .join("records")
        .join(&key[..2])
        .join(key)
}

/// Where a project's point manifest lives.
pub fn point_file(configuration: &Configuration, id: &str) -> Result<PathBuf> {
    Ok(configuration
        .directory()?
        .join("points")
        .join(format!("{}.json", id.replace([':', '@'], "_"))))
}

/// Writes a point's manifest: its base and a record for each of its files.
pub fn write_point(
    configuration: &Configuration,
    id: &str,
    base: Option<&str>,
    entries: &[PointEntry],
) -> Result<()> {
    let file = point_file(configuration, id)?;
    fs::create_dir_all(file.parent().ok_or("no parent")?)?;
    atomic_json(
        &file,
        &json!({"schemaVersion": 1, "point": id, "base": base, "entries": entries}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_short_names_a_file_can_hold() {
        for id in ["local", "depot@220368", "shelved:220258", "base.depot@1"] {
            assert!(valid_id(id), "{id}");
        }
        for id in ["", "a/b", "..\\x", &"x".repeat(129)] {
            assert!(!valid_id(id), "{id}");
        }
    }

    #[test]
    fn a_record_key_follows_every_input() {
        let key = record_key("f", "p", "Content/A.uasset", "c");
        assert_ne!(key, record_key("f", "p", "Content/B.uasset", "c"));
        assert_ne!(key, record_key("f", "q", "Content/A.uasset", "c"));
        assert_ne!(key, record_key("f", "p", "Content/A.uasset", "d"));
        assert_eq!(key, record_key("f", "p", "Content/A.uasset", "c"));
    }
}
