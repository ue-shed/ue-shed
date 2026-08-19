//! Human-facing command adapters for the native UAsset IO executors.
//!
//! This module owns only CLI parsing and presentation. Filesystem access, package decoding,
//! project discovery, filtering, scheduling, caching, and projections live in `direct_executor`.

use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use serde_json::{Value, json};
use uasset_inspection::generic::write_inspection_json;

use crate::direct_executor;
use crate::protocol::{
    Contract, ContractVersion, Operation, ProjectSelection, Request, ResourceLimits,
    ScanDepth as ProtocolScanDepth, ScanFilters as ProtocolScanFilters,
};
use crate::protocol_result::ResultFrame;

const EXIT_SUCCESS: u8 = 0;
const EXIT_MALFORMED: u8 = 2;
const EXIT_UNSUPPORTED: u8 = 3;
const EXIT_IO: u8 = 4;
const EXIT_INTERNAL: u8 = 5;
const EXIT_PARTIAL: u8 = 6;
const EXIT_RESOURCE_LIMIT: u8 = 7;
const EXIT_USAGE: u8 = 64;
const DEFAULT_SAVED_WORLD_MAXIMUM_ASSETS: usize = 100_000;

pub fn run(arguments: Vec<OsString>) -> u8 {
    match Command::parse(arguments) {
        Ok(Command::Help) => write_stdout(HELP.as_bytes()),
        Ok(Command::Version) => {
            write_stdout(format!("uasset {}\n", env!("CARGO_PKG_VERSION")).as_bytes())
        }
        Ok(Command::Inspect(options)) => inspect(&options),
        Ok(Command::Authoring(options)) => authoring(&options),
        Ok(Command::Scan(options)) => scan(&options),
        Ok(Command::SavedWorld(options)) => saved_world(&options),
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
struct ScanOptions {
    project_root: PathBuf,
    paths: Vec<PathBuf>,
    format: OutputFormat,
    concurrency: usize,
    maximum_assets: Option<usize>,
    filters: ScanFilters,
    depth: ScanDepth,
    cache: Option<PathBuf>,
    inventory: bool,
    projection: ScanProjection,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ScanProjection {
    #[default]
    Generic,
    Text,
    Texture,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ScanDepth {
    Header,
    #[default]
    Full,
}

#[derive(Debug, Eq, PartialEq)]
struct SavedWorldOptions {
    project_root: PathBuf,
    map_path: PathBuf,
    format: OutputFormat,
    concurrency: usize,
    maximum_assets: usize,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct ScanFilters {
    classes: Vec<String>,
    class_prefixes: Vec<String>,
    class_name_suffixes: Vec<String>,
    names: Vec<String>,
}

impl ScanFilters {
    fn is_empty(&self) -> bool {
        self.classes.is_empty()
            && self.class_prefixes.is_empty()
            && self.class_name_suffixes.is_empty()
            && self.names.is_empty()
    }
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
    Scan(ScanOptions),
    SavedWorld(SavedWorldOptions),
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
            Some("scan") => Self::parse_scan(arguments.collect()),
            Some("saved-world") => Self::parse_saved_world(arguments.collect()),
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

    fn parse_scan(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut format = OutputFormat::Json;
        let mut concurrency = std::thread::available_parallelism().map_or(4, usize::from);
        let mut project_root = None;
        let mut paths = Vec::new();
        let mut maximum_assets = None;
        let mut filters = ScanFilters::default();
        let mut depth = ScanDepth::default();
        let mut cache = None;
        let mut inventory = false;
        let mut projection = ScanProjection::default();
        let mut index = 0;
        while index < arguments.len() {
            let argument = arguments[index].clone();
            let Some(text) = argument.to_str() else {
                if project_root.is_some() {
                    return Err("scan accepts exactly one project root".to_owned());
                }
                project_root = Some(PathBuf::from(&argument));
                index += 1;
                continue;
            };
            if let Some(value) = option_value(&arguments, &mut index, text, "--format") {
                format = parse_format(value?.as_os_str())?;
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--concurrency")
            {
                concurrency = parse_concurrency(value?.as_os_str())?;
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--path") {
                paths.push(PathBuf::from(value?));
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--path-list") {
                paths.extend(read_scan_path_list(&value?)?);
            } else if let Some(value) =
                option_value(&arguments, &mut index, text, "--maximum-assets")
            {
                maximum_assets = Some(
                    parse_concurrency(value?.as_os_str())
                        .map_err(|_| "--maximum-assets requires a positive integer".to_owned())?,
                );
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--class") {
                filters.classes.push(utf8_option_value(&value?, "--class")?);
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--class-prefix")
            {
                filters
                    .class_prefixes
                    .push(utf8_option_value(&value?, "--class-prefix")?);
            } else if let Some(value) =
                option_value(&arguments, &mut index, text, "--class-name-suffix")
            {
                filters
                    .class_name_suffixes
                    .push(utf8_option_value(&value?, "--class-name-suffix")?);
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--name") {
                filters.names.push(utf8_option_value(&value?, "--name")?);
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--depth") {
                depth = parse_scan_depth(&utf8_option_value(&value?, "--depth")?)?;
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--cache") {
                cache = Some(PathBuf::from(value?));
            } else if let Some(value) = option_value(&arguments, &mut index, text, "--projection") {
                projection = parse_scan_projection(&utf8_option_value(&value?, "--projection")?)?;
            } else if text == "--inventory" {
                inventory = true;
            } else if text.starts_with('-') {
                return Err(format!("unknown scan option {text:?}"));
            } else if project_root.is_some() {
                return Err("scan accepts exactly one project root".to_owned());
            } else {
                project_root = Some(PathBuf::from(&argument));
            }
            index += 1;
        }
        if format != OutputFormat::Json {
            return Err("scan requires --format json".to_owned());
        }
        if cache.is_some() && depth != ScanDepth::Header {
            return Err("scan --cache requires --depth header".to_owned());
        }
        if projection != ScanProjection::Generic && depth != ScanDepth::Full {
            return Err("scan --projection requires --depth full (the default)".to_owned());
        }
        if projection != ScanProjection::Generic && cache.is_some() {
            return Err("scan --projection cannot reuse a header cache".to_owned());
        }
        Ok(Self::Scan(ScanOptions {
            project_root: project_root.ok_or_else(|| "scan requires a project root".to_owned())?,
            paths,
            format,
            concurrency,
            maximum_assets,
            filters,
            depth,
            cache,
            inventory,
            projection,
        }))
    }

    fn parse_saved_world(arguments: Vec<OsString>) -> Result<Self, String> {
        let mut format = OutputFormat::Json;
        let mut concurrency = std::thread::available_parallelism().map_or(4, usize::from);
        let mut maximum_assets = DEFAULT_SAVED_WORLD_MAXIMUM_ASSETS;
        let mut positional = Vec::new();
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
                Some("--maximum-assets") => {
                    index += 1;
                    let value = arguments
                        .get(index)
                        .ok_or_else(|| "--maximum-assets requires a positive integer".to_owned())?;
                    maximum_assets = parse_concurrency(value)?;
                }
                Some(value) if value.starts_with('-') => {
                    return Err(format!("unknown saved-world option {value:?}"));
                }
                _ => positional.push(PathBuf::from(argument)),
            }
            index += 1;
        }
        if format != OutputFormat::Json {
            return Err("saved-world requires --format json".to_owned());
        }
        let [project_root, map_path] = positional.as_slice() else {
            return Err("saved-world requires a project root and map path".to_owned());
        };
        Ok(Self::SavedWorld(SavedWorldOptions {
            project_root: project_root.clone(),
            map_path: map_path.clone(),
            format,
            concurrency,
            maximum_assets,
        }))
    }
}

fn option_value(
    arguments: &[OsString],
    index: &mut usize,
    argument: &str,
    flag: &str,
) -> Option<Result<OsString, String>> {
    if argument == flag {
        *index += 1;
        return Some(
            arguments
                .get(*index)
                .cloned()
                .ok_or_else(|| format!("{flag} requires a value")),
        );
    }
    argument
        .strip_prefix(&format!("{flag}="))
        .map(|value| Ok(OsString::from(value)))
}

fn utf8_option_value(value: &OsString, flag: &str) -> Result<String, String> {
    value
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{flag} value is not valid UTF-8"))
}

fn read_scan_path_list(value: &OsString) -> Result<Vec<PathBuf>, String> {
    let path = PathBuf::from(value);
    let file = File::open(&path)
        .map_err(|error| format!("--path-list {} is not readable: {error}", path.display()))?;
    let paths = serde_json::from_reader::<_, Vec<String>>(file).map_err(|error| {
        format!(
            "--path-list {} must be a JSON array of UTF-8 paths: {error}",
            path.display()
        )
    })?;
    Ok(paths.into_iter().map(PathBuf::from).collect())
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

fn parse_scan_depth(value: &str) -> Result<ScanDepth, String> {
    match value {
        "header" => Ok(ScanDepth::Header),
        "full" => Ok(ScanDepth::Full),
        other => Err(format!(
            "unsupported scan depth {other:?}; expected \"header\" or \"full\""
        )),
    }
}

fn parse_scan_projection(value: &str) -> Result<ScanProjection, String> {
    match value {
        "text" => Ok(ScanProjection::Text),
        "texture" => Ok(ScanProjection::Texture),
        _ => Err("--projection requires text or texture".to_owned()),
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
            return emit_failure(options.format, &input_name, "io", error.to_string(), true);
        }
    };
    if options.format == OutputFormat::Json {
        return inspect_json(&input_name, &bytes);
    }
    let (inspection, partial) = match direct_executor::inspect_generic_bytes(&input_name, &bytes) {
        Ok(output) => output,
        Err(error) => return emit_direct_failure(options.format, &input_name, error),
    };
    let result = write_stdout(render_inspection_text(&inspection).as_bytes());
    if result == EXIT_SUCCESS && partial {
        EXIT_PARTIAL
    } else {
        result
    }
}

fn inspect_json(path: &str, bytes: &[u8]) -> u8 {
    const MAX_INITIAL_CAPACITY: usize = 32 * 1024 * 1024;

    let capacity = bytes.len().saturating_mul(2).min(MAX_INITIAL_CAPACITY);
    let mut output = Vec::with_capacity(capacity);
    let status = match write_inspection_json(path, bytes, &mut output) {
        Ok(status) => status,
        Err(error) => {
            return emit_failure(
                OutputFormat::Json,
                path,
                error.kind(),
                error.message().to_owned(),
                false,
            );
        }
    };
    output.push(b'\n');
    let result = write_stdout(&output);
    if result == EXIT_SUCCESS && status.is_partial() {
        EXIT_PARTIAL
    } else {
        result
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
            return emit_failure(options.format, &input_name, "io", error.to_string(), true);
        }
    };
    let (snapshot, partial) = match direct_executor::authoring_bytes(&input_name, &bytes) {
        Ok(output) => output,
        Err(error) => return emit_direct_failure(options.format, &input_name, error),
    };
    let result = write_json_line(&snapshot);
    if result == EXIT_SUCCESS && partial {
        EXIT_PARTIAL
    } else {
        result
    }
}

fn scan(options: &ScanOptions) -> u8 {
    let operation = match options.projection {
        ScanProjection::Generic => Operation::Scan {
            cache_path: options
                .cache
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            depth: match options.depth {
                ScanDepth::Header => ProtocolScanDepth::Header,
                ScanDepth::Full => ProtocolScanDepth::Full,
            },
            selection: selection(options),
            filters: protocol_filters(&options.filters),
            inventory: Some(options.inventory),
        },
        ScanProjection::Text => Operation::ExtractText {
            selection: selection(options),
        },
        ScanProjection::Texture => Operation::ExtractTexture {
            selection: selection(options),
        },
    };
    let request = match request(operation, options.concurrency, options.maximum_assets) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("uasset: {error}");
            return EXIT_USAGE;
        }
    };
    match options.projection {
        ScanProjection::Generic => match direct_executor::scan(&request) {
            Ok(output) => emit_scan_output(output),
            Err(error) => emit_direct_failure(
                options.format,
                &options.project_root.to_string_lossy(),
                error,
            ),
        },
        ScanProjection::Text => match direct_executor::extract_text(&request) {
            Ok(output) => {
                emit_projection_output(output.results, output.diagnostics, output.partial)
            }
            Err(error) => emit_direct_failure(
                options.format,
                &options.project_root.to_string_lossy(),
                error,
            ),
        },
        ScanProjection::Texture => match direct_executor::extract_texture(&request) {
            Ok(output) => {
                emit_projection_output(output.results, output.diagnostics, output.partial)
            }
            Err(error) => emit_direct_failure(
                options.format,
                &options.project_root.to_string_lossy(),
                error,
            ),
        },
    }
}

fn saved_world(options: &SavedWorldOptions) -> u8 {
    let operation = Operation::SavedWorld {
        map_path: options.map_path.to_string_lossy().into_owned(),
        project_root: options.project_root.to_string_lossy().into_owned(),
    };
    let request = match request(operation, options.concurrency, Some(options.maximum_assets)) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("uasset: {error}");
            return EXIT_USAGE;
        }
    };
    match direct_executor::saved_world(&request) {
        Ok(output) => {
            let result = write_json_line(&output.world);
            if result == EXIT_SUCCESS && output.partial {
                EXIT_PARTIAL
            } else {
                result
            }
        }
        Err(error) => {
            emit_direct_failure(options.format, &options.map_path.to_string_lossy(), error)
        }
    }
}

