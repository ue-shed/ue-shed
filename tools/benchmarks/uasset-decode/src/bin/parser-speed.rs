//! In-memory parser replay with raw samples and complete decoded-model fingerprints.
use std::error::Error;
use std::fs::{self, File};
use std::hint::black_box;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::json;
use sha2::{Digest, Sha256};
use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};
use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, AssetDecodeSession};
use uasset_parser::schema::embedded_source_model;

type Fallible<T> = Result<T, Box<dyn Error>>;

struct Input {
    path: String,
    bytes: Vec<u8>,
    package: Result<Package, uasset_parser::package::PackageError>,
}

#[derive(Default)]
struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn decode(input: &Input, package: &Package) {
    let context = AssetDecodeContext {
        source: &input.bytes,
        package,
        schemas: embedded_source_model(),
        property_filter: None,
    };
    let mut decoder = AssetDecodeSession::new(&context);
    for export in &package.exports {
        black_box(decoder.decode(black_box(export))).ok();
    }
}

fn replay(inputs: &[Input], operation: &str) -> Fallible<()> {
    for input in inputs {
        match operation {
            "parse" => {
                black_box(Package::parse(black_box(&input.bytes))).ok();
            }
            "decode" => {
                if let Ok(package) = &input.package {
                    decode(input, package);
                }
            }
            "combined" => {
                if let Ok(package) = Package::parse(black_box(&input.bytes)) {
                    decode(input, &package);
                }
            }
            "inspect-json" => {
                black_box(inspect_bytes_json(&input.path, black_box(&input.bytes)));
            }
            "inspect-owned" => {
                black_box(inspect_bytes(&input.path, black_box(&input.bytes))).ok();
            }
            _ => return Err(format!("unknown operation: {operation}").into()),
        }
    }
    Ok(())
}

fn evidence(inputs: &[Input], output: PathBuf) -> Fallible<()> {
    let mut writer = BufWriter::new(File::create(output)?);
    for input in inputs {
        let mut model = HashWriter::default();
        write!(model, "{:?}", input.package)?;
        let mut decoded = 0;
        let mut skipped = 0;
        let mut errors = 0;
        if let Ok(package) = &input.package {
            let context = AssetDecodeContext {
                source: &input.bytes,
                package,
                schemas: embedded_source_model(),
                property_filter: None,
            };
            let mut decoder = AssetDecodeSession::new(&context);
            for export in &package.exports {
                let result = decoder.decode(export);
                match &result {
                    Ok(Some(_)) => decoded += 1,
                    Ok(None) => skipped += 1,
                    Err(_) => errors += 1,
                }
                write!(model, "\n{result:?}")?;
            }
        }
        let inspection = inspect_bytes_json(&input.path, &input.bytes);
        let mut owned = HashWriter::default();
        match inspect_bytes(&input.path, &input.bytes) {
            Ok(value) => serde_json::to_writer(&mut owned, &value)?,
            Err(error) => write!(owned, "{error:?}")?,
        }
        serde_json::to_writer(
            &mut writer,
            &json!({
                "path": input.path,
                "bytes": input.bytes.len(),
                "parsed": input.package.is_ok(),
                "decoded": decoded,
                "skipped": skipped,
                "errors": errors,
                "modelSha256": format!("{:x}", model.0.finalize()),
                "inspectionSha256": format!("{:x}", Sha256::digest(inspection.as_bytes())),
                "ownedSha256": format!("{:x}", owned.0.finalize()),
                "inspectionBytes": inspection.len()
            }),
        )?;
        writeln!(writer)?;
    }
    writer.flush()?;
    Ok(())
}

fn run() -> Fallible<()> {
    let mut args = std::env::args().skip(1);
    let mut list = None;
    let mut operation = "combined".to_owned();
    let mut runs: usize = 21;
    let mut warmups: usize = 3;
    let mut batch_ms: u64 = 30;
    let mut evidence_path = None;
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag.as_str() {
            "--list" => list = Some(value),
            "--operation" => operation = value,
            "--runs" => runs = value.parse()?,
            "--warmups" => warmups = value.parse()?,
            "--batch-ms" => batch_ms = value.parse()?,
            "--evidence" => evidence_path = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument: {flag}").into()),
        }
    }
    if runs == 0 {
        return Err("--runs must be positive".into());
    }
    let list = fs::read_to_string(list.ok_or("--list is required")?)?;
    let mut inputs = Vec::new();
    for path in list.lines().filter(|path| !path.is_empty()) {
        let bytes = fs::read(path)?;
        let package = Package::parse(&bytes);
        inputs.push(Input {
            path: path.to_owned(),
            bytes,
            package,
        });
    }
    if inputs.is_empty() {
        return Err("package list is empty".into());
    }
    black_box(embedded_source_model());
    if let Some(output) = evidence_path {
        return evidence(&inputs, output);
    }
    for _ in 0..warmups {
        replay(&inputs, &operation)?;
    }
    let target = Duration::from_millis(batch_ms);
    let started = Instant::now();
    replay(&inputs, &operation)?;
    let iterations = (target.as_secs_f64() / started.elapsed().as_secs_f64())
        .ceil()
        .clamp(1.0, 100_000.0) as usize;
    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let started = Instant::now();
        for _ in 0..iterations {
            replay(&inputs, &operation)?;
        }
        samples.push(started.elapsed().as_secs_f64() * 1000.0 / iterations as f64);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    println!(
        "{}",
        json!({
            "operation": operation,
            "packages": inputs.len(),
            "bytes": inputs.iter().map(|input| input.bytes.len()).sum::<usize>(),
            "exports": inputs.iter().filter_map(|input| input.package.as_ref().ok())
                .map(|package| package.exports.len()).sum::<usize>(),
            "parseErrors": inputs.iter().filter(|input| input.package.is_err()).count(),
            "runs": runs,
            "warmups": warmups,
            "iterations": iterations,
            "samplesMs": samples,
            "minMs": sorted[0],
            "p50Ms": sorted[(runs - 1) / 2],
            "p95Ms": sorted[(runs * 95).div_ceil(100) - 1],
            "maxMs": sorted[runs - 1]
        })
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("parser-speed: {error}");
        std::process::exit(1);
    }
}
