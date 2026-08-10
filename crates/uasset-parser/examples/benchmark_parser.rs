use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use uasset_parser::Package;
use uasset_parser::asset::{AssetDecodeContext, decode_export};
use uasset_parser::package::ObjectPath;
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};

const DEFAULT_RUNS: usize = 50;
const DEFAULT_WARMUPS: usize = 5;

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

#[derive(Clone, Copy)]
struct DecodeCounts {
    decoded: usize,
    errors: usize,
}

struct Distribution {
    minimum: Duration,
    mean: Duration,
    p50: Duration,
    p95: Duration,
    maximum: Duration,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (path, runs, warmups) = parse_arguments()?;
    let source = fs::read(&path)?;
    let package = Package::parse(&source)?;
    let counts = decode_package(&source, &package);

    let package_parse = measure(runs, warmups, || {
        Package::parse(black_box(&source)).unwrap()
    });
    let decode = measure(runs, warmups, || {
        decode_package(black_box(&source), &package)
    });
    let parse_and_decode = measure(runs, warmups, || {
        let package = Package::parse(black_box(&source)).unwrap();
        decode_package(black_box(&source), &package)
    });

    println!(
        "input={} bytes={} runs={runs} warmups={warmups}",
        path.display(),
        source.len()
    );
    println!(
        "observed names={} imports={} exports={} decoded={} errors={}",
        package.names.len(),
        package.imports.len(),
        package.exports.len(),
        counts.decoded,
        counts.errors
    );
    print_distribution("package.parse", &package_parse);
    print_distribution("asset.decode", &decode);
    print_distribution("parse_and_decode", &parse_and_decode);
    Ok(())
}

fn parse_arguments() -> Result<(PathBuf, usize, usize), String> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "usage: benchmark_parser <package> [runs] [warmups]".to_owned())?;
    let runs = parse_count(arguments.next(), "runs", DEFAULT_RUNS)?;
    let warmups = parse_count(arguments.next(), "warmups", DEFAULT_WARMUPS)?;
    if arguments.next().is_some() {
        return Err("usage: benchmark_parser <package> [runs] [warmups]".to_owned());
    }
    if runs == 0 {
        return Err("runs must be greater than zero".to_owned());
    }
    Ok((path, runs, warmups))
}

fn parse_count(
    value: Option<std::ffi::OsString>,
    label: &str,
    default: usize,
) -> Result<usize, String> {
    value.map_or(Ok(default), |value| {
        value
            .to_str()
            .ok_or_else(|| format!("{label} must be valid UTF-8"))?
            .parse()
            .map_err(|error| format!("invalid {label}: {error}"))
    })
}

fn decode_package(source: &[u8], package: &Package) -> DecodeCounts {
    let schemas = EmptySchemas;
    let context = AssetDecodeContext {
        source,
        package,
        schemas: &schemas,
    };
    let mut counts = DecodeCounts {
        decoded: 0,
        errors: 0,
    };
    for export in &package.exports {
        match black_box(decode_export(export, &context)) {
            Ok(Some(decoded)) => {
                counts.decoded += 1;
                black_box(decoded);
            }
            Ok(None) => {}
            Err(error) => {
                counts.errors += 1;
                black_box(error);
            }
        }
    }
    counts
}

fn measure<T>(runs: usize, warmups: usize, mut operation: impl FnMut() -> T) -> Distribution {
    for _ in 0..warmups {
        black_box(operation());
    }

    let mut samples = Vec::with_capacity(runs);
    for _ in 0..runs {
        let started = Instant::now();
        black_box(operation());
        samples.push(started.elapsed());
    }
    samples.sort_unstable();
    let total = samples.iter().sum::<Duration>();
    Distribution {
        minimum: samples[0],
        mean: total / u32::try_from(samples.len()).expect("run count fits in u32"),
        p50: percentile(&samples, 50),
        p95: percentile(&samples, 95),
        maximum: samples[samples.len() - 1],
    }
}

fn percentile(samples: &[Duration], percentile: usize) -> Duration {
    let rank = samples.len().saturating_mul(percentile).div_ceil(100);
    samples[rank.saturating_sub(1).min(samples.len() - 1)]
}

fn print_distribution(label: &str, distribution: &Distribution) {
    println!(
        "{label:16} min={:.3} ms mean={:.3} ms p50={:.3} ms p95={:.3} ms max={:.3} ms",
        milliseconds(distribution.minimum),
        milliseconds(distribution.mean),
        milliseconds(distribution.p50),
        milliseconds(distribution.p95),
        milliseconds(distribution.maximum)
    );
}

fn milliseconds(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}
