use std::env;
use std::fs;
use std::hint::black_box;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use uasset_inspection::generic::{inspect_bytes, inspect_bytes_json};

const DEFAULT_RUNS: usize = 20;
const DEFAULT_WARMUPS: usize = 3;

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
    let display_path = path.display().to_string();
    let inspection =
        inspect_bytes(&display_path, &source).map_err(|error| error.message.clone())?;
    let json = inspect_bytes_json(&display_path, &source);

    let inspect = measure(runs, warmups, || {
        inspect_bytes(black_box(&display_path), black_box(&source))
    });
    let serialize_to_string = measure(runs, warmups, || {
        serde_json::to_string(black_box(&inspection)).unwrap()
    });
    let serialize_to_sink = measure(runs, warmups, || {
        serde_json::to_writer(std::io::sink(), black_box(&inspection)).unwrap()
    });
    let inspect_json = measure(runs, warmups, || {
        inspect_bytes_json(black_box(&display_path), black_box(&source))
    });

    println!(
        "input={} bytes={} runs={runs} warmups={warmups}",
        path.display(),
        source.len()
    );
    println!(
        "observed assets={} errors={} json_bytes={}",
        inspection.assets.len(),
        inspection.decode_errors.len(),
        json.len()
    );
    print_distribution("inspect", &inspect);
    print_distribution("serialize.string", &serialize_to_string);
    print_distribution("serialize.sink", &serialize_to_sink);
    print_distribution("inspect_json", &inspect_json);
    Ok(())
}

fn parse_arguments() -> Result<(PathBuf, usize, usize), String> {
    let mut arguments = env::args_os().skip(1);
    let path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "usage: benchmark_inspection <package> [runs] [warmups]".to_owned())?;
    let runs = parse_count(arguments.next(), "runs", DEFAULT_RUNS)?;
    let warmups = parse_count(arguments.next(), "warmups", DEFAULT_WARMUPS)?;
    if arguments.next().is_some() {
        return Err("usage: benchmark_inspection <package> [runs] [warmups]".to_owned());
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
