//! Which files a `GatherTextFromSource` step reads, and what Unreal calls them.
//!
//! Ports `ResolveLocalizationPath`, `GetFilesToProcess` and `FFuzzyPathMatcher`: config paths
//! resolve against the project, each search directory is walked for the file name filters, and
//! the include and exclude filters decide, deepest and least fuzzy first. 5.x skips UHT output and
//! sorts the list; 4.27 keeps the walk's order (per search path, per filter, files before
//! subfolders), which decides which String Table registration comes first.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{CodeFile, EngineLine};

/// One `GatherTextFromSource` step of a localization target, as its config file states it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatherStep {
    pub search_directory_paths: Vec<String>,
    pub exclude_path_filters: Vec<String>,
    pub file_name_filters: Vec<String>,
    pub gather_editor_only: bool,
}

/// The files a step reads, sorted as Unreal processes them, and how many the filters left out.
#[derive(Clone, Debug, Default)]
pub struct StepFiles {
    pub files: Vec<CodeFile>,
    pub excluded: usize,
}

fn slashes(path: &str) -> String {
    path.replace('\\', "/")
}

pub(crate) fn absolute(path: &Path) -> String {
    collapse(&slashes(&path.to_string_lossy()))
}

fn with_slash(path: &str) -> String {
    if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    }
}

fn is_relative(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[1] == b':';
    !(drive || path.starts_with('/'))
}

/// `FPaths::CollapseRelativeDirectories`: folds `.` and `name/..` segments.
fn collapse(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "." => {}
            ".." if parts
                .last()
                .is_some_and(|last| *last != ".." && !last.is_empty() && !last.ends_with(':')) =>
            {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// `ResolveLocalizationPath`: substitutes the roots and anchors a relative path at the project.
pub(crate) fn resolve(path: &str, project: &Path, engine: Option<&Path>) -> String {
    let project_root = with_slash(&absolute(project));
    let engine_root = engine
        .map(|root| with_slash(&absolute(&root.join("Engine"))))
        .unwrap_or_default();
    let mut resolved = slashes(path)
        .replace("%LOCENGINEROOT%", &engine_root)
        .replace("%LOCPROJECTROOT%", &project_root);
    if is_relative(&resolved) {
        resolved.insert_str(0, &project_root);
    }
    collapse(&resolved)
}

fn fold(text: &str) -> String {
    text.to_ascii_lowercase()
}

/// `FString::MatchesWildcard`, ignoring case: `*` is any run, `?` any one character.
pub(crate) fn matches_wildcard(text: &str, pattern: &str) -> bool {
    let text: Vec<char> = fold(text).chars().collect();
    let pattern: Vec<char> = fold(pattern).chars().collect();
    let (mut t, mut p) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while t < text.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
            t += 1;
            p += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            mark = t;
            p += 1;
        } else if let Some(at) = star {
            p = at + 1;
            mark += 1;
            t = mark;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Include,
    Exclude,
}

struct FuzzyPath {
    filter: String,
    kind: Kind,
    starts_with: bool,
}

/// `FFuzzyPathMatcher`: the first filter that matches decides; no match leaves the file out.
struct Matcher {
    paths: Vec<FuzzyPath>,
}

impl Matcher {
    fn new(includes: &[String], excludes: &[String]) -> Self {
        let rating = |filter: &str| {
            let depth = filter.chars().filter(|&c| c == '/' || c == '\\').count() as i64;
            let fuzz = filter.chars().filter(|&c| c == '*' || c == '?').count() as i64;
            (100 - depth) + fuzz * 1000
        };
        let mut paths: Vec<FuzzyPath> = includes
            .iter()
            .map(|filter| (filter, Kind::Include))
            .chain(excludes.iter().map(|filter| (filter, Kind::Exclude)))
            .map(|(filter, kind)| {
                let starts_with = filter.find('*') == Some(filter.len().saturating_sub(1));
                FuzzyPath {
                    filter: filter.clone(),
                    kind,
                    starts_with,
                }
            })
            .collect();
        // Deeper, less fuzzy filters first; on a tie an exclusion goes first.
        paths.sort_by_key(|path| (rating(&path.filter), path.kind == Kind::Include));
        for path in &mut paths {
            if path.starts_with {
                path.filter.pop();
                path.filter = fold(&path.filter);
            }
        }
        Self { paths }
    }

    fn includes(&self, file: &str) -> bool {
        let folded = fold(file);
        for path in &self.paths {
            let hit = if path.starts_with {
                folded.starts_with(&path.filter)
            } else {
                matches_wildcard(file, &path.filter)
            };
            if hit {
                return path.kind == Kind::Include;
            }
        }
        false
    }
}

fn entries(folder: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut files = Vec::new();
    let mut folders = Vec::new();
    if let Ok(read) = std::fs::read_dir(folder) {
        for entry in read.filter_map(Result::ok) {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => folders.push(path),
                Ok(_) => files.push(path),
                Err(_) => {}
            }
        }
    }
    // NTFS lists names in upper-case order.
    let key = |path: &PathBuf| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_ascii_uppercase())
            .unwrap_or_default()
    };
    files.sort_by_key(key);
    folders.sort_by_key(key);
    (files, folders)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 4.27's `FindFilesRecursive`: this folder's matches, then each subfolder's.