fn selection(options: &ScanOptions) -> ProjectSelection {
    ProjectSelection {
        paths: (!options.paths.is_empty()).then(|| {
            options
                .paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect()
        }),
        project_root: options.project_root.to_string_lossy().into_owned(),
    }
}

fn protocol_filters(filters: &ScanFilters) -> ProtocolScanFilters {
    if filters.is_empty() {
        return ProtocolScanFilters {
            class_name_suffixes: None,
            class_prefixes: None,
            classes: None,
            names: None,
        };
    }
    ProtocolScanFilters {
        class_name_suffixes: (!filters.class_name_suffixes.is_empty())
            .then(|| filters.class_name_suffixes.clone()),
        class_prefixes: (!filters.class_prefixes.is_empty())
            .then(|| filters.class_prefixes.clone()),
        classes: (!filters.classes.is_empty()).then(|| filters.classes.clone()),
        names: (!filters.names.is_empty()).then(|| filters.names.clone()),
    }
}

fn request(
    operation: Operation,
    concurrency: usize,
    maximum_assets: Option<usize>,
) -> Result<Request, String> {
    Ok(Request {
        contract: Contract {
            name: "uasset-io".to_owned(),
            version: ContractVersion { major: 1, minor: 0 },
        },
        limits: ResourceLimits {
            concurrency: Some(
                u32::try_from(concurrency)
                    .map_err(|_| "concurrency exceeds protocol range".to_owned())?,
            ),
            maximum_assets: maximum_assets
                .map(|value| {
                    u64::try_from(value)
                        .map_err(|_| "maximum assets exceeds protocol range".to_owned())
                })
                .transpose()?,
            maximum_output_bytes: None,
            timeout_ms: None,
        },
        operation,
        request_id: "legacy-cli".to_owned(),
    })
}

