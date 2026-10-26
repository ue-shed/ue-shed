//! Bounded cold-scan attribution, enabled only by UE_SHED_COLD_SCAN_MEASURE_DIR.
//! Records contain numeric counters and static labels only; input identities never enter them.
pub use process_metrics::thread_cpu_ns;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

pub fn timestamp_ms() -> f64 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
pub struct PackageTimer {
    start: Option<(Instant, Option<u64>)>,
    pub bytes: u64,
    pub kind: &'static str,
}
impl Default for PackageTimer {
    fn default() -> Self {
        Self::new()
    }
}
impl PackageTimer {
    pub fn new() -> Self {
        Self {
            start: enabled().then(|| (Instant::now(), thread_cpu_ns().ok())),
            bytes: 0,
            kind: "Unknown",
        }
    }
}
impl Drop for PackageTimer {
    fn drop(&mut self) {
        if let Some((start, cpu)) = self.start {
            package(Package {
                bytes: self.bytes,
                kind: self.kind,
                wall_ms: start.elapsed().as_secs_f64() * 1000.0,
                cpu_ms: cpu
                    .zip(thread_cpu_ns().ok())
                    .map_or(0.0, |(a, b)| b.saturating_sub(a) as f64 / 1e6),
                end_ms: timestamp_ms(),
            });
        }
    }
}

fn directory() -> &'static Option<PathBuf> {
    static DIRECTORY: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIRECTORY.get_or_init(|| std::env::var_os("UE_SHED_COLD_SCAN_MEASURE_DIR").map(PathBuf::from))
}
pub fn enabled() -> bool {
    directory().is_some()
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    calls: u64,
    wall_ms: f64,
    cpu_ms: f64,
    exclusive_wall_ms: f64,
    exclusive_cpu_ms: f64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    timings: BTreeMap<&'static str, BTreeMap<String, Timing>>,
    counters: BTreeMap<&'static str, u64>,
    package_histogram: [u64; 8],
    top_packages: Vec<Package>,
    last_packages: Vec<Package>,
    checkpoints: Vec<serde_json::Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Package {
    pub bytes: u64,
    pub kind: &'static str,
    pub wall_ms: f64,
    pub cpu_ms: f64,
    pub end_ms: f64,
}
fn data() -> &'static Mutex<Data> {
    static DATA: OnceLock<Mutex<Data>> = OnceLock::new();
    DATA.get_or_init(|| Mutex::new(Data::default()))
}
fn lock() -> std::sync::MutexGuard<'static, Data> {
    data()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
