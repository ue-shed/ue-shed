//! The text in an Unreal project's source: C++, headers, config files and String Table CSVs, found
//! the way Unreal's `GatherTextFromSource` commandlet finds it.
//!
//! The scanner is a port of that commandlet, not a C++ parser. It is never smarter than Unreal: no
//! include following, no `#if` evaluation, no constant resolution. A key Unreal would gather is a
//! place here, with the same namespace, key and text, and nothing else is.
//!
//! Two tiers keep it fast. A file that holds none of the descriptors' tokens cannot produce text,
//! so a SIMD substring search skips it unread past its bytes. The few files left go through the
//! faithful line scanner. Behaviour follows the engine line: 4.27, 5.0 to 5.7, and 5.8.

mod csv;
mod discovery;
mod literal;
mod nested;
mod request;
mod scanner;
mod string_table;
mod wide;

use std::path::{Path, PathBuf};

use aho_corasick::AhoCorasick;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub use discovery::{GatherStep, StepFiles, step_files, step_includes, wrapper_files};
pub use nested::WrapperMacro;
pub use request::{
    CodeTarget, CodeTextProfile, CodeTextRequest, CodeTextResult, EngineWrappers, FileCounts,
    TargetText, code_wrappers, run, scan_files, target_includes,
};

use nested::{NestedWrapper, prune, report_twins};
use scanner::{Descriptor, Scanner, Sink, main_descriptors};
use string_table::{ContentRoot, CsvSource, Tables};
use wide::{Wide, decode, is_text_whitespace, narrow, split_lines};

/// Which commandlet's behaviour a scan reproduces.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EngineLine {
    /// UE 4.27: arguments on one line, project-wide String Tables, no wrappers or log macros.
    #[serde(rename = "4.27")]
    Ue4_27,
    /// UE 5.0 to 5.7: arguments over several lines, wrapper macros, localized log macros.
    #[serde(rename = "5.7")]
    Ue5_7,
    /// UE 5.8: adds developer notes, `UE_DECLARE_ERROR`, and drops whitespace-only text.
    #[serde(rename = "5.8")]
    Ue5_8,
}

impl EngineLine {
    pub fn from_version(major: u32, minor: u32) -> Option<Self> {
        match (major, minor) {
            (4, 27) => Some(Self::Ue4_27),
            (5, 0..=7) => Some(Self::Ue5_7),
            (5, _) => Some(Self::Ue5_8),
            _ => None,
        }
    }

