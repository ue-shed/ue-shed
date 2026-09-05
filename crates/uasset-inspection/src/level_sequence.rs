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
pub const SUB_SEQUENCE_TRACK_CLASS: &str = "/Script/MovieScene.MovieSceneSubTrack";
pub const SUB_SEQUENCE_SECTION_CLASS: &str = "/Script/MovieScene.MovieSceneSubSection";
pub const CINEMATIC_SHOT_TRACK_CLASS: &str =
    "/Script/MovieSceneTracks.MovieSceneCinematicShotTrack";
pub const CINEMATIC_SHOT_SECTION_CLASS: &str =
    "/Script/MovieSceneTracks.MovieSceneCinematicShotSection";
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
    /// Every decoded path-bearing property value in this asset package.
    pub references: Vec<SequenceReference>,
    /// Places where undecoded evidence prevents a complete reference inventory.
    pub reference_coverage_gaps: Vec<SequenceReferenceCoverageGap>,
    pub coverage_gaps: Vec<SequenceCoverageGap>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceReference {
    pub owner_path: String,
    pub owner_class_path: String,
    pub property_path: String,
    pub kind: SequenceReferenceKind,
    pub target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_row: Option<String>,
    pub scope: SequenceReferenceScope,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceReferenceKind {
    Object,
    SoftObject,
    DataTableRowHandle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceReferenceScope {
    Internal,
    External,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SequenceReferenceCoverageGap {
    pub owner_path: String,
    pub property_path: String,
    pub reason: SequenceReferenceCoverageGapReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SequenceReferenceCoverageGapReason {
    RawPropertyValue,
    NativeObjectTail,
    UnresolvedObjectReference,
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
    SubSequence,
    CinematicShot,
    StructureOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SequenceSection {
    pub object_path: String,
    pub class_path: String,
    pub range: Option<SequenceFrameRange>,
    pub sequence_path: Option<String>,
    pub shot_display_name: Option<String>,
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
    let (references, reference_coverage_gaps) = inventory_references(package, assets);
    let mut projection = LevelSequenceProjection {
        schema_version: 3,
        object_path: sequence.object_path.to_string(),
        movie_scene_path: None,
        tick_resolution: None,
        display_rate: None,
        playback_range: None,
        bindings: Vec::new(),
        root_tracks: Vec::new(),
        references,
        reference_coverage_gaps,
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

fn inventory_references(
    package: &Package,
    assets: &[DecodedAsset],
) -> (Vec<SequenceReference>, Vec<SequenceReferenceCoverageGap>) {
    let mut references = Vec::new();
    let mut gaps = Vec::new();
    for object in objects(assets) {
        inventory_property_stream(
            package,
            object,
            &object.properties,
            "",
            &mut references,
            &mut gaps,
        );
        if !object.tail.is_empty() {
            gaps.push(SequenceReferenceCoverageGap {
                owner_path: object.object_path.to_string(),
                property_path: "$native_tail".to_owned(),
                reason: SequenceReferenceCoverageGapReason::NativeObjectTail,
            });
        }
    }
    (references, gaps)
}

fn inventory_property_stream(
    package: &Package,
    owner: &DecodedUObject,
    stream: &PropertyStream,
    parent_path: &str,
    references: &mut Vec<SequenceReference>,
    gaps: &mut Vec<SequenceReferenceCoverageGap>,
) {
    for record in &stream.records {
        let name = package
            .resolve_name(record.name)
            .unwrap_or_else(|| "<unresolved_name>".to_owned());
        let path = join_property_path(parent_path, &name);
        inventory_property_value(package, owner, &path, &record.value, references, gaps);
    }
}

fn inventory_property_value(
    package: &Package,
    owner: &DecodedUObject,
    property_path: &str,
    value: &PropertyValue,
    references: &mut Vec<SequenceReference>,
    gaps: &mut Vec<SequenceReferenceCoverageGap>,
) {
    match value {
        PropertyValue::ObjectRef(index) => inventory_index_reference(
            package,
            owner,
            property_path,
            *index,
            SequenceReferenceKind::Object,
            None,
            references,
            gaps,
        ),
        PropertyValue::SoftObjectPath(target_path) if !target_path.is_empty() => {
            references.push(SequenceReference {
                owner_path: owner.object_path.to_string(),
                owner_class_path: owner.class_path.to_string(),
                property_path: property_path.to_owned(),
                kind: SequenceReferenceKind::SoftObject,
                target_path: target_path.clone(),
                target_row: None,
                scope: soft_reference_scope(package, target_path),
            });
        }
        PropertyValue::DataTableRowHandle(handle) => inventory_index_reference(
            package,
            owner,
            property_path,
            handle.table,
            SequenceReferenceKind::DataTableRowHandle,
            package.resolve_name(handle.row_name),
            references,
            gaps,
        ),
        PropertyValue::Array(values) | PropertyValue::Set(values) => {
            for (index, value) in values.iter().enumerate() {
                inventory_property_value(
                    package,
                    owner,
                    &format!("{property_path}[{index}]"),
                    value,
                    references,
                    gaps,
                );
            }
        }
        PropertyValue::Map(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                inventory_property_value(
                    package,
                    owner,
                    &format!("{property_path}[{index}].key"),
                    &entry.key,
                    references,
                    gaps,
                );
                inventory_property_value(
                    package,
                    owner,
                    &format!("{property_path}[{index}].value"),
                    &entry.value,
                    references,
                    gaps,
                );
            }
        }
        PropertyValue::Struct(stream) => {
            inventory_property_stream(package, owner, stream, property_path, references, gaps)
        }
        PropertyValue::Raw { .. } => gaps.push(SequenceReferenceCoverageGap {
            owner_path: owner.object_path.to_string(),
            property_path: property_path.to_owned(),
            reason: SequenceReferenceCoverageGapReason::RawPropertyValue,
        }),
        _ => {}
    }
}

#[allow(clippy::too_many_arguments)]
fn inventory_index_reference(
    package: &Package,
    owner: &DecodedUObject,
    property_path: &str,
    index: PackageIndex,
    kind: SequenceReferenceKind,
    target_row: Option<String>,
    references: &mut Vec<SequenceReference>,
    gaps: &mut Vec<SequenceReferenceCoverageGap>,
) {
    if index == PackageIndex::Null {
        return;
    }
    let Some(target_path) = package.resolve_index_str(index) else {
        gaps.push(SequenceReferenceCoverageGap {
            owner_path: owner.object_path.to_string(),
            property_path: property_path.to_owned(),
            reason: SequenceReferenceCoverageGapReason::UnresolvedObjectReference,
        });
        return;
    };
    references.push(SequenceReference {
        owner_path: owner.object_path.to_string(),
        owner_class_path: owner.class_path.to_string(),
        property_path: property_path.to_owned(),
        kind,
        target_path: target_path.to_owned(),
        target_row,
        scope: match index {
            PackageIndex::Export(_) => SequenceReferenceScope::Internal,
            PackageIndex::Import(_) => SequenceReferenceScope::External,
            PackageIndex::Null => unreachable!("null references return before resolution"),
        },
    });
}

fn soft_reference_scope(package: &Package, target_path: &str) -> SequenceReferenceScope {
    let package_name = package.summary.package_name.as_str();
    if target_path == package_name
        || target_path
            .strip_prefix(package_name)
            .is_some_and(|suffix| suffix.starts_with('.') || suffix.starts_with(':'))
    {
        SequenceReferenceScope::Internal
    } else {
        SequenceReferenceScope::External
    }
}

fn join_property_path(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}.{name}")
    }
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
    let content = match track.class_path.as_str() {
        TEXT_TRACK_CLASS => SequenceTrackContent::TimedText,
        SUB_SEQUENCE_TRACK_CLASS => SequenceTrackContent::SubSequence,
        CINEMATIC_SHOT_TRACK_CLASS => SequenceTrackContent::CinematicShot,
        _ => SequenceTrackContent::StructureOnly,
    };
    if content == SequenceTrackContent::StructureOnly {
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
            section.map(|section| project_section(package, section, content, gaps))
        })
        .collect();
    SequenceTrack {
        object_path: track.object_path.to_string(),
        class_path: track.class_path.to_string(),
        property_path,
        content,
        sections,
    }
}

fn project_section(
    package: &Package,
    section: &DecodedUObject,
    content: SequenceTrackContent,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> SequenceSection {
    let range = frame_range(package, &section.properties, "SectionRange");
    let text_keys = if content == SequenceTrackContent::TimedText
        && section.class_path.as_str() == TEXT_SECTION_CLASS
    {
        text_keys(package, section, gaps)
    } else {
        Vec::new()
    };
    let sequence_path = if matches!(
        content,
        SequenceTrackContent::SubSequence | SequenceTrackContent::CinematicShot
    ) {
        section_sequence_path(package, section, gaps)
    } else {
        None
    };
    let shot_display_name = if content == SequenceTrackContent::CinematicShot {
        string(package, &section.properties, "ShotDisplayName")
    } else {
        None
    };
    SequenceSection {
        object_path: section.object_path.to_string(),
        class_path: section.class_path.to_string(),
        range,
        sequence_path,
        shot_display_name,
        text_keys,
    }
}

fn section_sequence_path(
    package: &Package,
    section: &DecodedUObject,
    gaps: &mut Vec<SequenceCoverageGap>,
) -> Option<String> {
    match property(package, &section.properties, "SubSequence") {
        Some(PropertyValue::ObjectRef(index)) => resolve_object(package, *index).or_else(|| {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "SubSequence".to_owned(),
                reason: SequenceCoverageGapReason::MissingReference,
            });
            None
        }),
        Some(_) => {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "SubSequence".to_owned(),
                reason: SequenceCoverageGapReason::WrongValueKind,
            });
            None
        }
        None => {
            gaps.push(SequenceCoverageGap {
                object_path: section.object_path.to_string(),
                property_path: "SubSequence".to_owned(),
                reason: SequenceCoverageGapReason::MissingReference,
            });
            None
        }
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

#[cfg(test)]
mod tests {
    use std::fs;

    use uasset_parser::asset::{AssetDecodeContext, decode_export};
    use uasset_parser::property::{DataTableRowHandleValue, MapEntry, RawReason};

    use super::*;

    #[test]
    fn inventories_references_recursively_through_every_container_kind() {
        let bytes = fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/unreal-project/Content/Fixture/Sequences/LS_TextTimeline.uasset"
        ))
        .expect("fixture package");
        let package = Package::parse(&bytes).expect("fixture parses");
        let context = AssetDecodeContext {
            source: &bytes,
            package: &package,
        };
        let assets: Vec<_> = package
            .exports
            .iter()
            .filter_map(|export| decode_export(export, &context).ok().flatten())
            .collect();
        let owner = objects(&assets).next().expect("decoded sequence object");
        let mut nested_record = owner.properties.records[0].clone();
        nested_record.value = PropertyValue::DataTableRowHandle(DataTableRowHandleValue {
            table: PackageIndex::Import(0),
            row_name: nested_record.name,
        });
        let synthetic = PropertyValue::Array(vec![
            PropertyValue::Map(vec![MapEntry {
                key: PropertyValue::SoftObjectPath("/Game/Other/DA_Config.DA_Config".to_owned()),
                value: PropertyValue::Struct(PropertyStream {
                    class_extensions: None,
                    records: vec![nested_record],
                    terminator: Default::default(),
                }),
            }]),
            PropertyValue::Set(vec![PropertyValue::ObjectRef(PackageIndex::Export(0))]),
        ]);
        let mut references = Vec::new();
        let mut gaps = Vec::new();

        inventory_property_value(
            &package,
            owner,
            "Synthetic",
            &synthetic,
            &mut references,
            &mut gaps,
        );

        assert_eq!(references.len(), 3);
        assert_eq!(references[0].property_path, "Synthetic[0][0].key");
        assert_eq!(references[0].kind, SequenceReferenceKind::SoftObject);
        assert_eq!(references[0].scope, SequenceReferenceScope::External);
        assert_eq!(
            references[1].property_path,
            "Synthetic[0][0].value.MovieScene"
        );
        assert_eq!(
            references[1].kind,
            SequenceReferenceKind::DataTableRowHandle
        );
        assert_eq!(references[1].target_row.as_deref(), Some("MovieScene"));
        assert_eq!(references[2].property_path, "Synthetic[1][0]");
        assert_eq!(references[2].scope, SequenceReferenceScope::Internal);
        assert!(gaps.is_empty());

        inventory_property_value(
            &package,
            owner,
            "Opaque",
            &PropertyValue::Raw {
                reason: RawReason::UnsupportedType,
            },
            &mut references,
            &mut gaps,
        );
        assert_eq!(
            gaps,
            [SequenceReferenceCoverageGap {
                owner_path: owner.object_path.to_string(),
                property_path: "Opaque".to_owned(),
                reason: SequenceReferenceCoverageGapReason::RawPropertyValue,
            }]
        );
    }
}