fn emit_scan_output(output: direct_executor::ScanOutput) -> u8 {
    let partial = output.partial;
    for diagnostic in output.diagnostics {
        if write_json_line(&json!({
            "event": "error",
            "code": diagnostic.code,
            "message": diagnostic.message,
            "path": diagnostic.path,
            "retrySafe": diagnostic.retry_safe,
        })) != EXIT_SUCCESS
        {
            return EXIT_IO;
        }
    }
    for entry in output.inventory {
        let mut value = match serde_json::to_value(entry) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("uasset: failed to serialize inventory output: {error}");
                return EXIT_INTERNAL;
            }
        };
        value["event"] = Value::String("inventory".to_owned());
        if write_json_value_line(&value) != EXIT_SUCCESS {
            return EXIT_IO;
        }
    }
    for entry in output.entries {
        let mut value = match serde_json::to_value(entry) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("uasset: failed to serialize scan output: {error}");
                return EXIT_INTERNAL;
            }
        };
        value["event"] = Value::String("asset".to_owned());
        if write_json_value_line(&value) != EXIT_SUCCESS {
            return EXIT_IO;
        }
    }
    let mut summary = match serde_json::to_value(output.summary) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("uasset: failed to serialize scan summary: {error}");
            return EXIT_INTERNAL;
        }
    };
    summary["event"] = Value::String("summary".to_owned());
    if summary.get("inventoryComplete").is_some_and(Value::is_null) {
        summary["inventoryComplete"] = Value::Bool(false);
    }
    if summary.get("inventoryFiles").is_some_and(Value::is_null) {
        summary["inventoryFiles"] = Value::from(0_u64);
    }
    if write_json_value_line(&summary) != EXIT_SUCCESS {
        return EXIT_IO;
    }
    if partial { EXIT_PARTIAL } else { EXIT_SUCCESS }
}

