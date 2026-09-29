//! Saved channel values only: frame coordinates remain local, with no blending or evaluation.
use super::*;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceNumericChannel {
    pub property_path: String,
    /// Scalar channels use true. Transform channels use the saved mask bit, or None when
    /// that mask was not saved or could not be decoded. This does not evaluate section activity.
    pub enabled: Option<bool>,
    pub default_value: Option<f64>,
    pub pre_extrapolation: u8,
    pub post_extrapolation: u8,
    pub tick_resolution: SequenceFrameRate,
    pub show_curve: bool,
    pub keys: Vec<SequenceNumericKey>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceNumericKey {
    pub frame: i64,
    pub value: f64,
    pub interpolation: u8,
    pub tangent_mode: u8,
    pub tangent_weight_mode: u8,
    pub arrive_tangent: f64,
    pub leave_tangent: f64,
    pub arrive_tangent_weight: f64,
    pub leave_tangent_weight: f64,
}

pub(super) fn project_channels(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceNumericChannel> {
    let expected: Vec<(&str, i32, Option<u32>)> = match section.class_path.as_str() {
        "/Script/MovieSceneTracks.MovieSceneFloatSection" => vec![("FloatCurve", 0, None)],
        "/Script/MovieSceneTracks.MovieSceneDoubleSection" => vec![("DoubleCurve", 0, None)],
        "/Script/MovieSceneTracks.MovieScene3DTransformSection" => {
            let mut fields = Vec::new();
            for (name, base) in [("Translation", 0), ("Rotation", 3), ("Scale", 6)] {
                for axis in 0..3 {
                    fields.push((name, axis, Some(1 << (base + axis))));
                }
            }
            fields.push(("ManualWeight", 0, Some(1 << 9)));
            fields
        }
        _ => {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "Sections".into(),
                reason: SequenceCoverageGapReason::UnsupportedSectionContent,
            });
            return Vec::new();
        }
    };
    let mask = match property(package, &section.properties, "TransformMask") {
        Some(PropertyValue::Struct(stream)) => {
            integer(package, stream, "Mask").and_then(|v| u32::try_from(v).ok())
        }
        _ => None,
    };
    if expected.iter().any(|(_, _, bit)| bit.is_some()) && mask.is_none() {
        gaps.push(SequenceCoverageGap {
            object_path: section.object_path.to_string(),
            property_path: "TransformMask".into(),
            reason: SequenceCoverageGapReason::MissingChannelMask,
        });
    }
    expected
        .into_iter()
        .filter_map(|(name, index, bit)| {
            let path = if matches!(name, "Translation" | "Rotation" | "Scale") {
                format!("{name}[{index}]")
            } else {
                name.into()
            };
            let record = section.properties.records.iter().find(|record| {
                package.resolve_name_str(record.name) == Some(name) && record.array_index == index
            });
            let enabled = bit.map_or(Some(true), |bit| mask.map(|mask| mask & bit != 0));
            // Absent properties are not fabricated from editor defaults. Even inactive channels
            // may have saved keys worth reviewing, so retain them when present.
            let Some(record) = record else {
                if enabled != Some(false) {
                    gaps.push(SequenceCoverageGap {
                        object_path: section.object_path.to_string(),
                        property_path: path,
                        reason: SequenceCoverageGapReason::MissingChannel,
                    });
                }
                return None;
            };
            match channel(&record.value, path.clone(), enabled) {
                Some(value) => Some(value),
                None => {
                    gaps.push(SequenceCoverageGap {
                        object_path: section.object_path.to_string(),
                        property_path: path,
                        reason: SequenceCoverageGapReason::WrongValueKind,
                    });
                    None
                }
            }
        })
        .collect()
}

fn field<'a>(value: &'a PropertyValue, name: &str) -> Option<&'a PropertyValue> {
    let PropertyValue::NativeStruct { fields } = value else {
        return None;
    };
    fields
        .iter()
        .find(|field| field.name == name)
        .map(|field| &field.value)
}
fn number(value: &PropertyValue) -> Option<f64> {
    match value {
        PropertyValue::Float(v) => Some(f64::from(*v)),
        PropertyValue::Double(v) => Some(*v),
        _ => None,
    }
    .filter(|v| v.is_finite())
}
fn int(value: &PropertyValue) -> Option<i64> {
    match value {
        PropertyValue::Int(v) => Some(*v),
        PropertyValue::UInt(v) => i64::try_from(*v).ok(),
        _ => None,
    }
}
fn byte(value: &PropertyValue, name: &str) -> Option<u8> {
    u8::try_from(int(field(value, name)?)?).ok()
}
fn boolean(value: &PropertyValue) -> Option<bool> {
    if let PropertyValue::Bool(v) = value {
        Some(*v)
    } else {
        None
    }
}

