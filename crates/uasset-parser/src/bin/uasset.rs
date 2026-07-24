use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use uasset_parser::asset::{
    AssetDecodeContext, AssetErrorKind, DecodedAsset, EnumCppForm, decode_export,
};
use uasset_parser::asset::{
    COMPOSITE_DATATABLE_CLASS, DATA_ASSET_CLASS, DATATABLE_CLASS, PRIMARY_DATA_ASSET_CLASS,
    SKELETON_CLASS, USERDEFINEDENUM_CLASS, USERDEFINEDSTRUCT_CLASS,
};
use uasset_parser::package::{PackageError, PackageErrorKind, PackageIndex, TableLocation};
use uasset_parser::property::{PropertyRecord, PropertyValue, RawReason};
use uasset_parser::schema::{ClassSchema, SchemaProvider, StructSchema};
use uasset_parser::{Package, PackageSummary};

const SCHEMA_VERSION: u32 = 7;
const EXIT_SUCCESS: u8 = 0;
const EXIT_MALFORMED: u8 = 2;
const EXIT_UNSUPPORTED: u8 = 3;
const EXIT_IO: u8 = 4;
const EXIT_INTERNAL: u8 = 5;
const EXIT_PARTIAL: u8 = 6;
const EXIT_RESOURCE_LIMIT: u8 = 7;
const EXIT_USAGE: u8 = 64;
const CATALOG_CACHE_VERSION: u32 = 1;
const HEADER_PROBE_BYTES: usize = 4 * 1024;
const MAX_SUMMARY_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 64 * 1024 * 1024;
const PROGRESS_INTERVAL: usize = 1_000;

fn main() -> ExitCode {
    ExitCode::from(run(env::args_os().skip(1).collect()))
}

fn run(arguments: Vec<OsString>) -> u8 {
    match Command::parse(arguments) {
        Ok(Command::Help) => write_stdout(HELP.as_bytes()),
        Ok(Command::Version) => {
            write_stdout(format!("uasset {}\n", env!("CARGO_PKG_VERSION")).as_bytes())
        }
        Ok(Command::Inspect(options)) => inspect(&options),
        Ok(Command::Authoring(options)) => authoring(&options),
        Ok(Command::Catalog(options)) => catalog(&options),
        Err(error) => {
            eprintln!("uasset: {error}\n\n{USAGE}");
            EXIT_USAGE
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OutputFormat {
    Text,
    Json,
}

#[derive(Debug, Eq, PartialEq)]
struct InspectOptions {
    input: Input,
    format: OutputFormat,
}

#[derive(Debug, Eq, PartialEq)]
struct CatalogOptions {
    cache: Option<PathBuf>,
    project_root: PathBuf,
    format: OutputFormat,
    concurrency: usize,
}

#[derive(Debug, Eq, PartialEq)]
enum Input {
    File(PathBuf),
    Stdin,
}

impl Input {
    fn display_name(&self) -> String {
        match self {
            Self::File(path) => path.to_string_lossy().into_owned(),
            Self::Stdin => "-".to_owned(),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum Command {
    Inspect(InspectOptions),
    Authoring(InspectOptions),
    Catalog(CatalogOptions),
    Help,
    Version,
}

impl Command {
    fn parse(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut arguments = arguments.into_iter();
        let Some(command) = arguments.next() else {
            return Err("missing command".to_owned());
        };
        match command.to_str() {
            Some("inspect") => Self::parse_inspect(arguments.collect()),
            Some("authoring") => match Self::parse_inspect(arguments.collect())? {
                Self::Inspect(options) => Ok(Self::Authoring(options)),
                _ => unreachable!("parse_inspect only returns Inspect"),
            },
            Some("catalog") => Self::parse_catalog(arguments.collect()),
            Some("-h" | "--help" | "help") => {
                reject_trailing_arguments(arguments)?;
                Ok(Self::Help)
            }
            Some("-V" | "--version" | "version") => {
                reject_trailing_arguments(arguments)?;
                Ok(Self::Version)
            }
            Some(command) => Err(format!("unknown command {command:?}")),
            None => Err("command is not valid UTF-8".to_owned()),
        }
    }

    fn parse_inspect(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut format = OutputFormat::Text;
        let mut input = None;
        let mut index = 0;
        while index < arguments.len() {
            let argument = &arguments[index];
            match argument.to_str() {
                Some("--format") => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--format requires text or json".to_owned())?;
                    format = parse_format(value)?;
                }
                Some(value) if value.starts_with("--format=") => {
                    format = parse_format(OsString::from(&value["--format=".len()..]).as_os_str())?;
                }
                Some("-h" | "--help") => {
                    return Err("use uasset help for command usage".to_owned());
                }
                Some(value) if value.starts_with('-') && value != "-" => {
                    return Err(format!("unknown inspect option {value:?}"));
                }
                _ if input.is_some() => {
                    return Err("inspect accepts exactly one input".to_owned());
                }
                Some("-") => input = Some(Input::Stdin),
                _ => input = Some(Input::File(PathBuf::from(argument))),
            }
            index += 1;
        }
        Ok(Self::Inspect(InspectOptions {
            input: input.ok_or_else(|| "inspect requires a file path or -".to_owned())?,
            format,
        }))
    }

    fn parse_catalog(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut cache = None;
        let mut format = OutputFormat::Json;
        let mut concurrency = std::thread::available_parallelism().map_or(4, usize::from);
        let mut project_root = None;
        let mut index = 0;
        while index < arguments.len() {
            let argument = &arguments[index];
            match argument.to_str() {
                Some("--format") => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--format requires json".to_owned())?;
                    format = parse_format(value)?;
                }
                Some(value) if value.starts_with("--format=") => {
                    format = parse_format(OsString::from(&value["--format=".len()..]).as_os_str())?;
                }
                Some("--concurrency") => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--concurrency requires a positive integer".to_owned())?;
                    concurrency = parse_concurrency(value)?;
                }
                Some("--cache") => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--cache requires a file path".to_owned())?;
                    cache = Some(PathBuf::from(value));
                }
                Some(value) if value.starts_with("--cache=") => {
                    cache = Some(PathBuf::from(&value["--cache=".len()..]));
                }
                Some(value) if value.starts_with("--concurrency=") => {
                    concurrency = parse_concurrency(
                        OsString::from(&value["--concurrency=".len()..]).as_os_str(),
                    )?;
                }
                Some(value) if value.starts_with('-') => {
                    return Err(format!("unknown catalog option {value:?}"));
                }
                _ if project_root.is_some() => {
                    return Err("catalog accepts exactly one project root".to_owned());
                }
                _ => project_root = Some(PathBuf::from(argument)),
            }
            index += 1;
        }
        if format != OutputFormat::Json {
            return Err("catalog requires --format json".to_owned());
        }
        Ok(Self::Catalog(CatalogOptions {
            cache,
            project_root: project_root
                .ok_or_else(|| "catalog requires a project root".to_owned())?,
            format,
            concurrency,
        }))
    }
}

fn parse_concurrency(value: &std::ffi::OsStr) -> Result<usize, String> {
    value
        .to_str()
        .ok_or_else(|| "concurrency is not valid UTF-8".to_owned())?
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "--concurrency requires a positive integer".to_owned())
}

fn reject_trailing_arguments(mut arguments: impl Iterator<Item = OsString>) -> Result<(), String> {
    if arguments.next().is_some() {
        Err("unexpected trailing arguments".to_owned())
    } else {
        Ok(())
    }
}

fn parse_format(value: &std::ffi::OsStr) -> Result<OutputFormat, String> {
    match value.to_str() {
        Some("text") => Ok(OutputFormat::Text),
        Some("json") => Ok(OutputFormat::Json),
        Some(value) => Err(format!("unsupported output format {value:?}")),
        None => Err("output format is not valid UTF-8".to_owned()),
    }
}
fn inspect(options: &InspectOptions) -> u8 {
    let input_name = options.input.display_name();
    let bytes = match read_input(&options.input) {
        Ok(bytes) => bytes,
        Err(error) => {
            write_error(
                options.format,
                ErrorOutput::io(input_name, error.to_string()),
            );
            return EXIT_IO;
        }
    };

    let package = match Package::parse(&bytes) {
        Ok(package) => package,
        Err(error) => {
            let exit_code = exit_code_for_package_error(&error);
            write_error(options.format, ErrorOutput::package(input_name, &error));
            return exit_code;
        }
    };

    let output = InspectOutput::from_package(input_name, &bytes, &package);
    let partial = !output.decode_errors.is_empty();
    let rendered = match render_output(options.format, &output) {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("uasset: failed to serialize output: {error}");
            return EXIT_INTERNAL;
        }
    };
    let exit = write_stdout(&rendered);
    if exit == EXIT_SUCCESS && partial {
        EXIT_PARTIAL
    } else {
        exit
    }
}

