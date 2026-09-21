//! Supported UE 5.7 native recipes with source-checked serialization order.
use super::{GeneratorError, Token};
use std::collections::BTreeMap;
use uasset_parser::native::NativeLayout as L;

fn require(tokens: &[Token], sequences: &[&str]) -> Result<(), GeneratorError> {
    let mut cursor = 0;
    for sequence in sequences {
        let expected = super::lex(sequence)?;
        let offset = tokens[cursor..]
            .windows(expected.len())
            .position(|window| window.iter().zip(&expected).all(|(a, b)| a.text == b.text))
            .ok_or_else(|| {
                GeneratorError::new(format!(
                    "native coverage recipe missing ordered source: {sequence}"
                ))
            })?;
        cursor += offset + expected.len();
    }
    Ok(())
}

fn vector() -> L {
    L::record([("X", L::Double), ("Y", L::Double), ("Z", L::Double)])
}

pub(super) fn derive(
    sources: &BTreeMap<String, Vec<Token>>,
    layouts: &mut BTreeMap<String, L>,
) -> Result<(), GeneratorError> {
    for (path, tokens) in sources {
        if path.ends_with("Curves/RichCurve.cpp") {
            require(
                tokens,
                &[
                    "bool FRichCurveKey::Serialize",
                    "Ar << InterpMode",
                    "Ar << TangentMode",
                    "Ar << TangentWeightMode",
                    "Ar << Time",
                    "Ar << Value",
                    "Ar << ArriveTangent",
                    "Ar << ArriveTangentWeight",
                    "Ar << LeaveTangent",
                    "Ar << LeaveTangentWeight",
                ],
            )?;
            layouts.insert(
                "FRichCurveKey".into(),
                L::record([
                    ("InterpMode", L::UInt8),
                    ("TangentMode", L::UInt8),
                    ("TangentWeightMode", L::UInt8),
                    ("Time", L::Float),
                    ("Value", L::Float),
                    ("ArriveTangent", L::Float),
                    ("ArriveTangentWeight", L::Float),
                    ("LeaveTangent", L::Float),
                    ("LeaveTangentWeight", L::Float),
                ]),
            );
        }
        if path.ends_with("Animation/ReferenceSkeleton.cpp") {
            require(
                tokens,
                &[
                    "Ar << F.RawRefBoneInfo",
                    "Ar << F.RawRefBonePose",
                    "Ar << F.RawNameToIndexMap",
                ],
            )?;
            layouts.insert(
                "FReferenceSkeletonPose".into(),
                L::record([
                    (
                        "Poses",
                        L::array(L::record([
                            (
                                "Rotation",
                                L::record([
                                    ("X", L::Double),
                                    ("Y", L::Double),
                                    ("Z", L::Double),
                                    ("W", L::Double),
                                ]),
                            ),
                            ("Translation", vector()),
                            ("Scale3D", vector()),
                        ])),
                    ),
                    ("NameToIndex", L::map(L::Name, L::Int32)),
                ]),
            );
        }
        if path.ends_with("MovieSceneCurveChannelImpl.cpp") {
            require(
                tokens,
                &[
                    "Serialize(ChannelType* InChannel, FArchive& Ar)",
                    "Ar << InChannel->PreInfinityExtrap",
                    "Ar << InChannel->PostInfinityExtrap",
                    "Ar << SerializedElementSize",
                    "Ar << InChannel->Times",
                    "Ar << SerializedElementSize",
                    "Ar << InChannel->Values",
                    "Ar << InChannel->DefaultValue",
                    "Ar << InChannel->bHasDefaultValue",
                    "Ar << InChannel->TickResolution.Numerator",
                    "Ar << InChannel->TickResolution.Denominator",
                    "Ar << InChannel->bShowCurve",
                ],
            )?;
            require(
                tokens,
                &[
                    "Ar << InValue.Tangent.ArriveTangent",
                    "Ar << InValue.Tangent.LeaveTangent",
                    "Ar << InValue.Tangent.ArriveTangentWeight",
                    "Ar << InValue.Tangent.LeaveTangentWeight",
                    "Ar << InValue.Tangent.TangentWeightMode",
                    "Ar << InValue.InterpMode",
                    "Ar << InValue.TangentMode",
                    "Ar << InValue.PaddingByte",
                ],
            )?;
            for (name, number, stride) in [
                ("FMovieSceneFloatChannel", L::Float, 28),
                ("FMovieSceneDoubleChannel", L::Double, 32),
            ] {
                let values = L::record([
                    ("Value", number.clone()),
                    ("ArriveTangent", L::Float),
                    ("LeaveTangent", L::Float),
                    ("ArriveTangentWeight", L::Float),
                    ("LeaveTangentWeight", L::Float),
                    ("TangentWeightMode", L::UInt8),
                    ("TangentPadding", L::Padding { bytes: 3 }),
                    ("InterpMode", L::UInt8),
                    ("TangentMode", L::UInt8),
                    ("ValuePadding", L::Padding { bytes: 2 }),
                ]);
                layouts.insert(
                    name.into(),
                    L::record([
                        ("PreInfinityExtrap", L::UInt8),
                        ("PostInfinityExtrap", L::UInt8),
                        (
                            "Times",
                            L::SizedArray {
                                stride: 4,
                                element: Box::new(L::Int32),
                            },
                        ),
                        (
                            "Values",
                            L::SizedArray {
                                stride,
                                element: Box::new(values),
                            },
                        ),
                        ("DefaultValue", number),
                        ("HasDefaultValue", L::Bool),
                        ("TickNumerator", L::Int32),
                        ("TickDenominator", L::Int32),
                        ("ShowCurve", L::Bool),
                    ]),
                );
            }
        }
        if path.ends_with("StructUtils/InstancedStruct.cpp") {
            require(
                tokens,
                &[
                    "bool FInstancedStruct::Serialize",
                    "Ar << SerializedScriptStruct",
                    "Ar << SerialSize",
                    "SerializeItem",
                ],
            )?;
            layouts.insert(
                "FInstancedStructHeader".into(),
                L::record([("StructType", L::Int32), ("SerialSize", L::Int32)]),
            );
        }
        if path.ends_with("SavePackage/SavePackageUtilities.cpp") {
            require(
                tokens,
                &[
                    "void SaveMetaData",
                    "NumObjectMetaDataMap",
                    "NumRootMetaDataMap",
                    "ObjectMetaDataMapStream",
                    "RootMetaDataMapStream",
                ],
            )?;
            layouts.insert(
                "FPackageMetaDataHeader".into(),
                L::record([("ObjectCount", L::Int32), ("RootCount", L::Int32)]),
            );
            layouts.insert("FNameStringMap".into(), L::map(L::Name, L::String));
            layouts.insert(
                "FNameStringPair".into(),
                L::record([("Name", L::Name), ("Value", L::String)]),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordered_recipes_fail_closed_when_source_changes() {
        let source = "bool FRichCurveKey::Serialize(FArchive& Ar) { Ar << InterpMode; Ar << TangentMode; Ar << TangentWeightMode; Ar << Time; Ar << Value; Ar << ArriveTangent; Ar << ArriveTangentWeight; Ar << LeaveTangent; Ar << LeaveTangentWeight; }";
        let derive_curve = |source: &str| {
            let mut layouts = BTreeMap::new();
            derive(
                &BTreeMap::from([(
                    "Engine/Private/Curves/RichCurve.cpp".into(),
                    crate::lex(source).unwrap(),
                )]),
                &mut layouts,
            )
            .map(|()| layouts)
        };
        assert!(derive_curve(source).unwrap().contains_key("FRichCurveKey"));
        assert!(
            derive_curve(&source.replace("Ar << Time; Ar << Value", "Ar << Value; Ar << Time"))
                .is_err()
        );
        assert!(derive_curve(&source.replace("Ar << ArriveTangentWeight;", "")).is_err());
    }
}
