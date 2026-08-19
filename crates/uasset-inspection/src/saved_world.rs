//! Saved World Partition actor projection.
//!
//! This module deliberately consumes the generic tagged-property model rather than adding a
//! level-specific decoder. A world-partition actor package is an ordinary classic package; this
//! projection answers the narrower product question: which saved actors have a resolvable world
//! transform while the Unreal editor is closed?

use std::collections::{BTreeMap, BTreeSet};

use uasset_parser::archive::Guid;
use uasset_parser::asset::{DecodedAsset, DecodedUObject};
use uasset_parser::package::{ObjectPath, Package, PackageIndex};
use uasset_parser::property::{
    PropertyRecord, PropertyStream, PropertyValue, RotatorValue, VectorValue,
};

/// A double-precision Unreal vector retained from a saved property.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SavedWorldVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl SavedWorldVector {
    const ZERO: Self = Self {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };

    const ONE: Self = Self {
        x: 1.0,
        y: 1.0,
        z: 1.0,
    };

    fn component_mul(self, other: Self) -> Self {
        Self {
            x: self.x * other.x,
            y: self.y * other.y,
            z: self.z * other.z,
        }
    }

    fn add(self, other: Self) -> Self {
        Self {
            x: self.x + other.x,
            y: self.y + other.y,
            z: self.z + other.z,
        }
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }
}

impl From<&VectorValue> for SavedWorldVector {
    fn from(value: &VectorValue) -> Self {
        Self {
            x: value.x,
            y: value.y,
            z: value.z,
        }
    }
}

/// The saved portion of a scene component transform needed to resolve actor transforms.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldComponentFragment {
    pub attach_parent: Option<ObjectPath>,
    pub absolute_location: bool,
    pub absolute_rotation: bool,
    pub absolute_scale: bool,
    pub object_path: ObjectPath,
    pub relative_location: SavedWorldVector,
    pub relative_rotation: SavedWorldRotator,
    pub relative_scale: SavedWorldVector,
}

/// Unreal's saved pitch/yaw/roll representation, in degrees.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SavedWorldRotator {
    pub pitch: f64,
    pub yaw: f64,
    pub roll: f64,
}

impl SavedWorldRotator {
    const ZERO: Self = Self {
        pitch: 0.0,
        yaw: 0.0,
        roll: 0.0,
    };

    fn is_finite(self) -> bool {
        self.pitch.is_finite() && self.yaw.is_finite() && self.roll.is_finite()
    }
}

impl From<&RotatorValue> for SavedWorldRotator {
    fn from(value: &RotatorValue) -> Self {
        Self {
            pitch: value.pitch,
            yaw: value.yaw,
            roll: value.roll,
        }
    }
}

/// One actor recognized from an exported `RootComponent` reference.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldActorFragment {
    pub actor_guid: Option<Guid>,
    pub actor_path: ObjectPath,
    pub class_path: ObjectPath,
    pub label: Option<String>,
    pub root_component: Option<ObjectPath>,
}

/// The projection obtained from one external-actor package.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldPackageFragment {
    pub actors: Vec<SavedWorldActorFragment>,
    pub components: Vec<SavedWorldComponentFragment>,
    pub package_name: String,
}

/// A direct saved attachment between an actor root component and its parent component.
///
/// Component paths are exposed because the saved package proves them directly. This deliberately
/// does not infer which actor, if any, owns the parent component.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldAttachment {
    pub component_path: ObjectPath,
    pub parent_component_path: ObjectPath,
}

/// One saved actor with its best available transform and attachment evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldActorEvidence {
    pub actor_guid: Option<Guid>,
    pub actor_path: ObjectPath,
    pub attachment: Option<SavedWorldAttachment>,
    pub class_path: ObjectPath,
    pub label: Option<String>,
    /// The external actor package which contains this actor's serialized export.
    pub package_name: String,
    pub transform: SavedWorldTransform,
}

