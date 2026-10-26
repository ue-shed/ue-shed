//! Which packages a package-text refresh reads, and which of the 256 shards changed.
//!
//! The shard of a path and the shard keys are `package-text-layer.ts`'s rules
//! (`packageTextShard`, `PackageTextSelectionBuilder`), so a key computed here equals the one an
//! index already holds for the same inventory. The reader selects each package from its Catalog
//! header; this module shards, keys and compares them with the writer's store.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::package_text_contract::{
    PackageTextExpected as Expected, PackageTextPlan, PackageTextPlanRequest, PackageTextPlanShard,
};
use crate::store::Store;
use crate::wtf8::Wtf8Buf;
use crate::{Result, require};

pub const SHARDS: usize = 256;
const SHARD_PREFIX: &str = "package-text.";

/// FNV-1a over the path's UTF-16 code units, as `packageTextShard`.
#[must_use]
pub fn shard(path: &str) -> usize {
    let mut hash: u32 = 2_166_136_261;
    for unit in path.encode_utf16() {
        hash = (hash ^ u32::from(unit)).wrapping_mul(16_777_619);
    }
    hash as usize % SHARDS
}

/// One shard's plan: its key and its packages in path order.
#[derive(Clone, Debug)]
pub struct ShardPlan {
    pub group: u32,
    pub key: String,
    pub expected: Vec<Expected>,
}

/// Shards and keys an inventory of `(path, signature, selected)` entries, one entry per path.
pub fn shard_plans(
    entries: BTreeMap<String, Expected>,
    request: &PackageTextPlanRequest,
) -> Vec<ShardPlan> {
    let mut hashes = (0..SHARDS)
        .map(|_| {
            let mut hash = Sha256::new();
            hash.update(request.format.as_bytes());
            hash.update(request.policy_json.as_bytes());
            hash
        })
        .collect::<Vec<_>>();
    let mut shards = (0..SHARDS)
        .map(|_| Vec::new())
        .collect::<Vec<Vec<Expected>>>();
    // UTF-8 byte order is the host's WTF-8 order for well-formed paths.
    for (path, entry) in entries {
        let group = shard(&path);
        hashes[group].update(
            format!(
                "[{},{},{}]",
                Wtf8Buf::from_utf8(&entry.path).json_string(),
                Wtf8Buf::from_utf8(&entry.signature).json_string(),
                entry.selected
            )
            .as_bytes(),
        );
        shards[group].push(entry);
    }
    shards
        .into_iter()
        .zip(hashes)
        .enumerate()
        .map(|(group, (expected, hash))| ShardPlan {
            group: group as u32,
            key: format!("{}:{group}:{:x}", request.format, hash.finalize()),
            expected,
        })
        .collect()
}

/// A changed file as the package it belongs to: a sidecar names its `.uasset` and `.umap`.
fn changed_packages(changed: &[String]) -> BTreeSet<String> {
    let mut packages = BTreeSet::new();
    for path in changed {
        let path = path.replace('\\', "/");
        match path.rsplit_once('.') {
            Some((stem, "uexp" | "ubulk" | "uptnl")) => {
                packages.insert(format!("{stem}.uasset"));
                packages.insert(format!("{stem}.umap"));
            }
            _ => {
                packages.insert(path);
            }
        }
    }
    packages
}

/// Each package the store holds: its signature and whether it was read (a package stored as
/// not gatherable wasn't).
fn stored_packages(store: &Store) -> Result<BTreeMap<String, (String, bool)>> {
    let mut columns = Vec::new();
    let mut ids = BTreeSet::new();
    for (name, key) in store.root["active"].as_object().ok_or("active layers")? {
        if !name.starts_with(SHARD_PREFIX) {
            continue;
        }
        let (mut reader, record) =
            crate::join_columns::layer(store, key.as_str().ok_or("layer key")?)?
                .ok_or("package shard absent")?;
        let mut read = |field| crate::join_columns::column(&mut reader, &record, field);
        let (paths, signatures, statuses) = (
            read("package.path")?,
            read("package.signature")?,
            read("package.status")?,
        );
        require(
            paths.len() == signatures.len() && paths.len() == statuses.len(),
            "package column length",
        )?;
        ids.extend(paths.iter().chain(&signatures).copied());
        columns.push((paths, signatures, statuses));
    }
    let strings = crate::store::dictionary_selected_strings(&store.directory, &store.root, &ids)?;
    let text = |id: &u32| -> Result<String> {
        Ok(
            Wtf8Buf::from_view(strings.get(id).ok_or("package string ID")?)
                .to_utf8()?
                .to_owned(),
        )
    };
    let mut stored = BTreeMap::new();
    for (paths, signatures, statuses) in columns {
        for row in 0..paths.len() {
            stored.insert(
                text(&paths[row])?,
                (text(&signatures[row])?, statuses[row] != 2),
            );
        }
    }
    Ok(stored)
}

