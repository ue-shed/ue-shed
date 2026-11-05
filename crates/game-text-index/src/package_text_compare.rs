//! Which entries of a package-text refresh's changed shards the index already holds.
//!
//! The host plans a refresh's changed shards; this compares each one's entries with the shard the
//! index holds, so the host reads and converts only changed packages, and `publish_packages`
//! splices the rows written here. No unchanged entry crosses into the host.
use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::Path;

use crate::join_columns::{column, layer};
use crate::package_text_contract::{
    PackageTextCompareRequest, PackageTextCompareShard, PackageTextComparison,
    PackageTextExpected as Expected,
};
use crate::package_text_plan::{PlanLine, ShardKey, read_plan_file};
use crate::store::Store;
use crate::wtf8::Wtf8Buf;
use crate::{Error, ErrorCode, Result, require};

const SHARD_PREFIX: &str = "package-text.";

/// A stored scalar view as UTF-8: borrowed when it escapes nothing, `None` for a lone surrogate.
fn utf8(view: &str) -> Option<std::borrow::Cow<'_, str>> {
    // Views escape lone surrogates and reserved scalars with code points whose UTF-8 starts 0xf3.
    if !view.as_bytes().contains(&0xf3) {
        return Some(std::borrow::Cow::Borrowed(view));
    }
    Wtf8Buf::from_view(view)
        .to_utf8()
        .ok()
        .map(|text| std::borrow::Cow::Owned(text.to_owned()))
}

/// A held shard's identity columns: global string IDs and statuses, in path order.
struct Held {
    key: String,
    paths: Vec<u32>,
    signatures: Vec<u32>,
    statuses: Vec<u32>,
}