fn walk_427(folder: &Path, filter: &str, out: &mut Vec<String>) {
    let (files, folders) = entries(folder);
    for file in files {
        if matches_wildcard(&file_name(&file), filter) {
            out.push(absolute(&file));
        }
    }
    for folder in folders {
        walk_427(&folder, filter, out);
    }
}

/// Whether a file is Unreal Header Tool output, which 5.x's gather leaves out.
fn uht_output(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".generated.h") || lower.ends_with(".gen.cpp")
}

/// 5.x's visitor: every file under the folder matching any filter, UHT output left out.
fn walk_5(folder: &Path, filters: &[String], out: &mut Vec<String>) {
    let (files, folders) = entries(folder);
    for file in files {
        let name = file_name(&file);
        if uht_output(&name) {
            continue;
        }
        if filters.iter().any(|filter| matches_wildcard(&name, filter)) {
            out.push(absolute(&file));
        }
    }
    for folder in folders {
        walk_5(&folder, filters, out);
    }
}

/// `FPaths::MakePathRelativeTo` against a folder: `../` for each folder the file is not under.
pub(crate) fn relative_to(file: &str, base: &str) -> String {
    let file_parts: Vec<&str> = file.split('/').filter(|part| !part.is_empty()).collect();
    let base_parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    let common = file_parts
        .iter()
        .zip(&base_parts)
        .take_while(|(left, right)| left.eq_ignore_ascii_case(right))
        .count();
    if common == 0 {
        return file.to_owned();
    }
    let mut parts: Vec<&str> = vec![".."; base_parts.len() - common];
    parts.extend(&file_parts[common..]);
    parts.join("/")
}

fn unique_filters(filters: &[String]) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for filter in filters {
        if !unique.contains(filter) {
            unique.push(filter.clone());
        }
    }
    unique
}

/// The files one step reads, named relative to the project as the gather names them.
/// A step's include and exclude path patterns, resolved, and its file name filters.
struct StepPatterns {
    includes: Vec<String>,
    excludes: Vec<String>,
    filters: Vec<String>,
}

fn step_patterns(
    engine: EngineLine,
    project: &Path,
    engine_root: Option<&Path>,
    step: &GatherStep,
) -> StepPatterns {
    let resolve = |path: &String| resolve(path, project, engine_root);
    let searches: Vec<String> = step.search_directory_paths.iter().map(resolve).collect();
    let includes = searches
        .iter()
        .map(|search| {
            if engine != EngineLine::Ue4_27 && (search.ends_with('*') || search.ends_with('?')) {
                search.clone()
            } else {
                format!("{}/*", search.trim_end_matches('/'))
            }
        })
        .collect();
    StepPatterns {
        includes,
        excludes: step.exclude_path_filters.iter().map(resolve).collect(),
        filters: unique_filters(&step.file_name_filters),
    }
}

/// Whether a step gathers a file, by its path under the project, whether or not the file is on
/// disk now: a revision a host read from version control is judged as the step would judge it.
#[must_use]
pub fn step_includes(
    engine: EngineLine,
    project: &Path,
    engine_root: Option<&Path>,
    step: &GatherStep,
    path: &str,
) -> bool {
    let patterns = step_patterns(engine, project, engine_root, step);
    // A gather path may climb out of the project (`../Other/...`), as a recipe's folders can.
    let file = collapse(&format!(
        "{}{}",
        with_slash(&absolute(project)),
        slashes(path)
    ));
    let name = file.rsplit('/').next().unwrap_or_default();
    // As the walk does: 5.x leaves UHT output out, 4.27 does not.
    !(engine != EngineLine::Ue4_27 && uht_output(name))
        && patterns
            .filters
            .iter()
            .any(|filter| matches_wildcard(name, filter))
        && Matcher::new(&patterns.includes, &patterns.excludes).includes(&file)
}

