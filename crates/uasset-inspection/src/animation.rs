//! Saved animation inventory. No pose evaluation, external loads, or inferred CDO defaults.
use serde::Serialize;
use std::collections::HashMap;
use uasset_parser::asset::{
    AssetDecodeContext, DecodedAnimSequence, DecodedAsset, DecodedUObject, decode_export,
};
use uasset_parser::property::{PropertyStream, PropertyValue, RangeBoundKind};
use uasset_parser::{Package, PackageError};

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationOutput {
    pub schema_version: u8,
    pub status: &'static str,
    pub path: String,
    pub animations: Vec<AnimationSummary>,
    pub diagnostics: Vec<AnimationDiagnostic>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationDiagnostic {
    pub object_path: String,
    pub message: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationSummary {
    pub schema_version: u8,
    pub object_path: String,
    pub skeleton: Option<String>,
    pub data_model: Option<String>,
    pub data_model_class: Option<String>,
    pub duration_seconds: Option<f64>,
    pub rate_scale: Option<f64>,
    pub looping: Option<bool>,
    pub frame_rate: Option<AnimationFrameRate>,
    pub frame_count: Option<i32>,
    pub bone_tracks: Vec<AnimationBoneTrack>,
    pub curves: Vec<AnimationCurve>,
    pub notifies: Vec<AnimationNotify>,
    pub root_motion: AnimationRootMotion,
    pub coverage_gaps: Vec<AnimationCoverageGap>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationFrameRate {
    pub numerator: i32,
    pub denominator: i32,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationBoneTrack {
    pub name: String,
    pub property_path: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationCurve {
    pub name: String,
    pub kind: &'static str,
    pub key_count: Option<usize>,
    pub property_path: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationNotify {
    pub name: Option<String>,
    pub time_seconds: Option<f64>,
    pub duration_seconds: Option<f64>,
    pub track_index: Option<i32>,
    pub notify_object: Option<String>,
    pub notify_state_object: Option<String>,
    pub property_path: String,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationRootMotion {
    pub enabled: Option<bool>,
    pub root_lock: Option<String>,
    pub force_root_lock: Option<bool>,
    pub normalized_scale: Option<bool>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnimationGapReason {
    MissingSavedProperty,
    UndecodedValue,
    MissingExport,
    UnsupportedDataModel,
    UnsupportedTrack,
    InvalidValue,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AnimationCoverageGap {
    pub object_path: String,
    pub property_path: String,
    pub reason: AnimationGapReason,
}

pub fn inspect_animation_bytes(path: &str, bytes: &[u8]) -> Result<AnimationOutput, PackageError> {
    let package = Package::parse(bytes)?;
    let context = AssetDecodeContext {
        source: bytes,
        package: &package,
        schemas: uasset_parser::schema::embedded_source_model(),
    };
    let mut assets = Vec::new();
    let mut diagnostics = Vec::new();
    for export in &package.exports {
        match decode_export(export, &context) {
            Ok(Some(asset)) => assets.push(asset),
            Ok(None) => {}
            Err(error) => diagnostics.push(AnimationDiagnostic {
                object_path: export.object_path.to_string(),
                message: error.to_string(),
            }),
        }
    }
    let animations = project_animations(&package, &assets);
    let partial = !diagnostics.is_empty() || animations.iter().any(|a| !a.coverage_gaps.is_empty());
    Ok(AnimationOutput {
        schema_version: 1,
        status: if partial { "partial" } else { "complete" },
        path: path.into(),
        animations,
        diagnostics,
    })
}

pub fn project_animations(package: &Package, assets: &[DecodedAsset]) -> Vec<AnimationSummary> {
    let objects: HashMap<_, _> = assets
        .iter()
        .filter_map(|a| match a {
            DecodedAsset::UObject(o) => Some((o.object_path.as_str(), o)),
            _ => None,
        })
        .collect();
    assets
        .iter()
        .filter_map(|a| match a {
            DecodedAsset::AnimSequence(sequence) => Some(project(package, sequence, &objects)),
            _ => None,
        })
        .collect()
}

struct Context<'a> {
    package: &'a Package,
    owner: &'a str,
    gaps: Vec<AnimationCoverageGap>,
}
impl Context<'_> {
    fn gap(&mut self, path: &str, reason: AnimationGapReason) {
        self.gaps.push(AnimationCoverageGap {
            object_path: self.owner.into(),
            property_path: path.into(),
            reason,
        });
    }
    fn field<'a>(
        &mut self,
        stream: &'a PropertyStream,
        name: &str,
        path: &str,
    ) -> Option<&'a PropertyValue> {
        let value = property(self.package, stream, name);
        match value {
            None => self.gap(path, AnimationGapReason::MissingSavedProperty),
            Some(PropertyValue::Raw { .. }) => self.gap(path, AnimationGapReason::UndecodedValue),
            _ => {}
        }
        value
    }
    fn number(&mut self, stream: &PropertyStream, name: &str, path: &str) -> Option<f64> {
        match self.field(stream, name, path)? {
            PropertyValue::Float(v) if v.is_finite() => Some(f64::from(*v)),
            PropertyValue::Double(v) if v.is_finite() => Some(*v),
            _ => {
                self.gap(path, AnimationGapReason::InvalidValue);
                None
            }
        }
    }
    fn integer(&mut self, stream: &PropertyStream, name: &str, path: &str) -> Option<i32> {
        match self.field(stream, name, path)? {
            PropertyValue::Int(v) if i32::try_from(*v).is_ok() => Some(*v as i32),
            _ => {
                self.gap(path, AnimationGapReason::InvalidValue);
                None
            }
        }
    }
    fn boolean(&mut self, stream: &PropertyStream, name: &str) -> Option<bool> {
        match self.field(stream, name, name)? {
            PropertyValue::Bool(v) => Some(*v),
            _ => {
                self.gap(name, AnimationGapReason::InvalidValue);
                None
            }
        }
    }
    fn name(&mut self, stream: &PropertyStream, name: &str, path: &str) -> Option<String> {
        match self.field(stream, name, path)? {
            PropertyValue::Name(v) | PropertyValue::Enum(v) => self.package.resolve_name(*v),
            _ => {
                self.gap(path, AnimationGapReason::InvalidValue);
                None
            }
        }
    }
    fn reference(&mut self, stream: &PropertyStream, name: &str, path: &str) -> Option<String> {
        match self.field(stream, name, path)? {
            PropertyValue::ObjectRef(index) => {
                self.package.resolve_index_str(*index).map(str::to_owned)
            }
            _ => {
                self.gap(path, AnimationGapReason::InvalidValue);
                None
            }
        }
    }
    fn array<'a>(
        &mut self,
        stream: &'a PropertyStream,
        name: &str,
        path: &str,
    ) -> &'a [PropertyValue] {
        match self.field(stream, name, path) {
            Some(PropertyValue::Array(values)) => values,
            Some(_) => {
                self.gap(path, AnimationGapReason::InvalidValue);
                &[]
            }
            None => &[],
        }
    }
    fn frame_rate(&mut self, stream: &PropertyStream, name: &str) -> Option<AnimationFrameRate> {
        let PropertyValue::Struct(rate) = self.field(stream, name, name)? else {
            self.gap(name, AnimationGapReason::InvalidValue);
            return None;
        };
        let numerator = self.integer(rate, "Numerator", &format!("{name}.Numerator"))?;
        let denominator = self.integer(rate, "Denominator", &format!("{name}.Denominator"))?;
        if numerator <= 0 || denominator <= 0 {
            self.gap(name, AnimationGapReason::InvalidValue);
            return None;
        }
        Some(AnimationFrameRate {
            numerator,
            denominator,
        })
    }
}

fn project(
    package: &Package,
    sequence: &DecodedAnimSequence,
    objects: &HashMap<&str, &DecodedUObject>,
) -> AnimationSummary {
    let mut ctx = Context {
        package,
        owner: sequence.object_path.as_str(),
        gaps: Vec::new(),
    };
    let stream = &sequence.properties;
    let skeleton = ctx.reference(stream, "Skeleton", "Skeleton");
    let duration_seconds = ctx.number(stream, "SequenceLength", "SequenceLength");
    let rate_scale = ctx.number(stream, "RateScale", "RateScale");
    let looping = ctx.boolean(stream, "bLoop");
    let root_motion = AnimationRootMotion {
        enabled: ctx.boolean(stream, "bEnableRootMotion"),
        root_lock: ctx.name(stream, "RootMotionRootLock", "RootMotionRootLock"),
        force_root_lock: ctx.boolean(stream, "bForceRootLock"),
        normalized_scale: ctx.boolean(stream, "bUseNormalizedRootMotionScale"),
    };
    let mut notifies = Vec::new();
    for (index, value) in ctx.array(stream, "Notifies", "Notifies").iter().enumerate() {
        let path = format!("Notifies[{index}]");
        let PropertyValue::Struct(notify) = value else {
            ctx.gap(&path, AnimationGapReason::UndecodedValue);
            continue;
        };
        let method = ctx.name(
            notify,
            "CachedLinkMethod",
            &format!("{path}.CachedLinkMethod"),
        );
        let time_seconds = if method.as_deref() == Some("EAnimLinkMethod::Absolute") {
            ctx.number(notify, "LinkValue", &format!("{path}.LinkValue"))
        } else {
            ctx.gap(&path, AnimationGapReason::InvalidValue);
            None
        };
        notifies.push(AnimationNotify {
            name: ctx.name(notify, "NotifyName", &format!("{path}.NotifyName")),
            time_seconds,
            duration_seconds: ctx.number(notify, "Duration", &format!("{path}.Duration")),
            track_index: ctx.integer(notify, "TrackIndex", &format!("{path}.TrackIndex")),
            notify_object: ctx.reference(notify, "Notify", &format!("{path}.Notify")),
            notify_state_object: ctx.reference(
                notify,
                "NotifyStateClass",
                &format!("{path}.NotifyStateClass"),
            ),
            property_path: path,
        });
    }
    let model_field = if property(package, stream, "DataModelInterface").is_some() {
        "DataModelInterface"
    } else {
        "DataModel"
    };
    let data_model = ctx.reference(stream, model_field, model_field);
    let mut summary = AnimationSummary {
        schema_version: 1,
        object_path: sequence.object_path.to_string(),
        skeleton,
        data_model,
        data_model_class: None,
        duration_seconds,
        rate_scale,
        looping,
        frame_rate: None,
        frame_count: None,
        bone_tracks: Vec::new(),
        curves: Vec::new(),
        notifies,
        root_motion,
        coverage_gaps: Vec::new(),
    };
    if let Some(model) = summary
        .data_model
        .as_deref()
        .and_then(|path| objects.get(path))
        .copied()
    {
        summary.data_model_class = Some(model.class_path.to_string());
        ctx.owner = model.object_path.as_str();
        match model.class_path.as_str() {
            "/Script/AnimationData.AnimationSequencerDataModel" => {
                sequencer_model(&mut ctx, model, objects, &mut summary)
            }
            _ => ctx.gap("$model", AnimationGapReason::UnsupportedDataModel),
        }
    } else {
        ctx.gap(model_field, AnimationGapReason::MissingExport);
    }
    summary.coverage_gaps = ctx.gaps;
    summary
}

fn sequencer_model<'a>(
    ctx: &mut Context<'a>,
    model: &'a DecodedUObject,
    objects: &HashMap<&str, &'a DecodedUObject>,
    summary: &mut AnimationSummary,
) {
    let scene = ctx
        .reference(&model.properties, "MovieScene", "MovieScene")
        .and_then(|p| objects.get(p.as_str()).copied());
    let Some(scene) = scene else {
        ctx.gap("MovieScene", AnimationGapReason::MissingExport);
        return;
    };
    ctx.owner = scene.object_path.as_str();
    summary.frame_rate = ctx.frame_rate(&scene.properties, "DisplayRate");
    if let Some(PropertyValue::FrameRange(range)) =
        ctx.field(&scene.properties, "PlaybackRange", "PlaybackRange")
    {
        summary.frame_count = match range.upper.kind {
            RangeBoundKind::Inclusive => Some(range.upper.value),
            RangeBoundKind::Exclusive => range.upper.value.checked_sub(1).map(|v| v.max(1)),
            RangeBoundKind::Open => None,
        };
        if summary.frame_count.is_none_or(|v| v < 0) {
            summary.frame_count = None;
            ctx.gap("PlaybackRange", AnimationGapReason::InvalidValue);
        }
    } else {
        ctx.gap("PlaybackRange", AnimationGapReason::InvalidValue);
    }
    let tracks = ctx.array(&scene.properties, "Tracks", "Tracks");
    for value in tracks {
        ctx.owner = scene.object_path.as_str();
        let track = resolve_object(ctx.package, value, objects);
        let Some(track) = track else {
            ctx.gap("Tracks", AnimationGapReason::MissingExport);
            continue;
        };
        if track.class_path.as_str() != "/Script/ControlRig.MovieSceneControlRigParameterTrack" {
            ctx.gap("Tracks", AnimationGapReason::UnsupportedTrack);
            continue;
        }
        ctx.owner = track.object_path.as_str();
        let mut found = false;
        for value in ctx.array(&track.properties, "Sections", "Sections") {
            ctx.owner = track.object_path.as_str();
            let Some(section) = resolve_object(ctx.package, value, objects) else {
                ctx.gap("Sections", AnimationGapReason::MissingExport);
                continue;
            };
            ctx.owner = section.object_path.as_str();
            if section.class_path.as_str()
                != "/Script/ControlRig.MovieSceneControlRigParameterSection"
            {
                ctx.gap("$section", AnimationGapReason::UnsupportedTrack);
                continue;
            }
            let rig = ctx
                .reference(&section.properties, "ControlRig", "ControlRig")
                .and_then(|p| objects.get(p.as_str()).copied());
            if rig.is_none_or(|rig| rig.class_path.as_str() != "/Script/ControlRig.FKControlRig") {
                ctx.gap("ControlRig", AnimationGapReason::UnsupportedTrack);
                continue;
            }
            found = true;
            for (index, value) in ctx
                .array(
                    &section.properties,
                    "TransformParameterNamesAndCurves",
                    "TransformParameterNamesAndCurves",
                )
                .iter()
                .enumerate()
            {
                let path = format!("TransformParameterNamesAndCurves[{index}]");
                let PropertyValue::Struct(fields) = value else {
                    ctx.gap(&path, AnimationGapReason::UndecodedValue);
                    continue;
                };
                if let Some(name) = ctx.name(fields, "ParameterName", &path) {
                    summary.bone_tracks.push(AnimationBoneTrack {
                        name: control_target(&name, "_CONTROL"),
                        property_path: format!("{}.{}", section.object_path, path),
                    });
                }
            }
            for (index, value) in ctx
                .array(
                    &section.properties,
                    "ScalarParameterNamesAndCurves",
                    "ScalarParameterNamesAndCurves",
                )
                .iter()
                .enumerate()
            {
                let path = format!("ScalarParameterNamesAndCurves[{index}]");
                let PropertyValue::Struct(fields) = value else {
                    ctx.gap(&path, AnimationGapReason::UndecodedValue);
                    continue;
                };
                if let Some(name) = ctx.name(fields, "ParameterName", &path) {
                    let key_count = match ctx.field(
                        fields,
                        "ParameterCurve",
                        &format!("{path}.ParameterCurve"),
                    ) {
                        Some(PropertyValue::NativeStruct { fields }) => fields
                            .iter()
                            .find(|f| f.name == "Times")
                            .and_then(|f| match &f.value {
                                PropertyValue::Array(values) => Some(values.len()),
                                _ => None,
                            }),
                        _ => None,
                    };
                    if key_count.is_none() {
                        ctx.gap(&path, AnimationGapReason::UndecodedValue);
                    }
                    summary.curves.push(AnimationCurve {
                        name: control_target(&name, "_CURVE_CONTROL"),
                        kind: "float",
                        key_count,
                        property_path: format!("{}.{}", section.object_path, path),
                    });
                }
            }
            // Unreal uses the first FK section of the first ControlRig track.
            break;
        }
        if !found {
            ctx.gap("Sections", AnimationGapReason::MissingExport);
        }
        return;
    }
    ctx.owner = scene.object_path.as_str();
    ctx.gap("Tracks", AnimationGapReason::MissingExport);
}

fn property<'a>(
    package: &Package,
    stream: &'a PropertyStream,
    name: &str,
) -> Option<&'a PropertyValue> {
    stream
        .records
        .iter()
        .find(|r| r.array_index == 0 && package.resolve_name_str(r.name) == Some(name))
        .map(|r| &r.value)
}
fn resolve_object<'a>(
    package: &Package,
    value: &PropertyValue,
    objects: &HashMap<&str, &'a DecodedUObject>,
) -> Option<&'a DecodedUObject> {
    let PropertyValue::ObjectRef(index) = value else {
        return None;
    };
    objects.get(package.resolve_index_str(*index)?).copied()
}
fn control_target(name: &str, suffix: &str) -> String {
    name.split_once(suffix)
        .map_or(name, |(base, _)| base)
        .to_owned()
}
