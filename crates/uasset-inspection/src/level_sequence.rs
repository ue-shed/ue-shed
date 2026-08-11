//! Compact, evaluator-independent projection of saved Level Sequence timelines.
//!
//! This module joins the reflected `LevelSequence -> MovieScene -> binding -> track -> section`
//! export graph. It does not attempt to reproduce Sequencer evaluation, blending, or runtime
//! object binding.

use serde::Serialize;
use uasset_parser::asset::{DecodedAsset, DecodedUObject};
use uasset_parser::package::{Package, PackageIndex};
use uasset_parser::property::{
    FrameRangeValue, PropertyStream, PropertyValue, RangeBoundKind, TextHistory, TextValue,
};

pub const LEVEL_SEQUENCE_CLASS: &str = "/Script/LevelSequence.LevelSequence";
pub const MOVIE_SCENE_CLASS: &str = "/Script/MovieScene.MovieScene";
pub const TEXT_TRACK_CLASS: &str = "/Script/MovieSceneTracks.MovieSceneTextTrack";
pub const TEXT_SECTION_CLASS: &str = "/Script/MovieSceneTracks.MovieSceneTextSection";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LevelSequenceProjection {
    pub schema_version: u8,
    pub object_path: String,
    pub movie_scene_path: Option<String>,
    pub tick_resolution: Option<SequenceFrameRate>,
    pub display_rate: Option<SequenceFrameRate>,
    pub playback_range: Option<SequenceFrameRange>,
    pub bindings: Vec<SequenceBinding>,
    pub root_tracks: Vec<SequenceTrack>,
    pub coverage_gaps: Vec<SequenceCoverageGap>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceFrameRate {
    pub numerator: i64,
    pub denominator: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceFrameRange {
    pub lower: SequenceFrameBound,
    pub upper: SequenceFrameBound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceFrameBound {
    pub kind: SequenceFrameBoundKind,
    pub frame: i32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceFrameBoundKind {
    Exclusive,
    Inclusive,
    Open,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SequenceBinding {
    pub id: String,
    pub name: Option<String>,
    pub possessed_object_class: Option<String>,
    pub tracks: Vec<SequenceTrack>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SequenceTrack {
    pub object_path: String,
    pub class_path: String,
    pub property_path: Option<String>,
    pub content: SequenceTrackContent,
    pub sections: Vec<SequenceSection>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceTrackContent {
    TimedText,
    StructureOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SequenceSection {
    pub object_path: String,
    pub class_path: String,
    pub range: Option<SequenceFrameRange>,
    pub text_keys: Vec<SequenceTextKey>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceTextKey {
    pub frame: i64,
    pub source: String,
    pub identity: SequenceTextIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SequenceTextIdentity {
    Resolved { namespace: String, key: String },
    Unresolved,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceCoverageGap {
    pub object_path: String,
    pub property_path: String,
    pub reason: SequenceCoverageGapReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceCoverageGapReason {
    MissingReference,
    WrongValueKind,
    MismatchedChannelLengths,
    UnsupportedTrackContent,
}

/// Projects the first saved `ULevelSequence` export in a package.
///
/// All tracks and sections remain visible. Text tracks receive timed localized values; other track
/// classes are retained as structural inventory and produce an explicit coverage gap.
#[must_use]
pub fn project_level_sequence(
    package: &Package,
    assets: &[DecodedAsset],
) -> Option<LevelSequenceProjection> {
    let sequence =
        objects(assets).find(|object| object.class_path.as_str() == LEVEL_SEQUENCE_CLASS)?;
    let mut projection = LevelSequenceProjection {
        schema_version: 1,
        object_path: sequence.object_path.to_string(),
        movie_scene_path: None,
        tick_resolution: None,
        display_rate: None,
        playback_range: None,
        bindings: Vec::new(),
        root_tracks: Vec::new(),
        coverage_gaps: Vec::new(),
    };

    let Some(movie_scene_path) = object_reference(package, &sequence.properties, "MovieScene")
    else {
        gap(
            &mut projection,
            sequence.object_path.as_str(),
            "MovieScene",
            SequenceCoverageGapReason::MissingReference,
        );
        return Some(projection);
    };
    projection.movie_scene_path = Some(movie_scene_path.clone());
    let Some(movie_scene) = object_at_path(assets, &movie_scene_path) else {
        gap(
            &mut projection,
            sequence.object_path.as_str(),
            "MovieScene",
            SequenceCoverageGapReason::MissingReference,
        );
        return Some(projection);
    };

    projection.tick_resolution = frame_rate(package, &movie_scene.properties, "TickResolution");
    projection.display_rate = frame_rate(package, &movie_scene.properties, "DisplayRate");
    projection.playback_range = frame_range(package, &movie_scene.properties, "PlaybackRange");

    let possessables = possessable_metadata(package, &movie_scene.properties);
    if let Some(PropertyValue::Array(bindings)) =
        property(package, &movie_scene.properties, "ObjectBindings")
    {
        for binding in bindings {
            let PropertyValue::Struct(binding) = binding else {
                gap(
                    &mut projection,
                    movie_scene.object_path.as_str(),
                    "ObjectBindings",
                    SequenceCoverageGapReason::WrongValueKind,
                );
                continue;
            };
            let Some(id) = guid(package, binding, "ObjectGuid") else {
                gap(
                    &mut projection,
                    movie_scene.object_path.as_str(),
                    "ObjectBindings.ObjectGuid",
                    SequenceCoverageGapReason::WrongValueKind,
                );
                continue;
            };
            let metadata = possessables.iter().find(|candidate| candidate.id == id);
            let tracks = project_track_references(
                package,
                assets,
                binding,
                movie_scene.object_path.as_str(),
                &mut projection.coverage_gaps,
            );
            projection.bindings.push(SequenceBinding {
                id,
                name: metadata.and_then(|value| value.name.clone()),
                possessed_object_class: metadata.and_then(|value| value.object_class.clone()),
                tracks,
            });
        }
    }

    projection.root_tracks = project_named_track_array(
        package,
        assets,
        &movie_scene.properties,
        "Tracks",
        movie_scene.object_path.as_str(),
        &mut projection.coverage_gaps,
    );
    Some(projection)
}

#[derive(Clone)]
struct PossessableMetadata {
    id: String,
    name: Option<String>,
    object_class: Option<String>,
}

fn possessable_metadata(
    package: &Package,
    properties: &PropertyStream,
) -> Vec<PossessableMetadata> {
    let Some(PropertyValue::Array(possessables)) = property(package, properties, "Possessables")
    else {
        return Vec::new();
    };
    possessables
        .iter()
        .filter_map(|value| {
            let PropertyValue::Struct(value) = value else {
                return None;
            };
            Some(PossessableMetadata {
                id: guid(package, value, "Guid")?,
                name: string(package, value, "Name"),
                object_class: soft_object_path(package, value, "PossessedObjectClass"),
            })
        })
        .collect()
}

fn project_track_references(
    package: &Package,
    assets: &[DecodedAsset],
    binding: &PropertyStream,
    owner_path: &str,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceTrack> {
    project_named_track_array(package, assets, binding, "Tracks", owner_path, gaps)
}

fn project_named_track_array(
    package: &Package,
    assets: &[DecodedAsset],
    properties: &PropertyStream,
    property_name: &str,
    owner_path: &str,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceTrack> {
    let Some(value) = property(package, properties, property_name) else {
        return Vec::new();
    };
    let PropertyValue::Array(references) = value else {
        gaps.push(SequenceCoverageGap {
            object_path: owner_path.to_owned(),
            property_path: property_name.to_owned(),
            reason: SequenceCoverageGapReason::WrongValueKind,
        });
        return Vec::new();
    };
    references
        .iter()
        .filter_map(|reference| {
            let PropertyValue::ObjectRef(index) = reference else {
                gaps.push(SequenceCoverageGap {
                    object_path: owner_path.to_owned(),
                    property_path: property_name.to_owned(),
                    reason: SequenceCoverageGapReason::WrongValueKind,
                });
                return None;
            };
            let Some(path) = resolve_object(package, *index) else {
                gaps.push(SequenceCoverageGap {
                    object_path: owner_path.to_owned(),
                    property_path: property_name.to_owned(),
                    reason: SequenceCoverageGapReason::MissingReference,
                });
                return None;
            };
            let Some(track) = object_at_path(assets, &path) else {
                gaps.push(SequenceCoverageGap {
                    object_path: owner_path.to_owned(),
                    property_path: property_name.to_owned(),
                    reason: SequenceCoverageGapReason::MissingReference,
                });
                return None;
            };
            Some(project_track(package, assets, track, gaps))
        })
        .collect()
}

fn project_track(
    package: &Package,
    assets: &[DecodedAsset],
    track: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceTrack {
    let supports_text = track.class_path.as_str() == TEXT_TRACK_CLASS;
    if !supports_text {
        gaps.push(SequenceCoverageGap {
            object_path: track.object_path.to_string(),
            property_path: "Sections".to_owned(),
            reason: SequenceCoverageGapReason::UnsupportedTrackContent,
        });
    }
    let property_path = property(package, &track.properties, "PropertyBinding").and_then(|value| {
        let PropertyValue::Struct(binding) = value else {
            return None;
        };
        name(package, binding, "PropertyPath")
    });
    let sections = object_reference_array(package, &track.properties, "Sections")
        .into_iter()
        .filter_map(|path| {
            let section = object_at_path(assets, &path);
            if section.is_none() {
                gaps.push(SequenceCoverageGap {
                    object_path: track.object_path.to_string(),
                    property_path: "Sections".to_owned(),
                    reason: SequenceCoverageGapReason::MissingReference,
                });
            }
            section.map(|section| project_section(package, section, supports_text, gaps))
        })
        .collect();
    SequenceTrack {
        object_path: track.object_path.to_string(),
        class_path: track.class_path.to_string(),
        property_path,
        content: if supports_text {
            SequenceTrackContent::TimedText
        } else {
            SequenceTrackContent::StructureOnly
        },
        sections,
    }
}

fn project_section(
    package: &Package,
    section: &DecodedUObject,
    supports_text: bool,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceSection {
    let range = frame_range(package, &section.properties, "SectionRange");
    let text_keys = if supports_text && section.class_path.as_str() == TEXT_SECTION_CLASS {
        text_keys(package, section, gaps)
    } else {
        Vec::new()
    };
    SequenceSection {
        object_path: section.object_path.to_string(),
        class_path: section.class_path.to_string(),
        range,
        text_keys,
    }
}

fn text_keys(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Vec<SequenceTextKey> {
    let Some(PropertyValue::Struct(channel)) =
        property(package, &section.properties, "TextChannel")
    else {
        gaps.push(SequenceCoverageGap {
            object_path: section.object_path.to_string(),
            property_path: "TextChannel".to_owned(),
            reason: SequenceCoverageGapReason::WrongValueKind,
        });
        return Vec::new();
    };
    let times = match property(package, channel, "Times") {
        Some(PropertyValue::Array(values)) => values,
        _ => {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "TextChannel.Times".to_owned(),
                reason: SequenceCoverageGapReason::WrongValueKind,
            });
            return Vec::new();
        }
    };
    let values = match property(package, channel, "Values") {
        Some(PropertyValue::Array(values)) => values,
        _ => {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "TextChannel.Values".to_owned(),
                reason: SequenceCoverageGapReason::WrongValueKind,
            });
            return Vec::new();
        }
    };
    if times.len() != values.len() {
        gaps.push(SequenceCoverageGap {
            object_path: section.object_path.to_string(),
            property_path: "TextChannel".to_owned(),
            reason: SequenceCoverageGapReason::MismatchedChannelLengths,
        });
    }
    times
        .iter()
        .zip(values)
        .filter_map(|(time, value)| {
            let PropertyValue::Int(frame) = time else {
                return None;
            };
            let PropertyValue::Text(text) = value else {
                return None;
            };
            Some(SequenceTextKey {
                frame: *frame,
                source: text.source.clone(),
                identity: text_identity(text),
            })
        })
        .collect()
}

fn text_identity(text: &TextValue) -> SequenceTextIdentity {
    match &text.history {
        TextHistory::Base { namespace, key } if !key.is_empty() => SequenceTextIdentity::Resolved {
            namespace: namespace.clone(),
            key: key.clone(),
        },
        _ => SequenceTextIdentity::Unresolved,
    }
}

fn objects(assets: &[DecodedAsset]) -> impl Iterator<Item = &DecodedUObject> {
    assets.iter().filter_map(|asset| match asset {
        DecodedAsset::UObject(object) => Some(object),
        _ => None,
    })
}

fn object_at_path<'a>(assets: &'a [DecodedAsset], path: &str) -> Option<&'a DecodedUObject> {
    objects(assets).find(|object| object.object_path.as_str() == path)
}

fn property<'a>(
    package: &Package,
    stream: &'a PropertyStream,
    name: &str,
) -> Option<&'a PropertyValue> {
    stream.records.iter().find_map(|record| {
        (package.resolve_name_str(record.name) == Some(name)).then_some(&record.value)
    })
}

fn object_reference(package: &Package, stream: &PropertyStream, name: &str) -> Option<String> {
    let PropertyValue::ObjectRef(index) = property(package, stream, name)? else {
        return None;
    };
    resolve_object(package, *index)
}

fn object_reference_array(package: &Package, stream: &PropertyStream, name: &str) -> Vec<String> {
    let Some(PropertyValue::Array(values)) = property(package, stream, name) else {
        return Vec::new();
    };
    values
        .iter()
        .filter_map(|value| {
            let PropertyValue::ObjectRef(index) = value else {
                return None;
            };
            resolve_object(package, *index)
        })
        .collect()
}

fn resolve_object(package: &Package, index: PackageIndex) -> Option<String> {
    (index != PackageIndex::Null)
        .then(|| package.resolve_index_str(index).map(str::to_owned))
        .flatten()
}

fn guid(package: &Package, stream: &PropertyStream, property_name: &str) -> Option<String> {
    let PropertyValue::Guid(value) = property(package, stream, property_name)? else {
        return None;
    };
    Some(value.to_string())
}

fn string(package: &Package, stream: &PropertyStream, property_name: &str) -> Option<String> {
    let PropertyValue::String(value) = property(package, stream, property_name)? else {
        return None;
    };
    Some(value.clone())
}

fn name(package: &Package, stream: &PropertyStream, property_name: &str) -> Option<String> {
    let PropertyValue::Name(value) = property(package, stream, property_name)? else {
        return None;
    };
    package.resolve_name(*value)
}

fn soft_object_path(
    package: &Package,
    stream: &PropertyStream,
    property_name: &str,
) -> Option<String> {
    let PropertyValue::SoftObjectPath(value) = property(package, stream, property_name)? else {
        return None;
    };
    Some(value.clone())
}

fn frame_rate(
    package: &Package,
    stream: &PropertyStream,
    property_name: &str,
) -> Option<SequenceFrameRate> {
    let PropertyValue::Struct(value) = property(package, stream, property_name)? else {
        return None;
    };
    let numerator = integer(package, value, "Numerator")?;
    let denominator = integer(package, value, "Denominator").unwrap_or(1);
    Some(SequenceFrameRate {
        numerator,
        denominator,
    })
}

fn integer(package: &Package, stream: &PropertyStream, property_name: &str) -> Option<i64> {
    match property(package, stream, property_name)? {
        PropertyValue::Int(value) => Some(*value),
        PropertyValue::UInt(value) => i64::try_from(*value).ok(),
        _ => None,
    }
}

fn frame_range(
    package: &Package,
    stream: &PropertyStream,
    property_name: &str,
) -> Option<SequenceFrameRange> {
    let PropertyValue::FrameRange(value) = property(package, stream, property_name)? else {
        return None;
    };
    Some(sequence_frame_range(*value))
}

fn sequence_frame_range(value: FrameRangeValue) -> SequenceFrameRange {
    SequenceFrameRange {
        lower: SequenceFrameBound {
            kind: bound_kind(value.lower.kind),
            frame: value.lower.value,
        },
        upper: SequenceFrameBound {
            kind: bound_kind(value.upper.kind),
            frame: value.upper.value,
        },
    }
}

const fn bound_kind(value: RangeBoundKind) -> SequenceFrameBoundKind {
    match value {
        RangeBoundKind::Exclusive => SequenceFrameBoundKind::Exclusive,
        RangeBoundKind::Inclusive => SequenceFrameBoundKind::Inclusive,
        RangeBoundKind::Open => SequenceFrameBoundKind::Open,
    }
}

fn gap(
    projection: &mut LevelSequenceProjection,
    object_path: &str,
    property_path: &str,
    reason: SequenceCoverageGapReason,
) {
    projection.coverage_gaps.push(SequenceCoverageGap {
        object_path: object_path.to_owned(),
        property_path: property_path.to_owned(),
        reason,
    });
}