fn authoring(options: &InspectOptions) -> u8 {
    if options.format != OutputFormat::Json {
        eprintln!("uasset: authoring requires --format json");
        return EXIT_USAGE;
    }

    let input_name = options.input.display_name();
    let bytes = match read_input(&options.input) {
        Ok(bytes) => bytes,
        Err(error) => {
            write_error(
                options.format,
                ErrorOutput::io(input_name, error.to_string()),
            );
            return EXIT_IO;
        }
    };
    let package = match Package::parse(&bytes) {
        Ok(package) => package,
        Err(error) => {
            let exit_code = exit_code_for_package_error(&error);
            write_error(options.format, ErrorOutput::package(input_name, &error));
            return exit_code;
        }
    };
    let output = InspectOutput::from_package(input_name, &bytes, &package);
    let mut tables = output
        .assets
        .iter()
        .filter(|asset| matches!(asset.kind, "DataTable" | "CompositeDataTable"));
    let Some(table) = tables.next() else {
        eprintln!("uasset: package contains no supported DataTable export");
        return EXIT_UNSUPPORTED;
    };
    if tables.next().is_some() {
        eprintln!("uasset: package contains more than one DataTable export");
        return EXIT_UNSUPPORTED;
    }

    let authoring = AuthoringSnapshotOutput::from_inspect(&output, table);
    let partial = authoring.completeness == "partial";
    let mut rendered = match serde_json::to_vec(&authoring) {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("uasset: failed to serialize authoring output: {error}");
            return EXIT_INTERNAL;
        }
    };
    rendered.push(b'\n');
    let exit = write_stdout(&rendered);
    if exit == EXIT_SUCCESS && partial {
        EXIT_PARTIAL
    } else {
        exit
    }
}

fn catalog(options: &CatalogOptions) -> u8 {
    let content_root = options.project_root.join("Content");
    let mut asset_paths = Vec::new();
    emit_catalog_progress(CatalogProgressOutput {
        event: "catalog_progress",
        cache_hits: 0,
        phase: "enumerating",
        processed_assets: 0,
        tables_found: 0,
        total_assets: 0,
    });
    if let Err(error) = discover_uassets(&content_root, &mut asset_paths) {
        write_error(
            options.format,
            ErrorOutput::io(
                content_root.to_string_lossy().into_owned(),
                error.to_string(),
            ),
        );
        return EXIT_IO;
    }
    asset_paths.sort();
    let total_assets = asset_paths.len();
    let mut cached_by_path = load_catalog_cache(options.cache.as_deref())
        .map(|cache| {
            cache
                .entries
                .into_iter()
                .map(|entry| (entry.path.clone(), entry))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let mut completed_entries = Vec::new();
    let mut pending = Vec::new();
    for asset_path in asset_paths {
        match asset_signature(asset_path) {
            Ok(signature) => {
                let path = signature.path.to_string_lossy().into_owned();
                match cached_by_path.remove(&path) {
                    Some(entry) if cache_entry_matches(&entry, &signature) => {
                        completed_entries.push(entry);
                    }
                    _ => pending.push(signature),
                }
            }
            Err(entry) => completed_entries.push(entry),
        }
    }
    let cache_hits = completed_entries
        .iter()
        .filter(|entry| entry.failure_code.as_deref() != Some("asset_io"))
        .count();
    let cached_tables = completed_entries
        .iter()
        .map(|entry| entry.tables.len())
        .sum();
    emit_catalog_progress(CatalogProgressOutput {
        event: "catalog_progress",
        cache_hits,
        phase: "scanning",
        processed_assets: completed_entries.len(),
        tables_found: cached_tables,
        total_assets,
    });

    let processed = AtomicUsize::new(completed_entries.len());
    let table_count = AtomicUsize::new(cached_tables);
    let worker_count = options.concurrency.min(pending.len().max(1));
    let chunk_size = pending.len().div_ceil(worker_count);
    let results = std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in pending.chunks(chunk_size.max(1)) {
            let processed = &processed;
            let table_count = &table_count;
            handles.push(scope.spawn(move || {
                let mut entries = Vec::with_capacity(chunk.len());
                for signature in chunk {
                    let entry = inspect_asset_for_catalog(signature);
                    let tables_found = table_count.fetch_add(entry.tables.len(), Ordering::Relaxed)
                        + entry.tables.len();
                    let processed_assets = processed.fetch_add(1, Ordering::Relaxed) + 1;
                    if processed_assets % PROGRESS_INTERVAL == 0 || processed_assets == total_assets
                    {
                        emit_catalog_progress(CatalogProgressOutput {
                            event: "catalog_progress",
                            cache_hits,
                            phase: "scanning",
                            processed_assets,
                            tables_found,
                            total_assets,
                        });
                    }
                    entries.push(entry);
                }
                entries
            }));
        }
        handles
            .into_iter()
            .map(|handle| handle.join().expect("catalog worker must not panic"))
            .collect::<Vec<_>>()
    });

    for result in results {
        completed_entries.extend(result);
    }
    completed_entries.sort_by(|left, right| left.path.cmp(&right.path));
    emit_catalog_progress(CatalogProgressOutput {
        event: "catalog_progress",
        cache_hits,
        phase: "writing_cache",
        processed_assets: total_assets,
        tables_found: table_count.load(Ordering::Relaxed),
        total_assets,
    });

    let mut failure_counts = BTreeMap::<String, usize>::new();
    let mut tables = Vec::new();
    for entry in &completed_entries {
        tables.extend(entry.tables.clone());
        if let Some(code) = &entry.failure_code {
            *failure_counts.entry(code.clone()).or_insert(0) += 1;
        }
    }
    if save_catalog_cache(options.cache.as_deref(), &completed_entries).is_err() {
        *failure_counts
            .entry("catalog_cache_write".to_owned())
            .or_insert(0) += 1;
    }
    tables.sort_by(|left, right| left.object_path.cmp(&right.object_path));
    let diagnostics = failure_counts
        .into_iter()
        .map(|(code, count)| CatalogDiagnosticOutput {
            message: format!("{count} saved asset(s) could not be cataloged ({code})"),
            path: options.project_root.to_string_lossy().into_owned(),
            retry_safe: matches!(code.as_str(), "asset_io" | "catalog_cache_write"),
            code,
        })
        .collect();
    let output = CatalogOutput {
        schema_version: SCHEMA_VERSION,
        cache_hits,
        changed_assets: pending.len(),
        project_root: options.project_root.to_string_lossy().into_owned(),
        scanned_assets: total_assets,
        tables,
        diagnostics,
    };
    let mut rendered = match serde_json::to_vec(&output) {
        Ok(rendered) => rendered,
        Err(error) => {
            eprintln!("uasset: failed to serialize catalog output: {error}");
            return EXIT_INTERNAL;
        }
    };
    rendered.push(b'\n');
    let exit = write_stdout(&rendered);
    if exit == EXIT_SUCCESS {
        emit_catalog_progress(CatalogProgressOutput {
            event: "catalog_progress",
            cache_hits,
            phase: "ready",
            processed_assets: total_assets,
            tables_found: output.tables.len(),
            total_assets,
        });
    }
    exit
}

fn discover_uassets(directory: &Path, found: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            discover_uassets(&entry.path(), found)?;
        } else if file_type.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "uasset")
        {
            found.push(entry.path());
        }
    }
    Ok(())
}

#[derive(Clone)]
struct AssetSignature {
    modified_nanos: u64,
    path: PathBuf,
    size: u64,
}

fn asset_signature(path: PathBuf) -> Result<AssetSignature, CatalogCacheEntry> {
    let metadata =
        fs::metadata(&path).map_err(|_| CatalogCacheEntry::failure(&path, "asset_io"))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
        });
    Ok(AssetSignature {
        modified_nanos,
        path,
        size: metadata.len(),
    })
}

fn cache_entry_matches(entry: &CatalogCacheEntry, signature: &AssetSignature) -> bool {
    entry.path == signature.path.to_string_lossy()
        && entry.size == signature.size
        && entry.modified_nanos == signature.modified_nanos
}