/// The result of resolving an actor's root component through saved attachments.
#[derive(Clone, Debug, PartialEq)]
pub enum SavedWorldTransform {
    Resolved {
        location: SavedWorldVector,
        rotation: SavedWorldQuaternion,
        scale: SavedWorldVector,
    },
    MissingRootComponent,
    MissingAttachmentParent {
        parent_path: ObjectPath,
    },
    AttachmentCycle {
        component_path: ObjectPath,
    },
    AmbiguousComponentPath {
        component_path: ObjectPath,
    },
    UnsupportedAbsoluteTransform {
        component_path: ObjectPath,
    },
    NonFiniteTransform {
        component_path: ObjectPath,
    },
}

/// Projects generic decoded UObjects from one package into actor and component fragments.
///
/// `RootComponent` is the deliberately conservative actor signal. We do not infer inheritance
/// from a class-name suffix, because saved package metadata alone does not carry a complete native
/// class hierarchy. Components referenced by a root or carrying a saved scene-transform property
/// are retained; missing transform tags use Unreal's identity defaults.
#[must_use]
pub fn project_saved_world_package(
    package: &Package,
    decoded_assets: &[DecodedAsset],
) -> SavedWorldPackageFragment {
    let objects = decoded_assets.iter().filter_map(|asset| match asset {
        DecodedAsset::UObject(object) => Some(object),
        _ => None,
    });
    let objects: Vec<_> = objects.collect();

    let root_component_paths: BTreeSet<_> = objects
        .iter()
        .filter_map(|object| object_reference(package, &object.properties, "RootComponent"))
        .collect();

    let actors = objects
        .iter()
        .filter(|object| has_property(package, &object.properties, "RootComponent"))
        .map(|object| SavedWorldActorFragment {
            actor_guid: guid_property(package, &object.properties, "ActorGuid"),
            actor_path: object.object_path.clone(),
            class_path: object.class_path.clone(),
            label: string_property(package, &object.properties, "ActorLabel"),
            root_component: object_reference(package, &object.properties, "RootComponent"),
        })
        .collect();

    let components = objects
        .iter()
        .filter(|object| {
            root_component_paths.contains(&object.object_path)
                || has_scene_transform_property(package, &object.properties)
        })
        .map(|object| component_fragment(package, object))
        .collect();

    SavedWorldPackageFragment {
        actors,
        components,
        package_name: package.summary.package_name.clone(),
    }
}

/// Resolves root-component transforms across a set of saved level or external-actor packages.
///
/// This follows Unreal's `NewRelativeTransform * ParentToWorld` position rule. Absolute rotation
/// and scale require the engine's `FTransform` matrix/decomposition behavior once attachments are
/// involved, so they are deliberately reported instead of approximated. Absolute location is safe
/// to resolve because Unreal copies its translation directly from the relative transform.
#[must_use]
pub fn resolve_saved_world_actors(
    fragments: &[SavedWorldPackageFragment],
) -> Vec<SavedWorldActorEvidence> {
    let mut components = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    for component in fragments.iter().flat_map(|fragment| &fragment.components) {
        let key = component.object_path.as_str().to_owned();
        if components.insert(key.clone(), component).is_some() {
            duplicates.insert(key);
        }
    }

    let mut cache = BTreeMap::new();
    let mut actors = Vec::new();
    for fragment in fragments {
        for actor in &fragment.actors {
            let attachment = actor.root_component.as_ref().and_then(|root_component| {
                if duplicates.contains(root_component.as_str()) {
                    return None;
                }
                components
                    .get(root_component.as_str())
                    .and_then(|component| component.attach_parent.as_ref())
                    .map(|parent_component| SavedWorldAttachment {
                        component_path: root_component.clone(),
                        parent_component_path: parent_component.clone(),
                    })
            });
            let transform = match actor.root_component.as_ref() {
                None => SavedWorldTransform::MissingRootComponent,
                Some(root_component) if duplicates.contains(root_component.as_str()) => {
                    SavedWorldTransform::AmbiguousComponentPath {
                        component_path: root_component.clone(),
                    }
                }
                Some(root_component) if !components.contains_key(root_component.as_str()) => {
                    SavedWorldTransform::MissingRootComponent
                }
                Some(root_component) => match resolve_component(
                    root_component.as_str(),
                    &components,
                    &duplicates,
                    &mut cache,
                    &mut BTreeSet::new(),
                ) {
                    Ok(transform) => SavedWorldTransform::Resolved {
                        location: transform.location,
                        rotation: transform.rotation,
                        scale: transform.scale,
                    },
                    Err(ComponentResolution::MissingParent(parent_path)) => {
                        SavedWorldTransform::MissingAttachmentParent { parent_path }
                    }
                    Err(ComponentResolution::Cycle(component_path)) => {
                        SavedWorldTransform::AttachmentCycle { component_path }
                    }
                    Err(ComponentResolution::Ambiguous(component_path)) => {
                        SavedWorldTransform::AmbiguousComponentPath { component_path }
                    }
                    Err(ComponentResolution::UnsupportedAbsoluteTransform(component_path)) => {
                        SavedWorldTransform::UnsupportedAbsoluteTransform { component_path }
                    }
                    Err(ComponentResolution::NonFinite(component_path)) => {
                        SavedWorldTransform::NonFiniteTransform { component_path }
                    }
                },
            };
            actors.push(SavedWorldActorEvidence {
                actor_guid: actor.actor_guid,
                actor_path: actor.actor_path.clone(),
                attachment,
                class_path: actor.class_path.clone(),
                label: actor.label.clone(),
                package_name: fragment.package_name.clone(),
                transform,
            });
        }
    }
    actors
}

