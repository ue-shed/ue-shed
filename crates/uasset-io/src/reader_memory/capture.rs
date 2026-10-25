use super::Stage;
use serde::Serialize;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

const MAX_JOBS: usize = 200_000;
const MAX_SAMPLES: usize = 20_000;
const MAX_POINTS: usize = 128;
const WAITING: usize = 10;
const READY: usize = 11;
const CONSUMING: usize = 12;
const DONE: usize = 13;
const UNSEEN: usize = 14;

thread_local! {
    static REQUEST: RefCell<Option<Weak<Shared>>> = const { RefCell::new(None) };
    static CURRENT: RefCell<Option<Context>> = const { RefCell::new(None) };
}

struct Entry {
    bytes: u64,
    state: AtomicUsize,
    scheduled: AtomicU64,
    start: AtomicU64,
    ready: AtomicU64,
    consume: AtomicU64,
    end: AtomicU64,
    read_capacity: AtomicU64,
    read_peak_capacity: AtomicU64,
    staged_bytes: AtomicU64,
    staged_capacity: AtomicU64,
    checkpoint_live: AtomicU64,
    heap_peak: AtomicU64,
    stage_peaks: [AtomicU64; 6],
    header_live: AtomicU64,
    before_release: AtomicU64,
    after_release: AtomicU64,
    points: Mutex<Vec<Point>>,
}
impl Entry {
    fn new(bytes: u64) -> Self {
        Self {
            bytes,
            state: AtomicUsize::new(UNSEEN),
            scheduled: AtomicU64::new(0),
            start: AtomicU64::new(0),
            ready: AtomicU64::new(0),
            consume: AtomicU64::new(0),
            end: AtomicU64::new(0),
            read_capacity: AtomicU64::new(0),
            read_peak_capacity: AtomicU64::new(0),
            staged_bytes: AtomicU64::new(0),
            staged_capacity: AtomicU64::new(0),
            checkpoint_live: AtomicU64::new(0),
            heap_peak: AtomicU64::new(0),
            stage_peaks: std::array::from_fn(|_| AtomicU64::new(0)),
            header_live: AtomicU64::new(0),
            before_release: AtomicU64::new(0),
            after_release: AtomicU64::new(0),
            points: Mutex::new(Vec::new()),
        }
    }
}
struct Shared {
    start: Instant,
    jobs: OnceLock<Vec<Entry>>,
    tables: OnceLock<[u64; 4]>,
    core_start: AtomicU64,
    writer_count: AtomicU64,
    writer_bytes: AtomicU64,
    writer_capacity: AtomicU64,
    stop: AtomicBool,
    idle: AtomicBool,
    dropped_jobs: AtomicU64,
    dropped_samples: AtomicU64,
}
impl Shared {
    fn now(&self) -> u64 {
        self.start.elapsed().as_nanos() as u64
    }
    fn entry(&self, index: usize) -> Option<&Entry> {
        self.jobs.get()?.get(index)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    ns: u64,
    live_bytes: u64,
    interval_peak_bytes: u64,
    read_capacity: u64,
    stage: usize,
}
struct Context {
    shared: Arc<Shared>,
    index: usize,
    balance: i64,
    stage: Stage,
    points: Vec<Point>,
    pending_peak: u64,
}
impl Context {
    fn capture(&mut self, next: Stage, force: bool) {
        let (balance, peak) = process_metrics::thread_heap_window();
        let live = balance.saturating_sub(self.balance).max(0) as u64;
        let peak = peak.saturating_sub(self.balance).max(0) as u64;
        let Some(entry) = self.shared.entry(self.index) else {
            return;
        };
        entry.checkpoint_live.store(live, Relaxed);
        entry.heap_peak.fetch_max(peak, Relaxed);
        entry.stage_peaks[self.stage as usize].fetch_max(peak, Relaxed);
        let read = entry.read_capacity.load(Relaxed);
        if matches!((self.stage, next), (Stage::Parse, Stage::Decode)) {
            entry.header_live.store(live.saturating_sub(read), Relaxed);
        }
        if matches!(next, Stage::Release) {
            entry.before_release.store(live, Relaxed);
        }
        if matches!(next, Stage::Serialize) {
            entry.after_release.store(live, Relaxed);
        }
        self.pending_peak = self.pending_peak.max(peak);
        let ns = self.shared.now().saturating_sub(entry.start.load(Relaxed));
        let last = self.points.last().map_or(0, |p| p.ns);
        if force || ns.saturating_sub(last) >= 10_000_000 {
            if self.points.len() >= MAX_POINTS {
                let mut merged = Vec::with_capacity(MAX_POINTS);
                for pair in self.points.chunks(2) {
                    let mut point = pair[pair.len() - 1].clone();
                    point.interval_peak_bytes = pair
                        .iter()
                        .map(|p| p.interval_peak_bytes.max(p.live_bytes))
                        .max()
                        .unwrap_or(0);
                    merged.push(point);
                }
                self.points = merged;
            }
            self.points.push(Point {
                ns,
                live_bytes: live,
                interval_peak_bytes: self.pending_peak,
                read_capacity: read,
                stage: self.stage as usize,
            });
            self.pending_peak = 0;
        }
        self.stage = next;
        entry.state.store(next as usize, Relaxed);
    }
}

pub(crate) struct Probe {
    shared: Option<Arc<Shared>>,
    sampler: Option<std::thread::JoinHandle<Vec<Sample>>>,
    directory: Option<PathBuf>,
}
impl Probe {
    pub(crate) fn new(staged: bool) -> Self {
        let directory = staged
            .then(|| std::env::var_os("UE_SHED_READER_MEMORY_DIR"))
            .flatten()
            .map(PathBuf::from);
        let Some(directory) = directory else {
            return Self {
                shared: None,
                sampler: None,
                directory: None,
            };
        };
        let shared = Arc::new(Shared {
            start: Instant::now(),
            jobs: OnceLock::new(),
            tables: OnceLock::new(),
            core_start: AtomicU64::new(0),
            writer_count: AtomicU64::new(0),
            writer_bytes: AtomicU64::new(0),
            writer_capacity: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            idle: AtomicBool::new(false),
            dropped_jobs: AtomicU64::new(0),
            dropped_samples: AtomicU64::new(0),
        });
        REQUEST.with_borrow_mut(|r| *r = Some(Arc::downgrade(&shared)));
        let observed = Arc::clone(&shared);
        let sampler = std::thread::spawn(move || {
            let mut samples = Vec::with_capacity(1024);
            while !observed.stop.load(Relaxed) {
                if samples.len() < MAX_SAMPLES {
                    samples.push(Sample::take(&observed));
                } else {
                    observed.dropped_samples.fetch_add(1, Relaxed);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            samples.push(Sample::take(&observed));
            samples
        });
        Self {
            shared: Some(shared),
            sampler: Some(sampler),
            directory: Some(directory),
        }
    }
    pub(crate) fn configure(&self, paths: &[PathBuf], tables: impl FnOnce() -> [u64; 4]) {
        if let Some(shared) = &self.shared {
            let _ = shared.tables.set(tables());
            shared
                .dropped_jobs
                .store(paths.len().saturating_sub(MAX_JOBS) as u64, Relaxed);
            let jobs = paths
                .iter()
                .take(MAX_JOBS)
                .map(|p| Entry::new(std::fs::metadata(p).map_or(0, |m| m.len())))
                .collect();
            let _ = shared.jobs.set(jobs);
            shared.core_start.store(shared.now(), Relaxed);
        }
    }
    pub(crate) fn job(&self, index: usize) -> Job {
        let shared = self
            .shared
            .as_ref()
            .filter(|s| s.entry(index).is_some())
            .cloned();
        if let Some(shared) = &shared {
            let (balance, _) = process_metrics::thread_heap_window();
            if let Some(entry) = shared.entry(index) {
                entry.start.store(shared.now(), Relaxed);
                entry.state.store(Stage::Read as usize, Relaxed);
            }
            CURRENT.with_borrow_mut(|c| {
                *c = Some(Context {
                    shared: Arc::clone(shared),
                    index,
                    balance,
                    stage: Stage::Read,
                    points: Vec::with_capacity(8),
                    pending_peak: 0,
                })
            });
        }
        Job { shared, index }
    }
    pub(crate) fn consume(&self, index: usize) -> Consuming {
        let shared = self
            .shared
            .as_ref()
            .filter(|s| s.entry(index).is_some())
            .cloned();
        if let Some(shared) = &shared
            && let Some(entry) = shared.entry(index)
        {
            entry.consume.store(shared.now(), Relaxed);
            entry.state.store(CONSUMING, Relaxed);
        }
        Consuming { shared, index }
    }
}
pub(crate) struct Job {
    shared: Option<Arc<Shared>>,
    index: usize,
}
impl Job {
    pub(crate) fn ready(&self, sizes: impl FnOnce() -> (u64, u64)) {
        if let Some(shared) = &self.shared
            && let Some(entry) = shared.entry(self.index)
        {
            let (bytes, capacity) = sizes();
            entry.staged_bytes.store(bytes, Relaxed);
            entry.staged_capacity.store(capacity, Relaxed);
        }
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        if let Some(shared) = &self.shared
            && let Some(entry) = shared.entry(self.index)
        {
            CURRENT.with_borrow_mut(|c| {
                if let Some(mut context) = c.take() {
                    context.capture(Stage::Serialize, true);
                    *entry.points.lock().unwrap_or_else(PoisonError::into_inner) = context.points;
                }
            });
            entry.ready.store(shared.now(), Relaxed);
            entry.state.store(READY, Relaxed);
        }
    }
}
pub(crate) struct Consuming {
    shared: Option<Arc<Shared>>,
    index: usize,
}
impl Drop for Consuming {
    fn drop(&mut self) {
        if let Some(shared) = &self.shared
            && let Some(entry) = shared.entry(self.index)
        {
            entry.end.store(shared.now(), Relaxed);
            entry.state.store(DONE, Relaxed);
        }
    }
}
pub(crate) struct ReadBuffer {
    shared: Option<Arc<Shared>>,
    index: usize,
}
impl Drop for ReadBuffer {
    fn drop(&mut self) {
        if let Some(shared) = &self.shared
            && let Some(entry) = shared.entry(self.index)
        {
            entry.read_capacity.store(0, Relaxed);
        }
    }
}
pub(crate) fn read_buffer(capacity: usize) -> ReadBuffer {
    CURRENT.with_borrow(|c| {
        let shared = c.as_ref().map(|c| Arc::clone(&c.shared));
        let index = c.as_ref().map_or(0, |c| c.index);
        if let Some(shared) = &shared
            && let Some(entry) = shared.entry(index)
        {
            entry.read_capacity.store(capacity as u64, Relaxed);
            entry.read_peak_capacity.fetch_max(capacity as u64, Relaxed);
        }
        ReadBuffer { shared, index }
    })
}
pub(crate) fn checkpoint(stage: Stage) {
    CURRENT.with_borrow_mut(|c| {
        if let Some(c) = c {
            c.capture(stage, false);
        }
    });
}
pub(crate) fn scheduled(index: usize) {
    REQUEST.with_borrow(|r| {
        if let Some(shared) = r.as_ref().and_then(Weak::upgrade)
            && let Some(entry) = shared.entry(index)
        {
            entry.scheduled.store(shared.now(), Relaxed);
            entry.state.store(WAITING, Relaxed);
        }
    });
}
pub(crate) fn writers(sizes: impl Iterator<Item = (usize, usize)>) {
    REQUEST.with_borrow(|r| {
        if let Some(shared) = r.as_ref().and_then(Weak::upgrade) {
            let (mut count, mut bytes, mut capacity) = (0, 0, 0);
            for (length, cap) in sizes {
                count += 1;
                bytes += length as u64;
                capacity += cap as u64;
            }
            shared.writer_count.store(count, Relaxed);
            shared.writer_bytes.store(bytes, Relaxed);
            shared.writer_capacity.store(capacity, Relaxed);
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    ns: u64,
    idle: bool,
    working_set_bytes: u64,
    private_bytes: u64,
    heap_live_bytes: Option<u64>,
    cpu_ns: u64,
    in_flight_jobs: u64,
    in_flight_package_bytes: u64,
    waiting_jobs: u64,
    waiting_package_bytes: u64,
    active_jobs: u64,
    active_package_bytes: u64,
    ready_results: u64,
    ready_staged_bytes: u64,
    ready_staged_capacity: u64,
    consuming_results: u64,
    consuming_staged_capacity: u64,
    read_buffer_capacity: u64,
    checkpoint_active_heap: u64,
    active_stage_counts: [u64; 6],
    completed: u64,
    writer_count: u64,
    writer_bytes: u64,
    writer_capacity: u64,
}
impl Sample {
    fn take(shared: &Shared) -> Self {
        let memory = process_metrics::memory().unwrap_or_default();
        let mut s = Self {
            ns: shared.now(),
            idle: shared.idle.load(Relaxed),
            working_set_bytes: memory.working_set_bytes,
            private_bytes: memory.private_bytes,
            heap_live_bytes: process_metrics::thread_heap_live(),
            cpu_ns: process_metrics::process_cpu_ns().unwrap_or_default(),
            in_flight_jobs: 0,
            in_flight_package_bytes: 0,
            waiting_jobs: 0,
            waiting_package_bytes: 0,
            active_jobs: 0,
            active_package_bytes: 0,
            ready_results: 0,
            ready_staged_bytes: 0,
            ready_staged_capacity: 0,
            consuming_results: 0,
            consuming_staged_capacity: 0,
            read_buffer_capacity: 0,
            checkpoint_active_heap: 0,
            active_stage_counts: [0; 6],
            completed: 0,
            writer_count: shared.writer_count.load(Relaxed),
            writer_bytes: shared.writer_bytes.load(Relaxed),
            writer_capacity: shared.writer_capacity.load(Relaxed),
        };
        if let Some(jobs) = shared.jobs.get() {
            for job in jobs {
                let state = job.state.load(Relaxed);
                if matches!(state, 0..=5 | WAITING | READY | CONSUMING) {
                    s.in_flight_jobs += 1;
                    s.in_flight_package_bytes += job.bytes;
                }
                match state {
                    0..=5 => {
                        s.active_jobs += 1;
                        s.active_package_bytes += job.bytes;
                        s.active_stage_counts[state] += 1;
                        s.checkpoint_active_heap += job.checkpoint_live.load(Relaxed);
                    }
                    WAITING => {
                        s.waiting_jobs += 1;
                        s.waiting_package_bytes += job.bytes;
                    }
                    READY => {
                        s.ready_results += 1;
                        s.ready_staged_bytes += job.staged_bytes.load(Relaxed);
                        s.ready_staged_capacity += job.staged_capacity.load(Relaxed);
                    }
                    CONSUMING => {
                        s.consuming_results += 1;
                        s.consuming_staged_capacity += job.staged_capacity.load(Relaxed);
                    }
                    DONE => s.completed += 1,
                    _ => {}
                }
                s.read_buffer_capacity += job.read_capacity.load(Relaxed);
            }
        }
        s
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobTrace {
    index: usize,
    input_bytes: u64,
    scheduled_ns: u64,
    start_ns: u64,
    ready_ns: u64,
    consume_ns: u64,
    end_ns: u64,
    staged_bytes: u64,
    staged_capacity: u64,
    input_buffer_capacity: u64,
    heap_peak: u64,
    stage_heap_peaks: [u64; 6],
    header_live: u64,
    before_package_release_live: u64,
    after_package_release_live: u64,
    points: Vec<Point>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Trace {
    version: u8,
    stages: [&'static str; 6],
    heap_counting: bool,
    interval_ms: u64,
    core_start_ns: u64,
    idle_start_ns: u64,
    end_ns: u64,
    table_bytes: [u64; 4],
    table_labels: [&'static str; 4],
    dropped_jobs: u64,
    dropped_samples: u64,
    samples: Vec<Sample>,
    jobs: Vec<JobTrace>,
}
impl Drop for Probe {
    fn drop(&mut self) {
        let Some(shared) = &self.shared else {
            return;
        };
        let idle_start = shared.now();
        shared.idle.store(true, Relaxed);
        std::thread::sleep(Duration::from_secs(2));
        shared.stop.store(true, Relaxed);
        let samples = self
            .sampler
            .take()
            .and_then(|s| s.join().ok())
            .unwrap_or_default();
        let jobs = shared
            .jobs
            .get()
            .map(|jobs| {
                jobs.iter()
                    .enumerate()
                    .map(|(index, j)| JobTrace {
                        index,
                        input_bytes: j.bytes,
                        scheduled_ns: j.scheduled.load(Relaxed),
                        start_ns: j.start.load(Relaxed),
                        ready_ns: j.ready.load(Relaxed),
                        consume_ns: j.consume.load(Relaxed),
                        end_ns: j.end.load(Relaxed),
                        staged_bytes: j.staged_bytes.load(Relaxed),
                        staged_capacity: j.staged_capacity.load(Relaxed),
                        input_buffer_capacity: j.read_peak_capacity.load(Relaxed),
                        heap_peak: j.heap_peak.load(Relaxed),
                        stage_heap_peaks: std::array::from_fn(|i| j.stage_peaks[i].load(Relaxed)),
                        header_live: j.header_live.load(Relaxed),
                        before_package_release_live: j.before_release.load(Relaxed),
                        after_package_release_live: j.after_release.load(Relaxed),
                        points: std::mem::take(
                            &mut *j.points.lock().unwrap_or_else(PoisonError::into_inner),
                        ),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let trace = Trace {
            version: 1,
            stages: ["read", "parse", "decode", "project", "release", "serialize"],
            heap_counting: process_metrics::thread_heap_live().is_some(),
            interval_ms: 100,
            core_start_ns: shared.core_start.load(Relaxed),
            idle_start_ns: idle_start,
            end_ns: shared.now(),
            table_bytes: shared.tables.get().copied().unwrap_or_default(),
            table_labels: ["requestPaths", "roots", "discoveredPaths", "stagingGroups"],
            dropped_jobs: shared.dropped_jobs.load(Relaxed),
            dropped_samples: shared.dropped_samples.load(Relaxed),
            samples,
            jobs,
        };
        if let Some(directory) = &self.directory {
            let output = || -> Result<(), Box<dyn std::error::Error>> {
                std::fs::create_dir_all(directory)?;
                let file = std::fs::File::create(
                    directory.join(format!("reader-memory-{}.json", std::process::id())),
                )?;
                serde_json::to_writer(std::io::BufWriter::new(file), &trace)?;
                Ok(())
            };
            if output().is_err() {
                eprintln!("reader memory measurement write failed");
            }
        }
        REQUEST.with_borrow_mut(|r| *r = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Arc<Shared> {
        let shared = Arc::new(Shared {
            start: Instant::now(),
            jobs: OnceLock::new(),
            tables: OnceLock::new(),
            core_start: AtomicU64::new(0),
            writer_count: AtomicU64::new(2),
            writer_bytes: AtomicU64::new(10),
            writer_capacity: AtomicU64::new(32768),
            stop: AtomicBool::new(false),
            idle: AtomicBool::new(false),
            dropped_jobs: AtomicU64::new(0),
            dropped_samples: AtomicU64::new(0),
        });
        assert!(
            shared
                .jobs
                .set((1..=5).map(|size| Entry::new(size * 100)).collect())
                .is_ok()
        );
        shared
    }

    #[test]
    fn sampling_partitions_the_window_and_keeps_buffer_capacities_separate() {
        let shared = shared();
        let jobs = shared.jobs.get().unwrap();
        for (job, state) in
            jobs.iter()
                .zip([WAITING, Stage::Decode as usize, READY, CONSUMING, DONE])
        {
            job.state.store(state, Relaxed);
            job.staged_bytes.store(11, Relaxed);
            job.staged_capacity.store(32, Relaxed);
        }
        jobs[1].read_capacity.store(200, Relaxed);
        let sample = Sample::take(&shared);
        assert_eq!(sample.in_flight_jobs, 4);
        assert_eq!(sample.in_flight_package_bytes, 1000);
        assert_eq!((sample.active_jobs, sample.active_package_bytes), (1, 200));
        assert_eq!(
            (
                sample.ready_results,
                sample.ready_staged_bytes,
                sample.ready_staged_capacity
            ),
            (1, 11, 32)
        );
        assert_eq!(
            (sample.consuming_results, sample.consuming_staged_capacity),
            (1, 32)
        );
        assert_eq!(sample.read_buffer_capacity, 200);
        assert_eq!(
            (
                sample.writer_count,
                sample.writer_bytes,
                sample.writer_capacity
            ),
            (2, 10, 32768)
        );
        assert_eq!(sample.completed, 1);
    }

    #[test]
    fn memory_envelopes_remain_bounded_after_many_checkpoints() {
        let shared = shared();
        let mut context = Context {
            shared: Arc::clone(&shared),
            index: 0,
            balance: 0,
            stage: Stage::Read,
            points: Vec::new(),
            pending_peak: 0,
        };
        for _ in 0..2001 {
            context.capture(Stage::Project, true);
        }
        assert!(context.points.len() <= MAX_POINTS);
        assert!(context.points.windows(2).all(|p| p[0].ns <= p[1].ns));
    }
}
