use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use super::{Columns, Evidence, Expected, SnapshotRequest, Stored, write_staged};
use game_text_index::{Result, require};

struct Builder {
    expected: BTreeMap<String, Expected>,
    packages: BTreeMap<String, Columns>,
    remaining: usize,
    bytes: usize,
}
pub struct Shards {
    directory: PathBuf,
    builders: BTreeMap<u32, Builder>,
    pub expected: HashMap<PathBuf, (u32, Expected)>,
    rules: Vec<super::AudienceRule>,
}
impl Shards {
    pub fn new(directory: &Path, root: &Path, request: &SnapshotRequest) -> Result<Self> {
        let mut builders = BTreeMap::new();
        let mut all = HashMap::new();
        for shard in &request.shards {
            require(
                !builders.contains_key(&shard.group),
                "duplicate package shard",
            )?;
            let packages = BTreeMap::new();
            let mut expected = BTreeMap::new();
            let mut remaining = 0;
            for entry in &shard.expected {
                require(
                    !expected.contains_key(&entry.path),
                    "duplicate package inventory entry",
                )?;
                require(
                    all.insert(root.join(&entry.path), (shard.group, entry.clone()))
                        .is_none(),
                    "duplicate requested package",
                )?;
                if entry.selected {
                    remaining += 1;
                }
                expected.insert(entry.path.clone(), entry.clone());
            }
            builders.insert(
                shard.group,
                Builder {
                    expected,
                    packages,
                    remaining,
                    bytes: 0,
                },
            );
        }
        let mut result = Self {
            directory: directory.into(),
            builders,
            expected: all,
            rules: request.rules.clone(),
        };
        let ready = result
            .builders
            .iter()
            .filter_map(|(group, builder)| (builder.remaining == 0).then_some(*group))
            .collect::<Vec<_>>();
        for group in ready {
            result.publish(group)?;
        }
        Ok(result)
    }
    pub fn add(&mut self, group: u32, path: String, columns: Columns) -> Result<()> {
        let builder = self
            .builders
            .get_mut(&group)
            .ok_or("unexpected package shard")?;
        require(
            builder.expected.get(&path).is_some_and(|e| e.selected),
            "unexpected package",
        )?;
        builder.bytes += columns.resident_bytes();
        require(
            builder.packages.insert(path, columns).is_none(),
            "duplicate package",
        )?;
        builder.remaining -= 1;
        let complete = builder.remaining == 0;
        self.report_memory();
        if complete {
            self.publish(group)?;
        }
        self.report_memory();
        Ok(())
    }
    fn publish(&mut self, group: u32) -> Result<()> {
        let _span = game_text_index::scan_timings::Span::new("extract.shard_snapshot");
        let builder = self
            .builders
            .remove(&group)
            .ok_or("missing package shard")?;
        require(
            builder.packages.len() == builder.expected.values().filter(|e| e.selected).count(),
            "reader omitted requested packages",
        )?;
        let mut columns = Columns::new()?;
        // UTF-8 byte order matches WTF-8 order for filesystem paths.
        let mut packages = builder.packages;
        for (path, entry) in builder.expected {
            if entry.selected {
                columns.append(packages.remove(&path).ok_or("missing selected package")?)?;
            } else {
                columns.feed(
                    Stored {
                        path: path.clone(),
                        signature: entry.signature,
                        evidence: Evidence::NotGatherable { path },
                    },
                    &self.rules,
                )?;
            }
        }
        let bytes = write_staged(
            &self.directory.join(format!("{group}.snapshot")),
            &columns.finish()?,
        )?;
        game_text_index::scan_timings::count("extract.snapshot_bytes", bytes);
        Ok(())
    }
    fn report_memory(&self) {
        crate::reader_memory::writers(self.builders.values().map(|b| (b.bytes, b.bytes)));
        game_text_index::scan_timings::high_water(
            "extract.shard_builder_bytes",
            self.builders.values().map(|b| b.bytes as u64).sum(),
        );
        game_text_index::scan_timings::high_water(
            "extract.shard_builders",
            self.builders.len() as u64,
        );
    }
    pub fn finish(self) -> Result<()> {
        require(
            self.builders.is_empty(),
            "reader omitted requested packages",
        )?;
        crate::reader_memory::writers(std::iter::empty());
        Ok(())
    }
}
