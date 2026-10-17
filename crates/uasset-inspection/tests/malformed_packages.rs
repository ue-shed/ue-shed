//! A malformed package must give a typed error, never a crash. Each committed fixture package is
//! truncated and corrupted in deterministic ways and run through the parser, every export decoder
//! and the portable projections; any panic fails the test with the package and mutation.

use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use uasset_inspection::blueprint::project_blueprint_graphs;
use uasset_inspection::level_sequence::project_level_sequence;
use uasset_inspection::projection::{project_text_asset, project_texture_asset};
use uasset_inspection::saved_world::project_saved_world_package;
use uasset_parser::asset::{AssetDecodeContext, decode_export};
use uasset_parser::package::Package;

fn packages(directory: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            packages(&path, found);
        } else if path
            .extension()
            .is_some_and(|extension| extension == "uasset" || extension == "umap")
            && entry
                .metadata()
                .is_ok_and(|metadata| metadata.len() < 400 * 1024)
        {
            found.push(path);
        }
    }
}

/// Parses, decodes and projects one package; errors are fine, panics are not.
fn exercise(path: &str, bytes: &[u8]) {
    let _ = uasset_inspection::generic::inspect_bytes(path, bytes);
    let _ = uasset_inspection::saved_inspection::inspect_bytes(path, bytes);
    let Ok(package) = Package::parse(bytes) else {
        return;
    };
    let context = AssetDecodeContext {
        source: bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let assets: Vec<_> = package
        .exports
        .iter()
        .filter_map(|export| decode_export(export, &context).ok().flatten())
        .collect();
    for asset in &assets {
        let _ = project_text_asset(&package, asset);
        let _ = project_texture_asset(&package, asset, bytes.len() as u64);
    }
    let _ = project_blueprint_graphs(&package, &assets);
    let _ = project_level_sequence(&package, &assets);
    let _ = project_saved_world_package(&package, &assets);
}

/// xorshift64*: a fixed sequence, so a failure always reproduces.
struct Sequence(u64);
impl Sequence {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

/// Truncations, single-byte flips and 32-bit fields overwritten with extreme values.
fn mutations(bytes: &[u8], seed: u64) -> Vec<(String, Vec<u8>)> {
    let mut sequence = Sequence(seed | 1);
    let mut mutated = Vec::new();
    let len = bytes.len();
    for step in 0..48 {
        let end = len * step / 48;
        mutated.push((format!("truncated at {end}"), bytes[..end].to_vec()));
    }
    for _ in 0..160 {
        let offset = (sequence.next() as usize) % len;
        let mut copy = bytes.to_vec();
        copy[offset] ^= 1 << (sequence.next() % 8);
        mutated.push((format!("bit flipped at {offset}"), copy));
    }
    for value in [u32::MAX, 0x7fff_ffff, 0x8000_0000, 0xffff_fffe, 0x0010_0000] {
        for _ in 0..24 {
            let offset = ((sequence.next() as usize) % len.saturating_sub(4).max(1)) & !3;
            let mut copy = bytes.to_vec();
            if offset + 4 <= len {
                copy[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
            mutated.push((format!("{value:#x} written at {offset}"), copy));
        }
    }
    mutated
}

#[test]
fn malformed_packages_never_panic() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let mut found = Vec::new();
    packages(&root, &mut found);
    found.sort();
    assert!(!found.is_empty(), "fixture packages are committed");
    let hook = panic::take_hook();
    panic::set_hook(Box::new(|_| {}));
    let mut panics = Vec::new();
    for (index, file) in found.iter().enumerate() {
        let Ok(bytes) = fs::read(file) else {
            continue;
        };
        let name = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        for (mutation, mutated) in mutations(&bytes, 0x9e37_79b9_7f4a_7c15 ^ index as u64) {
            let outcome = panic::catch_unwind(AssertUnwindSafe(|| exercise(&name, &mutated)));
            if let Err(payload) = outcome {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| {
                        payload
                            .downcast_ref::<&str>()
                            .map(|text| (*text).to_owned())
                    })
                    .unwrap_or_default();
                panics.push(format!("{name}, {mutation}: {message}"));
            }
        }
    }
    panic::set_hook(hook);
    assert!(
        panics.is_empty(),
        "{} panics:\n{}",
        panics.len(),
        panics.join("\n")
    );
}
