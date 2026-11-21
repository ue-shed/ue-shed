use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::JoinHandle;

use super::{Columns, Expected, SnapshotRequest, write_staged};
use game_text_index::wtf8::Wtf8Buf;
use game_text_index::{Result, require};

const PUBLISHER_WORKERS: usize = 4;
const PUBLISHER_QUEUE_BOUND: usize = 8;

struct Builder {
    expected: BTreeMap<String, Expected>,
    packages: BTreeMap<String, Columns>,
    remaining: usize,
    bytes: usize,
}
pub struct Shards<T: Send + 'static = ()> {
    builders: BTreeMap<u32, Builder>,
    pub expected: HashMap<PathBuf, (u32, Expected)>,
    tx: Option<mpsc::SyncSender<(u32, Builder, Option<T>)>>,
    done_rx: mpsc::Receiver<T>,
    error: Arc<Mutex<Option<String>>>,
    workers: Vec<JoinHandle<()>>,
}

fn publish_builder(directory: &Path, group: u32, builder: Builder) -> Result<()> {
    let _span = game_text_index::scan_timings::Span::new("extract.shard_snapshot");
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
            // The encoder reads scalar views; ordinary UTF-8 without 0xf3 is its own view.
            if !path.as_bytes().contains(&0xf3) && !entry.signature.as_bytes().contains(&0xf3) {
                columns.feed_not_gatherable(&path, &entry.signature)?;
            } else {
                let path = Wtf8Buf::from_utf8(&path).into_view();
                let signature = Wtf8Buf::from_utf8(&entry.signature).into_view();
                columns.feed_not_gatherable(&path, &signature)?;
            }
        }
    }
    let bytes = write_staged(
        &directory.join(format!("{group}.snapshot")),
        &columns.finish()?,
    )?;
    game_text_index::scan_timings::count("extract.snapshot_bytes", bytes);
    Ok(())
}

impl<T: Send + 'static> Shards<T> {
    pub fn new(directory: &Path, root: &Path, request: &SnapshotRequest) -> Result<Self> {
        Self::new_with_expected(directory, Some(root), request)
    }

    pub fn new_without_expected(directory: &Path, request: &SnapshotRequest) -> Result<Self> {
        Self::new_with_expected(directory, None, request)
    }

    fn new_with_expected(
        directory: &Path,
        root: Option<&Path>,
        request: &SnapshotRequest,
    ) -> Result<Self> {
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
                if let Some(root) = root {
                    require(
                        all.insert(root.join(&entry.path), (shard.group, entry.clone()))
                            .is_none(),
                        "duplicate requested package",
                    )?;
                }
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
        let worker_count = PUBLISHER_WORKERS.min(builders.len().max(1));
        let (tx, rx) = mpsc::sync_channel::<(u32, Builder, Option<T>)>(PUBLISHER_QUEUE_BOUND);
        let (done_tx, done_rx) = mpsc::channel::<T>();
        let rx = Arc::new(Mutex::new(rx));
        let error = Arc::new(Mutex::new(None::<String>));
        let directory = Arc::new(directory.to_path_buf());
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let rx = Arc::clone(&rx);
            let done_tx = done_tx.clone();
            let error = Arc::clone(&error);
            let directory = Arc::clone(&directory);
            workers.push(std::thread::spawn(move || {
                loop {
                    let job = {
                        let guard = rx.lock().unwrap_or_else(PoisonError::into_inner);
                        guard.recv()
                    };
                    let Ok((group, builder, deferred)) = job else {
                        break;
                    };
                    if error
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .is_some()
                    {
                        continue;
                    }
                    match publish_builder(&directory, group, builder) {
                        Ok(()) => {
                            if let Some(payload) = deferred {
                                let _ = done_tx.send(payload);
                            }
                        }
                        Err(err) => {
                            let mut slot = error.lock().unwrap_or_else(PoisonError::into_inner);
                            if slot.is_none() {
                                *slot = Some(err.to_string());
                            }
                        }
                    }
                }
            }));
        }
        drop(done_tx);
        let mut result = Self {
            builders,
            expected: all,
            tx: Some(tx),
            done_rx,
            error,
            workers,
        };
        let ready = result
            .builders
            .iter()
            .filter_map(|(group, builder)| (builder.remaining == 0).then_some(*group))
            .collect::<Vec<_>>();
        for group in ready {
            result.enqueue_publish(group, None)?;
        }
        Ok(result)
    }

    fn check_error(&self) -> Result<()> {
        if let Some(message) = self
            .error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            return Err(message.clone().into());
        }
        Ok(())
    }

    /// Adds one selected package's columns to its shard. If the package completes the shard,
    /// `on_complete` is deferred until the background publisher finishes writing `<group>.snapshot`,
    /// preserving the invariant that `<group>.snapshot` exists on disk before the shard's final
    /// `StagedTextPackage` event is emitted. Returns `(emit_now, newly_completed_deferred)`.
    pub fn add_deferred(
        &mut self,
        group: u32,
        path: String,
        columns: Columns,
        on_complete: T,
    ) -> Result<(Option<T>, Vec<T>)> {
        self.check_error()?;
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
        let emit_now = if complete {
            self.enqueue_publish(group, Some(on_complete))?;
            None
        } else {
            Some(on_complete)
        };
        self.report_memory();
        let ready = self.drain_ready();
        self.check_error()?;
        Ok((emit_now, ready))
    }

    fn drain_ready(&self) -> Vec<T> {
        let mut ready = Vec::new();
        while let Ok(payload) = self.done_rx.try_recv() {
            ready.push(payload);
        }
        ready
    }

    fn enqueue_publish(&mut self, group: u32, deferred: Option<T>) -> Result<()> {
        let builder = self
            .builders
            .remove(&group)
            .ok_or("missing package shard")?;
        let tx = self.tx.as_ref().ok_or("shard publisher closed")?;
        tx.send((group, builder, deferred))
            .map_err(|_| game_text_index::Error::from("shard publisher stopped"))?;
        self.check_error()
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

    pub fn finish(mut self) -> Result<Vec<T>> {
        self.tx.take();
        for handle in self.workers.drain(..) {
            if handle.join().is_err() {
                return Err("shard publisher thread panicked".into());
            }
        }
        self.check_error()?;
        require(
            self.builders.is_empty(),
            "reader omitted requested packages",
        )?;
        let remaining = self.drain_ready();
        crate::reader_memory::writers(std::iter::empty());
        Ok(remaining)
    }
}

impl<T: Send + 'static> Drop for Shards<T> {
    fn drop(&mut self) {
        self.tx.take();
        for handle in self.workers.drain(..) {
            let _ = handle.join();
        }
    }
}