#[derive(Clone, Debug)]
enum ComponentResolution {
    Ambiguous(ObjectPath),
    Cycle(ObjectPath),
    MissingParent(ObjectPath),
    NonFinite(ObjectPath),
    UnsupportedAbsoluteTransform(ObjectPath),
}

#[derive(Clone, Copy, Debug)]
struct ComponentTransform {
    location: SavedWorldVector,
    rotation: SavedWorldQuaternion,
    scale: SavedWorldVector,
}

impl ComponentTransform {
    fn is_finite(self) -> bool {
        self.location.is_finite() && self.rotation.is_finite() && self.scale.is_finite()
    }
}

fn resolve_component(
    path: &str,
    components: &BTreeMap<String, &SavedWorldComponentFragment>,
    duplicates: &BTreeSet<String>,
    cache: &mut BTreeMap<String, Result<ComponentTransform, ComponentResolution>>,
    resolving: &mut BTreeSet<String>,
) -> Result<ComponentTransform, ComponentResolution> {
    if let Some(cached) = cache.get(path) {
        return cached.clone();
    }
    if !resolving.insert(path.to_owned()) {
        return Err(ComponentResolution::Cycle(ObjectPath::new(path)));
    }
    let result = (|| {
        if duplicates.contains(path) {
            return Err(ComponentResolution::Ambiguous(ObjectPath::new(path)));
        }
        let component = components
            .get(path)
            .ok_or_else(|| ComponentResolution::MissingParent(ObjectPath::new(path)))?;
        if !component.relative_location.is_finite()
            || !component.relative_rotation.is_finite()
            || !component.relative_scale.is_finite()
        {
            return Err(ComponentResolution::NonFinite(
                component.object_path.clone(),
            ));
        }
        let relative = ComponentTransform {
            location: component.relative_location,
            rotation: SavedWorldQuaternion::from_rotator(component.relative_rotation),
            scale: component.relative_scale,
        };
        let Some(parent_path) = component.attach_parent.as_ref() else {
            return Ok(relative);
        };
        if component.absolute_rotation || component.absolute_scale {
            return Err(ComponentResolution::UnsupportedAbsoluteTransform(
                component.object_path.clone(),
            ));
        }
        let parent = resolve_component(
            parent_path.as_str(),
            components,
            duplicates,
            cache,
            resolving,
        )?;
        let transform = ComponentTransform {
            location: if component.absolute_location {
                relative.location
            } else {
                parent
                    .rotation
                    .rotate(parent.scale.component_mul(relative.location))
                    .add(parent.location)
            },
            rotation: parent.rotation.multiply(relative.rotation),
            scale: parent.scale.component_mul(relative.scale),
        };
        if !transform.is_finite() {
            return Err(ComponentResolution::NonFinite(
                component.object_path.clone(),
            ));
        }
        Ok(transform)
    })();
    resolving.remove(path);
    cache.insert(path.to_owned(), result.clone());
    result
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SavedWorldQuaternion {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl SavedWorldQuaternion {
    fn from_rotator(rotator: SavedWorldRotator) -> Self {
        let to_radians = std::f64::consts::PI / 360.0;
        let (pitch_sin, pitch_cos) = (rotator.pitch * to_radians).sin_cos();
        let (yaw_sin, yaw_cos) = (rotator.yaw * to_radians).sin_cos();
        let (roll_sin, roll_cos) = (rotator.roll * to_radians).sin_cos();
        Self {
            x: roll_cos * pitch_sin * yaw_sin - roll_sin * pitch_cos * yaw_cos,
            y: -roll_cos * pitch_sin * yaw_cos - roll_sin * pitch_cos * yaw_sin,
            z: roll_cos * pitch_cos * yaw_sin - roll_sin * pitch_sin * yaw_cos,
            w: roll_cos * pitch_cos * yaw_cos + roll_sin * pitch_sin * yaw_sin,
        }
    }

    fn multiply(self, other: Self) -> Self {
        Self {
            x: self.w * other.x + self.x * other.w + self.y * other.z - self.z * other.y,
            y: self.w * other.y - self.x * other.z + self.y * other.w + self.z * other.x,
            z: self.w * other.z + self.x * other.y - self.y * other.x + self.z * other.w,
            w: self.w * other.w - self.x * other.x - self.y * other.y - self.z * other.z,
        }
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite() && self.w.is_finite()
    }

    fn rotate(self, value: SavedWorldVector) -> SavedWorldVector {
        // Equivalent to Unreal's FQuat::RotateVector, without materializing an intermediate
        // quaternion. Saved FRotators create normalized quaternions.
        let q = SavedWorldVector {
            x: self.x,
            y: self.y,
            z: self.z,
        };
        let t = cross(q, value);
        let t = SavedWorldVector {
            x: t.x * 2.0,
            y: t.y * 2.0,
            z: t.z * 2.0,
        };
        value.add(SavedWorldVector {
            x: self.w * t.x + cross(q, t).x,
            y: self.w * t.y + cross(q, t).y,
            z: self.w * t.z + cross(q, t).z,
        })
    }
}

fn cross(left: SavedWorldVector, right: SavedWorldVector) -> SavedWorldVector {
    SavedWorldVector {
        x: left.y * right.z - left.z * right.y,
        y: left.z * right.x - left.x * right.z,
        z: left.x * right.y - left.y * right.x,
    }
}

fn component_fragment(package: &Package, object: &DecodedUObject) -> SavedWorldComponentFragment {
    SavedWorldComponentFragment {
        attach_parent: object_reference(package, &object.properties, "AttachParent"),
        absolute_location: bool_property(package, &object.properties, "bAbsoluteLocation"),
        absolute_rotation: bool_property(package, &object.properties, "bAbsoluteRotation"),
        absolute_scale: bool_property(package, &object.properties, "bAbsoluteScale"),
        object_path: object.object_path.clone(),
        relative_location: vector_property(package, &object.properties, "RelativeLocation")
            .unwrap_or(SavedWorldVector::ZERO),
        relative_rotation: rotator_property(package, &object.properties, "RelativeRotation")
            .unwrap_or(SavedWorldRotator::ZERO),
        relative_scale: vector_property(package, &object.properties, "RelativeScale3D")
            .unwrap_or(SavedWorldVector::ONE),
    }
}

fn has_scene_transform_property(package: &Package, properties: &PropertyStream) -> bool {
    [
        "RelativeLocation",
        "RelativeRotation",
        "RelativeScale3D",
        "AttachParent",
        "bAbsoluteLocation",
        "bAbsoluteRotation",
        "bAbsoluteScale",
    ]
    .iter()
    .any(|name| has_property(package, properties, name))
}

fn has_property(package: &Package, properties: &PropertyStream, name: &str) -> bool {
    property(package, properties, name).is_some()
}

fn property<'a>(
    package: &'a Package,
    properties: &'a PropertyStream,
    name: &str,
) -> Option<&'a PropertyRecord> {
    properties
        .records
        .iter()
        .find(|record| package.resolve_name_str(record.name) == Some(name))
}

