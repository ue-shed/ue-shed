//! Which packages a package-text refresh reads, and which of the 256 shards changed.
//!
//! The shard of a path and the shard keys are `package-text-layer.ts`'s rules
//! (`packageTextShard`, `PackageTextSelectionBuilder`), so a key computed here equals the one an
//! index already holds for the same inventory. The reader selects each package from its Catalog
//! header; this module shards, keys and compares them with the writer's store.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::Path;

use rayon::prelude::*;
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
const PLAN_WITNESS_FILE: &str = "package-text-plan-witness.json";

/// FNV-1a over the path's UTF-16 code units, as `packageTextShard`.
#[must_use]
pub fn shard(path: &str) -> usize {
    let mut hash: u32 = 2_166_136_261;
    if path.is_ascii() {
        for &byte in path.as_bytes() {
            hash = (hash ^ u32::from(byte)).wrapping_mul(16_777_619);
        }
    } else {
        for unit in path.encode_utf16() {
            hash = (hash ^ u32::from(unit)).wrapping_mul(16_777_619);
        }
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

/// Feeds `Wtf8Buf::from_utf8(text).json_string().as_bytes()` directly into `hash` without
/// heap allocations. Valid UTF-8 contains no lone surrogates, so only `"`, `\`, and ASCII control
/// bytes (`0x00..=0x1f`) require escaping.
fn update_json_utf8(hash: &mut Sha256, text: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    hash.update(b"\"");
    let bytes = text.as_bytes();
    let mut copied = 0;
    for (at, &byte) in bytes.iter().enumerate() {
        let escape: &[u8] = match byte {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            8 => b"\\b",
            9 => b"\\t",
            10 => b"\\n",
            12 => b"\\f",
            13 => b"\\r",
            0..=31 => b"",
            _ => continue,
        };
        if copied < at {
            hash.update(&bytes[copied..at]);
        }
        if escape.is_empty() {
            let buf = [
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(byte >> 4) as usize],
                HEX[(byte & 0x0f) as usize],
            ];
            hash.update(buf);
        } else {
            hash.update(escape);
        }
        copied = at + 1;
    }
    if copied < bytes.len() {
        hash.update(&bytes[copied..]);
    }
    hash.update(b"\"");
}

/// A shard key in the making: the format and audience policy, then each entry in path order.
pub(crate) struct ShardKey(Sha256);
impl ShardKey {
    pub(crate) fn new(format: &str, policy_json: &str) -> Self {
        let mut hash = Sha256::new();
        hash.update(format.as_bytes());
        hash.update(policy_json.as_bytes());
        Self(hash)
    }
    pub(crate) fn add(&mut self, path: &Wtf8Buf, signature: &Wtf8Buf, selected: bool) {
        // `JSON.stringify([path, signature, selected])`, fed in parts.
        self.0.update(b"[");
        self.0.update(path.json_string().as_bytes());
        self.0.update(b",");
        self.0.update(signature.json_string().as_bytes());
        self.0.update(if selected {
            b",true]" as &[u8]
        } else {
            b",false]"
        });
    }
    /// Zero-allocation equivalent of `add(&Wtf8Buf::from_utf8(path), &Wtf8Buf::from_utf8(signature), selected)`.
    pub(crate) fn add_utf8(&mut self, path: &str, signature: &str, selected: bool) {
        self.0.update(b"[");
        update_json_utf8(&mut self.0, path);
        self.0.update(b",");
        update_json_utf8(&mut self.0, signature);
        self.0.update(if selected {
            b",true]" as &[u8]
        } else {
            b",false]"
        });
    }
    pub(crate) fn finish(self, format: &str, group: u32) -> String {
        format!("{format}:{group}:{:x}", self.0.finalize())
    }
}

/// Shards and keys a strictly path-sorted inventory of `(path, signature, selected)` entries
/// in parallel across all 256 shards.
fn shard_plans_sorted(entries: Vec<Expected>, request: &PackageTextPlanRequest) -> Vec<ShardPlan> {
    let per_shard = entries.len() / SHARDS + 16;
    let mut buckets: Vec<Vec<Expected>> =
        (0..SHARDS).map(|_| Vec::with_capacity(per_shard)).collect();
    for entry in entries {
        let group = shard(&entry.path);
        buckets[group].push(entry);
    }
    buckets
        .into_par_iter()
        .enumerate()
        .map(|(group, expected)| {
            let mut hash = ShardKey::new(&request.format, &request.policy_json);
            for entry in &expected {
                hash.add_utf8(&entry.path, &entry.signature, entry.selected);
            }
            ShardPlan {
                group: group as u32,
                key: hash.finish(&request.format, group as u32),
                expected,
            }
        })
        .collect()
}

/// Shards and keys an inventory of `(path, signature, selected)` entries, one entry per path.
pub fn shard_plans(
    entries: BTreeMap<String, Expected>,
    request: &PackageTextPlanRequest,
) -> Vec<ShardPlan> {
    let sorted = entries.into_values().collect::<Vec<_>>();
    shard_plans_sorted(sorted, request)
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
    let mut keys = Vec::new();
    for (name, key) in store.root["active"].as_object().ok_or("active layers")? {
        if name.starts_with(SHARD_PREFIX) {
            keys.push(key.as_str().ok_or("layer key")?);
        }
    }
    stored_layers(store, &keys)
}

/// [`stored_packages`] of the package shard layers `keys` alone.
fn stored_layers(store: &Store, keys: &[&str]) -> Result<BTreeMap<String, (String, bool)>> {
    let mut columns = Vec::new();
    let mut ids = BTreeSet::new();
    for key in keys {
        let (mut reader, record) =
            crate::join_columns::layer(store, key)?.ok_or("package shard absent")?;
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

/// Cryptographic witness binding a Catalog's complete `inventory_digest`, `format`, and
/// `policy_json` to the exact set of active `package-text.*` shard keys in the store.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanWitness {
    inventory_digest: String,
    format: String,
    policy_hash: String,
    active_shards_hash: String,
    packages: u32,
    first_key: String,
}

fn policy_hash(policy_json: &str) -> String {
    format!("{:x}", Sha256::digest(policy_json.as_bytes()))
}

/// The hash of each package shard's key, in group order.
fn shards_hash<'k>(keys: impl IntoIterator<Item = (u32, &'k str)>) -> String {
    let mut hash = Sha256::new();
    for (group, key) in keys {
        hash.update(group.to_le_bytes());
        hash.update((key.len() as u32).to_le_bytes());
        hash.update(key.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn shard_name(group: u32) -> String {
    format!("{SHARD_PREFIX}{group}")
}

fn active_shards_hash(active: &serde_json::Value) -> String {
    shards_hash(
        (0..SHARDS as u32).filter_map(|group| Some((group, active[shard_name(group)].as_str()?))),
    )
}

fn target_active_shards_hash(shards: &[ShardPlan]) -> String {
    shards_hash(
        shards
            .iter()
            .filter(|shard| !shard.expected.is_empty())
            .map(|shard| (shard.group, shard.key.as_str())),
    )
}

/// The recorded witness, when it was written for this request's format and policy and the
/// store's package shards are still the ones it planned.
fn current_witness(store: &Store, request: &PackageTextPlanRequest) -> Option<PlanWitness> {
    if request.changed_files.is_some() {
        return None;
    }
    let bytes = std::fs::read(store.directory.join(PLAN_WITNESS_FILE)).ok()?;
    let witness = serde_json::from_slice::<PlanWitness>(&bytes).ok()?;
    (witness.format == request.format
        && witness.policy_hash == policy_hash(&request.policy_json)
        && witness.active_shards_hash == active_shards_hash(&store.root["active"]))
    .then_some(witness)
}

/// Returns an unchanged empty plan in O(1) when the Catalog's complete `inventory_digest`,
/// `format`, `policy_json`, and the store's active `package-text.*` shard keys all match the
/// recorded witness. Always creates the empty `plan_file` to preserve the plan-file contract.
pub(crate) fn try_plan_unchanged(
    store: &Store,
    request: &PackageTextPlanRequest,
    catalog_digest: &str,
) -> Result<Option<PackageTextPlan>> {
    let Some(witness) = current_witness(store, request) else {
        return Ok(None);
    };
    if witness.inventory_digest != catalog_digest {
        return Ok(None);
    }
    std::fs::File::create_new(&request.plan_file)?;
    Ok(Some(PackageTextPlan {
        changed: Vec::new(),
        removed: Vec::new(),
        packages: witness.packages,
        first_key: witness.first_key,
    }))
}

fn write_plan_witness(
    store: &Store,
    request: &PackageTextPlanRequest,
    catalog_digest: &str,
    packages: u32,
    first_key: &str,
    active_shards_hash: String,
) {
    let witness = PlanWitness {
        inventory_digest: catalog_digest.to_owned(),
        format: request.format.clone(),
        policy_hash: policy_hash(&request.policy_json),
        active_shards_hash,
        packages,
        first_key: first_key.to_owned(),
    };
    if let Ok(value) = serde_json::to_value(&witness) {
        let _ = crate::store::atomic_json(&store.directory.join(PLAN_WITNESS_FILE), &value);
    }
}

/// The Catalog a delta plan reads. Each answer is exact or `None`, which plans every shard.
pub trait PlanCatalog {
    /// The entries (packages and sidecars) added, changed or removed since the inventory whose
    /// digest was `since`.
    fn changes_since(&mut self, since: &str) -> Option<BTreeSet<String>>;
    /// The inventory's packages at `paths`, in path order; a path holding no package is left out.
    fn entries(&mut self, paths: &BTreeSet<String>) -> Option<Vec<Expected>>;
}

/// The most shards a delta plan rekeys; a broader change plans every shard in parallel.
pub const MAXIMUM_DELTA_SHARDS: usize = 32;

/// The key `entries`, in path order, give shard `group`.
fn shard_key<'e>(
    request: &PackageTextPlanRequest,
    group: u32,
    entries: impl IntoIterator<Item = &'e Expected>,
) -> String {
    let mut hash = ShardKey::new(&request.format, &request.policy_json);
    for entry in entries {
        hash.add_utf8(&entry.path, &entry.signature, entry.selected);
    }
    hash.finish(&request.format, group)
}

/// Plans a refresh from the last one without reading the whole inventory: the plan [`plan`]
/// would give, and the same plan file and witness, when the store still holds the witness's
/// shards and the Catalog can say exactly which entries changed since its inventory.
///
/// Only the shards of changed packages are rekeyed. Each starts from the packages its held layer
/// stores, which must give the held key, so they are the planned inventory's packages: a stored
/// package was read exactly when it was selected (one not read is stored as not gatherable).
/// Changed packages are then replaced by the Catalog's current entries. Anything else, or more
/// than [`MAXIMUM_DELTA_SHARDS`] shards, returns `None` for a full plan.
pub(crate) fn try_plan_delta(
    store: &Store,
    request: &PackageTextPlanRequest,
    catalog_digest: &str,
    catalog: &mut dyn PlanCatalog,
) -> Result<Option<PackageTextPlan>> {
    let Some(witness) = current_witness(store, request) else {
        return Ok(None);
    };
    let Some(changes) = catalog.changes_since(&witness.inventory_digest) else {
        return Ok(None);
    };
    let changed = changed_packages(&changes.into_iter().collect::<Vec<_>>());
    let groups = changed
        .iter()
        .map(|path| shard(path) as u32)
        .collect::<BTreeSet<_>>();
    if groups.len() > MAXIMUM_DELTA_SHARDS {
        return Ok(None);
    }
    let Some(current) = catalog.entries(&changed) else {
        return Ok(None);
    };
    if current.iter().any(|entry| !changed.contains(&entry.path))
        || current.windows(2).any(|pair| pair[0].path >= pair[1].path)
    {
        return Ok(None);
    }
    let active = &store.root["active"];
    let held = groups
        .iter()
        .filter_map(|&group| active[shard_name(group)].as_str())
        .collect::<Vec<_>>();
    let Ok(stored) = stored_layers(store, &held) else {
        return Ok(None);
    };
    let mut shards = groups
        .iter()
        .map(|&group| (group, BTreeMap::<String, Expected>::new()))
        .collect::<BTreeMap<_, _>>();
    for (path, (signature, selected)) in stored {
        let Some(entries) = shards.get_mut(&(shard(&path) as u32)) else {
            return Ok(None);
        };
        entries.insert(
            path.clone(),
            Expected {
                path,
                signature,
                selected,
            },
        );
    }
    let mut packages = i64::from(witness.packages);
    for (&group, entries) in &shards {
        let held = active[shard_name(group)].as_str();
        if held.is_some_and(|key| key != shard_key(request, group, entries.values()))
            || (held.is_none() && !entries.is_empty())
        {
            return Ok(None);
        }
        packages -= entries.len() as i64;
    }
    for shard_entries in shards.values_mut() {
        shard_entries.retain(|path, _| !changed.contains(path));
    }
    for entry in current {
        shards
            .get_mut(&(shard(&entry.path) as u32))
            .ok_or("changed package shard")?
            .insert(entry.path.clone(), entry);
    }
    let mut changed_shards = Vec::new();
    let mut removed = Vec::new();
    let mut keys = BTreeMap::new();
    let mut file = std::io::BufWriter::with_capacity(
        256 * 1024,
        std::fs::File::create_new(&request.plan_file)?,
    );
    file.write_all(BINARY_PLAN_MAGIC)?;
    for (&group, entries) in &shards {
        packages += entries.len() as i64;
        let key = shard_key(request, group, entries.values());
        let held = active[shard_name(group)].as_str();
        if entries.is_empty() {
            if held.is_some() {
                removed.push(shard_name(group));
            }
        } else if held != Some(&key) {
            let expected = entries.values().cloned().collect::<Vec<_>>();
            write_binary_shard(&mut file, group, &expected)?;
            changed_shards.push(PackageTextPlanShard {
                group,
                key: key.clone(),
                packages: u32::try_from(expected.len())?,
                selected: u32::try_from(expected.iter().filter(|e| e.selected).count())?,
            });
        }
        keys.insert(group, (key, entries.is_empty()));
    }
    file.flush()?;
    let packages = u32::try_from(packages)?;
    let first_key = keys
        .get(&0)
        .map_or_else(|| witness.first_key.clone(), |(key, _)| key.clone());
    let target = shards_hash(
        (0..SHARDS as u32).filter_map(|group| match keys.get(&group) {
            Some((key, empty)) => (!empty).then_some((group, key.as_str())),
            None => Some((group, active[shard_name(group)].as_str()?)),
        }),
    );
    write_plan_witness(store, request, catalog_digest, packages, &first_key, target);
    crate::scan_timings::count("plan.delta_shards", groups.len() as u64);
    Ok(Some(PackageTextPlan {
        changed: changed_shards,
        removed,
        packages,
        first_key,
    }))
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
    plan_with_digest(store, request, inventory, None)
}

pub(crate) fn plan_with_digest(
    store: &Store,
    request: &PackageTextPlanRequest,
    mut inventory: Vec<Expected>,
    catalog_digest: Option<&str>,
) -> Result<PackageTextPlan> {
    let active = &store.root["active"];
    let sorted = if let Some(changed) = &request.changed_files
        && active
            .as_object()
            .ok_or("active layers")?
            .keys()
            .any(|name| name.starts_with(SHARD_PREFIX))
    {
        let changed = changed_packages(changed);
        let mut entries = BTreeMap::<String, Expected>::new();
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
        for entry in inventory {
            require(
                entries.insert(entry.path.clone(), entry).is_none(),
                "Inventory must have unique paths",
            )?;
        }
        entries.into_values().collect::<Vec<_>>()
    } else {
        // Catalog inventories arrive strictly sorted by UTF-8 path; verify in one linear scan
        // and avoid building an 800k-node BTreeMap or cloning every path.
        let mut strictly_sorted = true;
        for window in inventory.windows(2) {
            match window[0].path.cmp(&window[1].path) {
                std::cmp::Ordering::Less => {}
                std::cmp::Ordering::Equal => {
                    return Err("Inventory must have unique paths".into());
                }
                std::cmp::Ordering::Greater => {
                    strictly_sorted = false;
                    break;
                }
            }
        }
        if !strictly_sorted {
            inventory.sort_unstable_by(|a, b| a.path.cmp(&b.path));
            for window in inventory.windows(2) {
                require(
                    window[0].path != window[1].path,
                    "Inventory must have unique paths",
                )?;
            }
        }
        inventory
    };
    let packages = u32::try_from(sorted.len())?;
    let shards = shard_plans_sorted(sorted, request);
    let name = |group: u32| format!("{SHARD_PREFIX}{group}");
    let first_key = shards[0].key.clone();
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    let mut file = std::io::BufWriter::with_capacity(
        256 * 1024,
        std::fs::File::create_new(&request.plan_file)?,
    );
    file.write_all(BINARY_PLAN_MAGIC)?;
    for shard in &shards {
        let held = active[name(shard.group)].as_str();
        if shard.expected.is_empty() {
            if held.is_some() {
                removed.push(name(shard.group));
            }
        } else if held != Some(&shard.key) {
            write_binary_shard(&mut file, shard.group, &shard.expected)?;
            changed.push(PackageTextPlanShard {
                group: shard.group,
                key: shard.key.clone(),
                packages: u32::try_from(shard.expected.len())?,
                selected: u32::try_from(shard.expected.iter().filter(|e| e.selected).count())?,
            });
        }
    }
    file.flush()?;
    if request.changed_files.is_none()
        && let Some(digest) = catalog_digest
    {
        write_plan_witness(
            store,
            request,
            digest,
            packages,
            &first_key,
            target_active_shards_hash(&shards),
        );
    }
    Ok(PackageTextPlan {
        changed,
        removed,
        packages,
        first_key,
    })
}

/// The start of a plan file the planner writes. Each changed shard follows as its `group`, entry
/// count and payload length, little-endian `u32`s, then the payload: each entry's `selected`
/// byte, then its path and signature, each a little-endian `u32` length and UTF-8 bytes. A file
/// without the magic is the NDJSON form, one `PlanLine` per line, which hosts may still write.
const BINARY_PLAN_MAGIC: &[u8] = b"UEPT0001\n";

/// One shard's entries in the binary plan form.
fn write_binary_shard(out: &mut impl Write, group: u32, expected: &[Expected]) -> Result<()> {
    let payload = expected
        .iter()
        .map(|entry| 9 + entry.path.len() + entry.signature.len())
        .sum::<usize>();
    out.write_all(&group.to_le_bytes())?;
    out.write_all(&u32::try_from(expected.len())?.to_le_bytes())?;
    out.write_all(&u32::try_from(payload)?.to_le_bytes())?;
    for entry in expected {
        out.write_all(&[u8::from(entry.selected)])?;
        for text in [&entry.path, &entry.signature] {
            out.write_all(&u32::try_from(text.len())?.to_le_bytes())?;
            out.write_all(text.as_bytes())?;
        }
    }
    Ok(())
}

/// One shard's entries in a plan file: a JSON line.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PlanLine {
    pub(crate) group: u32,
    pub(crate) expected: Vec<Expected>,
}

/// The shards a plan file holds for `groups`, in the file's order. Reads the planner's binary
/// form, skipping unwanted shards unread, and the NDJSON form.
pub fn read_plan_file(path: &Path, groups: &[u32]) -> Result<Vec<(u32, Vec<Expected>)>> {
    use std::io::{Read, Seek};
    let wanted = groups.iter().copied().collect::<BTreeSet<_>>();
    let file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, file);
    let mut binary = false;
    if length >= BINARY_PLAN_MAGIC.len() as u64 {
        let mut magic = [0u8; BINARY_PLAN_MAGIC.len()];
        reader.read_exact(&mut magic)?;
        binary = magic == BINARY_PLAN_MAGIC;
    }
    let shards = if binary {
        read_binary_plan(&mut reader, length, &wanted)?
    } else {
        reader.rewind()?;
        let mut shards = Vec::new();
        for line in reader.lines() {
            let line: PlanLine = serde_json::from_str(&line?)?;
            if wanted.contains(&line.group) {
                shards.push((line.group, line.expected));
            }
        }
        shards
    };
    require(
        shards.len() == wanted.len(),
        "The plan file lacks a requested shard",
    )?;
    Ok(shards)
}

