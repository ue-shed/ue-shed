use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use uasset_source_gen::{GenerationRoots, generate, read_config};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("uasset-source-gen: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let command = arguments.next().ok_or_else(usage)?;
    if !matches!(command.as_str(), "generate" | "check") {
        return Err(usage());
    }
    let mut config = None;
    let mut engine_source = None;
    let mut workspace = None;
    let mut output = None;
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value after {argument}"))?;
        match argument.as_str() {
            "--config" => config = Some(PathBuf::from(value)),
            "--engine-source" => engine_source = Some(PathBuf::from(value)),
            "--workspace" => workspace = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {argument}\n{}", usage())),
        }
    }
    let config_path = config.ok_or_else(usage)?;
    let output_path = output.ok_or_else(usage)?;
    let config = read_config(&config_path).map_err(|error| error.to_string())?;
    let generated = generate(
        &config,
        &GenerationRoots {
            engine_source: engine_source.ok_or_else(usage)?,
            workspace: workspace.ok_or_else(usage)?,
        },
    )
    .map_err(|error| error.to_string())?;
    let json = generated_json(&generated.model)?;
    for diagnostic in &generated.diagnostics {
        eprintln!(
            "{}:{}: {}",
            diagnostic.path, diagnostic.line, diagnostic.message
        );
    }
    if command == "check" {
        let existing = fs::read_to_string(&output_path).map_err(|error| {
            format!(
                "failed to read generated model {}: {error}",
                output_path.display()
            )
        })?;
        if existing != json {
            return Err(format!(
                "{} is stale; rerun the generate command",
                output_path.display()
            ));
        }
        return Ok(());
    }
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create output directory {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(&output_path, json)
        .map_err(|error| format!("failed to write {}: {error}", output_path.display()))
}

fn generated_json(model: &uasset_parser::schema::SourceModel) -> Result<String, String> {
    let pretty = serde_json::to_string_pretty(model)
        .map_err(|error| format!("failed to serialize source model: {error}"))?;
    let mut output = String::with_capacity(pretty.len() + 1);
    for line in pretty.lines() {
        let leading_spaces = line.bytes().take_while(|byte| *byte == b' ').count();
        debug_assert_eq!(leading_spaces % 2, 0);
        output.extend(std::iter::repeat_n('\t', leading_spaces / 2));
        output.push_str(&line[leading_spaces..]);
        output.push('\n');
    }
    Ok(output)
}

fn usage() -> String {
    concat!(
        "usage: uasset-source-gen <generate|check> ",
        "--config <path> --engine-source <path> --workspace <path> --output <path>"
    )
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::generated_json;
    use uasset_parser::schema::{SOURCE_MODEL_SCHEMA_VERSION, SourceModel};

    #[test]
    fn generated_json_uses_repository_tab_indentation() {
        let model = SourceModel {
            schema_version: SOURCE_MODEL_SCHEMA_VERSION,
            engine_version: "test".to_owned(),
            classes: Vec::new(),
            structs: Vec::new(),
        };

        let output = generated_json(&model).expect("serialize model");

        assert!(output.contains("\n\t\"schema_version\""));
        assert!(!output.contains("\n  \"schema_version\""));
        assert!(output.ends_with('\n'));
    }
}