    pub(crate) fn ui_command_minimum(self) -> usize {
        if self == Self::Ue4_27 { 3 } else { 5 }
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetadataField {
    pub name: String,
    pub value: String,
}

/// One gathered piece of text and where it is.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodePlace {
    /// The file as Unreal names it, relative to the gather's base. For a String Table CSV entry,
    /// the CSV path as the `LOCTABLE_FROMFILE_*` call wrote it.
    pub file: String,
    /// 1-based; none for an entry imported from a CSV.
    pub line: Option<u32>,
    /// The macro that produced it, such as `LOCTEXT` or `LOCTABLE_SETSTRING`.
    pub macro_name: String,
    /// The `#define` wrapper the macro was expanded from, if any.
    pub wrapper: Option<String>,
    pub namespace: String,
    pub key: String,
    pub source: String,
    pub dev_notes: Option<String>,
    pub metadata: Vec<MetadataField>,
    /// Inside `#if WITH_EDITOR` or `#if WITH_EDITORONLY_DATA` (exactly those spellings).
    pub editor_only: bool,
    /// Whether the target gathers it: false for editor-only text in a target that leaves it out.
    pub gathered: bool,
    /// The split platform whose path holds the file, when the target splits platforms.
    pub platform: Option<String>,
    /// The String Table ID, for String Table entries.
    pub table: Option<String>,
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticCode {
    ArgumentCount,
    ArgumentParse,
    UnexpectedBracket,
    EndOfFile,
    MissingBracket,
    MissingQuotes,
    EmptyIdentifier,
    EmptySource,
    WhitespaceOnly,
    NoNamespace,
    NamespaceRedefined,
    NamespaceNotDefined,
    NamespaceNotClosed,
    RegionRedefined,
    RegionNotDefined,
    UnterminatedString,
    UnterminatedRawString,
    TableRedefined,
    TableEntryRedefined,
    TableMetadataRedefined,
    TableNotRegistered,
    TableImportFailed,
    WrapperUnsupported,
    WrapperDuplicate,
    CrashesUnreal427,
    Unreadable,
}

/// Something Unreal's gather would log, at the place it would name.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeDiagnostic {
    pub file: String,
    pub line: Option<u32>,
    pub code: DiagnosticCode,
    pub message: String,
}

impl CodeDiagnostic {
    pub(crate) fn new(
        file: &str,
        line: Option<u32>,
        code: DiagnosticCode,
        message: String,
    ) -> Self {
        Self {
            file: file.to_owned(),
            line,
            code,
            message,
        }
    }
}

/// A file to scan: its name as the gather reports it, and where to read it from.
#[derive(Clone, Debug)]
pub struct CodeFile {
    pub path: String,
    pub location: PathBuf,
}

/// Where file contents come from: the disk, or a revision a host read from version control.
pub trait FileStore: Sync {
    fn read(&self, location: &Path) -> std::io::Result<Vec<u8>>;
}

pub struct DiskStore;

impl FileStore for DiskStore {
    fn read(&self, location: &Path) -> std::io::Result<Vec<u8>> {
        std::fs::read(location)
    }
}

/// A platform whose files the target splits out: files whose path contains `fragment`.
#[derive(Clone, Debug)]
pub struct SplitPlatform {
    pub name: String,
    pub fragment: String,
}

#[derive(Clone, Debug)]
pub struct ScanSettings {
    pub engine: EngineLine,
    /// The target's `ShouldGatherFromEditorOnlyData`.
    pub gather_editor_only: bool,
    /// Where `LOCTABLE_FROMFILE_GAME` paths start: the project's `Content` folder.
    pub game_content: PathBuf,
    /// Where `LOCTABLE_FROMFILE_ENGINE` paths start: the engine's `Content` folder.
    pub engine_content: PathBuf,
    pub split_platforms: Vec<SplitPlatform>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeScan {
    pub places: Vec<CodePlace>,
    pub diagnostics: Vec<CodeDiagnostic>,
    /// Files that held a token and went through the line scanner.
    pub files_scanned: usize,
    /// Files whose bytes held no token.
    pub files_skipped: usize,
    pub bytes_read: u64,
}

fn split_platform(platforms: &[SplitPlatform], path: &str) -> Option<String> {
    let path = path.to_ascii_lowercase();
    platforms
        .iter()
        .find(|platform| path.contains(&platform.fragment.to_ascii_lowercase()))
        .map(|platform| platform.name.clone())
}

fn has_utf16_bom(bytes: &[u8]) -> bool {
    bytes.len() >= 2
        && bytes.len().is_multiple_of(2)
        && (bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]))
}

/// Tier one: whether any needle occurs in the file, searched in its UTF-8 form.
fn holds_any(bytes: &[u8], needles: &AhoCorasick) -> bool {
    if has_utf16_bom(bytes) {
        let text = narrow(&decode(bytes));
        return needles.is_match(text.as_bytes());
    }
    needles.is_match(bytes)
}

fn searcher(needles: &[String]) -> Option<AhoCorasick> {
    AhoCorasick::new(needles).ok()
}

/// Finds the `#define` wrappers around text macros in `files`. Unreal's prepass reads the
/// engine's and the project's `Source` and `Plugins` folders (`*.cpp` and `*.h`); a caller can
/// keep the engine's part per engine build. 4.27 has no wrapper prepass.
pub fn find_wrappers(
    engine: EngineLine,
    files: &[CodeFile],
    store: &dyn FileStore,
) -> Vec<WrapperMacro> {
    wrappers_read(engine, files, store).0
}