fn emit_projection_output(
    results: Vec<ResultFrame>,
    diagnostics: Vec<direct_executor::Diagnostic>,
    partial: bool,
) -> u8 {
    for diagnostic in diagnostics {
        if write_json_line(&json!({
            "event": "error",
            "code": diagnostic.code,
            "message": diagnostic.message,
            "path": diagnostic.path,
            "retrySafe": diagnostic.retry_safe,
        })) != EXIT_SUCCESS
        {
            return EXIT_IO;
        }
    }
    for result in results {
        let value = match serde_json::to_value(result) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("uasset: failed to serialize projection output: {error}");
                return EXIT_INTERNAL;
            }
        };
        let event = value.get("event").cloned().unwrap_or(Value::Null);
        if write_json_value_line(&event) != EXIT_SUCCESS {
            return EXIT_IO;
        }
    }
    if partial { EXIT_PARTIAL } else { EXIT_SUCCESS }
}

fn read_input(input: &Input) -> io::Result<Vec<u8>> {
    match input {
        Input::File(path) => std::fs::read(path),
        Input::Stdin => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes)?;
            Ok(bytes)
        }
    }
}

fn render_inspection_text(inspection: &uasset_inspection::generic::InspectOutput) -> String {
    let mut output = String::new();
    let _ = writeln!(output, "Package: {}", inspection.package.name);
    let _ = writeln!(output, "Path: {}", inspection.path);
    let _ = writeln!(output, "Status: {:?}", inspection.status);
    let _ = writeln!(output, "Assets: {}", inspection.assets.len());
    for asset in &inspection.assets {
        let _ = writeln!(output, "- {}: {}", asset.kind, asset.object_path);
    }
    if !inspection.decode_errors.is_empty() {
        let _ = writeln!(output, "Decode errors: {}", inspection.decode_errors.len());
    }
    output
}

