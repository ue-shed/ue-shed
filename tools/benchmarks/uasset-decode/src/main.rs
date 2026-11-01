//! Single-threaded saved-package decode measurements and byte-equivalence fingerprints.
#![deny(unsafe_code)]

use std::error::Error;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::mem::size_of;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uasset_inspection::blueprint_classes::blueprint_classes;
use uasset_inspection::generic::inspect_bytes_json;
use uasset_inspection::projection::{TextDecodeFilter, project_text_asset};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, decode_export};
use uasset_parser::property::{PropertyRecord, PropertyValue, TextValue};
use uasset_parser::schema::embedded_source_model;

mod coverage;

type Fallible<T> = Result<T, Box<dyn Error>>;
const STAGES: [&str; 5] = ["parse", "decode", "project", "drop", "inspect"];

// GlobalAlloc requires unsafe forwarding. This is the only unsafe module; each call delegates
// the caller's unchanged pointer/layout contract to System and records successful allocations.
#[allow(unsafe_code)]
mod counting_allocator {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

    pub struct CountingAllocator;

    static COUNT: AtomicU64 = AtomicU64::new(0);
    static BYTES: AtomicU64 = AtomicU64::new(0);
    static LIVE: AtomicU64 = AtomicU64::new(0);
    static PEAK: AtomicU64 = AtomicU64::new(0);

    #[derive(Clone, Copy)]
    pub struct Snapshot {
        count: u64,
        bytes: u64,
        live: u64,
    }

    #[derive(Default)]
    pub struct Measurement {
        pub count: u64,
        pub bytes: u64,
        pub peak: u64,
    }

    pub fn start() -> Snapshot {
        let live = LIVE.load(Relaxed);
        PEAK.store(live, Relaxed);
        Snapshot {
            count: COUNT.load(Relaxed),
            bytes: BYTES.load(Relaxed),
            live,
        }
    }

    pub fn finish(start: Snapshot) -> Measurement {
        Measurement {
            count: COUNT.load(Relaxed) - start.count,
            bytes: BYTES.load(Relaxed) - start.bytes,
            peak: PEAK.load(Relaxed).saturating_sub(start.live),
        }
    }

    fn allocated(size: usize) {
        COUNT.fetch_add(1, Relaxed);
        BYTES.fetch_add(size as u64, Relaxed);
        let live = LIVE.fetch_add(size as u64, Relaxed) + size as u64;
        PEAK.fetch_max(live, Relaxed);
    }

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            // SAFETY: GlobalAlloc's caller supplies a valid allocation layout.
            let pointer = unsafe { System.alloc(layout) };
            if !pointer.is_null() {
                allocated(layout.size());
            }
            pointer
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            // SAFETY: The original allocation layout is forwarded unchanged.
            let pointer = unsafe { System.alloc_zeroed(layout) };
            if !pointer.is_null() {
                allocated(layout.size());
            }
            pointer
        }

        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            // SAFETY: The caller supplies System's live pointer and its original layout.
            unsafe { System.dealloc(pointer, layout) };
            LIVE.fetch_sub(layout.size() as u64, Relaxed);
        }

        unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            // SAFETY: The pointer, old layout, and new size retain the caller's contract.
            let replacement = unsafe { System.realloc(pointer, layout, new_size) };
            if !replacement.is_null() {
                LIVE.fetch_sub(layout.size() as u64, Relaxed);
                // A successful realloc counts once, with its full requested new size.
                allocated(new_size);
            }
            replacement
        }
    }
}

#[global_allocator]
static ALLOCATOR: counting_allocator::CountingAllocator = counting_allocator::CountingAllocator;

struct Args {
    list: PathBuf,
    out: PathBuf,
    runs: usize,
    digest_only: bool,
    text_filter: bool,
    coverage_root: Option<PathBuf>,
    evidence: bool,
}