fn inspect_asset_for_catalog(signature: &AssetSignature) -> CatalogCacheEntry {
    let package = match read_package_header(signature) {
        Ok(package) => package,
        Err(code) => {
            return CatalogCacheEntry {
                failure_code: Some(code.to_owned()),
                modified_nanos: signature.modified_nanos,
                path: signature.path.to_string_lossy().into_owned(),
                size: signature.size,
                tables: Vec::new(),
            };
        }
    };
    let mut tables = Vec::new();
    for export in &package.exports {
        let Some(class_path) = export.class_path.as_ref().map(ToString::to_string) else {
            continue;
        };
        if !matches!(
            class_path.as_str(),
            DATATABLE_CLASS | COMPOSITE_DATATABLE_CLASS
        ) {
            continue;
        }
        tables.push(CatalogTableOutput {
            asset_path: signature.path.to_string_lossy().into_owned(),
            authority: CatalogAuthorityOutput {
                kind: "project_files".to_owned(),
                package_name: package.summary.package_name.clone(),
            },
            completeness: "partial".to_owned(),
            kind: if class_path == DATATABLE_CLASS {
                "data_table".to_owned()
            } else {
                "composite_data_table".to_owned()
            },
            object_path: export.object_path.to_string(),
            parent_tables: Vec::new(),
            row_struct: String::new(),
            schema: CatalogSchemaOutput {
                reason:
                    "Catalog metadata is header-only; open the table to decode its saved schema."
                        .to_owned(),
                status: "unavailable".to_owned(),
            },
        });
    }
    CatalogCacheEntry {
        failure_code: None,
        modified_nanos: signature.modified_nanos,
        path: signature.path.to_string_lossy().into_owned(),
        size: signature.size,
        tables,
    }
}

fn read_package_header(signature: &AssetSignature) -> Result<Package, &'static str> {
    let file_len = usize::try_from(signature.size).map_err(|_| "asset_resource_limit")?;
    if file_len == 0 {
        return Err("asset_malformed_data");
    }
    let mut file = File::open(&signature.path).map_err(|_| "asset_io")?;
    let mut prefix_len = HEADER_PROBE_BYTES.min(file_len);
    let mut bytes = vec![0; prefix_len];
    file.read_exact(&mut bytes).map_err(|_| "asset_io")?;
    let summary = loop {
        match PackageSummary::parse_with_file_len(&bytes, file_len) {
            Ok(summary) => break summary,
            Err(error)
                if error.kind() == PackageErrorKind::MalformedData
                    && prefix_len < MAX_SUMMARY_BYTES.min(file_len) =>
            {
                let next_len = (prefix_len * 2).min(MAX_SUMMARY_BYTES).min(file_len);
                bytes.resize(next_len, 0);
                file.read_exact(&mut bytes[prefix_len..])
                    .map_err(|_| "asset_io")?;
                prefix_len = next_len;
            }
            Err(error) => return Err(package_error_code(&error)),
        }
    };
    let header_len =
        usize::try_from(summary.total_header_size).map_err(|_| "asset_resource_limit")?;
    if header_len > MAX_HEADER_BYTES {
        return Err("asset_resource_limit");
    }
    if header_len > bytes.len() {
        let previous_len = bytes.len();
        bytes.resize(header_len, 0);
        file.read_exact(&mut bytes[previous_len..])
            .map_err(|_| "asset_io")?;
    } else {
        bytes.truncate(header_len);
    }
    Package::parse_header(&bytes, file_len).map_err(|error| package_error_code(&error))
}

fn package_error_code(error: &PackageError) -> &'static str {
    match error.kind() {
        PackageErrorKind::MalformedData => "asset_malformed_data",
        PackageErrorKind::ResourceLimit => "asset_resource_limit",
        PackageErrorKind::UnsupportedFormat => "asset_unsupported_format",
        PackageErrorKind::UnsupportedVersion => "asset_unsupported_version",
        PackageErrorKind::UnsupportedCapability => "asset_unsupported_capability",
    }
}

fn load_catalog_cache(path: Option<&Path>) -> Option<CatalogCache> {
    let path = path?;
    let cache: CatalogCache = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (cache.version == CATALOG_CACHE_VERSION).then_some(cache)
}

fn save_catalog_cache(path: Option<&Path>, entries: &[CatalogCacheEntry]) -> io::Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let rendered = serde_json::to_vec(&CatalogCache {
        entries: entries.to_vec(),
        version: CATALOG_CACHE_VERSION,
    })?;
    fs::write(path, rendered)
}

fn emit_catalog_progress(progress: CatalogProgressOutput) {
    if let Ok(rendered) = serde_json::to_string(&progress) {
        eprintln!("{rendered}");
    }
}

fn read_input(input: &Input) -> io::Result<Vec<u8>> {
    match input {
        Input::File(path) => fs::read(path),
        Input::Stdin => {
            let mut bytes = Vec::new();
            io::stdin().lock().read_to_end(&mut bytes)?;
            Ok(bytes)
        }
    }
}

fn render_output(
    format: OutputFormat,
    output: &InspectOutput,
) -> Result<Vec<u8>, serde_json::Error> {
    match format {
        OutputFormat::Text => Ok(render_text_output(output).into_bytes()),
        OutputFormat::Json => {
            let mut rendered = serde_json::to_vec(output)?;
            rendered.push(b'\n');
            Ok(rendered)
        }
    }
}

fn render_text_output(output: &InspectOutput) -> String {
    let mut rendered = String::new();
    writeln!(rendered, "path: {}", output.path).unwrap();
    writeln!(rendered, "package_name: {}", output.package.name).unwrap();
    writeln!(
        rendered,
        "version: legacy={} ue4={} ue5={} licensee={}",
        output.package.version.legacy_file,
        output.package.version.ue4,
        output.package.version.ue5,
        output.package.version.licensee
    )
    .unwrap();
    writeln!(rendered, "package_flags: {}", output.package.package_flags).unwrap();
    writeln!(rendered, "summary_size: {}", output.package.summary_size).unwrap();
    writeln!(
        rendered,
        "total_header_size: {}",
        output.package.total_header_size
    )
    .unwrap();
    writeln!(
        rendered,
        "names: count={} offset={}",
        output.package.names.count, output.package.names.offset
    )
    .unwrap();
    if let Some(table) = &output.package.soft_object_paths {
        writeln!(
            rendered,
            "soft_object_paths: count={} offset={} parsed={}",
            table.count, table.offset, table.parsed_count
        )
        .unwrap();
    }
    writeln!(
        rendered,
        "imports: count={} offset={}",
        output.package.imports.count, output.package.imports.offset
    )
    .unwrap();
    writeln!(
        rendered,
        "exports: count={} offset={}",
        output.package.exports.count, output.package.exports.offset
    )
    .unwrap();
    for asset in &output.assets {
        writeln!(
            rendered,
            "asset: {} {} rows={}",
            asset.kind, asset.object_path, asset.row_count
        )
        .unwrap();
        if let Some(row_struct) = &asset.row_struct {
            writeln!(rendered, "row_struct: {row_struct}").unwrap();
        }
        if let Some(class_path) = &asset.class_path {
            writeln!(rendered, "class: {class_path}").unwrap();
        }
        if let Some(namespace) = &asset.string_table_namespace {
            writeln!(rendered, "namespace: {namespace}").unwrap();
        }
        if let Some(cpp_form) = &asset.enum_cpp_form {
            writeln!(rendered, "cpp_form: {cpp_form}").unwrap();
        }
        for entry in &asset.enum_entries {
            match &entry.display_name {
                Some(display_name) => writeln!(
                    rendered,
                    "  {} = {} ({display_name:?})",
                    entry.name, entry.value
                )
                .unwrap(),
                None => writeln!(rendered, "  {} = {}", entry.name, entry.value).unwrap(),
            }
        }
        if let Some(struct_flags) = asset.struct_flags {
            writeln!(rendered, "struct_flags: {struct_flags:#x}").unwrap();
        }
        for field in &asset.struct_fields {
            let mut line = format!("  {} ({})", field.name, field.type_name);
            if let Some(referenced) = &field.referenced_path {
                line.push_str(&format!(" -> {referenced}"));
            }
            if let Some(display_name) = &field.display_name {
                line.push_str(&format!(" [{display_name:?}]"));
            }
            writeln!(rendered, "{line}").unwrap();
        }
        for property in &asset.properties {
            writeln!(
                rendered,
                "  {} ({}) = {}",
                property.name,
                property.type_name,
                property.value.render()
            )
            .unwrap();
        }
        for row in &asset.rows {
            writeln!(rendered, "  row {}:", row.name).unwrap();
            for property in &row.properties {
                writeln!(
                    rendered,
                    "    {} ({}) = {}",
                    property.name,
                    property.type_name,
                    property.value.render()
                )
                .unwrap();
            }
        }
        for row in &asset.curve_rows {
            writeln!(rendered, "  curve {}:", row.name).unwrap();
            for key in &row.keys {
                writeln!(rendered, "    {} => {}", key.time, key.value).unwrap();
            }
        }
        for entry in &asset.string_table_entries {
            writeln!(rendered, "  {} = {}", entry.key, entry.source).unwrap();
        }
        if !asset.bones.is_empty() {
            writeln!(rendered, "  bones: {}", asset.bones.len()).unwrap();
            for bone in &asset.bones {
                writeln!(rendered, "    {} parent={}", bone.name, bone.parent_index).unwrap();
            }
        }
    }
    for error in &output.decode_errors {
        writeln!(
            rendered,
            "decode_error: {} [{}] {}",
            error.object_path, error.kind, error.message
        )
        .unwrap();
    }
    rendered
}

