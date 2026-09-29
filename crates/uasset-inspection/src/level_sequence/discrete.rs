//! Reflected, saved channel evidence. Absence remains explicit; no constructor defaults or evaluation.
use super::*;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "value_type", rename_all = "snake_case")]
pub enum SequenceDiscreteChannel {
    Bool(SequenceDiscreteChannelData<bool>),
    Integer(SequenceDiscreteChannelData<i32>),
    Byte(SequenceDiscreteChannelData<u8>),
}

impl SequenceDiscreteChannel {
    #[must_use]
    pub fn key_count(&self) -> usize {
        match self {
            Self::Bool(channel) => channel.keys.as_ref().map_or(0, Vec::len),
            Self::Integer(channel) => channel.keys.as_ref().map_or(0, Vec::len),
            Self::Byte(channel) => channel.keys.as_ref().map_or(0, Vec::len),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceDiscreteChannelData<T> {
    pub property_path: String,
    /// Null means the property was not serialized, not false or an inferred engine default.
    pub has_default_value: Option<bool>,
    pub default_value: Option<T>,
    pub pre_extrapolation: Option<String>,
    pub post_extrapolation: Option<String>,
    pub interpolate_linear_keys: Option<bool>,
    pub externally_inverted: Option<bool>,
    pub enum_path: Option<String>,
    /// Null means the arrays were absent or invalid. An explicitly saved empty array is [].
    pub keys: Option<Vec<SequenceDiscreteKey<T>>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceDiscreteKey<T> {
    pub frame: i32,
    pub value: T,
}

pub(super) fn project_channels(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceDiscreteChannel> {
    let (field, kind) = match section.class_path.as_str() {
        "/Script/MovieScene.MovieSceneBoolSection"
        | "/Script/MovieSceneTracks.MovieSceneVisibilitySection" => ("BoolCurve", "bool"),
        "/Script/MovieSceneTracks.MovieSceneIntegerSection" => ("IntegerCurve", "integer"),
        "/Script/MovieSceneTracks.MovieSceneByteSection" => ("ByteCurve", "byte"),
        "/Script/MovieSceneTracks.MovieSceneEnumSection" => ("EnumCurve", "byte"),
        _ => {
            gap(
                section,
                "Sections",
                SequenceCoverageGapReason::UnsupportedSectionContent,
                gaps,
            );
            return Vec::new();
        }
    };
    let value = property(package, &section.properties, field);
    let Some(PropertyValue::Struct(stream)) = value else {
        gap(
            section,
            field,
            if value.is_none() {
                SequenceCoverageGapReason::MissingChannel
            } else {
                SequenceCoverageGapReason::WrongValueKind
            },
            gaps,
        );
        return Vec::new();
    };
    vec![match kind {
        "bool" => {
            SequenceDiscreteChannel::Bool(channel(package, section, stream, field, boolean, gaps))
        }
        "integer" => SequenceDiscreteChannel::Integer(channel(
            package,
            section,
            stream,
            field,
            |v| int(v).and_then(|v| i32::try_from(v).ok()),
            gaps,
        )),
        _ => SequenceDiscreteChannel::Byte(channel(
            package,
            section,
            stream,
            field,
            |v| int(v).and_then(|v| u8::try_from(v).ok()),
            gaps,
        )),
    }]
}

fn gap(
    section: &DecodedUObject,
    path: &str,
    reason: SequenceCoverageGapReason,
    gaps: &mut Vec<SequenceCoverageGap>,
) {
    gaps.push(SequenceCoverageGap {
        object_path: section.object_path.to_string(),
        property_path: path.into(),
        reason,
    });
}

fn boolean(value: &PropertyValue) -> Option<bool> {
    if let PropertyValue::Bool(value) = value {
        Some(*value)
    } else {
        None
    }
}

fn int(value: &PropertyValue) -> Option<i64> {
    match value {
        PropertyValue::Int(v) => Some(*v),
        PropertyValue::UInt(v) => i64::try_from(*v).ok(),
        _ => None,
    }
}

fn channel<T>(
    package: &Package,
    section: &DecodedUObject,
    stream: &PropertyStream,
    field: &str,
    decode: impl Fn(&PropertyValue) -> Option<T>,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceDiscreteChannelData<T> {
    let mut saved = |name: &str, decode: &dyn Fn(&PropertyValue) -> Option<T>| {
        let value = property(package, stream, name)?;
        let result = decode(value);
        if result.is_none() {
            gap(
                section,
                &format!("{field}.{name}"),
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
        }
        result
    };
    let default_value = saved("DefaultValue", &decode);
    let keys = keys(package, section, stream, field, &decode, gaps);
    let mut read_bool = |properties: &PropertyStream, name: &str, path: String| {
        let value = property(package, properties, name)?;
        let result = boolean(value);
        if result.is_none() {
            gap(
                section,
                &path,
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
        }
        result
    };
    let has_default_value = read_bool(
        stream,
        "bHasDefaultValue",
        format!("{field}.bHasDefaultValue"),
    );
    let interpolate_linear_keys = read_bool(
        stream,
        "bInterpolateLinearKeys",
        format!("{field}.bInterpolateLinearKeys"),
    );
    let externally_inverted = read_bool(
        &section.properties,
        "bIsExternallyInverted",
        "bIsExternallyInverted".into(),
    );
    let mut extrapolation = |name: &str| {
        let value = property(package, stream, name)?;
        let result = match value {
            PropertyValue::Enum(value) | PropertyValue::Name(value) => package.resolve_name(*value),
            _ => None,
        };
        if result.is_none() {
            gap(
                section,
                &format!("{field}.{name}"),
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
        }
        result
    };
    let pre_extrapolation = extrapolation("PreInfinityExtrap");
    let post_extrapolation = extrapolation("PostInfinityExtrap");
    let enum_path = match property(package, stream, "Enum") {
        None | Some(PropertyValue::ObjectRef(PackageIndex::Null)) => None,
        Some(PropertyValue::ObjectRef(index)) => {
            let result = resolve_object(package, *index);
            if result.is_none() {
                gap(
                    section,
                    &format!("{field}.Enum"),
                    SequenceCoverageGapReason::MissingReference,
                    gaps,
                );
            }
            result
        }
        Some(_) => {
            gap(
                section,
                &format!("{field}.Enum"),
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
            None
        }
    };
    SequenceDiscreteChannelData {
        property_path: field.into(),
        has_default_value,
        default_value,
        pre_extrapolation,
        post_extrapolation,
        interpolate_linear_keys,
        externally_inverted,
        enum_path,
        keys,
    }
}

fn keys<T>(
    package: &Package,
    section: &DecodedUObject,
    stream: &PropertyStream,
    field: &str,
    decode: &impl Fn(&PropertyValue) -> Option<T>,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Option<Vec<SequenceDiscreteKey<T>>> {
    let times = property(package, stream, "Times");
    let values = property(package, stream, "Values");
    if times.is_none() && values.is_none() {
        return None;
    }
    let (Some(PropertyValue::Array(times)), Some(PropertyValue::Array(values))) = (times, values)
    else {
        gap(
            section,
            field,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
        return None;
    };
    if times.len() != values.len() {
        gap(
            section,
            field,
            SequenceCoverageGapReason::MismatchedChannelLengths,
            gaps,
        );
        return None;
    }
    let result = times
        .iter()
        .zip(values)
        .map(|(time, value)| {
            Some(SequenceDiscreteKey {
                frame: i32::try_from(int(time)?).ok()?,
                value: decode(value)?,
            })
        })
        .collect::<Option<Vec<_>>>();
    if result.is_none() {
        gap(
            section,
            field,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
    }
    result
}
