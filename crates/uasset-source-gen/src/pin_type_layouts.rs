//! Current saved pin-type fragments; the map terminal is conditionally composed by the codec.
use super::{GeneratorError, Token, coverage_layouts::require};
use std::collections::BTreeMap;
use uasset_parser::native::NativeLayout as L;

pub(super) fn derive(
    tokens: &[Token],
    layouts: &mut BTreeMap<String, L>,
) -> Result<(), GeneratorError> {
    require(
        tokens,
        &[
            "bool FEdGraphPinType::Serialize(FArchive& Ar)",
            "Ar << PinCategory",
            "Ar << PinSubCategory",
            "Ar << Object",
            "Ar << ContainerType",
            "if (IsMap())",
            "Ar << PinValueType",
            "Ar << bIsReferenceBool",
            "Ar << bIsWeakPointerBool",
            "Ar << PinSubCategoryMemberReference",
            "Ar << bIsConstBool",
            "Ar << bIsUObjectWrapperBool",
            "Ar << bSerializeAsSinglePrecisionFloatBool",
        ],
    )?;
    layouts.insert(
        "FEdGraphPinTypePrefix".into(),
        L::record([
            ("PinCategory", L::Name),
            ("PinSubCategory", L::Name),
            ("PinSubCategoryObject", L::Int32),
            ("ContainerType", L::UInt8),
        ]),
    );
    layouts.insert(
        "FEdGraphTerminalType".into(),
        L::record([
            ("TerminalCategory", L::Name),
            ("TerminalSubCategory", L::Name),
            ("TerminalSubCategoryObject", L::Int32),
            ("bTerminalIsConst", L::Bool),
            ("bTerminalIsWeakPointer", L::Bool),
            ("bTerminalIsUObjectWrapper", L::Bool),
        ]),
    );
    layouts.insert(
        "FEdGraphPinTypeSuffix".into(),
        L::record([
            ("bIsReference", L::Bool),
            ("bIsWeakPointer", L::Bool),
            ("MemberParent", L::Int32),
            ("MemberName", L::Name),
            (
                "MemberGuid",
                L::record([
                    ("A", L::Int32),
                    ("B", L::Int32),
                    ("C", L::Int32),
                    ("D", L::Int32),
                ]),
            ),
            ("bIsConst", L::Bool),
            ("bIsUObjectWrapper", L::Bool),
            ("bSerializeAsSinglePrecisionFloat", L::Bool),
        ]),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pin_recipe_fails_on_missing_map_branch_or_changed_suffix_order() {
        let source = "bool FEdGraphPinType::Serialize(FArchive& Ar) { Ar << PinCategory; Ar << PinSubCategory; Ar << Object; Ar << ContainerType; if (IsMap()) Ar << PinValueType; Ar << bIsReferenceBool; Ar << bIsWeakPointerBool; Ar << PinSubCategoryMemberReference; Ar << bIsConstBool; Ar << bIsUObjectWrapperBool; Ar << bSerializeAsSinglePrecisionFloatBool; }";
        assert!(derive(&crate::lex(source).unwrap(), &mut BTreeMap::new()).is_ok());
        for changed in [
            source.replace("if (IsMap())", "if (IsArray())"),
            source.replace(
                "Ar << bIsReferenceBool; Ar << bIsWeakPointerBool",
                "Ar << bIsWeakPointerBool; Ar << bIsReferenceBool",
            ),
        ] {
            assert!(derive(&crate::lex(&changed).unwrap(), &mut BTreeMap::new()).is_err());
        }
    }
}