fn write_json_line<T: serde::Serialize>(value: &T) -> u8 {
    match serde_json::to_vec(value) {
        Ok(mut bytes) => {
            bytes.push(b'\n');
            write_stdout(&bytes)
        }
        Err(error) => {
            eprintln!("uasset: failed to serialize JSON output: {error}");
            EXIT_INTERNAL
        }
    }
}

fn write_json_value_line(value: &Value) -> u8 {
    write_json_line(value)
}

fn write_stdout(bytes: &[u8]) -> u8 {
    match io::stdout().write_all(bytes) {
        Ok(()) => EXIT_SUCCESS,
        Err(error) => {
            eprintln!("uasset: could not write stdout: {error}");
            EXIT_IO
        }
    }
}

fn emit_direct_failure(format: OutputFormat, path: &str, error: direct_executor::Failure) -> u8 {
    let code = error.code.clone();
    let message = error.message.clone();
    let retry_safe = error.retry_safe;
    emit_failure(format, path, &code, message, retry_safe)
}

fn emit_failure(
    format: OutputFormat,
    path: &str,
    code: &str,
    message: String,
    retry_safe: bool,
) -> u8 {
    if format == OutputFormat::Json {
        let result = write_json_line(&json!({
            "error": {
                "code": code,
                "message": message,
                "path": path,
                "retrySafe": retry_safe,
            }
        }));
        if result != EXIT_SUCCESS {
            return result;
        }
    } else {
        eprintln!("uasset: {code}: {message}");
    }
    match code {
        "malformed_data" | "unsupported_format" | "unsupported_version" => EXIT_MALFORMED,
        "unsupported" | "unsupported_capability" => EXIT_UNSUPPORTED,
        "resource_limit" => EXIT_RESOURCE_LIMIT,
        "io" | "asset_io" | "scan_cache_write" => EXIT_IO,
        _ => EXIT_INTERNAL,
    }
}