fn write_stdout(bytes: &[u8]) -> u8 {
    if let Err(error) = io::stdout().lock().write_all(bytes) {
        eprintln!("uasset: failed to write output: {error}");
        EXIT_INTERNAL
    } else {
        EXIT_SUCCESS
    }
}

fn write_error(format: OutputFormat, error: ErrorOutput) {
    match format {
        OutputFormat::Text => {
            let location = match (error.offset, error.field.as_deref()) {
                (Some(offset), Some(field)) => format!(" at byte {offset} ({field})"),
                (Some(offset), None) => format!(" at byte {offset}"),
                (None, Some(field)) => format!(" ({field})"),
                (None, None) => String::new(),
            };
            eprintln!(
                "uasset: {} error for {}{location}: {}",
                error.kind, error.path, error.message
            );
        }
        OutputFormat::Json => match serde_json::to_vec(&error) {
            Ok(mut rendered) => {
                rendered.push(b'\n');
                if let Err(write_error) = io::stderr().lock().write_all(&rendered) {
                    eprintln!("uasset: failed to write error output: {write_error}");
                }
            }
            Err(serialization_error) => {
                eprintln!("uasset: failed to serialize error: {serialization_error}");
            }
        },
    }
}

fn exit_code_for_package_error(error: &PackageError) -> u8 {
    match error.kind() {
        PackageErrorKind::MalformedData => EXIT_MALFORMED,
        PackageErrorKind::ResourceLimit => EXIT_RESOURCE_LIMIT,
        PackageErrorKind::UnsupportedFormat
        | PackageErrorKind::UnsupportedVersion
        | PackageErrorKind::UnsupportedCapability => EXIT_UNSUPPORTED,
    }
}

#[derive(Serialize)]
struct CatalogOutput {
    schema_version: u32,
    #[serde(rename = "cacheHits")]
    cache_hits: usize,
    #[serde(rename = "changedAssets")]
    changed_assets: usize,
    #[serde(rename = "projectRoot")]
    project_root: String,
    #[serde(rename = "scannedAssets")]
    scanned_assets: usize,
    tables: Vec<CatalogTableOutput>,
    diagnostics: Vec<CatalogDiagnosticOutput>,
}

#[derive(Clone, Deserialize, Serialize)]
struct CatalogTableOutput {
    #[serde(rename = "assetPath")]
    asset_path: String,
    authority: CatalogAuthorityOutput,
    completeness: String,
    kind: String,
    #[serde(rename = "objectPath")]
    object_path: String,
    #[serde(rename = "parentTables")]
    parent_tables: Vec<String>,
    #[serde(rename = "rowStruct")]
    row_struct: String,
    schema: CatalogSchemaOutput,
}