/// A binary plan's wanted shards, read from just after its magic. Every length is checked
/// against the file's before it is read or skipped.
fn read_binary_plan(
    reader: &mut std::io::BufReader<std::fs::File>,
    length: u64,
    wanted: &BTreeSet<u32>,
) -> Result<Vec<(u32, Vec<Expected>)>> {
    let mut position = BINARY_PLAN_MAGIC.len() as u64;
    let mut shards = Vec::new();
    while position < length {
        let mut available = length - position;
        let group = read_u32(reader, &mut available)?;
        let count = read_u32(reader, &mut available)?;
        let payload = u64::from(read_u32(reader, &mut available)?);
        position += 12;
        require(payload <= available, TRUNCATED_PLAN)?;
        if !wanted.contains(&group) {
            reader.seek_relative(i64::try_from(payload)?)?;
            position += payload;
            continue;
        }
        let mut remaining = payload;
        // Each entry takes at least nine bytes, which bounds a corrupt count's allocation.
        let mut expected = Vec::with_capacity((count as usize).min(payload as usize / 9));
        for _ in 0..count {
            let mut selected = [0u8; 1];
            read_bounded(reader, &mut selected, &mut remaining)?;
            require(selected[0] <= 1, "The plan file holds an invalid selection")?;
            let path = read_text(reader, &mut remaining)?;
            let signature = read_text(reader, &mut remaining)?;
            expected.push(Expected {
                path,
                signature,
                selected: selected[0] == 1,
            });
        }
        require(
            remaining == 0,
            "The plan file's shard length differs from its entries",
        )?;
        position += payload;
        shards.push((group, expected));
    }
    Ok(shards)
}