/// [`find_wrappers`], and whether it read every file: a set from a prepass that could not read
/// a file may lack that file's wrappers, so it is not kept for later scans.
pub(crate) fn wrappers_read(
    engine: EngineLine,
    files: &[CodeFile],
    store: &dyn FileStore,
) -> (Vec<WrapperMacro>, bool) {
    if engine == EngineLine::Ue4_27 {
        return (Vec::new(), true);
    }
    let Some(define) = searcher(&["#define ".to_owned()]) else {
        return (Vec::new(), true);
    };
    let Some(nested) = searcher(&["LOCTEXT".to_owned(), "UI_COMMAND".to_owned()]) else {
        return (Vec::new(), true);
    };
    let unread = std::sync::atomic::AtomicBool::new(false);
    let descriptors = [Descriptor::wrapper_prepass()];
    let found: Vec<Vec<NestedWrapper>> = files
        .par_iter()
        .map(|file| {
            let Ok(bytes) = store.read(&file.location) else {
                unread.store(true, std::sync::atomic::Ordering::Relaxed);
                return Vec::new();
            };
            if !holds_any(&bytes, &define) || !holds_any(&bytes, &nested) {
                return Vec::new();
            }
            let text = decode(&bytes);
            let scanner = Scanner {
                engine,
                file: &file.path,
                ini: false,
                lines: split_lines(&text),
                descriptors: &descriptors,
                wrappers: &[],
                handled: Vec::new(),
                prepass: true,
                platform: None,
            };
            let mut sink = Sink::default();
            scanner.run(&mut sink);
            sink.wrappers
        })
        .collect();
    let wrappers = found
        .into_iter()
        .flatten()
        .map(|wrapper| wrapper.public())
        .collect();
    (wrappers, !unread.into_inner())
}

struct ContentReader<'a> {
    settings: &'a ScanSettings,
    store: &'a dyn FileStore,
}

impl CsvSource for ContentReader<'_> {
    fn read_csv(&self, root: ContentRoot, path: &str) -> Option<Wide> {
        let base = match root {
            ContentRoot::Game => &self.settings.game_content,
            ContentRoot::Engine => &self.settings.engine_content,
        };
        // Without an engine root there is no engine content: a relative path would read from
        // wherever the process runs.
        if base.as_os_str().is_empty() {
            return None;
        }
        self.store
            .read(&base.join(path))
            .ok()
            .map(|bytes| decode(&bytes))
    }
}

struct FileResult {
    scanned: bool,
    bytes: u64,
    sink: Sink,
}

/// `FText::ShouldGatherForLocalization`: 5.8 drops empty and whitespace-only text.
fn is_whitespace_only(text: &str) -> bool {
    text.encode_utf16().all(is_text_whitespace)
}