pub fn step_files(
    engine: EngineLine,
    project: &Path,
    engine_root: Option<&Path>,
    step: &GatherStep,
) -> StepFiles {
    let StepPatterns {
        includes,
        excludes,
        filters,
    } = step_patterns(engine, project, engine_root, step);
    let mut found: Vec<String> = Vec::new();
    if engine == EngineLine::Ue4_27 {
        for include in &includes {
            let folder = include.trim_end_matches('*').trim_end_matches('/');
            for filter in &filters {
                walk_427(Path::new(folder), filter, &mut found);
            }
        }
    } else {
        let mut walked: Vec<String> = Vec::new();
        for include in &includes {
            let mut folder = include.clone();
            if let Some(wildcard) = folder.find(['*', '?']) {
                folder.truncate(wildcard);
                folder = folder
                    .rsplit_once('/')
                    .map_or(String::new(), |(parent, _)| parent.to_owned());
            }
            if walked.iter().any(|seen| seen.eq_ignore_ascii_case(&folder)) {
                continue;
            }
            walk_5(Path::new(&folder), &filters, &mut found);
            walked.push(folder);
        }
    }
    let matcher = Matcher::new(&includes, &excludes);
    let total = found.len();
    found.retain(|file| matcher.includes(file));
    let excluded = total - found.len();
    if engine != EngineLine::Ue4_27 {
        found.sort_by_key(|file| fold(file));
        found.dedup_by(|right, left| right.eq_ignore_ascii_case(left));
    }
    let base = absolute(project);
    let files = found
        .into_iter()
        .map(|file| CodeFile {
            path: relative_to(&file, &base),
            location: PathBuf::from(&file),
        })
        .collect();
    StepFiles { files, excluded }
}

/// The files Unreal's wrapper prepass reads under one root (the project, or the engine's `Engine`
/// folder): `*.cpp` and `*.h` in `Source` and `Plugins`, without `Source/ThirdParty`.
pub fn wrapper_files(root: &Path, project: &Path) -> Vec<CodeFile> {
    let filters = ["*.cpp".to_owned(), "*.h".to_owned()];
    let third_party = fold(&format!("{}/Source/ThirdParty/", absolute(root)));
    let mut found = Vec::new();
    for folder in ["Source", "Plugins"] {
        walk_5(&root.join(folder), &filters, &mut found);
    }
    found.retain(|file| !fold(file).starts_with(&third_party));
    found.sort_by_key(|file| fold(file));
    let base = absolute(project);
    found
        .into_iter()
        .map(|file| CodeFile {
            path: relative_to(&file, &base),
            location: PathBuf::from(&file),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_wildcards_without_case() {
        assert!(matches_wildcard("Literals.CPP", "*.cpp"));
        assert!(matches_wildcard("D:/p/Source/A/B.h", "d:/p/source/*/b.?"));
        assert!(!matches_wildcard("Literals.cpp", "*.ini"));
    }

    #[test]
    fn resolves_and_relates_paths_like_unreal() {
        let project = Path::new("D:/work/unreal-427");
        assert_eq!(
            resolve("../unreal-project/FixtureSource", project, None),
            "D:/work/unreal-project/FixtureSource"
        );
        assert_eq!(
            relative_to(
                "D:/work/unreal-project/FixtureSource/A.cpp",
                "D:/work/unreal-427"
            ),
            "../unreal-project/FixtureSource/A.cpp"
        );
        assert_eq!(
            relative_to("D:/work/unreal-427/Source/A.cpp", "D:/work/unreal-427/"),
            "Source/A.cpp"
        );
    }

    #[test]
    fn excludes_before_includes_of_the_same_rating() {
        let matcher = Matcher::new(
            &["D:/p/Source/*".to_owned()],
            &["D:/p/Source/Skip/*".to_owned()],
        );
        assert!(matcher.includes("D:/p/Source/Keep/A.cpp"));
        assert!(!matcher.includes("D:/p/Source/Skip/A.cpp"));
        assert!(!matcher.includes("D:/p/Other/A.cpp"));
    }
}
