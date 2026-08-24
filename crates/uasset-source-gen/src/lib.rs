use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use uasset_parser::package::ObjectPath;
use uasset_parser::schema::{
    ClassSchema, FieldSchema, FieldType, SOURCE_MODEL_SCHEMA_VERSION, SerializationOperation,
    SourceModel, StructSchema,
};

#[derive(Clone, Debug, Deserialize)]
pub struct GenerationConfig {
    pub schema_version: u8,
    pub engine_version: String,
    pub modules: Vec<ModuleConfig>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ModuleConfig {
    pub name: String,
    pub root: SourceRoot,
    pub headers: Vec<String>,
    pub sources: Vec<String>,
    #[serde(default)]
    pub include_types: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SourceRoot {
    EngineSource,
    Workspace,
}

#[derive(Clone, Debug)]
pub struct GenerationRoots {
    pub engine_source: PathBuf,
    pub workspace: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceDiagnostic {
    pub path: String,
    pub line: usize,
    pub message: String,
}

#[derive(Clone, Debug)]
pub struct GenerationOutput {
    pub model: SourceModel,
    pub diagnostics: Vec<SourceDiagnostic>,
}

#[derive(Debug)]
pub struct GeneratorError {
    message: String,
}

impl GeneratorError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for GeneratorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GeneratorError {}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Token {
    text: String,
    line: usize,
    is_string: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReflectedKind {
    Class,
    Struct,
    Enum,
}

#[derive(Clone, Debug)]
struct ParsedField {
    name: String,
    cpp_type: String,
    is_bitfield: bool,
}

#[derive(Clone, Debug)]
struct ReflectedType {
    kind: ReflectedKind,
    cpp_name: String,
    module: String,
    super_cpp_name: Option<String>,
    fields: Vec<ParsedField>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SerializationFact {
    Inherit,
    TaggedProperties,
    ObjectGuid,
    DataTableRows,
    CurveTableRows,
    EnumData,
    StructDefinition,
    StructFlags,
    StructDefaultInstance,
    StringTableData,
}

#[derive(Clone, Debug)]
struct FunctionBody {
    class_name: String,
    function_name: String,
    path: String,
    line: usize,
    tokens: Vec<Token>,
}

pub fn read_config(path: &Path) -> Result<GenerationConfig, GeneratorError> {
    let source = fs::read_to_string(path).map_err(|error| {
        GeneratorError::new(format!("failed to read {}: {error}", path.display()))
    })?;
    serde_json::from_str(&source).map_err(|error| {
        GeneratorError::new(format!("failed to parse {}: {error}", path.display()))
    })
}

pub fn generate(
    config: &GenerationConfig,
    roots: &GenerationRoots,
) -> Result<GenerationOutput, GeneratorError> {
    if config.schema_version != SOURCE_MODEL_SCHEMA_VERSION {
        return Err(GeneratorError::new(format!(
            "source-model schema {} is unsupported; expected {SOURCE_MODEL_SCHEMA_VERSION}",
            config.schema_version
        )));
    }

    let mut reflected = Vec::new();
    let mut functions = Vec::new();
    for module in &config.modules {
        for relative_path in &module.headers {
            let (absolute_path, display_path) = resolve_source(module.root, relative_path, roots);
            let source = read_source(&absolute_path)?;
            let tokens = lex(&source)?;
            reflected.extend(
                parse_reflected_types(&tokens, &module.name)
                    .into_iter()
                    .filter(|declaration| {
                        module.include_types.is_empty()
                            || module.include_types.contains(&declaration.cpp_name)
                    }),
            );
            functions.extend(parse_function_bodies(&tokens, &display_path));
        }
        for relative_path in &module.sources {
            let (absolute_path, display_path) = resolve_source(module.root, relative_path, roots);
            let source = read_source(&absolute_path)?;
            let tokens = lex(&source)?;
            functions.extend(parse_function_bodies(&tokens, &display_path));
        }
    }

    let serializer_facts = serializer_facts(&functions);
    let mut diagnostics = Vec::new();
    if has_serialization_fact(&serializer_facts, SerializationFact::DataTableRows) {
        validate_data_table_helper(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::CurveTableRows) {
        validate_curve_table_serializer(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::EnumData) {
        validate_enum_serializer(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::StructDefinition) {
        validate_struct_serializer(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::StructFlags) {
        validate_script_struct_serializer(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::StructDefaultInstance) {
        validate_user_defined_struct_serializer(&functions, &mut diagnostics)?;
    }
    if has_serialization_fact(&serializer_facts, SerializationFact::StringTableData) {
        validate_string_table_helper(&functions, &mut diagnostics)?;
    }

    let paths = reflected
        .iter()
        .map(|declaration| {
            (
                declaration.cpp_name.clone(),
                unreal_path(&declaration.module, &declaration.cpp_name),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let enum_names = reflected
        .iter()
        .filter(|declaration| declaration.kind == ReflectedKind::Enum)
        .map(|declaration| declaration.cpp_name.clone())
        .collect::<BTreeSet<_>>();
    let declarations = reflected
        .iter()
        .map(|declaration| (declaration.cpp_name.clone(), declaration))
        .collect::<BTreeMap<_, _>>();
    let mut classes = Vec::new();
    let mut structs = Vec::new();
    for declaration in &reflected {
        let fields = declaration
            .fields
            .iter()
            .map(|field| FieldSchema {
                name: field.name.clone(),
                field_type: if field.is_bitfield && field.cpp_type == "uint8" {
                    FieldType::Bool
                } else {
                    parse_field_type(&field.cpp_type, &declaration.module, &paths, &enum_names)
                },
            })
            .collect();
        let super_path = declaration
            .super_cpp_name
            .as_ref()
            .and_then(|name| paths.get(name))
            .cloned();
        match declaration.kind {
            ReflectedKind::Class => {
                let serialization = effective_serialization(
                    &declaration.cpp_name,
                    &declarations,
                    &serializer_facts,
                    &mut Vec::new(),
                )?;
                classes.push(ClassSchema {
                    path: paths[&declaration.cpp_name].clone(),
                    cpp_name: declaration.cpp_name.clone(),
                    super_path,
                    fields,
                    serialization,
                });
            }
            ReflectedKind::Struct => structs.push(StructSchema {
                path: paths[&declaration.cpp_name].clone(),
                cpp_name: declaration.cpp_name.clone(),
                super_path,
                fields,
            }),
            ReflectedKind::Enum => {}
        }
    }
    classes.sort_by(|left, right| left.path.cmp(&right.path));
    structs.sort_by(|left, right| left.path.cmp(&right.path));

    for schema in classes
        .iter()
        .flat_map(|schema| &schema.fields)
        .chain(structs.iter().flat_map(|schema| &schema.fields))
    {
        collect_unknown_diagnostic(schema, &mut diagnostics);
    }

    Ok(GenerationOutput {
        model: SourceModel {
            schema_version: config.schema_version,
            engine_version: config.engine_version.clone(),
            classes,
            structs,
        },
        diagnostics,
    })
}

fn resolve_source(
    root: SourceRoot,
    relative_path: &str,
    roots: &GenerationRoots,
) -> (PathBuf, String) {
    let base = match root {
        SourceRoot::EngineSource => &roots.engine_source,
        SourceRoot::Workspace => &roots.workspace,
    };
    (base.join(relative_path), relative_path.replace('\\', "/"))
}

fn read_source(path: &Path) -> Result<String, GeneratorError> {
    fs::read_to_string(path).map_err(|error| {
        GeneratorError::new(format!("failed to read source {}: {error}", path.display()))
    })
}

fn lex(source: &str) -> Result<Vec<Token>, GeneratorError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    let mut line = 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            if byte == b'\n' {
                line += 1;
            }
            index += 1;
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            let start_line = line;
            let mut closed = false;
            while index + 1 < bytes.len() {
                if bytes[index] == b'\n' {
                    line += 1;
                }
                if bytes[index] == b'*' && bytes[index + 1] == b'/' {
                    index += 2;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if !closed {
                return Err(GeneratorError::new(format!(
                    "unterminated block comment starting on line {start_line}"
                )));
            }
            continue;
        }
        if byte == b'"' || byte == b'\'' {
            let quote = byte;
            let token_line = line;
            index += 1;
            let start = index;
            let mut escaped = false;
            while index < bytes.len() {
                let current = bytes[index];
                if current == b'\n' {
                    line += 1;
                }
                if !escaped && current == quote {
                    break;
                }
                escaped = !escaped && current == b'\\';
                if current != b'\\' {
                    escaped = false;
                }
                index += 1;
            }
            if index >= bytes.len() {
                return Err(GeneratorError::new(format!(
                    "unterminated string starting on line {token_line}"
                )));
            }
            tokens.push(Token {
                text: source[start..index].to_owned(),
                line: token_line,
                is_string: true,
            });
            index += 1;
            continue;
        }
        if byte.is_ascii_alphabetic() || byte == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            tokens.push(Token {
                text: source[start..index].to_owned(),
                line,
                is_string: false,
            });
            continue;
        }
        if byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'.' | b'_'))
            {
                index += 1;
            }
            tokens.push(Token {
                text: source[start..index].to_owned(),
                line,
                is_string: false,
            });
            continue;
        }
        tokens.push(Token {
            text: char::from(byte).to_string(),
            line,
            is_string: false,
        });
        index += 1;
    }
    Ok(tokens)
}

fn parse_reflected_types(tokens: &[Token], module: &str) -> Vec<ReflectedType> {
    let mut declarations = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let kind = match tokens[index].text.as_str() {
            "UCLASS" => Some(ReflectedKind::Class),
            "USTRUCT" => Some(ReflectedKind::Struct),
            "UENUM" => Some(ReflectedKind::Enum),
            _ => None,
        };
        let Some(kind) = kind else {
            index += 1;
            continue;
        };
        let Some(after_macro) = skip_macro(tokens, index) else {
            index += 1;
            continue;
        };
        let declaration_keyword = match kind {
            ReflectedKind::Class | ReflectedKind::Enum => "class",
            ReflectedKind::Struct => "struct",
        };
        let Some(keyword_index) = tokens[after_macro..]
            .iter()
            .position(|token| token.text == declaration_keyword)
            .map(|offset| after_macro + offset)
        else {
            index = after_macro;
            continue;
        };
        let Some(open_brace) = tokens[keyword_index..]
            .iter()
            .position(|token| token.text == "{")
            .map(|offset| keyword_index + offset)
        else {
            index = keyword_index + 1;
            continue;
        };
        let Some(close_brace) = matching_token(tokens, open_brace, "{", "}") else {
            index = open_brace + 1;
            continue;
        };
        let header = &tokens[keyword_index + 1..open_brace];
        let (cpp_name, super_cpp_name) = declaration_identity(header, kind);
        if let Some(cpp_name) = cpp_name {
            declarations.push(ReflectedType {
                kind,
                cpp_name,
                module: module.to_owned(),
                super_cpp_name,
                fields: if kind == ReflectedKind::Enum {
                    Vec::new()
                } else {
                    parse_properties(&tokens[open_brace + 1..close_brace])
                },
            });
        }
        index = close_brace + 1;
    }
    declarations
}

fn skip_macro(tokens: &[Token], macro_index: usize) -> Option<usize> {
    if tokens.get(macro_index + 1)?.text != "(" {
        return Some(macro_index + 1);
    }
    matching_token(tokens, macro_index + 1, "(", ")").map(|index| index + 1)
}

fn declaration_identity(header: &[Token], kind: ReflectedKind) -> (Option<String>, Option<String>) {
    let colon = header.iter().position(|token| token.text == ":");
    let name_end = colon.unwrap_or(header.len());
    let cpp_name = header[..name_end]
        .iter()
        .rev()
        .find(|token| is_identifier(&token.text) && token.text != "final")
        .map(|token| token.text.clone());
    if kind == ReflectedKind::Enum {
        return (cpp_name, None);
    }
    let super_cpp_name = colon.and_then(|colon| {
        header[colon + 1..]
            .iter()
            .find(|token| {
                is_identifier(&token.text)
                    && !matches!(
                        token.text.as_str(),
                        "public" | "protected" | "private" | "virtual"
                    )
            })
            .map(|token| token.text.clone())
    });
    (cpp_name, super_cpp_name)
}

fn parse_properties(body: &[Token]) -> Vec<ParsedField> {
    let mut fields = Vec::new();
    let mut depth = 0_i32;
    let mut index = 0;
    while index < body.len() {
        match body[index].text.as_str() {
            "{" => depth += 1,
            "}" => depth -= 1,
            "UPROPERTY" if depth == 0 => {
                let Some(after_macro) = skip_macro(body, index) else {
                    index += 1;
                    continue;
                };
                let mut end = after_macro;
                let mut nested = 0_i32;
                while end < body.len() {
                    match body[end].text.as_str() {
                        "<" | "(" | "[" | "{" => nested += 1,
                        ">" | ")" | "]" | "}" => nested -= 1,
                        ";" if nested == 0 => break,
                        _ => {}
                    }
                    end += 1;
                }
                if let Some(field) = parse_property_declaration(&body[after_macro..end]) {
                    fields.push(field);
                }
                index = end;
            }
            _ => {}
        }
        index += 1;
    }
    fields
}

fn parse_property_declaration(tokens: &[Token]) -> Option<ParsedField> {
    let mut nested = 0_i32;
    let mut declaration_end = tokens.len();
    for (index, token) in tokens.iter().enumerate() {
        match token.text.as_str() {
            "<" | "(" | "[" | "{" => nested += 1,
            ">" | ")" | "]" | "}" => nested -= 1,
            "=" | ":" if nested == 0 => {
                declaration_end = index;
                break;
            }
            _ => {}
        }
    }
    let declaration = &tokens[..declaration_end];
    let name_index = declaration
        .iter()
        .rposition(|token| is_identifier(&token.text))?;
    let name = declaration[name_index].text.clone();
    let cpp_type = declaration[..name_index]
        .iter()
        .filter(|token| !matches!(token.text.as_str(), "const" | "class" | "struct"))
        .map(|token| token.text.as_str())
        .collect::<String>()
        .trim_end_matches(['*', '&'])
        .to_owned();
    let is_bitfield = tokens
        .get(declaration_end)
        .is_some_and(|token| token.text == ":");
    Some(ParsedField {
        name,
        cpp_type,
        is_bitfield,
    })
}

fn parse_function_bodies(tokens: &[Token], path: &str) -> Vec<FunctionBody> {
    let mut functions = Vec::new();
    for index in 0..tokens.len().saturating_sub(3) {
        if !is_identifier(&tokens[index].text)
            || tokens[index + 1].text != ":"
            || tokens[index + 2].text != ":"
            || !is_identifier(&tokens[index + 3].text)
        {
            continue;
        }
        let Some(open_paren) = tokens[index + 4..]
            .iter()
            .position(|token| token.text == "(")
            .map(|offset| index + 4 + offset)
        else {
            continue;
        };
        if open_paren > index + 6 {
            continue;
        }
        let Some(close_paren) = matching_token(tokens, open_paren, "(", ")") else {
            continue;
        };
        let Some(open_brace) = tokens[close_paren + 1..]
            .iter()
            .take(64)
            .position(|token| token.text == "{")
            .map(|offset| close_paren + 1 + offset)
        else {
            continue;
        };
        let Some(close_brace) = matching_token(tokens, open_brace, "{", "}") else {
            continue;
        };
        functions.push(FunctionBody {
            class_name: tokens[index].text.clone(),
            function_name: tokens[index + 3].text.clone(),
            path: path.to_owned(),
            line: tokens[index].line,
            tokens: tokens[open_brace + 1..close_brace].to_vec(),
        });
    }
    functions
}

fn serializer_facts(functions: &[FunctionBody]) -> BTreeMap<String, Vec<SerializationFact>> {
    functions
        .iter()
        .filter(|function| function.function_name == "Serialize")
        .map(|function| {
            let mut facts = Vec::new();
            let mut index = 0;
            while index < function.tokens.len() {
                let tokens = &function.tokens[index..];
                if token_sequence(tokens, &["Super", ":", ":", "Serialize"]) {
                    facts.push(SerializationFact::Inherit);
                    index += 4;
                    continue;
                }
                if function.tokens[index].text == "SerializeScriptProperties" {
                    facts.push(SerializationFact::TaggedProperties);
                } else if function.tokens[index].text == "PossiblySerializeObjectGuid" {
                    facts.push(SerializationFact::ObjectGuid);
                } else if function.tokens[index].text == "SaveStructData" {
                    facts.push(SerializationFact::DataTableRows);
                } else if function.class_name == "UCurveTable"
                    && token_sequence(tokens, &["Ar", "<", "<", "NumRows"])
                    && !facts.contains(&SerializationFact::CurveTableRows)
                {
                    facts.push(SerializationFact::CurveTableRows);
                    index += 4;
                    continue;
                } else if function.class_name == "UEnum"
                    && token_sequence(tokens, &["Ar", "<", "<", "Num"])
                    && !facts.contains(&SerializationFact::EnumData)
                {
                    facts.push(SerializationFact::EnumData);
                    index += 4;
                    continue;
                } else if function.class_name == "UStruct"
                    && token_sequence(tokens, &["Ar", "<", "<", "SuperStruct"])
                    && !facts.contains(&SerializationFact::StructDefinition)
                {
                    facts.push(SerializationFact::StructDefinition);
                    index += 4;
                    continue;
                } else if function.class_name == "UScriptStruct"
                    && token_sequence(tokens, &["Ar", "<", "<", "SavedStructFlags"])
                    && !facts.contains(&SerializationFact::StructFlags)
                {
                    facts.push(SerializationFact::StructFlags);
                    index += 4;
                    continue;
                } else if function.class_name == "UUserDefinedStruct"
                    && function.tokens[index].text == "SerializeItem"
                    && !facts.contains(&SerializationFact::StructDefaultInstance)
                {
                    facts.push(SerializationFact::StructDefaultInstance);
                } else if function.class_name == "UStringTable"
                    && token_sequence(tokens, &["StringTable", "-", ">", "Serialize"])
                {
                    facts.push(SerializationFact::StringTableData);
                    index += 4;
                    continue;
                }
                index += 1;
            }
            (function.class_name.clone(), facts)
        })
        .collect()
}

fn has_serialization_fact(
    facts: &BTreeMap<String, Vec<SerializationFact>>,
    expected: SerializationFact,
) -> bool {
    facts.values().any(|facts| facts.contains(&expected))
}

fn validate_data_table_helper(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(helper) = functions.iter().find(|function| {
        function.class_name == "UDataTable" && function.function_name == "SaveStructData"
    }) else {
        return Err(GeneratorError::new(
            "UDataTable::SaveStructData was not found in the configured sources",
        ));
    };
    let required = ["EnterArray", "SA_VALUE", "Name", "SerializeItem", "Value"];
    let missing = required
        .iter()
        .copied()
        .filter(|needle| !helper.tokens.iter().any(|token| token.text == *needle))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(GeneratorError::new(format!(
            "{}:{} does not match the supported DataTable row serializer; missing {}",
            helper.path,
            helper.line,
            missing.join(", ")
        )));
    }
    diagnostics.push(SourceDiagnostic {
        path: helper.path.clone(),
        line: helper.line,
        message: "recognized array<Record{Name: FName, Value: RowStruct::SerializeItem}>"
            .to_owned(),
    });
    Ok(())
}

fn validate_string_table_helper(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(helper) = functions.iter().find(|function| {
        function.class_name == "FStringTable" && function.function_name == "Serialize"
    }) else {
        return Err(GeneratorError::new(
            "FStringTable::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &["TableNamespace", ".", "SerializeAsString"][..],
        &["Ar", "<", "<", "NumEntries"][..],
        &["Key", ".", "SerializeAsString"][..],
        &["Ar", "<", "<", "SourceString"][..],
        &["Ar", "<", "<", "TmpKeysToMetaData"][..],
    ];
    let mut cursor = 0;
    for sequence in required {
        let Some(offset) = helper.tokens[cursor..]
            .windows(sequence.len())
            .position(|tokens| token_sequence(tokens, sequence))
        else {
            return Err(GeneratorError::new(format!(
                "{}:{} does not match the supported StringTable serializer; missing ordered token sequence {}",
                helper.path,
                helper.line,
                sequence.join(" ")
            )));
        };
        cursor += offset + sequence.len();
    }
    diagnostics.push(SourceDiagnostic {
        path: helper.path.clone(),
        line: helper.line,
        message:
            "recognized namespace + array<Record{Key: FTextKey, Source: FString}> + metadata map"
                .to_owned(),
    });
    Ok(())
}

fn validate_curve_table_serializer(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(serializer) = functions.iter().find(|function| {
        function.class_name == "UCurveTable" && function.function_name == "Serialize"
    }) else {
        return Err(GeneratorError::new(
            "UCurveTable::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &["Ar", "<", "<", "NumRows"][..],
        &["Ar", "<", "<", "CurveTableMode"][..],
        &["Ar", "<", "<", "RowName"][..],
        &[
            "FSimpleCurve",
            ":",
            ":",
            "StaticStruct",
            "(",
            ")",
            "-",
            ">",
            "SerializeTaggedProperties",
        ][..],
        &[
            "FRichCurve",
            ":",
            ":",
            "StaticStruct",
            "(",
            ")",
            "-",
            ">",
            "SerializeTaggedProperties",
        ][..],
    ];
    let mut cursor = 0;
    for sequence in required {
        let Some(offset) = serializer.tokens[cursor..]
            .windows(sequence.len())
            .position(|tokens| token_sequence(tokens, sequence))
        else {
            return Err(GeneratorError::new(format!(
                "{}:{} does not match the supported CurveTable serializer; missing ordered token sequence {}",
                serializer.path,
                serializer.line,
                sequence.join(" ")
            )));
        };
        cursor += offset + sequence.len();
    }
    diagnostics.push(SourceDiagnostic {
        path: serializer.path.clone(),
        line: serializer.line,
        message: "recognized mode + array<Record{Name: FName, Curve: FSimpleCurve | FRichCurve}>"
            .to_owned(),
    });
    Ok(())
}

fn validate_enum_serializer(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(serializer) = functions
        .iter()
        .find(|function| function.class_name == "UEnum" && function.function_name == "Serialize")
    else {
        return Err(GeneratorError::new(
            "UEnum::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &[
            "TArray",
            "<",
            "TPair",
            "<",
            "FName",
            ",",
            "int64",
            ">",
            ">",
            "TempNames",
        ][..],
        &["Ar", "<", "<", "Num"][..],
        &["Ar", "<", "<", "Pair"][..],
        &["Ar", "<", "<", "EnumTypeByte"][..],
    ];
    let mut cursor = 0;
    for sequence in required {
        let Some(offset) = serializer.tokens[cursor..]
            .windows(sequence.len())
            .position(|tokens| token_sequence(tokens, sequence))
        else {
            return Err(GeneratorError::new(format!(
                "{}:{} does not match the supported Enum serializer; missing ordered token sequence {}",
                serializer.path,
                serializer.line,
                sequence.join(" ")
            )));
        };
        cursor += offset + sequence.len();
    }
    diagnostics.push(SourceDiagnostic {
        path: serializer.path.clone(),
        line: serializer.line,
        message: "recognized array<Record{Name: FName, Value: int64}> + uint8 CppForm".to_owned(),
    });
    Ok(())
}

fn validate_struct_serializer(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(serializer) = functions
        .iter()
        .find(|function| function.class_name == "UStruct" && function.function_name == "Serialize")
    else {
        return Err(GeneratorError::new(
            "UStruct::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &["Ar", "<", "<", "SuperStruct"][..],
        &["Ar", "<", "<", "ChildArray"][..],
        &["SerializeProperties", "(", "Ar", ")"][..],
        &["FStructScriptLoader", "ScriptLoadHelper"][..],
        &[
            "ScriptLoadHelper",
            ".",
            "LoadStructWithScript",
            "(",
            "this",
            ",",
            "Ar",
        ][..],
    ];
    validate_ordered_serializer_shape(serializer, "Struct", &required)?;

    let Some(script_loader) = functions.iter().find(|function| {
        function.class_name == "FStructScriptLoader"
            && function.function_name == "FStructScriptLoader"
    }) else {
        return Err(GeneratorError::new(
            "FStructScriptLoader constructor was not found in the configured sources",
        ));
    };
    let script_header = [
        &["Ar", "<", "<", "BytecodeBufferSize"][..],
        &["Ar", "<", "<", "SerializedScriptSize"][..],
    ];
    validate_ordered_serializer_shape(script_loader, "Struct script header", &script_header)?;

    diagnostics.push(SourceDiagnostic {
        path: serializer.path.clone(),
        line: serializer.line,
        message: "recognized SuperStruct + UField children + FProperty fields + script header"
            .to_owned(),
    });
    Ok(())
}

fn validate_script_struct_serializer(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(serializer) = functions.iter().find(|function| {
        function.class_name == "UScriptStruct" && function.function_name == "Serialize"
    }) else {
        return Err(GeneratorError::new(
            "UScriptStruct::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &["uint32", "SavedStructFlags"][..],
        &["Ar", "<", "<", "SavedStructFlags"][..],
    ];
    validate_ordered_serializer_shape(serializer, "ScriptStruct", &required)?;
    diagnostics.push(SourceDiagnostic {
        path: serializer.path.clone(),
        line: serializer.line,
        message: "recognized uint32 non-computed StructFlags".to_owned(),
    });
    Ok(())
}

fn validate_user_defined_struct_serializer(
    functions: &[FunctionBody],
    diagnostics: &mut Vec<SourceDiagnostic>,
) -> Result<(), GeneratorError> {
    let Some(serializer) = functions.iter().find(|function| {
        function.class_name == "UUserDefinedStruct" && function.function_name == "Serialize"
    }) else {
        return Err(GeneratorError::new(
            "UUserDefinedStruct::Serialize was not found in the configured sources",
        ));
    };
    let required = [
        &[
            "UserDefinedStructsStoreDefaultInstance",
            ")",
            "{",
            "if",
            "(",
            "EUserDefinedStructureStatus",
        ][..],
        &["uint8", "*", "StructData"][..],
        &[
            "SerializeItem",
            "(",
            "Record",
            ".",
            "EnterField",
            "(",
            "TEXT",
            "(",
            "Data",
        ][..],
    ];
    validate_ordered_serializer_shape(serializer, "UserDefinedStruct", &required)?;
    diagnostics.push(SourceDiagnostic {
        path: serializer.path.clone(),
        line: serializer.line,
        message: "recognized tagged default struct instance".to_owned(),
    });
    Ok(())
}

fn validate_ordered_serializer_shape(
    function: &FunctionBody,
    label: &str,
    required: &[&[&str]],
) -> Result<(), GeneratorError> {
    let mut cursor = 0;
    for sequence in required {
        let Some(offset) = function.tokens[cursor..]
            .windows(sequence.len())
            .position(|tokens| token_sequence(tokens, sequence))
        else {
            return Err(GeneratorError::new(format!(
                "{}:{} does not match the supported {label} serializer; missing ordered token sequence {}",
                function.path,
                function.line,
                sequence.join(" ")
            )));
        };
        cursor += offset + sequence.len();
    }
    Ok(())
}

fn effective_serialization(
    cpp_name: &str,
    declarations: &BTreeMap<String, &ReflectedType>,
    facts: &BTreeMap<String, Vec<SerializationFact>>,
    stack: &mut Vec<String>,
) -> Result<Vec<SerializationOperation>, GeneratorError> {
    if stack.iter().any(|name| name == cpp_name) {
        return Err(GeneratorError::new(format!(
            "serialization inheritance cycle: {} -> {cpp_name}",
            stack.join(" -> ")
        )));
    }
    stack.push(cpp_name.to_owned());
    let declaration = declarations
        .get(cpp_name)
        .ok_or_else(|| GeneratorError::new(format!("missing declaration for {cpp_name}")))?;
    let local_facts = facts.get(cpp_name);
    let mut operations = Vec::new();
    if let Some(local_facts) = local_facts {
        for fact in local_facts {
            match fact {
                SerializationFact::Inherit => {
                    if let Some(super_name) = &declaration.super_cpp_name
                        && declarations.contains_key(super_name)
                    {
                        operations.extend(effective_serialization(
                            super_name,
                            declarations,
                            facts,
                            stack,
                        )?);
                    }
                }
                SerializationFact::TaggedProperties => {
                    operations.push(SerializationOperation::TaggedProperties);
                }
                SerializationFact::ObjectGuid => {
                    operations.push(SerializationOperation::ObjectGuid);
                }
                SerializationFact::DataTableRows => {
                    operations.push(SerializationOperation::DataTableRows {
                        row_struct_property: "RowStruct".to_owned(),
                    });
                }
                SerializationFact::CurveTableRows => {
                    operations.push(SerializationOperation::CurveTableRows);
                }
                SerializationFact::EnumData => {
                    operations.push(SerializationOperation::EnumData);
                }
                SerializationFact::StructDefinition => {
                    operations.push(SerializationOperation::StructDefinition);
                }
                SerializationFact::StructFlags => {
                    operations.push(SerializationOperation::StructFlags);
                }
                SerializationFact::StructDefaultInstance => {
                    operations.push(SerializationOperation::StructDefaultInstance);
                }
                SerializationFact::StringTableData => {
                    operations.push(SerializationOperation::StringTableData);
                }
            }
        }
    } else if let Some(super_name) = &declaration.super_cpp_name
        && declarations.contains_key(super_name)
    {
        operations.extend(effective_serialization(
            super_name,
            declarations,
            facts,
            stack,
        )?);
    }
    stack.pop();
    Ok(operations)
}

fn parse_field_type(
    cpp_type: &str,
    module: &str,
    paths: &BTreeMap<String, ObjectPath>,
    enum_names: &BTreeSet<String>,
) -> FieldType {
    if let Some(inner) = generic_argument(cpp_type, "TArray") {
        return FieldType::Array {
            inner: Box::new(parse_field_type(inner, module, paths, enum_names)),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TSet") {
        return FieldType::Set {
            inner: Box::new(parse_field_type(inner, module, paths, enum_names)),
        };
    }
    if let Some(arguments) = generic_argument(cpp_type, "TMap")
        && let Some((key, value)) = split_generic_arguments(arguments)
    {
        return FieldType::Map {
            key: Box::new(parse_field_type(key, module, paths, enum_names)),
            value: Box::new(parse_field_type(value, module, paths, enum_names)),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TObjectPtr") {
        return FieldType::Object {
            class_path: resolve_named_path(inner, module, paths),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TWeakObjectPtr") {
        return FieldType::Object {
            class_path: resolve_named_path(inner, module, paths),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TSoftObjectPtr") {
        return FieldType::SoftObject {
            class_path: resolve_named_path(inner, module, paths),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TSubclassOf") {
        return FieldType::Class {
            class_path: resolve_named_path(inner, module, paths),
        };
    }
    if let Some(inner) = generic_argument(cpp_type, "TEnumAsByte") {
        let enum_name = inner.strip_prefix("enum").unwrap_or(inner);
        return FieldType::Enum {
            path: paths
                .get(enum_name)
                .cloned()
                .unwrap_or_else(|| unreal_path(module, enum_name)),
        };
    }
    match cpp_type {
        "bool" => FieldType::Bool,
        "int8" => FieldType::Int8,
        "uint8" => FieldType::UInt8,
        "int16" => FieldType::Int16,
        "uint16" => FieldType::UInt16,
        "int32" => FieldType::Int32,
        "uint32" => FieldType::UInt32,
        "int64" => FieldType::Int64,
        "uint64" => FieldType::UInt64,
        "float" => FieldType::Float,
        "double" => FieldType::Double,
        "FName" => FieldType::Name,
        "FString" => FieldType::String,
        "FText" => FieldType::Text,
        "FVector" => FieldType::Struct {
            path: ObjectPath::new("/Script/CoreUObject.Vector"),
        },
        "FIntPoint" => FieldType::Struct {
            path: ObjectPath::new("/Script/CoreUObject.IntPoint"),
        },
        "FTopLevelAssetPath" => FieldType::Struct {
            path: ObjectPath::new("/Script/CoreUObject.TopLevelAssetPath"),
        },
        "FDataTableRowHandle" => FieldType::Struct {
            path: ObjectPath::new("/Script/Engine.DataTableRowHandle"),
        },
        _ if enum_names.contains(cpp_type) => FieldType::Enum {
            path: paths
                .get(cpp_type)
                .cloned()
                .unwrap_or_else(|| unreal_path(module, cpp_type)),
        },
        _ if cpp_type.starts_with('F') => FieldType::Struct {
            path: paths
                .get(cpp_type)
                .cloned()
                .unwrap_or_else(|| unreal_path(module, cpp_type)),
        },
        _ if cpp_type.starts_with('U') || cpp_type.starts_with('A') => FieldType::Object {
            class_path: resolve_named_path(cpp_type, module, paths),
        },
        _ => FieldType::Unknown {
            cpp_type: cpp_type.to_owned(),
        },
    }
}

fn generic_argument<'a>(cpp_type: &'a str, wrapper: &str) -> Option<&'a str> {
    cpp_type
        .strip_prefix(wrapper)?
        .strip_prefix('<')?
        .strip_suffix('>')
}

fn split_generic_arguments(arguments: &str) -> Option<(&str, &str)> {
    let mut depth = 0_i32;
    for (index, character) in arguments.char_indices() {
        match character {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => return Some((&arguments[..index], &arguments[index + 1..])),
            _ => {}
        }
    }
    None
}

fn resolve_named_path(
    cpp_name: &str,
    module: &str,
    paths: &BTreeMap<String, ObjectPath>,
) -> Option<ObjectPath> {
    let normalized = cpp_name
        .trim_start_matches("const")
        .trim_start_matches("class")
        .trim_end_matches(['*', '&']);
    if normalized == "UObject" {
        return Some(ObjectPath::new("/Script/CoreUObject.Object"));
    }
    if normalized == "UScriptStruct" {
        return Some(ObjectPath::new("/Script/CoreUObject.ScriptStruct"));
    }
    Some(
        paths
            .get(normalized)
            .cloned()
            .unwrap_or_else(|| unreal_path(module, normalized)),
    )
}

fn unreal_path(module: &str, cpp_name: &str) -> ObjectPath {
    let unreal_name = cpp_name
        .strip_prefix(['U', 'A', 'F', 'E'])
        .unwrap_or(cpp_name);
    ObjectPath::new(format!("/Script/{module}.{unreal_name}"))
}

fn collect_unknown_diagnostic(field: &FieldSchema, diagnostics: &mut Vec<SourceDiagnostic>) {
    fn contains_unknown(field_type: &FieldType) -> bool {
        match field_type {
            FieldType::Unknown { .. } => true,
            FieldType::Array { inner } | FieldType::Set { inner } => contains_unknown(inner),
            FieldType::Map { key, value } => contains_unknown(key) || contains_unknown(value),
            _ => false,
        }
    }
    if contains_unknown(&field.field_type) {
        diagnostics.push(SourceDiagnostic {
            path: "<reflected-field>".to_owned(),
            line: 0,
            message: format!("{} has an unsupported reflected type", field.name),
        });
    }
}

fn matching_token(tokens: &[Token], start: usize, open: &str, close: &str) -> Option<usize> {
    let mut depth = 0_i32;
    for (index, token) in tokens.iter().enumerate().skip(start) {
        if token.text == open {
            depth += 1;
        } else if token.text == close {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn token_sequence(tokens: &[Token], expected: &[&str]) -> bool {
    tokens.len() >= expected.len()
        && tokens
            .iter()
            .zip(expected)
            .all(|(token, expected)| token.text == *expected)
}

fn is_identifier(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_reflected_fields_and_nested_container_types() {
        let source = r#"
            USTRUCT(BlueprintType)
            struct FIXTURE_API FExampleRow : public FTableRowBase
            {
                GENERATED_BODY()

                UPROPERTY(EditAnywhere)
                TMap<FName, TArray<int32>> Values;

                UPROPERTY(EditAnywhere)
                uint8 Enabled : 1;
            };
        "#;
        let declarations = parse_reflected_types(&lex(source).expect("lex"), "Fixture");
        assert_eq!(declarations.len(), 1);
        assert_eq!(declarations[0].cpp_name, "FExampleRow");
        assert_eq!(
            declarations[0].super_cpp_name.as_deref(),
            Some("FTableRowBase")
        );
        assert_eq!(declarations[0].fields[0].name, "Values");
        assert_eq!(
            declarations[0].fields[0].cpp_type,
            "TMap<FName,TArray<int32>>"
        );
        assert_eq!(declarations[0].fields[1].name, "Enabled");
        assert_eq!(declarations[0].fields[1].cpp_type, "uint8");
        assert!(declarations[0].fields[1].is_bitfield);
    }

    #[test]
    fn recognizes_the_supported_serializer_language_in_order() {
        let source = r#"
            void UObject::Serialize(FStructuredArchive::FRecord Record)
            {
                SerializeScriptProperties(Record.EnterField(TEXT("Properties")));
                FLazyObjectPtr::PossiblySerializeObjectGuid(this, Record);
            }
            void UDataTable::Serialize(FStructuredArchiveRecord Record)
            {
                Super::Serialize(Record);
                if (Ar.IsSaving()) { SaveStructData(Record.EnterField(TEXT("Data"))); }
            }
            void UCurveTable::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                Ar << NumRows;
            }
            void UStringTable::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                StringTable->Serialize(Ar);
            }
            void UEnum::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                Ar << Num;
            }
            void UStruct::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                Ar << SuperStruct;
            }
            void UScriptStruct::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                Ar << SavedStructFlags;
            }
            void UUserDefinedStruct::Serialize(FStructuredArchive::FRecord Record)
            {
                Super::Serialize(Record);
                SerializeItem(Record.EnterField(TEXT("Data")), StructData, nullptr);
            }
        "#;
        let functions = parse_function_bodies(&lex(source).expect("lex"), "DataTable.cpp");
        let facts = serializer_facts(&functions);
        assert_eq!(
            facts["UObject"],
            vec![
                SerializationFact::TaggedProperties,
                SerializationFact::ObjectGuid
            ]
        );
        assert_eq!(
            facts["UDataTable"],
            vec![SerializationFact::Inherit, SerializationFact::DataTableRows]
        );
        assert_eq!(
            facts["UCurveTable"],
            vec![
                SerializationFact::Inherit,
                SerializationFact::CurveTableRows
            ]
        );
        assert_eq!(
            facts["UStringTable"],
            vec![
                SerializationFact::Inherit,
                SerializationFact::StringTableData
            ]
        );
        assert_eq!(
            facts["UEnum"],
            vec![SerializationFact::Inherit, SerializationFact::EnumData]
        );
        assert_eq!(
            facts["UStruct"],
            vec![
                SerializationFact::Inherit,
                SerializationFact::StructDefinition
            ]
        );
        assert_eq!(
            facts["UScriptStruct"],
            vec![SerializationFact::Inherit, SerializationFact::StructFlags]
        );
        assert_eq!(
            facts["UUserDefinedStruct"],
            vec![
                SerializationFact::Inherit,
                SerializationFact::StructDefaultInstance
            ]
        );
    }

    #[test]
    fn recognizes_the_string_table_payload_shape_in_order() {
        let source = r#"
            void FStringTable::Serialize(FArchive& Ar)
            {
                TableNamespace.SerializeAsString(Ar);
                int32 NumEntries = KeysToEntries.Num();
                Ar << NumEntries;
                FTextKey Key;
                Key.SerializeAsString(Ar);
                FString SourceString;
                Ar << SourceString;
                Ar << TmpKeysToMetaData;
            }
        "#;
        let functions = parse_function_bodies(&lex(source).expect("lex"), "StringTableCore.cpp");
        let mut diagnostics = Vec::new();
        validate_string_table_helper(&functions, &mut diagnostics)
            .expect("supported StringTable shape");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("metadata map"));
    }

    #[test]
    fn recognizes_the_curve_table_payload_shape_in_order() {
        let source = r#"
            void UCurveTable::Serialize(FArchive& Ar)
            {
                int32 NumRows;
                Ar << NumRows;
                Ar << CurveTableMode;
                FName RowName;
                Ar << RowName;
                FSimpleCurve::StaticStruct()->SerializeTaggedProperties(Ar, nullptr, nullptr, nullptr);
                FRichCurve::StaticStruct()->SerializeTaggedProperties(Ar, nullptr, nullptr, nullptr);
            }
        "#;
        let functions = parse_function_bodies(&lex(source).expect("lex"), "CurveTable.cpp");
        let mut diagnostics = Vec::new();
        validate_curve_table_serializer(&functions, &mut diagnostics)
            .expect("supported CurveTable shape");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("FSimpleCurve | FRichCurve"));
    }

    #[test]
    fn recognizes_the_enum_payload_shape_in_order() {
        let source = r#"
            void UEnum::Serialize(FArchive& Ar)
            {
                TArray<TPair<FName, int64>> TempNames;
                int32 Num = 0;
                Ar << Num;
                for (TPair<FName, int64>& Pair : TempNames)
                {
                    Ar << Pair;
                }
                uint8 EnumTypeByte = (uint8)CppForm;
                Ar << EnumTypeByte;
            }
        "#;
        let functions = parse_function_bodies(&lex(source).expect("lex"), "Enum.cpp");
        let mut diagnostics = Vec::new();
        validate_enum_serializer(&functions, &mut diagnostics).expect("supported Enum shape");
        assert_eq!(diagnostics.len(), 1);
        assert!(diagnostics[0].message.contains("int64"));
        assert!(diagnostics[0].message.contains("CppForm"));
    }

    #[test]
    fn recognizes_the_user_defined_struct_payload_shape_in_order() {
        let source = r#"
            void UStruct::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                Ar << SuperStruct;
                Ar << ChildArray;
                SerializeProperties(Ar);
                FStructScriptLoader ScriptLoadHelper(this, Ar);
                ScriptLoadHelper.LoadStructWithScript(this, Ar, true);
            }
            FStructScriptLoader::FStructScriptLoader(UStruct* Target, FArchive& Ar)
                : BytecodeBufferSize(0)
                , SerializedScriptSize(0)
                , ScriptSerializationOffset(INDEX_NONE)
            {
                Ar << BytecodeBufferSize;
                Ar << SerializedScriptSize;
            }
            void UScriptStruct::Serialize(FArchive& Ar)
            {
                Super::Serialize(Ar);
                uint32 SavedStructFlags = NonComputedStructFlags;
                Ar << SavedStructFlags;
            }
            void UUserDefinedStruct::Serialize(FStructuredArchive::FRecord Record)
            {
                Super::Serialize(Record);
                if (UnderlyingArchive.CustomVer(FFrameworkObjectVersion::GUID) >=
                    FFrameworkObjectVersion::UserDefinedStructsStoreDefaultInstance)
                {
                    if (EUserDefinedStructureStatus::UDSS_UpToDate == Status)
                    {
                        uint8* StructData = DefaultStructInstance.GetStructMemory();
                        SerializeItem(Record.EnterField(TEXT("Data")), StructData, nullptr);
                    }
                }
            }
        "#;
        let functions = parse_function_bodies(&lex(source).expect("lex"), "Struct.cpp");
        let mut diagnostics = Vec::new();
        validate_struct_serializer(&functions, &mut diagnostics).expect("supported Struct shape");
        validate_script_struct_serializer(&functions, &mut diagnostics)
            .expect("supported ScriptStruct shape");
        validate_user_defined_struct_serializer(&functions, &mut diagnostics)
            .expect("supported UserDefinedStruct shape");
        assert_eq!(diagnostics.len(), 3);
        assert!(diagnostics[0].message.contains("FProperty fields"));
        assert!(diagnostics[1].message.contains("StructFlags"));
        assert!(diagnostics[2].message.contains("default struct instance"));
    }

    #[test]
    fn maps_fixture_field_types_without_unknown_fallbacks() {
        let paths = BTreeMap::from([
            (
                "FNested".to_owned(),
                ObjectPath::new("/Script/Fixture.Nested"),
            ),
            (
                "ERarity".to_owned(),
                ObjectPath::new("/Script/Fixture.Rarity"),
            ),
            (
                "UUserDefinedStruct".to_owned(),
                ObjectPath::new("/Script/CoreUObject.UserDefinedStruct"),
            ),
        ]);
        let enums = BTreeSet::from(["ERarity".to_owned()]);
        assert_eq!(
            parse_field_type("TArray<FNested>", "Fixture", &paths, &enums),
            FieldType::Array {
                inner: Box::new(FieldType::Struct {
                    path: ObjectPath::new("/Script/Fixture.Nested")
                })
            }
        );
        assert_eq!(
            parse_field_type("ERarity", "Fixture", &paths, &enums),
            FieldType::Enum {
                path: ObjectPath::new("/Script/Fixture.Rarity")
            }
        );
        assert_eq!(
            parse_field_type(
                "TWeakObjectPtr<UUserDefinedStruct>",
                "CoreUObject",
                &paths,
                &enums
            ),
            FieldType::Object {
                class_path: Some(ObjectPath::new("/Script/CoreUObject.UserDefinedStruct"))
            }
        );
        assert_eq!(
            parse_field_type("TEnumAsByte<enumERarity>", "Fixture", &paths, &enums),
            FieldType::Enum {
                path: ObjectPath::new("/Script/Fixture.Rarity")
            }
        );
    }
}
