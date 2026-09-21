//! Reusable native type lowering. Family recognizers supply order and semantic names;
//! this module resolves container and alias composition across configured source modules.

use super::{GeneratorError, Token};
use std::collections::{BTreeMap, BTreeSet};
use uasset_parser::native::NativeLayout;

pub(super) fn collect_aliases(tokens: &[Token], aliases: &mut BTreeMap<String, BTreeSet<String>>) {
    for (index, token) in tokens.iter().enumerate() {
        if token.text != "typedef" {
            continue;
        }
        let Some(end) = tokens[index + 1..]
            .iter()
            .position(|token| token.text == ";")
        else {
            continue;
        };
        let declaration = &tokens[index + 1..index + 1 + end];
        if let Some((name, cpp_type)) = declaration.split_last() {
            aliases
                .entry(name.text.clone())
                .or_default()
                .insert(cpp_type.iter().map(|token| token.text.as_str()).collect());
        }
    }
}

pub(super) fn lower_type(
    cpp_type: &str,
    aliases: &BTreeMap<String, BTreeSet<String>>,
) -> Result<NativeLayout, GeneratorError> {
    lower(cpp_type, aliases, 0)
}

fn lower(
    cpp_type: &str,
    aliases: &BTreeMap<String, BTreeSet<String>>,
    depth: usize,
) -> Result<NativeLayout, GeneratorError> {
    if depth > 32 {
        return Err(GeneratorError::new(format!(
            "native type alias/container nesting exceeds limit at {cpp_type}"
        )));
    }
    Ok(match cpp_type {
        "FString" => NativeLayout::String,
        "FName" => NativeLayout::Name,
        "int64" => NativeLayout::Int64,
        "int32" => NativeLayout::Int32,
        "float" => NativeLayout::Float,
        "double" => NativeLayout::Double,
        "bool" => NativeLayout::Bool,
        "uint8" => NativeLayout::UInt8,
        _ => {
            if let Some(targets) = aliases.get(cpp_type) {
                if targets.len() != 1 {
                    return Err(GeneratorError::new(format!(
                        "ambiguous native alias {cpp_type} across configured sources"
                    )));
                }
                return lower(
                    targets.first().expect("one alias target"),
                    aliases,
                    depth + 1,
                );
            }
            if let Some(inner) = super::generic_argument(cpp_type, "TArray") {
                return Ok(NativeLayout::array(lower(inner, aliases, depth + 1)?));
            }
            if let Some(inner) = super::generic_argument(cpp_type, "TMap") {
                let (key, value) = super::split_generic_arguments(inner).ok_or_else(|| {
                    GeneratorError::new(format!("unsupported native map type {cpp_type}"))
                })?;
                return Ok(NativeLayout::map(
                    lower(key.trim(), aliases, depth + 1)?,
                    lower(value.trim(), aliases, depth + 1)?,
                ));
            }
            return Err(GeneratorError::new(format!(
                "unsupported native serialized type {cpp_type}"
            )));
        }
    })
}

pub(super) fn string_table(
    aliases: &BTreeMap<String, BTreeSet<String>>,
) -> Result<NativeLayout, GeneratorError> {
    // FStringTable's ordered serializer recognizer proves the namespace and entry loop.
    // FTextKey::SerializeAsString explicitly uses FString wire encoding.
    Ok(NativeLayout::record([
        ("Namespace", NativeLayout::String),
        (
            "Entries",
            NativeLayout::array(NativeLayout::record([
                ("Key", NativeLayout::String),
                ("SourceString", NativeLayout::String),
            ])),
        ),
        (
            "MetaData",
            lower_type("TMap<FString,FMetaDataMap>", aliases)?,
        ),
    ]))
}

pub(super) fn enumeration() -> NativeLayout {
    NativeLayout::record([
        (
            "Names",
            NativeLayout::array(NativeLayout::record([
                ("Name", NativeLayout::Name),
                ("Value", NativeLayout::Int64),
            ])),
        ),
        ("CppForm", NativeLayout::UInt8),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_nested_native_containers_through_source_aliases() {
        let mut aliases = BTreeMap::new();
        collect_aliases(
            &crate::lex("typedef TMap<FName, FString> FMetaDataMap;").unwrap(),
            &mut aliases,
        );
        assert_eq!(
            lower_type("TArray<TMap<FString,FMetaDataMap>>", &aliases).unwrap(),
            NativeLayout::array(NativeLayout::map(
                NativeLayout::String,
                NativeLayout::map(NativeLayout::Name, NativeLayout::String)
            ))
        );
        assert!(lower_type("FUnsupported", &aliases).is_err());
        aliases.insert("FCycle".into(), BTreeSet::from(["FCycle".into()]));
        assert!(lower_type("FCycle", &aliases).is_err());
        collect_aliases(
            &crate::lex("typedef TMap<FString, FString> FMetaDataMap;").unwrap(),
            &mut aliases,
        );
        assert!(
            lower_type("FMetaDataMap", &aliases)
                .unwrap_err()
                .to_string()
                .contains("ambiguous")
        );
    }
}