fn object_reference(
    package: &Package,
    properties: &PropertyStream,
    name: &str,
) -> Option<ObjectPath> {
    let PropertyValue::ObjectRef(index) = property(package, properties, name)?.value else {
        return None;
    };
    (index != PackageIndex::Null)
        .then(|| package.resolve_index(index))
        .flatten()
}

fn bool_property(package: &Package, properties: &PropertyStream, name: &str) -> bool {
    matches!(
        property(package, properties, name).map(|record| &record.value),
        Some(PropertyValue::Bool(true))
    )
}

fn vector_property(
    package: &Package,
    properties: &PropertyStream,
    name: &str,
) -> Option<SavedWorldVector> {
    let PropertyValue::Vector(value) = &property(package, properties, name)?.value else {
        return None;
    };
    Some(value.into())
}

fn rotator_property(
    package: &Package,
    properties: &PropertyStream,
    name: &str,
) -> Option<SavedWorldRotator> {
    let PropertyValue::Rotator(value) = &property(package, properties, name)?.value else {
        return None;
    };
    Some(value.into())
}

fn string_property(package: &Package, properties: &PropertyStream, name: &str) -> Option<String> {
    match &property(package, properties, name)?.value {
        PropertyValue::String(value) => Some(value.clone()),
        PropertyValue::Text(value) => Some(value.source.clone()),
        _ => None,
    }
}