impl Args {
    fn read() -> Fallible<Self> {
        let mut arguments = std::env::args().skip(1);
        let mut list = None;
        let mut out = None;
        let mut runs = 3;
        let mut digest_only = false;
        let mut text_filter = false;
        let mut coverage_root = None;
        let mut evidence = false;
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--list" => list = Some(PathBuf::from(next_argument(&mut arguments, "--list")?)),
                "--out" => out = Some(PathBuf::from(next_argument(&mut arguments, "--out")?)),
                "--runs" => {
                    runs = next_argument(&mut arguments, "--runs")?.parse()?;
                    if runs == 0 {
                        return Err("--runs must be greater than zero".into());
                    }
                }
                "--digest-only" => digest_only = true,
                "--text-filter" => text_filter = true,
                "--coverage-root" => {
                    coverage_root = Some(PathBuf::from(next_argument(
                        &mut arguments,
                        "--coverage-root",
                    )?))
                }
                "--evidence" => evidence = true,
                "--help" | "-h" => {
                    println!(
                        "uasset-decode --list <file> --out <dir> [--runs N] [--digest-only] [--text-filter] [--coverage-root <Content directory>] [--evidence]"
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("unknown argument: {argument}").into()),
            }
        }
        Ok(Self {
            list: list.ok_or("--list is required")?,
            out: out.ok_or("--out is required")?,
            runs: if digest_only { 1 } else { runs },
            digest_only,
            text_filter,
            coverage_root,
            evidence,
        })
    }
}

fn next_argument(arguments: &mut impl Iterator<Item = String>, flag: &str) -> Fallible<String> {
    arguments
        .next()
        .ok_or_else(|| format!("{flag} requires a value").into())
}

fn read_list(path: &Path) -> Fallible<Vec<String>> {
    let contents = fs::read_to_string(path)?;
    let mut paths = Vec::new();
    for (index, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if !Path::new(line).is_absolute() || line.contains('\t') {
            return Err(format!(
                "{}:{}: expected an absolute package path without tabs",
                path.display(),
                index + 1
            )
            .into());
        }
        paths.push(line.to_owned());
    }
    Ok(paths)
}

#[derive(Default)]
struct Metrics {
    stage_ns: [u64; 5],
    alloc_count: u64,
    alloc_bytes: u64,
    peak_live_bytes: u64,
    inspect_peak_live_bytes: u64,
}

impl Metrics {
    fn record_allocations(&mut self, start: counting_allocator::Snapshot) {
        let measurement = counting_allocator::finish(start);
        self.alloc_count = measurement.count;
        self.alloc_bytes = measurement.bytes;
        self.peak_live_bytes = measurement.peak;
    }

    fn add(&mut self, other: &Self) {
        for (total, value) in self.stage_ns.iter_mut().zip(other.stage_ns) {
            *total += value;
        }
        self.alloc_count += other.alloc_count;
        self.alloc_bytes += other.alloc_bytes;
        self.peak_live_bytes = self.peak_live_bytes.max(other.peak_live_bytes);
        self.inspect_peak_live_bytes = self
            .inspect_peak_live_bytes
            .max(other.inspect_peak_live_bytes);
    }

    fn json(&self) -> Value {
        json!({
            "parse_ns": self.stage_ns[0],
            "decode_ns": self.stage_ns[1],
            "project_ns": self.stage_ns[2],
            "drop_ns": self.stage_ns[3],
            "inspect_ns": self.stage_ns[4],
            "alloc_count": self.alloc_count,
            "alloc_bytes": self.alloc_bytes,
            "peak_live_bytes": self.peak_live_bytes,
            "inspect_peak_live_bytes": self.inspect_peak_live_bytes
        })
    }
}

struct PackageResult<'a> {
    path: &'a str,
    bytes: usize,
    exports: usize,
    parse_error: Option<String>,
    decode_errors: usize,
    metrics: Metrics,
    text_digest: String,
    inspect_digest: String,
}

