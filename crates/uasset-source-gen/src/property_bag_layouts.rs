//! Source-checked fragments for custom-versioned property-bag framing.
use super::{GeneratorError, Token, coverage_layouts::require};
use std::collections::BTreeMap;
use uasset_parser::native::NativeLayout as L;

pub(super) fn verify_types(tokens: &[Token]) -> Result<(), GeneratorError> {
    for (name, variants) in [
        (
            "EPropertyBagPropertyType",
            vec![
                "None",
                "Bool",
                "Byte",
                "Int32",
                "Int64",
                "Float",
                "Double",
                "Name",
                "String",
                "Text",
                "Enum",
                "Struct",
                "Object",
                "SoftObject",
                "Class",
                "SoftClass",
            ],
        ),
        ("EPropertyBagContainerType", vec!["None", "Array", "Set"]),
    ] {
        let start = tokens
            .iter()
            .position(|t| t.text == name)
            .ok_or_else(|| GeneratorError::new(format!("missing {name}")))?;
        let body = &tokens[start..];
        let end = body
            .iter()
            .position(|t| t.text == "}")
            .ok_or_else(|| GeneratorError::new(format!("unclosed {name}")))?;
        let text: Vec<_> = body[..end].iter().map(|t| t.text.as_str()).collect();
        let begin = text.iter().position(|t| *t == "{").unwrap() + 1;
        let mut actual = Vec::new();
        let mut i = begin;
        while i < text.len() {
            actual.push(text[i]);
            i += 1;
            if text.get(i) == Some(&"UMETA") {
                i += 1;
                while i < text.len() && text[i] != ")" {
                    i += 1;
                }
                i += 1;
            }
            if i < text.len() && text[i] != "," {
                return Err(GeneratorError::new(format!("unsupported {name} numbering")));
            }
            i += 1;
        }
        let mut ue57 = variants.clone();
        let mut ue58 = variants;
        if name == "EPropertyBagPropertyType" {
            ue57.extend(["UInt32", "UInt64"]);
            ue58.extend(["Int8", "Int16", "UInt16", "UInt32", "UInt64"]);
        } else {
            ue58.push("Map");
        }
        ue57.push("Count");
        ue58.push("Count");
        if actual != ue57 && actual != ue58 {
            return Err(GeneratorError::new(format!(
                "unsupported {name} order: {actual:?}"
            )));
        }
    }
    Ok(())
}

pub(super) fn derive(
    tokens: &[Token],
    layouts: &mut BTreeMap<String, L>,
) -> Result<(), GeneratorError> {
    require(
        tokens,
        &[
            "MetaClass = 3",
            "const FGuid FPropertyBagCustomVersion::GUID(0x134A157E, 0xD5E249A3, 0x8D4E843C, 0x98FE9E31)",
        ],
    )?;
    require(
        tokens,
        &[
            "void FPropertyBagContainerTypes::Serialize(FArchive& Ar)",
            "Ar << NumContainers",
            "Ar << Types[i]",
            "void FPropertyBagPropertyDescMetaData::Serialize(FArchive& Ar)",
            "Ar << Key",
            "Ar << Value",
            "FArchive& operator<<(FArchive& Ar, FPropertyBagPropertyDesc& Bag)",
            "Ar << Bag.ValueTypeObject",
            "Ar << Bag.ID",
            "Ar << Bag.Name",
            "Ar << Bag.ValueType",
            "Ar << Bag.ContainerTypes",
            "Ar << bHasMetaData",
            "Ar << Bag.MetaData",
            "Ar << Bag.MetaClass",
            "bool FInstancedPropertyBag::Serialize(FArchive& Ar)",
            "Ar << bHasData",
            "Ar << PropertyDescs",
            "Ar << SerialSize",
            "BagStruct->SerializeItem(Ar, Value.GetMutableMemory(), /*Defaults*/nullptr)",
        ],
    )?;
    layouts.insert("/Script/CoreUObject.InstancedPropertyBag".into(), L::Bool);
    layouts.insert(
        "FPropertyBagDescriptorPrefix".into(),
        L::record([
            ("ValueTypeObject", L::Int32),
            (
                "ID",
                L::record([
                    ("A", L::Int32),
                    ("B", L::Int32),
                    ("C", L::Int32),
                    ("D", L::Int32),
                ]),
            ),
            ("Name", L::Name),
            ("ValueType", L::UInt8),
        ]),
    );
    layouts.insert(
        "FPropertyBagMetadata".into(),
        L::array(L::record([("Key", L::Name), ("Value", L::String)])),
    );
    // The custom version, not the package revision, selects this extra suffix.
    if tokens
        .windows(3)
        .any(|w| w[0].text == "KeyTypes" && w[1].text == "=" && w[2].text == "5")
    {
        require(
            tokens,
            &[
                "PropertyFlags = 4",
                "KeyTypes = 5",
                "Ar << Bag.PropertyFlags",
                "Ar << Bag.KeyType",
                "Ar << Bag.KeyTypeObject",
            ],
        )?;
        layouts.insert(
            "FPropertyBagDescriptorV5Suffix".into(),
            L::record([
                ("PropertyFlags", L::Int64),
                ("KeyType", L::UInt8),
                ("KeyTypeObject", L::Int32),
            ]),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_enum_order_or_explicit_numbering_requires_a_new_recipe() {
        let source = "enum class EPropertyBagPropertyType : uint8 {None UMETA(Hidden), Bool, Byte, Int32, Int64, Float, Double, Name, String, Text, Enum, Struct, Object, SoftObject, Class, SoftClass, UInt32, UInt64, Count UMETA(Hidden)}; enum class EPropertyBagContainerType : uint8 {None, Array, Set, Count UMETA(Hidden)};";
        verify_types(&super::super::lex(source).unwrap()).unwrap();
        let ue58 = source
            .replace("UInt32, UInt64", "Int8, Int16, UInt16, UInt32, UInt64")
            .replace("Set, Count", "Set, Map, Count");
        verify_types(&super::super::lex(&ue58).unwrap()).unwrap();
        for bad in [
            source.replace("Int32, Int64", "Int64, Int32"),
            source.replace("Byte,", "Byte = 99,"),
            ue58.replace("Set, Map", "Map, Set"),
            source.replace("UInt64,", "UInt64, NewType,"),
        ] {
            assert!(verify_types(&super::super::lex(&bad).unwrap()).is_err());
        }
    }
}