/// Compares `request`'s shards with the store and writes their rows and changed entries to the
/// request's output directory. Stage times go to `stages`.
pub fn compare(
    store: &Store,
    request: &PackageTextCompareRequest,
    stages: &mut Vec<(&'static str, f64)>,
) -> Result<PackageTextComparison> {
    let _span = crate::scan_timings::Span::new("package_text.compare");
    let started = std::time::Instant::now();
    let directory = Path::new(&request.output_directory);
    std::fs::create_dir(directory)?;
    let planned = read_plan_file(Path::new(&request.plan_file), &request.groups)?;
    stages.push(("compare.plan", started.elapsed().as_secs_f64()));
    let started = std::time::Instant::now();
    let prefix = format!("{}:", request.format);
    let mut held = HashMap::<u32, Held>::new();
    let mut ids = BTreeSet::new();
    for (group, _) in &planned {
        let name = format!("{SHARD_PREFIX}{group}");
        let Some(key) = store.root["active"][&name].as_str() else {
            continue;
        };
        if !key.starts_with(&prefix) {
            continue;
        }
        let (mut reader, record) = layer(store, &name)?.ok_or("held package shard")?;
        let mut read = |field| column(&mut reader, &record, field);
        let shard = Held {
            key: key.to_owned(),
            paths: read("package.path")?,
            signatures: read("package.signature")?,
            statuses: read("package.status")?,
        };
        require(
            shard.paths.len() == shard.signatures.len()
                && shard.paths.len() == shard.statuses.len(),
            "package identity column length",
        )?;
        ids.extend(shard.paths.iter().chain(&shard.signatures).copied());
        held.insert(*group, shard);
    }
    let strings = crate::store::dictionary_selected_strings(&store.directory, &store.root, &ids)?;
    drop(ids);
    stages.push(("compare.held", started.elapsed().as_secs_f64()));
    let started = std::time::Instant::now();
    let text = |id: &u32| -> Result<&str> {
        strings
            .get(id)
            .map(String::as_str)
            .ok_or_else(|| Error::from("package string ID"))
    };
    let mut changed_file =
        std::io::BufWriter::new(std::fs::File::create_new(directory.join("changed.ndjson"))?);
    let mut shards = Vec::with_capacity(planned.len());
    for (group, expected) in planned {
        let previous = held.remove(&group);
        // A held shard is current when its key is the one its own entries give: same format and
        // audience policy. Only then are its records kept.
        let current = match &previous {
            Some(shard) => {
                let mut key = ShardKey::new(&request.format, &request.policy_json);
                for row in 0..shard.paths.len() {
                    key.add(
                        &Wtf8Buf::from_view(text(&shard.paths[row])?),
                        &Wtf8Buf::from_view(text(&shard.signatures[row])?),
                        shard.statuses[row] != 2,
                    );
                }
                key.finish(&request.format, group) == shard.key
            }
            None => false,
        };
        let mut rows_by_path = HashMap::new();
        if current && let Some(shard) = &previous {
            for (row, path) in shard.paths.iter().enumerate() {
                // A stored path that is not valid UTF-8 matches no planned entry.
                if let Some(path) = utf8(text(path)?) {
                    rows_by_path.insert(path, row);
                }
            }
        }
        let mut rows = Vec::with_capacity(expected.len() * 4);
        let mut changed = Vec::<Expected>::new();
        let mut retained = 0u32;
        for entry in expected {
            let kept = previous
                .as_ref()
                .zip(rows_by_path.get(entry.path.as_str()))
                .filter(|(shard, row)| {
                    (shard.statuses[**row] != 2) == entry.selected
                        && text(&shard.signatures[**row]).is_ok_and(|signature| {
                            utf8(signature).as_deref() == Some(&entry.signature)
                        })
                });
            let row = match kept {
                Some((_, row)) => {
                    retained += 1;
                    i32::try_from(*row)?
                }
                None => {
                    changed.push(entry);
                    -i32::try_from(changed.len())?
                }
            };
            rows.extend_from_slice(&row.to_le_bytes());
        }
        std::fs::write(directory.join(format!("{group}.rows")), rows)?;
        let selected = u32::try_from(changed.iter().filter(|entry| entry.selected).count())?;
        let count = u32::try_from(changed.len())?;
        if !changed.is_empty() {
            serde_json::to_writer(
                &mut changed_file,
                &PlanLine {
                    group,
                    expected: changed,
                },
            )?;
            changed_file.write_all(b"\n")?;
        }
        shards.push(PackageTextCompareShard {
            group,
            previous_key: previous.map(|shard| shard.key),
            current,
            retained,
            changed: count,
            selected,
        });
    }
    changed_file.flush()?;
    stages.push(("compare.rows", started.elapsed().as_secs_f64()));
    Ok(PackageTextComparison { shards })
}

/// Rejects a comparison whose groups are not package shards.
pub fn validate(request: &PackageTextCompareRequest) -> Result<()> {
    let unique = request.groups.iter().collect::<BTreeSet<_>>();
    require(
        request.groups.len() <= crate::package_text_plan::SHARDS
            && unique.len() == request.groups.len()
            && request
                .groups
                .iter()
                .all(|group| (*group as usize) < crate::package_text_plan::SHARDS)
            && !request.plan_file.is_empty()
            && !request.output_directory.is_empty(),
        Error::new(ErrorCode::InvalidInput, "invalid package comparison"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::package_delta::tests::{package, shard};
    use crate::store::Configuration;

    const FORMAT: &str = "package-text-v10";
    const POLICY: &str = "[2,[]]";

    /// The key the planner gives entries: the one an index holds for them.
    fn key(group: u32, entries: &[(String, String, Vec<String>)], policy: &str) -> String {
        let mut key = ShardKey::new(FORMAT, policy);
        for (path, signature, _) in entries {
            key.add(
                &Wtf8Buf::from_utf8(path),
                &Wtf8Buf::from_utf8(signature),
                true,
            );
        }
        key.finish(FORMAT, group)
    }

    fn expected(path: &str, signature: &str, selected: bool) -> Expected {
        Expected {
            path: path.into(),
            signature: signature.into(),
            selected,
        }
    }

    #[test]
    fn writes_rows_and_changed_entries_and_tells_an_older_policy() -> Result<()> {
        let configuration = Configuration {
            cache_root: crate::test_directory("package-compare"),
            project_key: "project".into(),
            target_key: "text".into(),
            shared_project: false,
            view_prefix: None,
        };
        let root = configuration.cache_root.clone();
        let mut store = Store::writer(configuration)?;
        let held = [package(0, "B", "kept"), package(0, "D", "before")];
        let current = key(0, &held, POLICY);
        store.publish_local("package-text.0", &current, &shard(&root, "held-0", &held))?;
        // Shard 1 was written under another audience policy.
        let older = [package(1, "B", "kept")];
        let stale = key(1, &older, "[1,[]]");
        store.publish_local("package-text.1", &stale, &shard(&root, "held-1", &older))?;
        let plan = root.join("plan.ndjson");
        let lines = [
            PlanLine {
                group: 0,
                expected: vec![
                    expected("Content/S000/A.uasset", "A-signature", false),
                    expected("Content/S000/B.uasset", "B-signature", true),
                    expected("Content/S000/D.uasset", "D-edited", true),
                ],
            },
            PlanLine {
                group: 1,
                expected: vec![expected("Content/S001/B.uasset", "B-signature", true)],
            },
            PlanLine {
                group: 2,
                expected: vec![expected("Content/S002/N.uasset", "N", true)],
            },
        ];
        std::fs::write(
            &plan,
            lines
                .iter()
                .map(|line| serde_json::to_string(line).map(|line| line + "\n"))
                .collect::<std::result::Result<String, _>>()?,
        )?;
        let output = root.join("compared");
        let mut stages = Vec::new();
        let comparison = compare(
            &store,
            &PackageTextCompareRequest {
                format: FORMAT.into(),
                policy_json: POLICY.into(),
                plan_file: plan.to_string_lossy().into_owned(),
                groups: vec![0, 1, 2],
                output_directory: output.to_string_lossy().into_owned(),
            },
            &mut stages,
        )?;
        assert_eq!(
            comparison.shards,
            vec![
                PackageTextCompareShard {
                    group: 0,
                    previous_key: Some(current),
                    current: true,
                    retained: 1,
                    changed: 2,
                    selected: 1
                },
                PackageTextCompareShard {
                    group: 1,
                    previous_key: Some(stale),
                    current: false,
                    retained: 0,
                    changed: 1,
                    selected: 1
                },
                PackageTextCompareShard {
                    group: 2,
                    previous_key: None,
                    current: false,
                    retained: 0,
                    changed: 1,
                    selected: 1
                },
            ]
        );
        let rows = |group: u32| -> Result<Vec<i32>> {
            Ok(std::fs::read(output.join(format!("{group}.rows")))?
                .as_chunks::<4>()
                .0
                .iter()
                .map(|value| i32::from_le_bytes(*value))
                .collect())
        };
        // A is new (changed 0), B keeps held row 0, D's signature changed (changed 1).
        assert_eq!(rows(0)?, vec![-1, 0, -2]);
        assert_eq!(rows(1)?, vec![-1]);
        assert_eq!(rows(2)?, vec![-1]);
        let changed = std::fs::read_to_string(output.join("changed.ndjson"))?
            .lines()
            .map(serde_json::from_str::<PlanLine>)
            .collect::<std::result::Result<Vec<_>, _>>()?;
        assert_eq!(
            changed
                .iter()
                .map(|line| (
                    line.group,
                    line.expected
                        .iter()
                        .map(|e| e.path.as_str())
                        .collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            vec![
                (0, vec!["Content/S000/A.uasset", "Content/S000/D.uasset"]),
                (1, vec!["Content/S001/B.uasset"]),
                (2, vec!["Content/S002/N.uasset"]),
            ]
        );
        assert!(stages.iter().any(|(stage, _)| *stage == "compare.held"));
        drop(store);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }
}