impl PackageResult<'_> {
    fn json(&self) -> Value {
        let mut output = self.metrics.json();
        output["path"] = json!(self.path);
        output["bytes"] = json!(self.bytes);
        output["exports"] = json!(self.exports);
        output["parse_error"] = json!(self.parse_error);
        output["decode_errors"] = json!(self.decode_errors);
        output
    }
}

fn measure<T>(timed: bool, total: &mut u64, operation: impl FnOnce() -> T) -> T {
    if timed {
        let start = Instant::now();
        let output = operation();
        *total += start.elapsed().as_nanos() as u64;
        output
    } else {
        operation()
    }
}

// Digest framing is fixed: zero-based u64 little-endian export index, followed by each payload's
// u64 little-endian byte length and bytes. Framing prevents ambiguous adjacent payloads.
fn hash_payload(digest: &mut Sha256, bytes: &[u8]) {
    digest.update((bytes.len() as u64).to_le_bytes());
    digest.update(bytes);
}

/// Digest work (projection serialization and hashing) runs only when `digest` is set, so passes
/// without it keep allocation and timing figures free of harness work.
fn inspect_package(
    path: &str,
    timed: bool,
    digest: bool,
    text_filter: bool,
) -> Fallible<PackageResult<'_>> {
    let bytes = fs::read(path)
        .map_err(|error| io::Error::new(error.kind(), format!("reading {path}: {error}")))?;
    let mut result = PackageResult {
        path,
        bytes: bytes.len(),
        exports: 0,
        parse_error: None,
        decode_errors: 0,
        metrics: Metrics::default(),
        text_digest: String::new(),
        inspect_digest: String::new(),
    };
    let allocations = counting_allocator::start();
    let parsed = measure(timed, &mut result.metrics.stage_ns[0], || {
        Package::parse(&bytes)
    });
    let package = match parsed {
        Ok(package) => package,
        Err(error) => {
            result.metrics.record_allocations(allocations);
            let message = error.to_string();
            let digest = format!("parse-error:{:x}", Sha256::digest(message.as_bytes()));
            result.text_digest = digest.clone();
            result.inspect_digest = digest;
            result.parse_error = Some(message);
            return Ok(result);
        }
    };
    result.exports = package.exports.len();
    let context = AssetDecodeContext {
        property_filter: if text_filter {
            Some(&TextDecodeFilter)
        } else {
            None
        },
        source: &bytes,
        package: &package,
        schemas: embedded_source_model(),
    };
    let mut decoded = Vec::with_capacity(package.exports.len());
    for export in &package.exports {
        let asset = measure(timed, &mut result.metrics.stage_ns[1], || {
            decode_export(export, &context)
        });
        decoded.push(asset);
    }
    let mut text_digest = Sha256::new();
    for (index, asset) in decoded.iter().enumerate() {
        text_digest.update((index as u64).to_le_bytes());
        match asset {
            Ok(Some(asset)) => {
                let (projection, classes) = measure(timed, &mut result.metrics.stage_ns[2], || {
                    (
                        project_text_asset(&package, asset),
                        blueprint_classes(&package, asset),
                    )
                });
                // Both TextAssetProjection and Option<SavedAssetBlueprintClasses> implement
                // Serialize: use serde_json::to_vec, the strongest available representation.
                if digest {
                    hash_payload(&mut text_digest, &serde_json::to_vec(&projection)?);
                    hash_payload(&mut text_digest, &serde_json::to_vec(&classes)?);
                }
            }
            Ok(None) => hash_payload(&mut text_digest, b"ok-none"),
            Err(error) => {
                result.decode_errors += 1;
                hash_payload(
                    &mut text_digest,
                    format!("err:{:?}:{}", error.kind(), error.message()).as_bytes(),
                );
            }
        }
    }
    measure(timed, &mut result.metrics.stage_ns[3], || drop(decoded));
    result.metrics.record_allocations(allocations);
    result.text_digest = format!("{:x}", text_digest.finalize());

    let inspect_allocations = counting_allocator::start();
    let inspection = measure(timed, &mut result.metrics.stage_ns[4], || {
        inspect_bytes_json(path, &bytes)
    });
    result.metrics.inspect_peak_live_bytes = counting_allocator::finish(inspect_allocations).peak;
    if digest {
        result.inspect_digest = format!("{:x}", Sha256::digest(inspection.as_bytes()));
    }
    Ok(result)
}

