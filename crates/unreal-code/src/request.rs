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
    DiskLister, GatherStep, Lister, absolute, relative_to, step_files, step_includes,
    wrapper_files, wrapper_files_listed,
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
    let (wrappers, state) = engine_wrappers_in_root(request, &root, &DiskLister);
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

/// Names the cache file's contents. Raised when sets kept by an earlier build can no longer be
/// trusted: 2 drops sets from prepasses that could not list every folder (P1).
const WRAPPER_CACHE_SCHEMA: u32 = 2;

fn engine_wrappers_in_root(
    request: &CodeTextRequest,
    root: &Path,
    lister: &dyn Lister,
) -> (Vec<WrapperMacro>, EngineWrappers) {
    let engine_folder = root.join("Engine");
    let version =
        std::fs::read_to_string(engine_folder.join("Build/Build.version")).unwrap_or_default();
    let key = format!(
        "{WRAPPER_CACHE_SCHEMA}\n{}\n{}\n{:?}\n{version}",
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
    let (files, listed) = wrapper_files_listed(&engine_folder, root, lister);
    let (wrappers, read) = crate::wrappers_read(request.engine, &files, &DiskStore);
    // A prepass that could not list a folder or read a header may lack its wrappers: the next
    // scan reads again.
    if let (Some(file), true) = (cache_file, listed && read) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::ListedEntry;

    #[derive(Clone, Copy)]
    enum Failure {
        Listing,
        Entry,
        FileType,
    }

    /// The disk, except one folder whose listing fails as `failure` says.
    struct FailingLister {
        folder: PathBuf,
        failure: Failure,
    }

    impl Lister for FailingLister {
        fn list(&self, folder: &Path) -> std::io::Result<Vec<std::io::Result<ListedEntry>>> {
            let listed = DiskLister.list(folder)?;
            if folder != self.folder {
                return Ok(listed);
            }
            let denied = || std::io::Error::from(std::io::ErrorKind::PermissionDenied);
            match self.failure {
                Failure::Listing => Err(denied()),
                Failure::Entry => Ok(listed.into_iter().map(|_| Err(denied())).collect()),
                Failure::FileType => Ok(listed
                    .into_iter()
                    .map(|entry| {
                        entry.map(|entry| ListedEntry {
                            path: entry.path,
                            is_dir: Err(denied()),
                        })
                    })
                    .collect()),
            }
        }
    }

    struct Engine {
        root: PathBuf,
        cache: PathBuf,
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
            let _ = std::fs::remove_dir_all(&self.cache);
        }
    }

    /// An engine root whose only wrapper sits in `Engine/Source/Nested`; it has no `Plugins`.
    fn engine(name: &str) -> Engine {
        let base = std::env::temp_dir().join(format!(
            "unreal-code-{name}-{}-{}",
            std::process::id(),
            fnv(&format!("{:?}", Instant::now()))
        ));
        let root = base.join("engine");
        let nested = root.join("Engine/Source/Nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(root.join("Engine/Build")).unwrap();
        std::fs::write(root.join("Engine/Build/Build.version"), "{}").unwrap();
        std::fs::write(
            nested.join("Wrap.h"),
            "#define WRAPPED_TEXT(Key, Text) LOCTEXT(Key, Text)\n",
        )
        .unwrap();
        Engine {
            root,
            cache: base.join("cache"),
        }
    }

    fn request(engine: &Engine) -> CodeTextRequest {
        CodeTextRequest {
            project_root: engine.root.join("Project").to_string_lossy().into_owned(),
            engine_root: Some(engine.root.to_string_lossy().into_owned()),
            engine: EngineLine::Ue5_7,
            targets: Vec::new(),
            cache_root: Some(engine.cache.to_string_lossy().into_owned()),
            refresh_engine_wrappers: false,
        }
    }

    fn names(wrappers: &[WrapperMacro]) -> Vec<&str> {
        wrappers
            .iter()
            .map(|wrapper| wrapper.name.as_str())
            .collect()
    }

    #[test]
    fn a_prepass_that_could_not_list_a_folder_is_not_kept() {
        for failure in [Failure::Listing, Failure::Entry, Failure::FileType] {
            let engine = engine("unlisted");
            let request = request(&engine);
            let failing = FailingLister {
                folder: engine.root.join("Engine/Source/Nested"),
                failure,
            };

            let (wrappers, state) = engine_wrappers_in_root(&request, &engine.root, &failing);
            assert_eq!(state, EngineWrappers::Read);
            assert!(names(&wrappers).is_empty());

            // Once the folder lists again, the same engine build finds the wrapper it missed.
            let (wrappers, state) = engine_wrappers_in_root(&request, &engine.root, &DiskLister);
            assert_eq!(state, EngineWrappers::Read);
            assert_eq!(names(&wrappers), ["WRAPPED_TEXT"]);
            let (wrappers, state) = engine_wrappers_in_root(&request, &engine.root, &DiskLister);
            assert_eq!(state, EngineWrappers::Cached);
            assert_eq!(names(&wrappers), ["WRAPPED_TEXT"]);
        }
    }

    #[test]
    fn a_missing_plugins_folder_is_a_complete_listing() {
        let engine = engine("no-plugins");
        let request = request(&engine);
        assert!(!engine.root.join("Engine/Plugins").exists());

        let (wrappers, state) = engine_wrappers_in_root(&request, &engine.root, &DiskLister);
        assert_eq!(state, EngineWrappers::Read);
        assert_eq!(names(&wrappers), ["WRAPPED_TEXT"]);
        let (_, state) = engine_wrappers_in_root(&request, &engine.root, &DiskLister);
        assert_eq!(state, EngineWrappers::Cached);
    }
}
