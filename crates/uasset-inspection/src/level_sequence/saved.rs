//! Saved section settings and reference-bearing channels; no runtime binding or evaluation.
use super::*;
use crate::generic::{PropertyOutput, property_outputs};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceSectionSettings {
    pub row_index: Option<i32>,
    pub overlap_priority: Option<i32>,
    pub is_active: Option<bool>,
    pub is_locked: Option<bool>,
    pub pre_roll_frames: Option<i32>,
    pub post_roll_frames: Option<i32>,
    pub blend_type: Option<Vec<PropertyOutput>>,
    pub easing: Option<Vec<PropertyOutput>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceCameraCut {
    pub binding: Option<SequenceObjectBindingId>,
    pub lock_previous_camera: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceObjectBindingId {
    pub guid: Option<String>,
    pub sequence_id: Option<i32>,
    pub resolve_parent_index: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(tag = "value_type", rename_all = "snake_case")]
pub enum SequenceValueChannel {
    String(SequenceStringChannel),
    Object(SequenceObjectChannel),
}

impl SequenceValueChannel {
    #[must_use]
    pub fn key_count(&self) -> usize {
        match self {
            Self::String(c) => c.keys.as_ref().map_or(0, Vec::len),
            Self::Object(c) => c.keys.as_ref().map_or(0, Vec::len),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceStringChannel {
    pub property_path: String,
    pub has_default_value: Option<bool>,
    pub default_value: Option<String>,
    pub keys: Option<Vec<SequenceDiscreteKey<String>>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceObjectChannel {
    pub property_path: String,
    pub property_class: Option<String>,
    pub default_value: Option<SequenceObjectValue>,
    pub keys: Option<Vec<SequenceDiscreteKey<SequenceObjectValue>>>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SequenceObjectValue {
    pub soft_path: Option<String>,
    pub hard_path: Option<String>,
}

fn issue(
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

fn saved<T>(
    package: &Package,
    section: &DecodedUObject,
    stream: &PropertyStream,
    field: &str,
    path: &str,
    decode: impl FnOnce(&PropertyValue) -> Option<T>,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Option<T> {
    let value = property(package, stream, field)?;
    let result = decode(value);
    if result.is_none() {
        issue(
            section,
            path,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
    }
    result
}

fn int(value: &PropertyValue) -> Option<i32> {
    match value {
        PropertyValue::Int(v) => i32::try_from(*v).ok(),
        PropertyValue::UInt(v) => i32::try_from(*v).ok(),
        _ => None,
    }
}
fn boolean(value: &PropertyValue) -> Option<bool> {
    if let PropertyValue::Bool(v) = value {
        Some(*v)
    } else {
        None
    }
}

pub(super) fn settings(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceSectionSettings {
    let stream = &section.properties;
    let mut number = |field: &str| saved(package, section, stream, field, field, int, gaps);
    let row_index = number("RowIndex");
    let overlap_priority = number("OverlapPriority");
    let pre_roll_frames = number("PreRollFrames");
    let post_roll_frames = number("PostRollFrames");
    let mut flag = |field: &str| saved(package, section, stream, field, field, boolean, gaps);
    let is_active = flag("bIsActive");
    let is_locked = flag("bIsLocked");
    let mut fields = |field: &str| {
        saved(
            package,
            section,
            stream,
            field,
            field,
            |v| {
                if let PropertyValue::Struct(v) = v {
                    Some(property_outputs(package, v.clone()))
                } else {
                    None
                }
            },
            gaps,
        )
    };
    let blend_type = fields("BlendType");
    let easing = fields("Easing");
    SequenceSectionSettings {
        row_index,
        overlap_priority,
        is_active,
        is_locked,
        pre_roll_frames,
        post_roll_frames,
        blend_type,
        easing,
    }
}

pub(super) fn camera_cut(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceCameraCut {
    let binding = match property(package, &section.properties, "CameraBindingID") {
        Some(PropertyValue::Struct(stream)) => {
            let guid = saved(
                package,
                section,
                stream,
                "Guid",
                "CameraBindingID.Guid",
                |v| {
                    if let PropertyValue::Guid(v) = v {
                        Some(v.to_string())
                    } else {
                        None
                    }
                },
                gaps,
            );
            let sequence_id = saved(
                package,
                section,
                stream,
                "SequenceID",
                "CameraBindingID.SequenceID",
                int,
                gaps,
            );
            let resolve_parent_index = saved(
                package,
                section,
                stream,
                "ResolveParentIndex",
                "CameraBindingID.ResolveParentIndex",
                int,
                gaps,
            );
            Some(SequenceObjectBindingId {
                guid,
                sequence_id,
                resolve_parent_index,
            })
        }
        None => {
            issue(
                section,
                "CameraBindingID",
                SequenceCoverageGapReason::MissingReference,
                gaps,
            );
            None
        }
        _ => {
            issue(
                section,
                "CameraBindingID",
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
            None
        }
    };
    let lock_previous_camera = saved(
        package,
        section,
        &section.properties,
        "bLockPreviousCamera",
        "bLockPreviousCamera",
        boolean,
        gaps,
    );
    SequenceCameraCut {
        binding,
        lock_previous_camera,
    }
}

pub(super) fn channels(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceValueChannel> {
    let (field, is_object) = match section.class_path.as_str() {
        "/Script/MovieSceneTracks.MovieSceneStringSection" => ("StringCurve", false),
        "/Script/MovieSceneTracks.MovieSceneObjectPropertySection" => ("ObjectChannel", true),
        _ => {
            issue(
                section,
                "Sections",
                SequenceCoverageGapReason::UnsupportedSectionContent,
                gaps,
            );
            return Vec::new();
        }
    };
    let stream = match property(package, &section.properties, field) {
        Some(PropertyValue::Struct(v)) => v,
        None => {
            issue(
                section,
                field,
                SequenceCoverageGapReason::MissingChannel,
                gaps,
            );
            return Vec::new();
        }
        _ => {
            issue(
                section,
                field,
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
            return Vec::new();
        }
    };
    if is_object {
        let property_class = match property(package, stream, "PropertyClass") {
            None | Some(PropertyValue::ObjectRef(PackageIndex::Null)) => None,
            Some(PropertyValue::ObjectRef(index)) => {
                let result = resolve_object(package, *index);
                if result.is_none() {
                    issue(
                        section,
                        "ObjectChannel.PropertyClass",
                        SequenceCoverageGapReason::MissingReference,
                        gaps,
                    );
                }
                result
            }
            _ => {
                issue(
                    section,
                    "ObjectChannel.PropertyClass",
                    SequenceCoverageGapReason::WrongValueKind,
                    gaps,
                );
                None
            }
        };
        let default_value = object_value(
            package,
            section,
            property(package, stream, "DefaultValue"),
            &format!("{field}.DefaultValue"),
            gaps,
        );
        let keys = keys(
            package,
            section,
            stream,
            field,
            |v, path, gaps| object_value(package, section, Some(v), path, gaps),
            gaps,
        );
        vec![SequenceValueChannel::Object(SequenceObjectChannel {
            property_path: field.into(),
            property_class,
            default_value,
            keys,
        })]
    } else {
        let has_default_value = saved(
            package,
            section,
            stream,
            "bHasDefaultValue",
            &format!("{field}.bHasDefaultValue"),
            boolean,
            gaps,
        );
        let default_value = saved(
            package,
            section,
            stream,
            "DefaultValue",
            &format!("{field}.DefaultValue"),
            |v| {
                if let PropertyValue::String(v) = v {
                    Some(v.clone())
                } else {
                    None
                }
            },
            gaps,
        );
        let keys = keys(
            package,
            section,
            stream,
            field,
            |v, _, _| {
                if let PropertyValue::String(v) = v {
                    Some(v.clone())
                } else {
                    None
                }
            },
            gaps,
        );
        vec![SequenceValueChannel::String(SequenceStringChannel {
            property_path: field.into(),
            has_default_value,
            default_value,
            keys,
        })]
    }
}

fn object_value(
    package: &Package,
    section: &DecodedUObject,
    value: Option<&PropertyValue>,
    path: &str,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Option<SequenceObjectValue> {
    let PropertyValue::Struct(stream) = value? else {
        issue(
            section,
            path,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
        return None;
    };
    let soft_path = saved(
        package,
        section,
        stream,
        "SoftPtr",
        path,
        |v| {
            if let PropertyValue::SoftObjectPath(v) = v {
                Some(v.clone())
            } else {
                None
            }
        },
        gaps,
    );
    let hard_path = match property(package, stream, "HardPtr") {
        None | Some(PropertyValue::ObjectRef(PackageIndex::Null)) => None,
        Some(PropertyValue::ObjectRef(index)) => {
            let result = resolve_object(package, *index);
            if result.is_none() {
                issue(
                    section,
                    path,
                    SequenceCoverageGapReason::MissingReference,
                    gaps,
                );
            }
            result
        }
        _ => {
            issue(
                section,
                path,
                SequenceCoverageGapReason::WrongValueKind,
                gaps,
            );
            None
        }
    };
    Some(SequenceObjectValue {
        soft_path,
        hard_path,
    })
}

fn keys<T>(
    package: &Package,
    section: &DecodedUObject,
    stream: &PropertyStream,
    field: &str,
    decode: impl Fn(&PropertyValue, &str, &mut Vec<SequenceCoverageGap>) -> Option<T>,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Option<Vec<SequenceDiscreteKey<T>>> {
    let (times, values) = (
        property(package, stream, "Times"),
        property(package, stream, "Values"),
    );
    if times.is_none() && values.is_none() {
        return None;
    }
    let (Some(PropertyValue::Array(times)), Some(PropertyValue::Array(values))) = (times, values)
    else {
        issue(
            section,
            field,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
        return None;
    };
    if times.len() != values.len() {
        issue(
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
        .enumerate()
        .map(|(i, (time, value))| {
            Some(SequenceDiscreteKey {
                frame: int(time)?,
                value: decode(value, &format!("{field}.Values[{i}]"), gaps)?,
            })
        })
        .collect::<Option<Vec<_>>>();
    if result.is_none() {
        issue(
            section,
            field,
            SequenceCoverageGapReason::WrongValueKind,
            gaps,
        );
    }
    result
}