#[derive(Clone, Deserialize, Serialize)]
struct CatalogAuthorityOutput {
    kind: String,
    #[serde(rename = "packageName")]
    package_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct CatalogSchemaOutput {
    reason: String,
    status: String,
}

#[derive(Serialize)]
struct CatalogDiagnosticOutput {
    code: String,
    message: String,
    path: String,
    #[serde(rename = "retrySafe")]
    retry_safe: bool,
}

#[derive(Deserialize, Serialize)]
struct CatalogCache {
    entries: Vec<CatalogCacheEntry>,
    version: u32,
}

#[derive(Clone, Deserialize, Serialize)]
struct CatalogCacheEntry {
    failure_code: Option<String>,
    modified_nanos: u64,
    path: String,
    size: u64,
    tables: Vec<CatalogTableOutput>,
}

impl CatalogCacheEntry {
    fn failure(path: &Path, code: &str) -> Self {
        Self {
            failure_code: Some(code.to_owned()),
            modified_nanos: 0,
            path: path.to_string_lossy().into_owned(),
            size: 0,
            tables: Vec::new(),
        }
    }
}

#[derive(Serialize)]
struct CatalogProgressOutput {
    event: &'static str,
    #[serde(rename = "cacheHits")]
    cache_hits: usize,
    phase: &'static str,
    #[serde(rename = "processedAssets")]
    processed_assets: usize,
    #[serde(rename = "tablesFound")]
    tables_found: usize,
    #[serde(rename = "totalAssets")]
    total_assets: usize,
}

#[derive(Serialize)]
struct InspectOutput {
    schema_version: u32,
    status: &'static str,
    path: String,
    package: PackageOutput,
    assets: Vec<AssetOutput>,
    /// Exports that failed to decode. Non-empty implies `status: "partial"`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    decode_errors: Vec<DecodeErrorOutput>,
}

#[derive(Serialize)]
struct DecodeErrorOutput {
    object_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_path: Option<String>,
    kind: &'static str,
    message: String,
}

#[derive(Serialize)]
struct AuthoringSnapshotOutput {
    contract: AuthoringContractOutput,
    authority: AuthoringAuthorityOutput,
    completeness: &'static str,
    fingerprint: AuthoringUnavailableEvidenceOutput,
    producer: AuthoringProducerOutput,
    table: AuthoringTableOutput,
    diagnostics: Vec<AuthoringDiagnosticOutput>,
}

#[derive(Serialize)]
struct AuthoringContractOutput {
    name: &'static str,
    version: AuthoringVersionOutput,
}

#[derive(Serialize)]
struct AuthoringVersionOutput {
    major: u32,
    minor: u32,
}

#[derive(Serialize)]
struct AuthoringAuthorityOutput {
    kind: &'static str,
    #[serde(rename = "packageName")]
    package_name: String,
}

#[derive(Serialize)]
struct AuthoringProducerOutput {
    name: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct AuthoringUnavailableEvidenceOutput {
    status: &'static str,
    reason: &'static str,
}

#[derive(Serialize)]
struct AuthoringTableOutput {
    kind: &'static str,
    #[serde(rename = "objectPath")]
    object_path: String,
    #[serde(rename = "packageName")]
    package_name: String,
    #[serde(rename = "rowStruct")]
    row_struct: String,
    #[serde(rename = "parentTables")]
    parent_tables: Vec<String>,
    rows: Vec<AuthoringRowOutput>,
    schema: AuthoringUnavailableEvidenceOutput,
}

#[derive(Serialize)]
struct AuthoringRowOutput {
    id: String,
    name: String,
    fields: Vec<AuthoringFieldOutput>,
}

#[derive(Serialize)]
struct AuthoringFieldOutput {
    name: String,
    #[serde(rename = "typeName")]
    type_name: String,
    value: AuthoringValueOutput,
}

#[derive(Serialize)]
struct AuthoringMapEntryOutput {
    key: AuthoringValueOutput,
    value: AuthoringValueOutput,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AuthoringValueOutput {
    Bool {
        value: bool,
    },
    Int {
        value: String,
    },
    Uint {
        value: String,
    },
    Float {
        value: AuthoringFloatOutput,
    },
    Double {
        value: AuthoringFloatOutput,
    },
    Name {
        value: String,
    },
    Enum {
        value: String,
    },
    String {
        value: String,
    },
    Text {
        value: String,
    },
    Vector {
        x: f64,
        y: f64,
        z: f64,
    },
    RowReference {
        #[serde(rename = "tableObjectPath")]
        table_object_path: Option<String>,
        #[serde(rename = "rowName")]
        row_name: String,
    },
    ObjectRef {
        value: Option<String>,
    },
    Guid {
        value: String,
    },
    SoftObjectPath {
        value: String,
    },
    Array {
        values: Vec<AuthoringValueOutput>,
    },
    Set {
        values: Vec<AuthoringValueOutput>,
    },
    Map {
        entries: Vec<AuthoringMapEntryOutput>,
    },
    Struct {
        fields: Vec<AuthoringFieldOutput>,
    },
    Unsupported {
        reason: String,
        #[serde(rename = "byteSize")]
        byte_size: u64,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
enum AuthoringFloatOutput {
    Finite(f64),
    Special(&'static str),
}

impl AuthoringFloatOutput {
    fn from_f64(value: f64) -> Self {
        if value.is_nan() {
            Self::Special("nan")
        } else if value == f64::INFINITY {
            Self::Special("infinity")
        } else if value == f64::NEG_INFINITY {
            Self::Special("-infinity")
        } else {
            Self::Finite(value)
        }
    }
}

#[derive(Serialize)]
struct AuthoringDiagnosticOutput {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

impl AuthoringSnapshotOutput {
    fn from_inspect(inspect: &InspectOutput, table: &AssetOutput) -> Self {
        let mut partial = !inspect.decode_errors.is_empty();
        let rows = table
            .rows
            .iter()
            .map(|row| {
                let fields = row
                    .properties
                    .iter()
                    .map(|property| {
                        if property.value.contains_unsupported() {
                            partial = true;
                        }
                        AuthoringFieldOutput::from_property(property)
                    })
                    .collect();
                AuthoringRowOutput {
                    id: format!("row:{}", row.name),
                    name: row.name.clone(),
                    fields,
                }
            })
            .collect();
        Self {
            contract: AuthoringContractOutput {
                name: "unreal-authoring",
                version: AuthoringVersionOutput { major: 2, minor: 1 },
            },
            authority: AuthoringAuthorityOutput {
                kind: "project_files",
                package_name: inspect.package.name.clone(),
            },
            completeness: if partial { "partial" } else { "complete" },
            fingerprint: AuthoringUnavailableEvidenceOutput {
                status: "unavailable",
                reason: "The saved-package producer does not emit a canonical fingerprint yet.",
            },
            producer: AuthoringProducerOutput {
                name: "uasset-parser",
                version: env!("CARGO_PKG_VERSION"),
            },
            table: AuthoringTableOutput {
                kind: if table.kind == "CompositeDataTable" {
                    "composite_data_table"
                } else {
                    "data_table"
                },
                object_path: table.object_path.clone(),
                package_name: inspect.package.name.clone(),
                row_struct: table.row_struct.clone().unwrap_or_default(),
                parent_tables: table.parent_tables.clone(),
                rows,
                schema: AuthoringUnavailableEvidenceOutput {
                    status: "unavailable",
                    reason: "Saved row-structure schema has not been resolved for this table.",
                },
            },
            diagnostics: inspect
                .decode_errors
                .iter()
                .map(|error| AuthoringDiagnosticOutput {
                    code: error.kind,
                    message: error.message.clone(),
                    path: Some(error.object_path.clone()),
                })
                .collect(),
        }
    }
}

impl AuthoringFieldOutput {
    fn from_property(property: &PropertyOutput) -> Self {
        Self {
            name: property.name.clone(),
            type_name: property.type_name.clone(),
            value: AuthoringValueOutput::from_property(&property.value),
        }
    }
}

impl AuthoringValueOutput {
    fn from_property(value: &PropertyValueOutput) -> Self {
        match value {
            PropertyValueOutput::Bool { value } => Self::Bool { value: *value },
            PropertyValueOutput::Int { value } => Self::Int {
                value: value.to_string(),
            },
            PropertyValueOutput::Uint { value } => Self::Uint {
                value: value.to_string(),
            },
            PropertyValueOutput::Float { value } => Self::Float {
                value: AuthoringFloatOutput::from_f64(f64::from(*value)),
            },
            PropertyValueOutput::Double { value } => Self::Double {
                value: AuthoringFloatOutput::from_f64(*value),
            },
            PropertyValueOutput::Name { value } => Self::Name {
                value: value.clone(),
            },
            PropertyValueOutput::Enum { value } => Self::Enum {
                value: value.clone(),
            },
            PropertyValueOutput::String { value } => Self::String {
                value: value.clone(),
            },
            PropertyValueOutput::Text { value, .. } => Self::Text {
                value: value.clone(),
            },
            PropertyValueOutput::Vector { x, y, z } => Self::Vector {
                x: *x,
                y: *y,
                z: *z,
            },
            PropertyValueOutput::IntPoint { x, y } => Self::Struct {
                fields: vec![
                    AuthoringFieldOutput {
                        name: "X".to_owned(),
                        type_name: "IntProperty".to_owned(),
                        value: Self::Int {
                            value: x.to_string(),
                        },
                    },
                    AuthoringFieldOutput {
                        name: "Y".to_owned(),
                        type_name: "IntProperty".to_owned(),
                        value: Self::Int {
                            value: y.to_string(),
                        },
                    },
                ],
            },
            PropertyValueOutput::DataTableRowHandle {
                table_object_path,
                row_name,
            } => Self::RowReference {
                table_object_path: table_object_path.clone(),
                row_name: row_name.clone(),
            },
            PropertyValueOutput::ObjectRef { value } => Self::ObjectRef {
                value: value.clone(),
            },
            PropertyValueOutput::Guid { value } => Self::Guid {
                value: value.clone(),
            },
            PropertyValueOutput::SoftObjectPath { value } => Self::SoftObjectPath {
                value: value.clone(),
            },
            PropertyValueOutput::Array { values } => Self::Array {
                values: values.iter().map(Self::from_property).collect(),
            },
            PropertyValueOutput::Set { values } => Self::Set {
                values: values.iter().map(Self::from_property).collect(),
            },
            PropertyValueOutput::Map { entries } => Self::Map {
                entries: entries
                    .iter()
                    .map(|entry| AuthoringMapEntryOutput {
                        key: Self::from_property(&entry.key),
                        value: Self::from_property(&entry.value),
                    })
                    .collect(),
            },
            PropertyValueOutput::Struct { properties } => Self::Struct {
                fields: properties
                    .iter()
                    .map(AuthoringFieldOutput::from_property)
                    .collect(),
            },
            PropertyValueOutput::Raw { reason, size } => Self::Unsupported {
                reason: reason.clone(),
                byte_size: *size,
            },
        }
    }
}

impl PropertyValueOutput {
    fn contains_unsupported(&self) -> bool {
        match self {
            Self::Raw { .. } => true,
            Self::Array { values } | Self::Set { values } => {
                values.iter().any(Self::contains_unsupported)
            }
            Self::Map { entries } => entries.iter().any(|entry| {
                entry.key.contains_unsupported() || entry.value.contains_unsupported()
            }),
            Self::Struct { properties } => properties
                .iter()
                .any(|property| property.value.contains_unsupported()),
            _ => false,
        }
    }
}

impl InspectOutput {
    fn from_summary(path: String, summary: &PackageSummary) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            status: "ok",
            path,
            package: PackageOutput {
                name: summary.package_name.clone(),
                version: VersionOutput {
                    legacy_file: summary.versions.legacy_file_version,
                    legacy_ue3: summary.versions.legacy_ue3,
                    ue4: summary.versions.ue4,
                    ue5: summary.versions.ue5,
                    licensee: summary.versions.licensee,
                },
                package_flags: summary.versions.package_flags.bits(),
                summary_size: summary.span.len(),
                total_header_size: summary.total_header_size,
                names: TableOutput::from(summary.names),
                soft_object_paths: summary
                    .soft_object_paths
                    .map(|table| SoftObjectPathsOutput {
                        count: table.count,
                        offset: table.offset.get(),
                        parsed_count: 0,
                    }),
                imports: TableOutput::from(summary.imports),
                exports: TableOutput::from(summary.exports),
            },
            assets: Vec::new(),
            decode_errors: Vec::new(),
        }
    }

    /// Decodes every export, collecting per-export failures instead of aborting.
    /// A single unsupported or malformed export no longer blanks the whole file;
    /// callers report `status: "partial"` when `decode_errors` is non-empty.
    fn from_package(path: String, source: &[u8], package: &Package) -> Self {
        let mut output = Self::from_summary(path, &package.summary);
        if let Some(table) = &mut output.package.soft_object_paths {
            table.parsed_count = package.soft_object_paths.len();
        }
        let schemas = EmptySchemas;
        let context = AssetDecodeContext {
            source,
            package,
            schemas: &schemas,
        };
        for export in &package.exports {
            match decode_export(export, &context) {
                Ok(Some(decoded)) => {
                    output
                        .assets
                        .push(asset_output_from_decoded(package, decoded));
                }
                Ok(None) => {}
                Err(error) => {
                    output.decode_errors.push(DecodeErrorOutput {
                        object_path: export.object_path.to_string(),
                        class_path: export.class_path.as_ref().map(ToString::to_string),
                        kind: asset_error_kind_name(error.kind()),
                        message: error.message().to_owned(),
                    });
                }
            }
        }
        if !output.decode_errors.is_empty() {
            output.status = "partial";
        }
        output
    }
}

fn asset_error_kind_name(kind: AssetErrorKind) -> &'static str {
    match kind {
        AssetErrorKind::MalformedData => "malformed_data",
        AssetErrorKind::ResourceLimit => "resource_limit",
        AssetErrorKind::UnsupportedFormat => "unsupported_format",
        AssetErrorKind::UnsupportedVersion => "unsupported_version",
        AssetErrorKind::UnsupportedCapability => "unsupported_capability",
    }
}

fn asset_output_from_decoded(package: &Package, decoded: DecodedAsset) -> AssetOutput {
    match decoded {
        DecodedAsset::DataTable(datatable) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: match datatable.kind {
                uasset_parser::asset::DataTableKind::Plain => "DataTable",
                uasset_parser::asset::DataTableKind::Composite => "CompositeDataTable",
            },
            object_path: datatable.object_path.to_string(),
            class_path: None,
            object_guid: None,
            row_struct: datatable.row_struct.map(|path| path.to_string()),
            parent_tables: datatable
                .parent_tables
                .iter()
                .map(|path| path.to_string())
                .collect(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: Vec::new(),
            row_count: datatable.rows.len(),
            curve_rows: Vec::new(),
            rows: datatable
                .rows
                .iter()
                .map(|row| RowOutput {
                    name: resolve_name_or_placeholder(package, row.name),
                    properties: property_outputs(package, &row.properties),
                })
                .collect(),
        },
        DecodedAsset::CurveTable(curve_table) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: "CurveTable",
            object_path: curve_table.object_path.to_string(),
            class_path: Some(uasset_parser::asset::CURVETABLE_CLASS.to_owned()),
            object_guid: None,
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, &curve_table.properties),
            row_count: curve_table.rows.len(),
            curve_rows: curve_table
                .rows
                .iter()
                .map(|row| CurveRowOutput {
                    name: resolve_name_or_placeholder(package, row.name),
                    keys: row
                        .keys
                        .iter()
                        .map(|key| CurveKeyOutput {
                            time: key.time(),
                            value: key.value(),
                        })
                        .collect(),
                })
                .collect(),
            rows: Vec::new(),
        },
        DecodedAsset::StringTable(string_table) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: "StringTable",
            object_path: string_table.object_path.to_string(),
            class_path: Some(uasset_parser::asset::STRINGTABLE_CLASS.to_owned()),
            object_guid: None,
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: Some(string_table.namespace),
            string_table_entries: string_table
                .entries
                .into_iter()
                .map(|entry| StringTableEntryOutput {
                    key: entry.key,
                    source: entry.source,
                })
                .collect(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: Vec::new(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::DataAsset(data_asset) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: data_asset_kind(data_asset.class_path.as_str()),
            object_path: data_asset.object_path.to_string(),
            class_path: Some(data_asset.class_path.to_string()),
            object_guid: data_asset.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, &data_asset.properties),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::UObject(object) => AssetOutput {
            kind: "UObject",
            object_path: object.object_path.to_string(),
            class_path: Some(object.class_path.to_string()),
            object_guid: object.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, &object.properties),
            tail_bytes: object.tail.len(),
            bones: Vec::new(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::Skeleton(skeleton) => AssetOutput {
            kind: "Skeleton",
            object_path: skeleton.object_path.to_string(),
            class_path: Some(SKELETON_CLASS.to_owned()),
            object_guid: skeleton.object_guid.map(|guid| guid.to_string()),
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: property_outputs(package, &skeleton.properties),
            tail_bytes: 0,
            bones: skeleton
                .bones
                .iter()
                .map(|bone| BoneOutput {
                    name: resolve_name_or_placeholder(package, bone.name),
                    parent_index: bone.parent_index,
                })
                .collect(),
            row_count: 0,
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::Enum(decoded_enum) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: "Enum",
            object_path: decoded_enum.object_path.to_string(),
            class_path: Some(USERDEFINEDENUM_CLASS.to_owned()),
            object_guid: None,
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: Some(enum_cpp_form_name(decoded_enum.cpp_form)),
            enum_entries: decoded_enum
                .entries
                .iter()
                .map(|entry| EnumEntryOutput {
                    name: resolve_name_or_placeholder(package, entry.name),
                    value: entry.value,
                    display_name: entry.display_name.clone(),
                })
                .collect(),
            struct_flags: None,
            struct_fields: Vec::new(),
            properties: Vec::new(),
            row_count: decoded_enum.entries.len(),
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
        DecodedAsset::Struct(decoded_struct) => AssetOutput {
            tail_bytes: 0,
            bones: Vec::new(),
            kind: "Struct",
            object_path: decoded_struct.object_path.to_string(),
            class_path: Some(USERDEFINEDSTRUCT_CLASS.to_owned()),
            object_guid: None,
            row_struct: None,
            parent_tables: Vec::new(),
            string_table_namespace: None,
            string_table_entries: Vec::new(),
            enum_cpp_form: None,
            enum_entries: Vec::new(),
            struct_flags: Some(decoded_struct.struct_flags),
            struct_fields: decoded_struct
                .fields
                .iter()
                .map(|field| StructFieldOutput {
                    name: resolve_name_or_placeholder(package, field.name),
                    type_name: resolve_name_or_placeholder(package, field.type_name),
                    referenced_path: field.referenced_path.as_ref().map(ToString::to_string),
                    display_name: field.display_name.clone(),
                })
                .collect(),
            properties: property_outputs(package, &decoded_struct.default_values),
            row_count: decoded_struct.fields.len(),
            curve_rows: Vec::new(),
            rows: Vec::new(),
        },
    }
}

fn enum_cpp_form_name(cpp_form: EnumCppForm) -> &'static str {
    match cpp_form {
        EnumCppForm::Regular => "Regular",
        EnumCppForm::Namespaced => "Namespaced",
        EnumCppForm::EnumClass => "EnumClass",
    }
}

fn property_outputs(
    package: &Package,
    stream: &uasset_parser::property::PropertyStream,
) -> Vec<PropertyOutput> {
    stream
        .records
        .iter()
        .map(|record| PropertyOutput::from_record(record, package))
        .collect()
}

fn data_asset_kind(class_path: &str) -> &'static str {
    match class_path {
        PRIMARY_DATA_ASSET_CLASS => "PrimaryDataAsset",
        DATA_ASSET_CLASS => "DataAsset",
        _ => "DataAsset",
    }
}

struct EmptySchemas;

impl SchemaProvider for EmptySchemas {
    fn find_struct(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&StructSchema> {
        None
    }

    fn find_class(&self, _path: &uasset_parser::package::ObjectPath) -> Option<&ClassSchema> {
        None
    }
}

#[derive(Serialize)]
struct PackageOutput {
    name: String,
    version: VersionOutput,
    package_flags: u32,
    summary_size: u64,
    total_header_size: u32,
    names: TableOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    soft_object_paths: Option<SoftObjectPathsOutput>,
    imports: TableOutput,
    exports: TableOutput,
}

#[derive(Serialize)]
struct SoftObjectPathsOutput {
    count: u32,
    offset: u64,
    parsed_count: usize,
}

#[derive(Serialize)]
struct AssetOutput {
    kind: &'static str,
    object_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    class_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    object_guid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_struct: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    parent_tables: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    string_table_namespace: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    string_table_entries: Vec<StringTableEntryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enum_cpp_form: Option<&'static str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    enum_entries: Vec<EnumEntryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    struct_flags: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    struct_fields: Vec<StructFieldOutput>,
    properties: Vec<PropertyOutput>,
    /// Count of unparsed class-specific bytes retained after the property stream
    /// (e.g. a `StaticMesh`/`Texture2D` binary tail). Omitted when zero.
    #[serde(skip_serializing_if = "is_zero_u64")]
    tail_bytes: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    bones: Vec<BoneOutput>,
    row_count: usize,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    curve_rows: Vec<CurveRowOutput>,
    rows: Vec<RowOutput>,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Serialize)]
struct BoneOutput {
    name: String,
    parent_index: i32,
}

#[derive(Serialize)]
struct EnumEntryOutput {
    name: String,
    value: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
}

#[derive(Serialize)]
struct StructFieldOutput {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    referenced_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
}

#[derive(Serialize)]
struct RowOutput {
    name: String,
    properties: Vec<PropertyOutput>,
}

#[derive(Serialize)]
struct CurveRowOutput {
    name: String,
    keys: Vec<CurveKeyOutput>,
}

#[derive(Serialize)]
struct CurveKeyOutput {
    time: f32,
    value: f32,
}

#[derive(Serialize)]
struct StringTableEntryOutput {
    key: String,
    source: String,
}

#[derive(Serialize)]
struct PropertyOutput {
    name: String,
    #[serde(rename = "type")]
    type_name: String,
    #[serde(flatten)]
    value: PropertyValueOutput,
}

impl PropertyOutput {
    fn from_record(record: &PropertyRecord, package: &Package) -> Self {
        let value = match &record.value {
            PropertyValue::Bool(value) => PropertyValueOutput::Bool { value: *value },
            PropertyValue::Int(value) => PropertyValueOutput::Int { value: *value },
            PropertyValue::UInt(value) => PropertyValueOutput::Uint { value: *value },
            PropertyValue::Float(value) => PropertyValueOutput::Float { value: *value },
            PropertyValue::Double(value) => PropertyValueOutput::Double { value: *value },
            PropertyValue::Name(name) => PropertyValueOutput::Name {
                value: resolve_name_or_placeholder(package, *name),
            },
            PropertyValue::Enum(name) => PropertyValueOutput::Enum {
                value: resolve_name_or_placeholder(package, *name),
            },
            PropertyValue::String(value) => PropertyValueOutput::String {
                value: value.clone(),
            },
            PropertyValue::Text(text) => text_value_output(text),
            PropertyValue::Vector(vector) => PropertyValueOutput::Vector {
                x: vector.x,
                y: vector.y,
                z: vector.z,
            },
            PropertyValue::IntPoint(point) => PropertyValueOutput::IntPoint {
                x: point.x,
                y: point.y,
            },
            PropertyValue::DataTableRowHandle(handle) => PropertyValueOutput::DataTableRowHandle {
                table_object_path: resolve_object_ref(package, handle.table),
                row_name: resolve_name_or_placeholder(package, handle.row_name),
            },
            PropertyValue::ObjectRef(index) => PropertyValueOutput::ObjectRef {
                value: resolve_object_ref(package, *index),
            },
            PropertyValue::Guid(guid) => PropertyValueOutput::Guid {
                value: guid.to_string(),
            },
            PropertyValue::SoftObjectPath(path) => PropertyValueOutput::SoftObjectPath {
                value: path.clone(),
            },
            PropertyValue::Array(values) => PropertyValueOutput::Array {
                values: values
                    .iter()
                    .map(|value| value_output(package, value))
                    .collect(),
            },
            PropertyValue::Set(values) => PropertyValueOutput::Set {
                values: values
                    .iter()
                    .map(|value| value_output(package, value))
                    .collect(),
            },
            PropertyValue::Map(entries) => PropertyValueOutput::Map {
                entries: entries
                    .iter()
                    .map(|entry| MapEntryOutput {
                        key: value_output(package, &entry.key),
                        value: value_output(package, &entry.value),
                    })
                    .collect(),
            },
            PropertyValue::Struct(stream) => PropertyValueOutput::Struct {
                properties: stream
                    .records
                    .iter()
                    .map(|record| PropertyOutput::from_record(record, package))
                    .collect(),
            },
            PropertyValue::Raw { reason } => PropertyValueOutput::Raw {
                reason: render_raw_reason(reason),
                size: record.payload.len(),
            },
        };
        Self {
            name: resolve_name_or_placeholder(package, record.name),
            type_name: resolve_name_or_placeholder(package, record.type_name.name),
            value,
        }
    }
}

#[derive(Serialize)]
struct MapEntryOutput {
    key: PropertyValueOutput,
    value: PropertyValueOutput,
}

#[derive(Serialize)]
#[serde(tag = "value_kind", rename_all = "snake_case")]
enum PropertyValueOutput {
    Bool {
        value: bool,
    },
    Int {
        value: i64,
    },
    Uint {
        value: u64,
    },
    Float {
        value: f32,
    },
    Double {
        value: f64,
    },
    Name {
        value: String,
    },
    Enum {
        value: String,
    },
    String {
        value: String,
    },
    Text {
        value: String,
        history: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        key: Option<String>,
    },
    Vector {
        x: f64,
        y: f64,
        z: f64,
    },
    IntPoint {
        x: i32,
        y: i32,
    },
    DataTableRowHandle {
        table_object_path: Option<String>,
        row_name: String,
    },
    ObjectRef {
        value: Option<String>,
    },
    Guid {
        value: String,
    },
    SoftObjectPath {
        value: String,
    },
    Array {
        values: Vec<PropertyValueOutput>,
    },
    Set {
        values: Vec<PropertyValueOutput>,
    },
    Map {
        entries: Vec<MapEntryOutput>,
    },
    Struct {
        properties: Vec<PropertyOutput>,
    },
    Raw {
        reason: String,
        size: u64,
    },
}

fn value_output(package: &Package, value: &PropertyValue) -> PropertyValueOutput {
    match value {
        PropertyValue::Bool(value) => PropertyValueOutput::Bool { value: *value },
        PropertyValue::Int(value) => PropertyValueOutput::Int { value: *value },
        PropertyValue::UInt(value) => PropertyValueOutput::Uint { value: *value },
        PropertyValue::Float(value) => PropertyValueOutput::Float { value: *value },
        PropertyValue::Double(value) => PropertyValueOutput::Double { value: *value },
        PropertyValue::Name(name) => PropertyValueOutput::Name {
            value: resolve_name_or_placeholder(package, *name),
        },
        PropertyValue::Enum(name) => PropertyValueOutput::Enum {
            value: resolve_name_or_placeholder(package, *name),
        },
        PropertyValue::String(value) => PropertyValueOutput::String {
            value: value.clone(),
        },
        PropertyValue::Text(text) => text_value_output(text),
        PropertyValue::Vector(vector) => PropertyValueOutput::Vector {
            x: vector.x,
            y: vector.y,
            z: vector.z,
        },
        PropertyValue::IntPoint(point) => PropertyValueOutput::IntPoint {
            x: point.x,
            y: point.y,
        },
        PropertyValue::DataTableRowHandle(handle) => PropertyValueOutput::DataTableRowHandle {
            table_object_path: resolve_object_ref(package, handle.table),
            row_name: resolve_name_or_placeholder(package, handle.row_name),
        },
        PropertyValue::ObjectRef(index) => PropertyValueOutput::ObjectRef {
            value: resolve_object_ref(package, *index),
        },
        PropertyValue::Guid(guid) => PropertyValueOutput::Guid {
            value: guid.to_string(),
        },
        PropertyValue::SoftObjectPath(path) => PropertyValueOutput::SoftObjectPath {
            value: path.clone(),
        },
        PropertyValue::Array(values) => PropertyValueOutput::Array {
            values: values
                .iter()
                .map(|value| value_output(package, value))
                .collect(),
        },
        PropertyValue::Set(values) => PropertyValueOutput::Set {
            values: values
                .iter()
                .map(|value| value_output(package, value))
                .collect(),
        },
        PropertyValue::Map(entries) => PropertyValueOutput::Map {
            entries: entries
                .iter()
                .map(|entry| MapEntryOutput {
                    key: value_output(package, &entry.key),
                    value: value_output(package, &entry.value),
                })
                .collect(),
        },
        PropertyValue::Struct(stream) => PropertyValueOutput::Struct {
            properties: stream
                .records
                .iter()
                .map(|record| PropertyOutput::from_record(record, package))
                .collect(),
        },
        PropertyValue::Raw { reason } => PropertyValueOutput::Raw {
            reason: render_raw_reason(reason),
            size: 0,
        },
    }
}

fn text_value_output(text: &uasset_parser::property::TextValue) -> PropertyValueOutput {
    use uasset_parser::property::TextHistory;

    match &text.history {
        TextHistory::None => PropertyValueOutput::Text {
            value: text.source.clone(),
            history: "none",
            namespace: None,
            key: None,
        },
        TextHistory::Base { namespace, key } => PropertyValueOutput::Text {
            value: text.source.clone(),
            history: "base",
            namespace: Some(namespace.clone()),
            key: Some(key.clone()),
        },
    }
}

impl PropertyValueOutput {
    fn render(&self) -> String {
        match self {
            Self::Bool { value } => value.to_string(),
            Self::Int { value } => value.to_string(),
            Self::Uint { value } => value.to_string(),
            Self::Float { value } => value.to_string(),
            Self::Double { value } => value.to_string(),
            Self::Name { value } => value.clone(),
            Self::Enum { value } => value.clone(),
            Self::String { value } => format!("{value:?}"),
            Self::Text { value, .. } => format!("{value:?}"),
            Self::Vector { x, y, z } => format!("({x}, {y}, {z})"),
            Self::IntPoint { x, y } => format!("({x}, {y})"),
            Self::DataTableRowHandle {
                table_object_path,
                row_name,
            } => format!(
                "{} -> {row_name}",
                table_object_path.as_deref().unwrap_or("<none>")
            ),
            Self::ObjectRef { value } => value.clone().unwrap_or_else(|| "null".to_owned()),
            Self::Guid { value } => value.clone(),
            Self::SoftObjectPath { value } => {
                if value.is_empty() {
                    "<none>".to_owned()
                } else {
                    value.clone()
                }
            }
            Self::Array { values } => {
                let rendered: Vec<String> = values.iter().map(Self::render).collect();
                format!("[{}]", rendered.join(", "))
            }
            Self::Set { values } => {
                let rendered: Vec<String> = values.iter().map(Self::render).collect();
                format!("{{{}}}", rendered.join(", "))
            }
            Self::Map { entries } => {
                let rendered: Vec<String> = entries
                    .iter()
                    .map(|entry| format!("{} => {}", entry.key.render(), entry.value.render()))
                    .collect();
                format!("{{{}}}", rendered.join(", "))
            }
            Self::Struct { properties } => {
                let rendered: Vec<String> = properties
                    .iter()
                    .map(|property| format!("{} = {}", property.name, property.value.render()))
                    .collect();
                format!("{{{}}}", rendered.join(", "))
            }
            Self::Raw { reason, size } => format!("<raw {reason}, {size} bytes>"),
        }
    }
}

fn resolve_name_or_placeholder(package: &Package, name: uasset_parser::archive::NameRef) -> String {
    package
        .resolve_name(name)
        .unwrap_or_else(|| "<unresolved>".to_owned())
}

fn resolve_object_ref(package: &Package, index: PackageIndex) -> Option<String> {
    if index == PackageIndex::Null {
        None
    } else {
        package.resolve_index(index).map(|path| path.to_string())
    }
}

fn render_raw_reason(reason: &RawReason) -> String {
    match reason {
        RawReason::UnsupportedType => "unsupported type".to_owned(),
        RawReason::DecoderRejected(detail) => detail.clone(),
    }
}

#[derive(Serialize)]
struct VersionOutput {
    legacy_file: i32,
    legacy_ue3: Option<i32>,
    ue4: i32,
    ue5: i32,
    licensee: i32,
}

#[derive(Serialize)]
struct TableOutput {
    count: u32,
    offset: u64,
}

impl From<TableLocation> for TableOutput {
    fn from(table: TableLocation) -> Self {
        Self {
            count: table.count,
            offset: table.offset.get(),
        }
    }
}

#[derive(Serialize)]
struct ErrorOutput {
    schema_version: u32,
    status: &'static str,
    path: String,
    kind: &'static str,
    message: String,
    field: Option<String>,
    offset: Option<u64>,
}

impl ErrorOutput {
    fn io(path: String, message: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            status: "error",
            path,
            kind: "io",
            message,
            field: None,
            offset: None,
        }
    }