thread_local! {
    static CHILDREN: RefCell<Vec<(f64, f64)>> = const { RefCell::new(Vec::new()) };
}
/// Inclusive and exclusive wall/CPU sums, aggregated per label and thread, never per row.
pub struct Span {
    label: &'static str,
    start: Option<(Instant, Option<u64>)>,
}
impl Span {
    pub fn new(label: &'static str) -> Self {
        let start = enabled().then(|| (Instant::now(), process_metrics::thread_cpu_ns().ok()));
        if start.is_some() {
            CHILDREN.with_borrow_mut(|s| s.push((0.0, 0.0)));
        }
        Self { label, start }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        let Some((start, cpu)) = self.start else {
            return;
        };
        let cpu = cpu
            .zip(process_metrics::thread_cpu_ns().ok())
            .map_or(0.0, |(a, b)| b.saturating_sub(a) as f64 / 1e6);
        let wall = start.elapsed().as_secs_f64() * 1000.0;
        let children = CHILDREN.with_borrow_mut(|s| {
            let children = s.pop().unwrap_or_default();
            if let Some(parent) = s.last_mut() {
                parent.0 += wall;
                parent.1 += cpu;
            }
            children
        });
        let mut d = lock();
        let t = d
            .timings
            .entry(self.label)
            .or_default()
            .entry(format!("{:?}", std::thread::current().id()))
            .or_default();
        t.calls += 1;
        t.wall_ms += wall;
        t.cpu_ms += cpu;
        t.exclusive_wall_ms += (wall - children.0).max(0.0);
        t.exclusive_cpu_ms += (cpu - children.1).max(0.0);
    }
}
pub fn count(label: &'static str, amount: u64) {
    if enabled() {
        *lock().counters.entry(label).or_default() += amount;
    }
}
pub fn high_water(label: &'static str, amount: u64) {
    if enabled() {
        let mut data = lock();
        let high = data.counters.entry(label).or_default();
        *high = (*high).max(amount);
    }
}
pub fn package(value: Package) {
    if enabled() {
        lock().record_package(value);
    }
}
impl Data {
    fn record_package(&mut self, value: Package) {
        let bounds = [1.0, 5.0, 20.0, 100.0, 500.0, 2000.0, 10000.0];
        let bin = bounds
            .iter()
            .position(|bound| value.wall_ms < *bound)
            .unwrap_or(7);
        self.package_histogram[bin] += 1;
        self.last_packages.push(Package { ..value });
        self.last_packages
            .sort_by(|a, b| b.end_ms.total_cmp(&a.end_ms));
        self.last_packages.truncate(10);
        self.top_packages.push(value);
        self.top_packages
            .sort_by(|a, b| b.wall_ms.total_cmp(&a.wall_ms));
        self.top_packages.truncate(10);
    }
}
fn cpu_delta(
    before: &process_metrics::CpuSnapshot,
    after: &process_metrics::CpuSnapshot,
) -> serde_json::Value {
    let threads = after
        .threads
        .iter()
        .filter_map(|(id, ns)| {
            let delta = ns.saturating_sub(*before.threads.get(id).unwrap_or(&0));
            (delta > 0).then_some((id.to_string(), delta as f64 / 1e6))
        })
        .collect::<BTreeMap<_, _>>();
    serde_json::json!({"cpuMs": after.total_ns.saturating_sub(before.total_ns) as f64 / 1e6, "threadCpuMs": threads})
}
/// Coarse boundaries sample process CPU, including Rayon workers, without enumerating threads.
pub struct Cursor {
    start: Option<(Instant, process_metrics::CpuSnapshot)>,
}
impl Default for Cursor {
    fn default() -> Self {
        Self::new()
    }
}
fn fast_cpu_snapshot() -> process_metrics::CpuSnapshot {
    process_metrics::CpuSnapshot {
        total_ns: process_metrics::process_cpu_ns().unwrap_or_default(),
        ..Default::default()
    }
}
impl Cursor {
    pub fn new() -> Self {
        Self {
            start: enabled().then(|| (Instant::now(), fast_cpu_snapshot())),
        }
    }
    pub fn mark(&mut self, label: &'static str) {
        let Some((start, before)) = self.start.take() else {
            return;
        };
        let wall = start.elapsed().as_secs_f64() * 1000.0;
        let after = fast_cpu_snapshot();
        let mut value = cpu_delta(&before, &after);
        value["label"] = label.into();
        value["wallMs"] = wall.into();
        let mut d = lock();
        if d.checkpoints.len() < 256 {
            d.checkpoints.push(value);
        } else {
            *d.counters
                .entry("measurement.dropped_checkpoints")
                .or_default() += 1;
        }
        self.start = Some((Instant::now(), after));
    }
}
/// A request owns the aggregated samples until all its workers have joined.
pub struct Request {
    label: &'static str,
    start: Option<(
        Instant,
        process_metrics::CpuSnapshot,
        crate::snapshot::IoMetrics,
    )>,
}
impl Request {
    pub fn new(label: &'static str) -> Self {
        if enabled() {
            timestamp_ms();
        }
        let start = enabled().then(|| {
            let mut before = process_metrics::cpu_snapshot().unwrap_or_default();
            *lock() = Data::default();
            let io = crate::snapshot::io_metrics();
            before.total_ns = process_metrics::process_cpu_ns().unwrap_or_default();
            (Instant::now(), before, io)
        });
        Self { label, start }
    }
    pub fn elapsed_ms(&self) -> f64 {
        self.start
            .as_ref()
            .map_or(0.0, |(s, _, _)| s.elapsed().as_secs_f64() * 1000.0)
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        let Some((start, before, io)) = &self.start else {
            return;
        };
        let wall = start.elapsed().as_secs_f64() * 1000.0;
        let cpu = process_metrics::process_cpu_ns().unwrap_or_default();
        let mut after = process_metrics::cpu_snapshot().unwrap_or_default();
        after.total_ns = cpu;
        let mut value = cpu_delta(before, &after);
        let samples = std::mem::take(&mut *lock());
        value["label"] = self.label.into();
        value["wallMs"] = wall.into();
        value["pid"] = std::process::id().into();
        value["endMs"] = timestamp_ms().into();
        value["samples"] = serde_json::to_value(samples).unwrap_or_default();
        let now = crate::snapshot::io_metrics();
        value["snapshotIo"] = serde_json::json!({
            "storedBytes": now.stored_bytes.saturating_sub(io.stored_bytes),
            "rawBytes": now.raw_bytes.saturating_sub(io.raw_bytes),
            "indexBytes": now.index_bytes.saturating_sub(io.index_bytes),
            "writtenBytes": now.written_bytes.saturating_sub(io.written_bytes),
            "opens": now.opens.saturating_sub(io.opens),
            "loads": now.section_loads.saturating_sub(io.section_loads),
            "verifies": now.full_verifies.saturating_sub(io.full_verifies)
        });
        if let Some(directory) = directory() {
            let result = (|| -> std::io::Result<()> {
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(directory.join(format!("cold-scan-{}.ndjson", std::process::id())))?;
                writeln!(f, "{value}")
            })();
            if result.is_err() {
                eprintln!("cold-scan measurement write failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn package_retention_and_histogram_are_bounded() {
        let mut samples = super::Data::default();
        for index in 0..1001 {
            samples.record_package(super::Package {
                bytes: index,
                kind: "Other",
                wall_ms: index as f64,
                cpu_ms: 0.0,
                end_ms: index as f64,
            });
        }
        assert_eq!(samples.top_packages.len(), 10);
        assert_eq!(samples.last_packages.len(), 10);
        assert_eq!(samples.top_packages[0].bytes, 1000);
        assert_eq!(samples.last_packages[0].bytes, 1000);
        assert_eq!(samples.package_histogram.iter().sum::<u64>(), 1001);
        assert_eq!(samples.package_histogram, [1, 4, 15, 80, 400, 501, 0, 0]);
    }
    #[test]
    fn package_summary_is_bounded_and_contains_no_identity_fields() {
        let value = super::Package {
            bytes: 12,
            kind: "DataTable",
            wall_ms: 1.0,
            cpu_ms: 0.5,
            end_ms: 2.0,
        };
        let json = serde_json::to_value(value).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 5);
        assert!(json.get("path").is_none());
        assert!(json.get("name").is_none());
    }
}