fn channel(
    value: &PropertyValue,
    property_path: String,
    enabled: Option<bool>,
) -> Option<SequenceNumericChannel> {
    let PropertyValue::Array(times) = field(value, "Times")? else {
        return None;
    };
    let PropertyValue::Array(values) = field(value, "Values")? else {
        return None;
    };
    if times.len() != values.len() {
        return None;
    }
    let keys = times
        .iter()
        .zip(values)
        .map(|(time, key)| {
            Some(SequenceNumericKey {
                frame: int(time)?,
                value: number(field(key, "Value")?)?,
                interpolation: byte(key, "InterpMode")?,
                tangent_mode: byte(key, "TangentMode")?,
                tangent_weight_mode: byte(key, "TangentWeightMode")?,
                arrive_tangent: number(field(key, "ArriveTangent")?)?,
                leave_tangent: number(field(key, "LeaveTangent")?)?,
                arrive_tangent_weight: number(field(key, "ArriveTangentWeight")?)?,
                leave_tangent_weight: number(field(key, "LeaveTangentWeight")?)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let default_value = if boolean(field(value, "HasDefaultValue")?)? {
        Some(number(field(value, "DefaultValue")?)?)
    } else {
        None
    };
    Some(SequenceNumericChannel {
        property_path,
        enabled,
        default_value,
        pre_extrapolation: byte(value, "PreInfinityExtrap")?,
        post_extrapolation: byte(value, "PostInfinityExtrap")?,
        tick_resolution: SequenceFrameRate {
            numerator: int(field(value, "TickNumerator")?)?,
            denominator: int(field(value, "TickDenominator")?)?,
        },
        show_curve: boolean(field(value, "ShowCurve")?)?,
        keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uasset_parser::asset::{AssetDecodeContext, decode_export};

    #[test]
    fn empty_defaults_nonfinite_values_and_mismatched_lengths_remain_explicit() {
        let bytes = include_bytes!(
            "../../../../fixtures/unreal-project/Content/Fixture/ParserNative/DA_Native.uasset"
        );
        let package = Package::parse(bytes).unwrap();
        let context = AssetDecodeContext {
            source: bytes,
            package: &package,
            schemas: uasset_parser::schema::embedded_source_model(),
        };
        let object = package
            .exports
            .iter()
            .find_map(|export| match decode_export(export, &context).unwrap() {
                Some(DecodedAsset::UObject(object)) => Some(object),
                _ => None,
            })
            .unwrap();
        let empty = property(&package, &object.properties, "EmptyChannel").unwrap();
        let result = channel(empty, "EmptyChannel".into(), Some(true)).unwrap();
        assert!(result.keys.is_empty());
        assert_eq!(result.default_value, None);
        let mut invalid = property(&package, &object.properties, "DoubleChannel")
            .unwrap()
            .clone();
        let PropertyValue::NativeStruct { fields } = &mut invalid else {
            panic!()
        };
        fields
            .iter_mut()
            .find(|f| f.name == "DefaultValue")
            .unwrap()
            .value = PropertyValue::Double(f64::NAN);
        assert!(channel(&invalid, "DoubleChannel".into(), None).is_none());
        let PropertyValue::NativeStruct { fields } = &mut invalid else {
            panic!()
        };
        fields
            .iter_mut()
            .find(|f| f.name == "HasDefaultValue")
            .unwrap()
            .value = PropertyValue::Bool(false);
        assert!(channel(&invalid, "DoubleChannel".into(), None).is_some());
        let PropertyValue::NativeStruct { fields } = &mut invalid else {
            panic!()
        };
        fields.iter_mut().find(|f| f.name == "Times").unwrap().value =
            PropertyValue::Array(Vec::new());
        assert!(channel(&invalid, "DoubleChannel".into(), None).is_none());
    }
}
