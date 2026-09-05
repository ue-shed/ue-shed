//! Read-only, evenly sampled header replay. Loading and validation are outside the timed loop.
use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::hint::black_box;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use uasset_parser::{Package, PackageSummary};

fn discover(root: &Path, paths: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            discover(&entry.path(), paths)?;
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("uasset") || v.eq_ignore_ascii_case("umap"))
        {
            paths.push(entry.path());
        }
    }
    Ok(())
}

fn load(path: &Path) -> Result<(Vec<u8>, usize), Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    let file_len = usize::try_from(file.metadata()?.len())?;
    let mut bytes = vec![0; file_len.min(4096)];
    file.read_exact(&mut bytes)?;
    let summary = loop {
        match PackageSummary::parse_with_file_len(&bytes, file_len) {
            Ok(summary) => break summary,
            Err(_) if bytes.len() < file_len.min(65536) => {
                let old = bytes.len();
                bytes.resize((old * 2).max(1).min(file_len).min(65536), 0);
                file.read_exact(&mut bytes[old..])?;
            }
            Err(error) => return Err(error.into()),
        }
    };
    let header_len = usize::try_from(summary.total_header_size)?;
    if header_len > 64 * 1024 * 1024 {
        return Err("header exceeds benchmark limit".into());
    }
    let old = bytes.len();
    bytes.resize(header_len, 0);
    if header_len > old {
        file.read_exact(&mut bytes[old..])?;
    }
    Ok((bytes, file_len))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("usage: benchmark_headers <project-root>".into());
    }
    let mut paths = Vec::new();
    discover(&PathBuf::from(&args[0]).join("Content"), &mut paths)?;
    paths.sort();
    let selected = paths.len().min(4096);
    let mut headers = Vec::new();
    let mut failures = 0;
    let mut digest = DefaultHasher::new();
    let mut bytes_loaded = 0;
    for index in 0..selected {
        let (bytes, file_len) = load(&paths[index * paths.len() / selected])?;
        // Bound total replay memory independently of the real project size.
        if bytes_loaded + bytes.len() > 512 * 1024 * 1024 {
            break;
        }
        bytes_loaded += bytes.len();
        match Package::parse_header(&bytes, file_len) {
            Ok(package) => format!("{package:?}").hash(&mut digest),
            Err(error) => {
                error.to_string().hash(&mut digest);
                failures += 1;
            }
        }
        headers.push((bytes, file_len));
    }
    let mut samples = Vec::new();
    for run in 0..12 {
        let start = Instant::now();
        for (bytes, file_len) in &headers {
            black_box(Package::parse_header(black_box(bytes), *file_len)).ok();
        }
        if run >= 2 {
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "discovered": paths.len(), "sampled": headers.len(), "headerBytes": bytes_loaded,
            "parseFailures": failures, "debugDigest": format!("{:016x}", digest.finish()),
            "samplesMs": samples, "warmups": 2
        })
    );
    Ok(())
}