/// Scans `files` (one target's `GatherTextFromSource` files, sorted as Unreal sorts them) with
/// the wrappers [`find_wrappers`] found across the engine and the project.
pub fn scan(
    settings: &ScanSettings,
    files: &[CodeFile],
    wrappers: &[WrapperMacro],
    store: &dyn FileStore,
) -> CodeScan {
    let engine = settings.engine;
    let mut diagnostics = Vec::new();
    let mut nested: Vec<NestedWrapper> = if engine == EngineLine::Ue4_27 {
        Vec::new()
    } else {
        wrappers.iter().map(NestedWrapper::from_public).collect()
    };
    prune(&mut nested, &mut diagnostics);
    report_twins(&nested, &mut diagnostics);
    let mut descriptors = main_descriptors(engine);
    for (index, wrapper) in nested.iter().enumerate() {
        if !wrapper.excluded {
            descriptors.push(Descriptor::wrapper(&wrapper.name, index));
        }
    }
    let tokens: Vec<String> = descriptors
        .iter()
        .filter(|descriptor| descriptor.produces_text())
        .map(|descriptor| narrow(&descriptor.token))
        .collect();
    let Some(needles) = searcher(&tokens) else {
        return CodeScan::default();
    };
    let results: Vec<FileResult> = files
        .par_iter()
        .map(|file| {
            let mut sink = Sink::default();
            let bytes = match store.read(&file.location) {
                Ok(bytes) => bytes,
                Err(error) => {
                    sink.diagnostics.push(CodeDiagnostic::new(
                        &file.path,
                        None,
                        DiagnosticCode::Unreadable,
                        format!("The file could not be read: {error}."),
                    ));
                    return FileResult {
                        scanned: false,
                        bytes: 0,
                        sink,
                    };
                }
            };
            let size = bytes.len() as u64;
            if !holds_any(&bytes, &needles) {
                return FileResult {
                    scanned: false,
                    bytes: size,
                    sink,
                };
            }
            let text = decode(&bytes);
            let handled = nested
                .iter()
                .filter(|wrapper| wrapper.file.eq_ignore_ascii_case(&file.path))
                .map(|wrapper| (wrapper.line_start, wrapper.line_count))
                .collect();
            let scanner = Scanner {
                engine,
                file: &file.path,
                ini: file.path.to_ascii_lowercase().ends_with(".ini"),
                lines: split_lines(&text),
                descriptors: &descriptors,
                wrappers: &nested,
                handled,
                prepass: false,
                platform: split_platform(
                    &settings.split_platforms,
                    &file.location.to_string_lossy(),
                ),
            };
            let state = scanner.run(&mut sink);
            if let Some(line) = state.namespace_line() {
                sink.diagnostics.push(CodeDiagnostic::new(
                    &file.path,
                    Some(line as u32),
                    DiagnosticCode::NamespaceNotClosed,
                    "LOCTEXT_NAMESPACE is defined here and never #undef'd.".to_owned(),
                ));
            }
            FileResult {
                scanned: true,
                bytes: size,
                sink,
            }
        })
        .collect();

    let reader = ContentReader { settings, store };
    let platform_of = |path: &str| split_platform(&settings.split_platforms, path);
    let mut scan = CodeScan::default();
    let mut project_tables = Tables::default();
    for (file, result) in files.iter().zip(results) {
        scan.bytes_read += result.bytes;
        if result.scanned {
            scan.files_scanned += 1;
        } else {
            scan.files_skipped += 1;
        }
        let FileResult { sink, .. } = result;
        diagnostics.extend(sink.diagnostics);
        for found in sink.found {
            let editor_only = found.editor_only;
            scan.places.push(CodePlace {
                file: file.path.clone(),
                line: Some(found.line),
                macro_name: narrow(&found.macro_name),
                wrapper: found.wrapper.as_deref().map(narrow),
                namespace: narrow(&found.namespace),
                key: narrow(&found.key),
                source: narrow(&found.source),
                dev_notes: (!found.dev_notes.is_empty()).then(|| narrow(&found.dev_notes)),
                metadata: Vec::new(),
                editor_only,
                gathered: !editor_only || settings.gather_editor_only,
                platform: split_platform(
                    &settings.split_platforms,
                    &file.location.to_string_lossy(),
                ),
                table: None,
            });
        }
        if engine == EngineLine::Ue4_27 {
            for call in &sink.tables {
                project_tables.apply(call, engine, &reader, &platform_of, &mut diagnostics);
            }
        } else {
            let mut tables = Tables::default();
            for call in &sink.tables {
                tables.apply(call, engine, &reader, &platform_of, &mut diagnostics);
            }
            tables.places(
                engine,
                settings.gather_editor_only,
                &mut scan.places,
                &mut diagnostics,
                &file.path,
            );
        }
    }
    if engine == EngineLine::Ue4_27 {
        project_tables.places(
            engine,
            settings.gather_editor_only,
            &mut scan.places,
            &mut diagnostics,
            "",
        );
    }

    // The manifest refuses an empty key; 5.8 also drops empty and whitespace-only text.
    scan.places.retain(|place| {
        if place.key.is_empty() {
            diagnostics.push(CodeDiagnostic::new(
                &place.file,
                place.line,
                DiagnosticCode::EmptyIdentifier,
                format!("{} has an empty key and is not gathered.", place.macro_name),
            ));
            return false;
        }
        if engine == EngineLine::Ue5_8 && is_whitespace_only(&place.source) {
            diagnostics.push(CodeDiagnostic::new(
                &place.file,
                place.line,
                DiagnosticCode::WhitespaceOnly,
                format!(
                    "{} '{}' has only whitespace and is not gathered.",
                    place.macro_name, place.key
                ),
            ));
            return false;
        }
        true
    });
    scan.diagnostics = diagnostics;
    scan
}