    fn package(path: String, error: &PackageError) -> Self {
        let kind = match error.kind() {
            PackageErrorKind::MalformedData => "malformed_data",
            PackageErrorKind::ResourceLimit => "resource_limit",
            PackageErrorKind::UnsupportedFormat => "unsupported_format",
            PackageErrorKind::UnsupportedVersion => "unsupported_version",
            PackageErrorKind::UnsupportedCapability => "unsupported_capability",
        };
        Self {
            schema_version: SCHEMA_VERSION,
            status: "error",
            path,
            kind,
            message: error.detail().to_owned(),
            field: Some(error.path().to_owned()),
            offset: error.offset(),
        }
    }
}

const USAGE: &str = "Usage: uasset <inspect|authoring|catalog> <path> [--format text|json]";

const HELP: &str = "\
uasset - inspect classic Unreal Engine asset packages

Usage:
  uasset inspect <path|-> [--format text|json]
  uasset authoring <path|-> --format json
  uasset catalog <project-root> [--format json] [--concurrency <count>]
  uasset help
  uasset version

Commands:
  inspect    Parse one package and emit decoded assets.
  authoring  Emit the versioned Unreal authoring snapshot for one DataTable package.
  catalog    Discover saved DataTables beneath one Unreal project in a single process.

Output contract:
  stdout     Successful result only.
  stderr     Diagnostics and structured errors only.
  text       Human-readable output (default).
  json       Stable schema-versioned JSON.

Exit codes:
  0          Success
  2          Malformed package data
  3          Unsupported format, version, or capability
  4          Input/output failure
  5          Internal output failure
  6          Partial authoring or inspection result
  7          Parser resource limit exceeded
  64         Invalid command-line usage
";

#[cfg(test)]
mod command_tests {
    use super::*;

