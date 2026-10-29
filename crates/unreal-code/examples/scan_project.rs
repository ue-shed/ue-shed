//! Times a scan of a project's source: `cargo run --release --example scan_project -- <project>
//! <4.27|5.7|5.8> [engine-root]`. It reads `Source`, `Plugins` and `Config` (`*.cpp`, `*.h`,
//! `*.ini`) as one target would, plus the engine's `Source` and `Plugins` for the wrapper prepass
//! when an engine root is given. Set `RAYON_NUM_THREADS=1` for the single-threaded figure.

use std::path::{Path, PathBuf};
use std::time::Instant;

use unreal_code::{CodeFile, DiskStore, EngineLine, ScanSettings, find_wrappers, scan};

fn walk(
    folder: &Path,
    base: &Path,
    extensions: &[&str],
    skip: Option<&Path>,
    files: &mut Vec<CodeFile>,
) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let location = entry.path();
        if skip.is_some_and(|skip| location.starts_with(skip)) {
            continue;
        }
        if location.is_dir() {
            walk(&location, base, extensions, skip, files);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".generated.h") || name.ends_with(".gen.cpp") {
            continue;
        }
        if extensions.iter().any(|extension| name.ends_with(extension)) {
            let path = location
                .strip_prefix(base)
                .unwrap_or(&location)
                .to_string_lossy()
                .replace('\\', "/");
            files.push(CodeFile { path, location });
        }
    }
}

fn collect(
    base: &Path,
    folders: &[&str],
    extensions: &[&str],
    skip: Option<&Path>,
) -> Vec<CodeFile> {
    let mut files = Vec::new();
    for folder in folders {
        walk(&base.join(folder), base, extensions, skip, &mut files);
    }
    files.sort_by_key(|file| file.path.to_ascii_lowercase());
    files
}

fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let (Some(project), Some(engine)) = (arguments.first(), arguments.get(1)) else {
        eprintln!("usage: scan_project <project> <4.27|5.7|5.8> [engine-root]");
        std::process::exit(2);
    };
    let project = PathBuf::from(project);
    let engine = match engine.as_str() {
        "4.27" => EngineLine::Ue4_27,
        "5.7" => EngineLine::Ue5_7,
        _ => EngineLine::Ue5_8,
    };
    let engine_root = arguments.get(2).map(PathBuf::from);

    let started = Instant::now();
    let files = collect(
        &project,
        &["Source", "Plugins", "Config"],
        &[".cpp", ".h", ".ini"],
        None,
    );
    let prepass_project = collect(&project, &["Source", "Plugins"], &[".cpp", ".h"], None);
    let prepass_engine = engine_root
        .as_ref()
        .map(|root| {
            let engine_folder = root.join("Engine");
            let third_party = engine_folder.join("Source/ThirdParty");
            collect(
                &engine_folder,
                &["Source", "Plugins"],
                &[".cpp", ".h"],
                Some(&third_party),
            )
        })
        .unwrap_or_default();
    let listed = started.elapsed();

    let started = Instant::now();
    let mut wrappers = find_wrappers(engine, &prepass_engine, &DiskStore);
    let engine_prepass = started.elapsed();
    let started = Instant::now();
    wrappers.extend(find_wrappers(engine, &prepass_project, &DiskStore));
    let project_prepass = started.elapsed();

    let settings = ScanSettings {
        engine,
        gather_editor_only: false,
        game_content: project.join("Content"),
        engine_content: engine_root
            .map(|root| root.join("Engine/Content"))
            .unwrap_or_default(),
        split_platforms: Vec::new(),
    };
    let started = Instant::now();
    let result = scan(&settings, &files, &wrappers, &DiskStore);
    let scanned = started.elapsed();

    let megabytes = result.bytes_read as f64 / 1_048_576.0;
    println!(
        "files listed: {} target, {} project prepass, {} engine prepass in {listed:.2?}",
        files.len(),
        prepass_project.len(),
        prepass_engine.len()
    );
    println!(
        "engine prepass: {engine_prepass:.2?}; project prepass: {project_prepass:.2?}; wrappers: {}",
        wrappers.len()
    );
    println!(
        "scan: {scanned:.2?} for {megabytes:.1} MB ({:.0} MB/s); {} files through the line scanner, {} skipped",
        megabytes / scanned.as_secs_f64(),
        result.files_scanned,
        result.files_skipped
    );
    let gathered = result.places.iter().filter(|place| place.gathered).count();
    println!(
        "places: {} ({gathered} gathered); diagnostics: {}",
        result.places.len(),
        result.diagnostics.len()
    );
}