fn guid_property(package: &Package, properties: &PropertyStream, name: &str) -> Option<Guid> {
    let PropertyValue::Guid(value) = property(package, properties, name)?.value else {
        return None;
    };
    (!value.is_zero()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(path: &str, root_component: Option<&str>) -> SavedWorldActorFragment {
        SavedWorldActorFragment {
            actor_guid: None,
            actor_path: ObjectPath::new(path),
            class_path: ObjectPath::new("/Script/Engine.Actor"),
            label: None,
            root_component: root_component.map(ObjectPath::new),
        }
    }

    fn component(
        path: &str,
        parent: Option<&str>,
        location: SavedWorldVector,
        rotation: SavedWorldRotator,
        scale: SavedWorldVector,
    ) -> SavedWorldComponentFragment {
        SavedWorldComponentFragment {
            attach_parent: parent.map(ObjectPath::new),
            absolute_location: false,
            absolute_rotation: false,
            absolute_scale: false,
            object_path: ObjectPath::new(path),
            relative_location: location,
            relative_rotation: rotation,
            relative_scale: scale,
        }
    }

    fn fragment(
        actors: Vec<SavedWorldActorFragment>,
        components: Vec<SavedWorldComponentFragment>,
    ) -> SavedWorldPackageFragment {
        SavedWorldPackageFragment {
            actors,
            components,
            package_name: "/Game/Maps/Fixture".to_owned(),
        }
    }

    #[test]
    fn nested_attachments_compose_effective_transform_and_direct_attachment() {
        let parent = component(
            "Parent",
            None,
            SavedWorldVector {
                x: 100.0,
                y: 200.0,
                z: 300.0,
            },
            SavedWorldRotator {
                pitch: 0.0,
                yaw: 90.0,
                roll: 0.0,
            },
            SavedWorldVector {
                x: 2.0,
                y: 2.0,
                z: 2.0,
            },
        );
        let middle = component(
            "Middle",
            Some("Parent"),
            SavedWorldVector {
                x: 10.0,
                y: 0.0,
                z: 0.0,
            },
            SavedWorldRotator::ZERO,
            SavedWorldVector {
                x: 0.5,
                y: 1.0,
                z: 1.0,
            },
        );
        let child = component(
            "Child",
            Some("Middle"),
            SavedWorldVector {
                x: 5.0,
                y: 0.0,
                z: 0.0,
            },
            SavedWorldRotator::ZERO,
            SavedWorldVector {
                x: 3.0,
                y: 4.0,
                z: 5.0,
            },
        );
        let fragments = [fragment(
            vec![actor("NestedActor", Some("Child"))],
            vec![parent, middle, child],
        )];

        let first = resolve_saved_world_actors(&fragments);
        let second = resolve_saved_world_actors(&fragments);
        assert_eq!(
            first, second,
            "saved actor order and evidence are deterministic"
        );
        assert_eq!(
            first[0].attachment,
            Some(SavedWorldAttachment {
                component_path: ObjectPath::new("Child"),
                parent_component_path: ObjectPath::new("Middle"),
            })
        );
        let SavedWorldTransform::Resolved {
            location,
            rotation,
            scale,
        } = first[0].transform
        else {
            panic!("nested transform must resolve")
        };
        assert!((location.x - 100.0).abs() < 1e-9);
        assert!((location.y - 225.0).abs() < 1e-9);
        assert!((location.z - 300.0).abs() < 1e-9);
        assert!((rotation.w - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert!((rotation.z - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert_eq!(
            scale,
            SavedWorldVector {
                x: 3.0,
                y: 8.0,
                z: 10.0,
            }
        );
    }

    #[test]
    fn transform_failures_remain_explicit_and_never_become_identity() {
        let mut unsupported = component(
            "Unsupported",
            Some("StableParent"),
            SavedWorldVector::ZERO,
            SavedWorldRotator::ZERO,
            SavedWorldVector::ONE,
        );
        unsupported.absolute_rotation = true;
        let fragments = [
            fragment(vec![actor("MissingRoot", None)], vec![]),
            fragment(
                vec![actor("MissingParent", Some("MissingParentRoot"))],
                vec![component(
                    "MissingParentRoot",
                    Some("Absent"),
                    SavedWorldVector::ZERO,
                    SavedWorldRotator::ZERO,
                    SavedWorldVector::ONE,
                )],
            ),
            fragment(
                vec![actor("Cycle", Some("CycleA"))],
                vec![
                    component(
                        "CycleA",
                        Some("CycleB"),
                        SavedWorldVector::ZERO,
                        SavedWorldRotator::ZERO,
                        SavedWorldVector::ONE,
                    ),
                    component(
                        "CycleB",
                        Some("CycleA"),
                        SavedWorldVector::ZERO,
                        SavedWorldRotator::ZERO,
                        SavedWorldVector::ONE,
                    ),
                ],
            ),
            fragment(
                vec![actor("Ambiguous", Some("Duplicate"))],
                vec![component(
                    "Duplicate",
                    None,
                    SavedWorldVector::ZERO,
                    SavedWorldRotator::ZERO,
                    SavedWorldVector::ONE,
                )],
            ),
            fragment(
                vec![],
                vec![component(
                    "Duplicate",
                    None,
                    SavedWorldVector::ZERO,
                    SavedWorldRotator::ZERO,
                    SavedWorldVector::ONE,
                )],
            ),
            fragment(
                vec![actor("Unsupported", Some("Unsupported"))],
                vec![
                    component(
                        "StableParent",
                        None,
                        SavedWorldVector::ZERO,
                        SavedWorldRotator::ZERO,
                        SavedWorldVector::ONE,
                    ),
                    unsupported,
                ],
            ),
            fragment(
                vec![actor("NonFinite", Some("NonFinite"))],
                vec![component(
                    "NonFinite",
                    None,
                    SavedWorldVector::ZERO,
                    SavedWorldRotator::ZERO,
                    SavedWorldVector {
                        x: f64::NAN,
                        y: 1.0,
                        z: 1.0,
                    },
                )],
            ),
        ];

        let evidence: BTreeMap<_, _> = resolve_saved_world_actors(&fragments)
            .into_iter()
            .map(|actor| (actor.actor_path.to_string(), actor.transform))
            .collect();
        assert!(matches!(
            evidence["MissingRoot"],
            SavedWorldTransform::MissingRootComponent
        ));
        assert!(matches!(
            evidence["MissingParent"],
            SavedWorldTransform::MissingAttachmentParent { .. }
        ));
        assert!(matches!(
            evidence["Cycle"],
            SavedWorldTransform::AttachmentCycle { .. }
        ));
        assert!(matches!(
            evidence["Ambiguous"],
            SavedWorldTransform::AmbiguousComponentPath { .. }
        ));
        assert!(matches!(
            evidence["Unsupported"],
            SavedWorldTransform::UnsupportedAbsoluteTransform { .. }
        ));
        assert!(matches!(
            evidence["NonFinite"],
            SavedWorldTransform::NonFiniteTransform { .. }
        ));
    }
}