    #[test]
    fn parses_inspect_contract() {
        assert_eq!(
            Command::parse(vec![
                "inspect".into(),
                "asset.uasset".into(),
                "--format=json".into(),
            ])
            .expect("inspect command"),
            Command::Inspect(InspectOptions {
                input: Input::File(PathBuf::from("asset.uasset")),
                format: OutputFormat::Json,
            })
        );
    }

    #[test]
    fn parses_authoring_contract() {
        assert!(matches!(
            Command::parse(vec![
                "authoring".into(),
                "table.uasset".into(),
                "--format".into(),
                "json".into(),
            ])
            .expect("authoring command"),
            Command::Authoring(_)
        ));
    }

    #[test]
    fn parses_catalog_contract() {
        assert_eq!(
            Command::parse(vec![
                "catalog".into(),
                "project".into(),
                "--concurrency=3".into(),
            ])
            .expect("catalog command"),
            Command::Catalog(CatalogOptions {
                cache: None,
                project_root: PathBuf::from("project"),
                format: OutputFormat::Json,
                concurrency: 3,
            })
        );
    }

    #[test]
    fn catalog_cache_requires_matching_path_size_and_timestamp() {
        let signature = AssetSignature {
            modified_nanos: 20,
            path: PathBuf::from("Content/DT_Test.uasset"),
            size: 10,
        };
        let entry = CatalogCacheEntry {
            failure_code: None,
            modified_nanos: 20,
            path: "Content/DT_Test.uasset".to_owned(),
            size: 10,
            tables: Vec::new(),
        };
        assert!(cache_entry_matches(&entry, &signature));
        assert!(!cache_entry_matches(
            &CatalogCacheEntry {
                modified_nanos: 21,
                ..entry.clone()
            },
            &signature
        ));
        assert!(!cache_entry_matches(
            &CatalogCacheEntry { size: 11, ..entry },
            &signature
        ));
    }

    #[test]
    fn parses_stdin_contract() {
        assert_eq!(
            Command::parse(vec!["inspect".into(), "-".into()]).expect("stdin command"),
            Command::Inspect(InspectOptions {
                input: Input::Stdin,
                format: OutputFormat::Text,
            })
        );
    }

    #[test]
    fn rejects_multiple_inputs() {
        let error = Command::parse(vec!["inspect".into(), "one".into(), "two".into()]).unwrap_err();
        assert_eq!(error, "inspect accepts exactly one input");
    }
}