/// Plans a refresh of `inventory` against `store`: shards and keys every package, compares each
/// key with the store's, and writes the changed shards' entries to the request's plan file.
///
/// With `changed_files`, a package not among them keeps its stored signature and selection; a
/// stored package the inventory no longer lists stays unless it changed. Inventory paths must be
/// unique.
pub fn plan(
    store: &Store,
    request: &PackageTextPlanRequest,
    inventory: Vec<Expected>,
) -> Result<PackageTextPlan> {
    let active = &store.root["active"];
    let mut entries = BTreeMap::<String, Expected>::new();
    let mut inventory = inventory;
    if let Some(changed) = &request.changed_files
        && active
            .as_object()
            .ok_or("active layers")?
            .keys()
            .any(|name| name.starts_with(SHARD_PREFIX))
    {
        let changed = changed_packages(changed);
        for (path, (signature, selected)) in stored_packages(store)? {
            if !changed.contains(&path) {
                entries.insert(
                    path.clone(),
                    Expected {
                        path,
                        signature,
                        selected,
                    },
                );
            }
        }
        inventory.retain(|entry| changed.contains(&entry.path));
    }
    for entry in inventory {
        require(
            entries.insert(entry.path.clone(), entry).is_none(),
            "Inventory must have unique paths",
        )?;
    }
    let packages = u32::try_from(entries.len())?;
    let shards = shard_plans(entries, request);
    let name = |group: u32| format!("{SHARD_PREFIX}{group}");
    let first_key = shards[0].key.clone();
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut file = std::io::BufWriter::new(std::fs::File::create_new(&request.plan_file)?);
    for shard in shards {
        let held = active[name(shard.group)].as_str();
        if shard.expected.is_empty() {
            if held.is_some() {
                removed.push(name(shard.group));
            }
        } else if held != Some(&shard.key) {
            serde_json::to_writer(
                &mut file,
                &PlanLine {
                    group: shard.group,
                    expected: shard.expected.clone(),
                },
            )?;
            file.write_all(b"\n")?;
            changed.push(PackageTextPlanShard {
                group: shard.group,
                key: shard.key,
                packages: u32::try_from(shard.expected.len())?,
                selected: u32::try_from(shard.expected.iter().filter(|e| e.selected).count())?,
            });
        }
    }
    file.flush()?;
    Ok(PackageTextPlan {
        changed,
        removed,
        packages,
        first_key,
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PlanLine {
    group: u32,
    expected: Vec<Expected>,
}

/// The shards a plan file holds for `groups`, in the file's order.
pub fn read_plan_file(path: &Path, groups: &[u32]) -> Result<Vec<(u32, Vec<Expected>)>> {
    let wanted = groups.iter().copied().collect::<BTreeSet<_>>();
    let mut shards = Vec::new();
    for line in std::io::BufReader::new(std::fs::File::open(path)?).lines() {
        let line: PlanLine = serde_json::from_str(&line?)?;
        if wanted.contains(&line.group) {
            shards.push((line.group, line.expected));
        }
    }
    require(
        shards.len() == wanted.len(),
        "The plan file lacks a requested shard",
    )?;
    Ok(shards)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shards_hash_utf16_code_units() {
        // An astral character is two code units; hashing its UTF-8 bytes would differ.
        let mut hash: u32 = 2_166_136_261;
        for unit in [u32::from(b'x'), 0xd83d, 0xde00] {
            hash = (hash ^ unit).wrapping_mul(16_777_619);
        }
        assert_eq!(shard("x😀"), hash as usize % SHARDS);
        assert_eq!(shard(""), 2_166_136_261 % SHARDS);
    }

    #[test]
    fn a_sidecar_names_its_package() {
        let changed = changed_packages(&["Content\\A.uexp".into(), "Content/B.uasset".into()]);
        assert_eq!(
            changed.into_iter().collect::<Vec<_>>(),
            vec!["Content/A.uasset", "Content/A.umap", "Content/B.uasset"]
        );
    }
}