const TRUNCATED_PLAN: &str = "The plan file is truncated";

/// Fills `bytes` from at most `remaining` bytes, and counts them off.
fn read_bounded(
    reader: &mut impl std::io::Read,
    bytes: &mut [u8],
    remaining: &mut u64,
) -> Result<()> {
    require(bytes.len() as u64 <= *remaining, TRUNCATED_PLAN)?;
    reader.read_exact(bytes)?;
    *remaining -= bytes.len() as u64;
    Ok(())
}

fn read_u32(reader: &mut impl std::io::Read, remaining: &mut u64) -> Result<u32> {
    let mut bytes = [0u8; 4];
    read_bounded(reader, &mut bytes, remaining)?;
    Ok(u32::from_le_bytes(bytes))
}

/// A length-prefixed UTF-8 string.
fn read_text(reader: &mut impl std::io::Read, remaining: &mut u64) -> Result<String> {
    let size = u64::from(read_u32(reader, remaining)?);
    require(size <= *remaining, TRUNCATED_PLAN)?;
    let mut bytes = vec![0; usize::try_from(size)?];
    read_bounded(reader, &mut bytes, remaining)?;
    Ok(String::from_utf8(bytes)?)
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
        assert_eq!(
            shard("Content/Area/Asset.uasset"),
            shard("Content/Area/Asset.uasset")
        );
    }

    #[test]
    fn add_utf8_matches_wtf8_json_string_for_all_escapes_and_unicode() {
        let cases = [
            (
                "Content/Plain.uasset",
                r#"[{"size":123,"modifiedMs":456.5},null,null,null]"#,
                true,
            ),
            (
                "Content/Quote\"Back\\Slash.uasset",
                "sig\x00\x07\x08\t\n\x0b\x0c\r\x1f",
                false,
            ),
            (
                "Content/日本語/Émoji😀.uasset",
                r#"[{"size":0,"modifiedMs":0},null,null,null]"#,
                true,
            ),
            ("", "", false),
        ];
        for (path, sig, selected) in cases {
            let mut slow = ShardKey::new("v1", r#"{"rules":[]}"#);
            slow.add(
                &Wtf8Buf::from_utf8(path),
                &Wtf8Buf::from_utf8(sig),
                selected,
            );
            let mut fast = ShardKey::new("v1", r#"{"rules":[]}"#);
            fast.add_utf8(path, sig, selected);
            assert_eq!(slow.finish("v1", 7), fast.finish("v1", 7));
        }
    }

    fn entry(path: &str, signature: &str, selected: bool) -> Expected {
        Expected {
            path: path.into(),
            signature: signature.into(),
            selected,
        }
    }

    #[test]
    fn plan_files_round_trip_in_binary_and_read_legacy_lines() -> Result<()> {
        let directory = crate::test_directory("package-text-plan-file");
        std::fs::create_dir_all(&directory)?;
        let shards = vec![
            (3, vec![entry("Content/A.uasset", "[1]", true)]),
            (
                7,
                vec![
                    entry("Content/日本語/Émoji😀.uasset", "sig\"\\\n", false),
                    entry("", "", true),
                ],
            ),
            (200, vec![entry("Content/Z.umap", r#"[{"size":0}]"#, false)]),
        ];
        let binary = directory.join("plan.bin");
        let mut file = std::io::BufWriter::new(std::fs::File::create_new(&binary)?);
        file.write_all(BINARY_PLAN_MAGIC)?;
        for (group, expected) in &shards {
            write_binary_shard(&mut file, *group, expected)?;
        }
        file.flush()?;
        drop(file);
        let legacy = directory.join("plan.ndjson");
        let mut lines = String::new();
        for (group, expected) in &shards {
            lines.push_str(&serde_json::to_string(&PlanLine {
                group: *group,
                expected: expected.clone(),
            })?);
            lines.push('\n');
        }
        std::fs::write(&legacy, lines)?;
        for path in [&binary, &legacy] {
            assert_eq!(read_plan_file(path, &[3, 7, 200])?, shards);
            // Shards come in the file's order, whatever the request's.
            assert_eq!(
                read_plan_file(path, &[200, 3])?,
                vec![shards[0].clone(), shards[2].clone()]
            );
            assert_eq!(read_plan_file(path, &[7])?, vec![shards[1].clone()]);
            assert!(read_plan_file(path, &[])?.is_empty());
            assert!(read_plan_file(path, &[3, 5]).is_err());
        }
        // An empty plan, as an unchanged inventory writes, holds no shards.
        let empty = directory.join("empty.plan");
        std::fs::write(&empty, b"")?;
        assert!(read_plan_file(&empty, &[])?.is_empty());
        assert!(read_plan_file(&empty, &[0]).is_err());
        // Truncation anywhere, even in a skipped shard, and invalid UTF-8 are rejected.
        let bytes = std::fs::read(&binary)?;
        let damaged = directory.join("damaged.plan");
        for cut in [
            BINARY_PLAN_MAGIC.len() + 5,
            bytes.len() - 20,
            bytes.len() - 1,
        ] {
            std::fs::write(&damaged, &bytes[..cut])?;
            assert!(read_plan_file(&damaged, &[3]).is_err(), "{cut}");
        }
        let mut invalid = bytes.clone();
        let at = BINARY_PLAN_MAGIC.len() + 12 + 1 + 4;
        invalid[at] = 0xff;
        std::fs::write(&damaged, &invalid)?;
        assert!(read_plan_file(&damaged, &[3]).is_err());
        assert_eq!(read_plan_file(&damaged, &[7])?, vec![shards[1].clone()]);
        std::fs::remove_dir_all(directory)?;
        Ok(())
    }

    const FORMAT: &str = "package-text-v10";
    const POLICY: &str = "[2,[]]";

    /// A Catalog that holds `inventory` and logged `changes` since the digest `since`.
    struct FakeCatalog {
        since: &'static str,
        changes: Option<BTreeSet<String>>,
        inventory: Vec<Expected>,
    }

    impl PlanCatalog for FakeCatalog {
        fn changes_since(&mut self, since: &str) -> Option<BTreeSet<String>> {
            (since == self.since)
                .then(|| self.changes.clone())
                .flatten()
        }
        fn entries(&mut self, paths: &BTreeSet<String>) -> Option<Vec<Expected>> {
            let mut entries = self
                .inventory
                .iter()
                .filter(|entry| paths.contains(&entry.path))
                .cloned()
                .collect::<Vec<_>>();
            entries.sort_by(|a, b| a.path.cmp(&b.path));
            Some(entries)
        }
    }

    struct Planner {
        store: Store,
        root: std::path::PathBuf,
        plans: usize,
    }

    impl Planner {
        fn request(&mut self) -> PackageTextPlanRequest {
            self.plans += 1;
            PackageTextPlanRequest {
                cache_root: String::new(),
                project_id: "project".into(),
                generation: 1,
                format: FORMAT.into(),
                policy_json: POLICY.into(),
                changed_files: None,
                plan_file: self
                    .root
                    .join(format!("plan-{}.bin", self.plans))
                    .to_string_lossy()
                    .into_owned(),
            }
        }

        /// A store that holds the shards of a full plan of `inventory` at digest `d0`.
        fn published(name: &str, inventory: &[Expected]) -> Result<Self> {
            let configuration = crate::store::Configuration {
                cache_root: crate::test_directory(name),
                project_key: "project".into(),
                target_key: "text".into(),
                shared_project: false,
                view_prefix: None,
            };
            let root = configuration.cache_root.clone();
            let mut planner = Self {
                store: Store::writer(configuration)?,
                root,
                plans: 0,
            };
            let request = planner.request();
            let plan = plan_with_digest(&planner.store, &request, inventory.to_vec(), Some("d0"))?;
            let groups = plan.changed.iter().map(|s| s.group).collect::<Vec<_>>();
            for (shard, (group, expected)) in plan
                .changed
                .iter()
                .zip(read_plan_file(Path::new(&request.plan_file), &groups)?)
            {
                let packages = expected
                    .iter()
                    .map(|e| {
                        (
                            e.path.clone(),
                            e.signature.clone(),
                            vec![format!("text {group}")],
                        )
                    })
                    .collect::<Vec<_>>();
                let statuses = expected
                    .iter()
                    .map(|e| if e.selected { 0 } else { 2 })
                    .collect::<Vec<_>>();
                let file = crate::package_delta::tests::shard_with_statuses(
                    &planner.root,
                    &format!("held-{group}"),
                    &packages,
                    &statuses,
                );
                planner
                    .store
                    .publish_local(&shard_name(group), &shard.key, &file)?;
            }
            Ok(planner)
        }

        fn witness(&self) -> std::path::PathBuf {
            self.store.directory.join(PLAN_WITNESS_FILE)
        }

        /// The delta plan from `d0` to `d1` with `changes`, after checking that it, its plan file
        /// and its witness equal a full plan's of `inventory`. The store is left as it was.
        fn delta(
            &mut self,
            inventory: &[Expected],
            changes: Option<&[&str]>,
        ) -> Result<Option<PackageTextPlan>> {
            let before = std::fs::read(self.witness())?;
            let delta_request = self.request();
            let delta = try_plan_delta(
                &self.store,
                &delta_request,
                "d1",
                &mut FakeCatalog {
                    since: "d0",
                    changes: changes.map(|paths| paths.iter().map(|p| (*p).to_owned()).collect()),
                    inventory: inventory.to_vec(),
                },
            )?;
            let Some(delta) = delta else {
                assert_eq!(std::fs::read(self.witness())?, before);
                assert!(!Path::new(&delta_request.plan_file).exists());
                return Ok(None);
            };
            let delta_witness = std::fs::read(self.witness())?;
            std::fs::write(self.witness(), &before)?;
            let full_request = self.request();
            let full =
                plan_with_digest(&self.store, &full_request, inventory.to_vec(), Some("d1"))?;
            assert_eq!(delta, full);
            assert_eq!(
                std::fs::read(&delta_request.plan_file)?,
                std::fs::read(&full_request.plan_file)?
            );
            assert_eq!(delta_witness, std::fs::read(self.witness())?);
            std::fs::write(self.witness(), &before)?;
            Ok(Some(delta))
        }
    }

    impl Drop for Planner {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn signature(version: u32) -> String {
        format!(r#"[{{"size":{version},"modifiedMs":{version}}},null,null,null]"#)
    }

    /// Packages in many shards, every fifth one selected, sorted by path.
    fn inventory(count: usize) -> Vec<Expected> {
        let mut inventory = (0..count)
            .map(|i| {
                entry(
                    &format!("Content/P{i:03}.uasset"),
                    &signature(1),
                    i % 5 == 0,
                )
            })
            .collect::<Vec<_>>();
        inventory.push(entry("Content/Map.umap", &signature(1), true));
        inventory.sort_by(|a, b| a.path.cmp(&b.path));
        inventory
    }

    fn edited(inventory: &[Expected], path: &str, edit: impl Fn(&mut Expected)) -> Vec<Expected> {
        let mut inventory = inventory.to_vec();
        edit(inventory.iter_mut().find(|e| e.path == path).unwrap());
        inventory
    }

    #[test]
    fn delta_plans_equal_full_plans_for_small_changes() -> Result<()> {
        let base = inventory(120);
        let mut planner = Planner::published("package-text-delta", &base)?;
        let path = |i: usize| format!("Content/P{i:03}.uasset");
        // One edited package, selected or not.
        for i in [0, 1] {
            let next = edited(&base, &path(i), |e| e.signature = signature(2));
            let plan = planner.delta(&next, Some(&[&path(i)]))?.unwrap();
            assert_eq!(plan.changed.len(), 1);
        }
        // An added package, and a deleted one.
        let mut added = base.clone();
        added.push(entry("Content/New.uasset", &signature(1), true));
        added.sort_by(|a, b| a.path.cmp(&b.path));
        planner
            .delta(&added, Some(&["Content/New.uasset"]))?
            .unwrap();
        let deleted = base
            .iter()
            .filter(|e| e.path != path(7))
            .cloned()
            .collect::<Vec<_>>();
        planner.delta(&deleted, Some(&[&path(7)]))?.unwrap();
        // Packages that start or stop carrying text.
        let flipped_on = edited(&base, &path(3), |e| {
            e.selected = true;
            e.signature = signature(3);
        });
        planner.delta(&flipped_on, Some(&[&path(3)]))?.unwrap();
        let flipped_off = edited(&base, &path(10), |e| {
            e.selected = false;
            e.signature = signature(3);
        });
        planner.delta(&flipped_off, Some(&[&path(10)]))?.unwrap();
        // Several shards at once, including a sidecar's package, a deleted map and unchanged or
        // non-package entries the Catalog also logged.
        let mut several = edited(&base, &path(20), |e| e.signature = signature(4));
        several = edited(&several, &path(21), |e| e.signature = signature(5));
        several.retain(|e| e.path != "Content/Map.umap");
        let plan = planner
            .delta(
                &several,
                Some(&[
                    &path(20),
                    "Content/P021.uexp",
                    "Content/Map.ubulk",
                    &path(22),
                    "Content/Readme.txt",
                ]),
            )?
            .unwrap();
        assert!(plan.changed.len() + plan.removed.len() >= 2);
        // No change at all.
        assert!(planner.delta(&base, Some(&[]))?.unwrap().changed.is_empty());
        Ok(())
    }

    #[test]
    fn delta_plans_remove_emptied_shards_and_rekey_the_first() -> Result<()> {
        // One package per shard for the shards it reaches, so a deletion empties its shard.
        let base = vec![
            entry("Content/A.uasset", &signature(1), true),
            entry("Content/B.uasset", &signature(1), false),
        ];
        let mut planner = Planner::published("package-text-delta-remove", &base)?;
        let plan = planner
            .delta(&base[..1], Some(&["Content/B.uasset"]))?
            .unwrap();
        assert_eq!(plan.removed.len(), 1);
        // A package in shard 0 rekeys the marker an empty inventory publishes.
        let zero = (0..10_000)
            .map(|i| format!("Content/Z{i}.uasset"))
            .find(|path| shard(path) == 0)
            .unwrap();
        let mut with_zero = base.clone();
        with_zero.push(entry(&zero, &signature(1), true));
        with_zero.sort_by(|a, b| a.path.cmp(&b.path));
        let plan = planner.delta(&with_zero, Some(&[&zero]))?.unwrap();
        assert_eq!(plan.changed[0].group, 0);
        Ok(())
    }

    #[test]
    fn delta_plans_fall_back_when_they_cannot_be_exact() -> Result<()> {
        let base = inventory(300);
        let mut planner = Planner::published("package-text-delta-fallback", &base)?;
        // The Catalog cannot say what changed (a gap, overflow or another digest).
        assert!(planner.delta(&base, None)?.is_none());
        // Changes reaching more shards than a delta plan rekeys.
        let mut groups = BTreeSet::new();
        let mut broad = base.clone();
        let mut paths = Vec::new();
        for entry in &mut broad {
            if groups.insert(shard(&entry.path)) {
                entry.signature = signature(9);
                paths.push(entry.path.clone());
            }
            if groups.len() > MAXIMUM_DELTA_SHARDS {
                break;
            }
        }
        let paths = paths.iter().map(String::as_str).collect::<Vec<_>>();
        assert!(planner.delta(&broad, Some(&paths))?.is_none());
        let within = &paths[..MAXIMUM_DELTA_SHARDS];
        let mut narrow = base.clone();
        for entry in &mut narrow {
            if within.contains(&entry.path.as_str()) {
                entry.signature = signature(9);
            }
        }
        assert!(planner.delta(&narrow, Some(within))?.is_some());
        // Another format or policy, or a request naming changed files, plans in full.
        let mut request = planner.request();
        request.policy_json = "[1,[]]".into();
        let mut catalog = FakeCatalog {
            since: "d0",
            changes: Some(BTreeSet::new()),
            inventory: base.clone(),
        };
        assert!(try_plan_delta(&planner.store, &request, "d1", &mut catalog)?.is_none());
        let mut request = planner.request();
        request.changed_files = Some(Vec::new());
        assert!(try_plan_delta(&planner.store, &request, "d1", &mut catalog)?.is_none());
        // A held shard whose packages do not give its key is never patched, even under a witness
        // that names it.
        let group = shard("Content/P000.uasset") as u32;
        let file = crate::package_delta::tests::shard_with_statuses(
            &planner.root,
            "tampered",
            &[(
                "Content/P000.uasset".into(),
                signature(1),
                vec!["text".into()],
            )],
            &[2],
        );
        planner
            .store
            .publish_local(&shard_name(group), "tampered-key", &file)?;
        let mut witness =
            serde_json::from_slice::<PlanWitness>(&std::fs::read(planner.witness())?)?;
        witness.active_shards_hash = active_shards_hash(&planner.store.root["active"]);
        std::fs::write(planner.witness(), serde_json::to_vec(&witness)?)?;
        let edited = edited(&base, "Content/P000.uasset", |e| e.signature = signature(2));
        assert!(
            planner
                .delta(&edited, Some(&["Content/P000.uasset"]))?
                .is_none()
        );
        Ok(())
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