const USAGE: &str = "Usage: uasset <inspect|authoring|scan|saved-world> <path> [options]";

const HELP: &str = "\
uasset — Unreal asset inspection and project IO\n\n\
Commands:\n\
  inspect     Inspect one package as text or JSON.\n\
  authoring   Emit the typed authoring snapshot for one DataTable package.\n\
  scan        Scan selected project packages, optionally at header depth.\n\
  saved-world Read one saved map and resolve actor transforms.\n\n\
Protocol operations use the same native direct executors as these human adapters.\n";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_authoring_contract() {
        assert_eq!(
            Command::parse(vec![
                "authoring".into(),
                "asset.uasset".into(),
                "--format".into(),
                "json".into()
            ]),
            Ok(Command::Authoring(InspectOptions {
                input: Input::File(PathBuf::from("asset.uasset")),
                format: OutputFormat::Json,
            }))
        );
    }

    #[test]
    fn parses_scan_contract() {
        let Ok(Command::Scan(options)) = Command::parse(vec![
            "scan".into(),
            "project".into(),
            "--path".into(),
            "Content/Fixture".into(),
            "--class".into(),
            "DataTable".into(),
            "--depth".into(),
            "header".into(),
            "--cache".into(),
            "cache.json".into(),
        ]) else {
            panic!("scan command")
        };
        assert_eq!(options.depth, ScanDepth::Header);
        assert_eq!(options.paths, vec![PathBuf::from("Content/Fixture")]);
        assert_eq!(options.filters.classes, vec!["DataTable"]);
        assert_eq!(options.cache, Some(PathBuf::from("cache.json")));
    }

    #[test]
    fn rejects_full_depth_cache() {
        let result = Command::parse(vec![
            "scan".into(),
            "project".into(),
            "--cache".into(),
            "cache.json".into(),
        ]);
        assert_eq!(
            result,
            Err("scan --cache requires --depth header".to_owned())
        );
    }

    #[test]
    fn parses_projection_commands() {
        let Ok(Command::Scan(options)) = Command::parse(vec![
            "scan".into(),
            "project".into(),
            "--projection=text".into(),
        ]) else {
            panic!("projection command")
        };
        assert_eq!(options.projection, ScanProjection::Text);
        assert_eq!(options.depth, ScanDepth::Full);
    }

    #[test]
    fn parses_saved_world_contract() {
        let Ok(Command::SavedWorld(options)) = Command::parse(vec![
            "saved-world".into(),
            "project".into(),
            "map.umap".into(),
            "--maximum-assets".into(),
            "10".into(),
        ]) else {
            panic!("saved-world command")
        };
        assert_eq!(options.maximum_assets, 10);
        assert_eq!(options.map_path, PathBuf::from("map.umap"));
    }

    #[test]
    fn human_filters_are_empty_by_default() {
        assert!(ScanFilters::default().is_empty());
    }
}