fn git_commit() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let commit = String::from_utf8(output.stdout).ok()?;
    let commit = commit.trim();
    (!commit.is_empty()).then(|| commit.to_owned())
}

fn median(values: impl Iterator<Item = u64>) -> f64 {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        values[middle - 1] as f64 / 2.0 + values[middle] as f64 / 2.0
    } else {
        values[middle] as f64
    }
}

fn print_stages(label: &str, values: impl Iterator<Item = f64>) {
    print!("{label}:");
    for (stage, value) in STAGES.iter().zip(values) {
        print!(" {stage}={:.3}ms", value / 1_000_000.0);
    }
    println!();
}

fn run() -> Fallible<()> {
    let args = Args::read()?;
    let type_sizes = json!({
        "PropertyValue": size_of::<PropertyValue>(),
        "PropertyRecord": size_of::<PropertyRecord>(),
        "TextValue": size_of::<TextValue>()
    });
    println!(
        "Type sizes (bytes): PropertyValue={} PropertyRecord={} TextValue={}",
        size_of::<PropertyValue>(),
        size_of::<PropertyRecord>(),
        size_of::<TextValue>()
    );
    let paths = read_list(&args.list)?;
    fs::create_dir_all(&args.out)?;
    if let Some(root) = &args.coverage_root {
        if args.text_filter || args.digest_only {
            return Err(
                "coverage requires unfiltered decoding and cannot use --digest-only".into(),
            );
        }
        return coverage::run(&paths, root, &args.out, args.evidence);
    }
    if args.evidence {
        return Err("--evidence requires --coverage-root".into());
    }
    let mut digests = BufWriter::new(File::create(args.out.join("digests.tsv"))?);
    let mut runs = Vec::with_capacity(args.runs);
    for pass in 0..args.runs {
        let mut totals = Metrics::default();
        let mut packages = if !args.digest_only && pass + 1 == args.runs {
            Some(BufWriter::new(File::create(
                args.out.join("packages.jsonl"),
            )?))
        } else {
            None
        };
        for path in &paths {
            let package = inspect_package(path, !args.digest_only, pass == 0, args.text_filter)?;
            totals.add(&package.metrics);
            if pass == 0 {
                writeln!(
                    digests,
                    "{}\t{}\t{}",
                    package.path, package.text_digest, package.inspect_digest
                )?;
            }
            if let Some(writer) = packages.as_mut() {
                serde_json::to_writer(&mut *writer, &package.json())?;
                writeln!(writer)?;
            }
        }
        if let Some(mut writer) = packages {
            writer.flush()?;
        }
        if !args.digest_only {
            print_stages(
                &format!("Pass {} ({} packages)", pass + 1, paths.len()),
                totals.stage_ns.iter().map(|value| *value as f64),
            );
        }
        runs.push(totals);
    }
    digests.flush()?;
    if !args.digest_only {
        let output = json!({
            "git_commit": git_commit(),
            "list": args.list,
            "text_filter": args.text_filter,
            "type_sizes": type_sizes,
            "runs": runs.iter().enumerate().map(|(index, totals)| {
                let mut value = totals.json();
                value["pass"] = json!(index + 1);
                value
            }).collect::<Vec<_>>()
        });
        let mut writer = BufWriter::new(File::create(args.out.join("runs.json"))?);
        serde_json::to_writer_pretty(&mut writer, &output)?;
        writeln!(writer)?;
        writer.flush()?;
        print_stages(
            "Median",
            (0..STAGES.len()).map(|index| median(runs.iter().map(|run| run.stage_ns[index]))),
        );
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("uasset-decode: {error}");
        std::process::exit(1);
    }
}
