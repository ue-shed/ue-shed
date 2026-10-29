//! One request for a project's source text, as a host sends it through the Game Text engine:
//! the project, its engine, and each localization target's `GatherTextFromSource` steps.
//!
//! The engine's wrappers come from about 80,000 files and change only with the engine build, so
//! they are kept under the cache root, one file per engine build shared by every project, keyed
//! by the engine's `Build.version`. A source-built engine edited without a version change needs
//! `refreshEngineWrappers`.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::discovery::{
    GatherStep, absolute, relative_to, step_files, step_includes, wrapper_files,
};
use crate::{
    CodeDiagnostic, CodeFile, CodePlace, DiskStore, EngineLine, FileStore, ScanSettings,
    WrapperMacro, find_wrappers, scan,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeTarget {
    pub name: String,
    pub steps: Vec<GatherStep>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeTextRequest {
    pub project_root: String,
    /// The engine installation root, holding `Engine/`. Without it, the engine's wrappers and
    /// `LOCTABLE_FROMFILE_ENGINE` tables are left out, and the result says so.
    pub engine_root: Option<String>,
    pub engine: EngineLine,
    pub targets: Vec<CodeTarget>,
    /// Where the engine's wrappers are kept between scans.
    pub cache_root: Option<String>,
    #[serde(default)]
    pub refresh_engine_wrappers: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileCounts {
    /// Files the steps' search folders and name filters found.
    pub listed: u32,
    /// Of those, files the exclude filters left out.
    pub excluded: u32,
    /// Files that held a descriptor token and went through the line scanner.
    pub scanned: u32,
    /// Files with no token, skipped after a substring search.
    pub skipped: u32,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub bytes_read: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TargetText {
    pub name: String,
    pub places: Vec<CodePlace>,
    pub diagnostics: Vec<CodeDiagnostic>,
    pub files: FileCounts,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "kebab-case")]
pub enum EngineWrappers {
    /// 4.27 has no wrapper prepass.
    NotUsed,
    /// No engine root was given, so the engine's wrappers are missing.
    NoEngineRoot,
    Read,
    Cached,
}

/// Where a scan spent its time, in microseconds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CodeTextProfile {
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub engine_wrappers_micros: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub project_wrappers_micros: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub list_micros: u64,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub scan_micros: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CodeTextResult {
    pub engine: EngineLine,
    pub targets: Vec<TargetText>,
    pub engine_wrappers: EngineWrappers,
    pub wrapper_count: u32,
    pub profile: CodeTextProfile,
}

#[derive(Serialize, Deserialize)]
struct WrapperCache {
    key: String,
    wrappers: Vec<WrapperMacro>,
}

fn micros(since: Instant) -> u64 {
    since.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

/// FNV-1a, for a stable cache file name; the full key is checked inside the file.
fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// The engine's wrappers, with paths relative to the project as Unreal reports them. The cache
/// keeps them relative to the engine root, so every project on one engine build shares a file.
fn engine_wrappers(
    request: &CodeTextRequest,
    project: &Path,
) -> (Vec<WrapperMacro>, EngineWrappers) {
    if request.engine == EngineLine::Ue4_27 {
        return (Vec::new(), EngineWrappers::NotUsed);
    }
    let Some(root) = request.engine_root.as_deref().map(PathBuf::from) else {
        return (Vec::new(), EngineWrappers::NoEngineRoot);
    };
    let (wrappers, state) = engine_wrappers_in_root(request, &root);
    let root = absolute(&root);
    let project = absolute(project);
    let wrappers = wrappers
        .into_iter()
        .map(|mut wrapper| {
            wrapper.file = relative_to(&format!("{root}/{}", wrapper.file), &project);
            wrapper
        })
        .collect();
    (wrappers, state)
}

/// The project's wrappers. 4.27 has no wrapper prepass, so its project is not walked.
fn project_wrappers(request: &CodeTextRequest, project: &Path) -> Vec<WrapperMacro> {
    if request.engine == EngineLine::Ue4_27 {
        return Vec::new();
    }
    find_wrappers(request.engine, &wrapper_files(project, project), &DiskStore)
}

fn engine_wrappers_in_root(
    request: &CodeTextRequest,
    root: &Path,
) -> (Vec<WrapperMacro>, EngineWrappers) {
    let engine_folder = root.join("Engine");
    let version =
        std::fs::read_to_string(engine_folder.join("Build/Build.version")).unwrap_or_default();
    let key = format!(
        "{}\n{}\n{:?}\n{version}",
        env!("CARGO_PKG_VERSION"),
        root.to_string_lossy(),
        request.engine,
    );
    let cache_file = request.cache_root.as_deref().map(|cache| {
        Path::new(cache)
            .join("unreal-code")
            .join(format!("engine-wrappers-{:016x}.json", fnv(&key)))
    });
    if let (Some(file), false) = (&cache_file, request.refresh_engine_wrappers) {
        let cached = std::fs::read(file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<WrapperCache>(&bytes).ok())
            .filter(|cache| cache.key == key);
        if let Some(cache) = cached {
            return (cache.wrappers, EngineWrappers::Cached);
        }
    }
    let wrappers = find_wrappers(
        request.engine,
        &wrapper_files(&engine_folder, root),
        &DiskStore,
    );
    if let Some(file) = cache_file {
        let written = serde_json::to_vec(&WrapperCache {
            key,
            wrappers: wrappers.clone(),
        });
        if let (Some(folder), Ok(bytes)) = (file.parent(), written) {
            // A cache that cannot be written only costs the next scan the engine prepass.
            let _ = std::fs::create_dir_all(folder).and_then(|()| std::fs::write(&file, bytes));
        }
    }
    (wrappers, EngineWrappers::Read)
}

/// Scans each target's steps. Unreal gathers all of a target's steps into one manifest, so their
/// places and diagnostics are reported together.
/// The engine's and the project's wrappers as `run` finds them, and a key that names them, so a
/// cache of scanned files can tell when they change.
pub fn code_wrappers(request: &CodeTextRequest) -> (Vec<WrapperMacro>, String) {
    let project = PathBuf::from(&request.project_root);
    let (mut wrappers, _) = engine_wrappers(request, &project);
    wrappers.extend(project_wrappers(request, &project));
    let mut names = wrappers
        .iter()
        .map(|wrapper| format!("{wrapper:?}"))
        .collect::<Vec<_>>();
    names.sort();
    let key = format!("{:016x}", fnv(&names.join("\n")));
    (wrappers, key)
}

/// Whether the request's one target gathers a file, by its path under the project.
#[must_use]
pub fn target_includes(request: &CodeTextRequest, path: &str) -> bool {
    let project = PathBuf::from(&request.project_root);
    let engine_root = request.engine_root.as_deref().map(Path::new);
    request
        .targets
        .iter()
        .take(1)
        .flat_map(|target| &target.steps)
        .any(|step| step_includes(request.engine, &project, engine_root, step, path))
}

/// Scans given files of the request's one target with `code_wrappers`' wrappers, read through
/// `store`: each a gather path under the project and where its bytes are, as at a revision a host
/// read from version control. Each step scans the files it gathers, judged by path, so a file need
/// not be on disk. On 4.27, String Tables registered in another file than their entries are not
/// seen.
pub fn scan_files(
    request: &CodeTextRequest,
    files: &[CodeFile],
    wrappers: &[WrapperMacro],
    store: &dyn FileStore,
) -> TargetText {
    let project = PathBuf::from(&request.project_root);
    let engine_root = request.engine_root.as_deref().map(Path::new);
    let mut text = TargetText {
        name: request
            .targets
            .first()
            .map_or_else(String::new, |target| target.name.clone()),
        places: Vec::new(),
        diagnostics: Vec::new(),
        files: FileCounts::default(),
    };
    for step in request
        .targets
        .iter()
        .take(1)
        .flat_map(|target| &target.steps)
    {
        let listed = files
            .iter()
            .filter(|file| step_includes(request.engine, &project, engine_root, step, &file.path))
            .cloned()
            .collect::<Vec<_>>();
        let settings = ScanSettings {
            engine: request.engine,
            gather_editor_only: step.gather_editor_only,
            game_content: project.join("Content"),
            engine_content: engine_root
                .map(|root| root.join("Engine/Content"))
                .unwrap_or_default(),
            split_platforms: Vec::new(),
        };
        let result = scan(&settings, &listed, wrappers, store);
        text.files.listed += listed.len() as u32;
        text.files.scanned += result.files_scanned as u32;
        text.files.skipped += result.files_skipped as u32;
        text.files.bytes_read += result.bytes_read;
        text.places.extend(result.places);
        text.diagnostics.extend(result.diagnostics);
    }
    text
}

pub fn run(request: &CodeTextRequest) -> CodeTextResult {
    let project = PathBuf::from(&request.project_root);
    let engine_root = request.engine_root.as_deref().map(Path::new);
    let mut profile = CodeTextProfile::default();

    let started = Instant::now();
    let (mut wrappers, engine_state) = engine_wrappers(request, &project);
    profile.engine_wrappers_micros = micros(started);
    let started = Instant::now();
    wrappers.extend(project_wrappers(request, &project));
    profile.project_wrappers_micros = micros(started);

    let mut targets = Vec::new();
    for target in &request.targets {
        let mut text = TargetText {
            name: target.name.clone(),
            places: Vec::new(),
            diagnostics: Vec::new(),
            files: FileCounts::default(),
        };
        for step in &target.steps {
            let started = Instant::now();
            let listed = step_files(request.engine, &project, engine_root, step);
            profile.list_micros += micros(started);
            let settings = ScanSettings {
                engine: request.engine,
                gather_editor_only: step.gather_editor_only,
                game_content: project.join("Content"),
                engine_content: engine_root
                    .map(|root| root.join("Engine/Content"))
                    .unwrap_or_default(),
                split_platforms: Vec::new(),
            };
            let started = Instant::now();
            let result = scan(&settings, &listed.files, &wrappers, &DiskStore);
            profile.scan_micros += micros(started);
            text.files.listed += (listed.files.len() + listed.excluded) as u32;
            text.files.excluded += listed.excluded as u32;
            text.files.scanned += result.files_scanned as u32;
            text.files.skipped += result.files_skipped as u32;
            text.files.bytes_read += result.bytes_read;
            text.places.extend(result.places);
            text.diagnostics.extend(result.diagnostics);
        }
        targets.push(text);
    }
    CodeTextResult {
        engine: request.engine,
        targets,
        engine_wrappers: engine_state,
        wrapper_count: wrappers.len() as u32,
        profile,
    }
}
