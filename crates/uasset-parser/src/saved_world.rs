//! Saved World Partition actor projection.
//!
//! This module deliberately consumes the generic tagged-property model rather than adding a
//! level-specific decoder. A world-partition actor package is an ordinary classic package; this
//! projection answers the narrower product question: which saved actors have a resolvable world
//! position while the Unreal editor is closed?

use std::collections::{BTreeMap, BTreeSet};

use crate::archive::Guid;
use crate::asset::{DecodedAsset, DecodedUObject};
use crate::package::{ObjectPath, Package, PackageIndex};
use crate::property::{PropertyRecord, PropertyStream, PropertyValue, RotatorValue, VectorValue};

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

/// The saved portion of a scene component transform needed to resolve actor positions.
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

/// One saved actor with its best available world-position result.
#[derive(Clone, Debug, PartialEq)]
pub struct SavedWorldActorPosition {
    pub actor_guid: Option<Guid>,
    pub actor_path: ObjectPath,
    pub class_path: ObjectPath,
    pub label: Option<String>,
    /// The external actor package which contains this actor's serialized export.
    pub package_name: String,
    pub position: SavedWorldPosition,
}

/// The result of resolving an actor's root component through saved attachments.
#[derive(Clone, Debug, PartialEq)]
pub enum SavedWorldPosition {
    Resolved { location: SavedWorldVector },
    MissingRootComponent,
    MissingAttachmentParent { parent_path: ObjectPath },
    AttachmentCycle { component_path: ObjectPath },
    AmbiguousComponentPath { component_path: ObjectPath },
    UnsupportedAbsoluteTransform { component_path: ObjectPath },
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

/// Resolves root-component locations across a set of saved external-actor packages.
///
/// This follows Unreal's `NewRelativeTransform * ParentToWorld` position rule. Absolute rotation
/// and scale require the engine's `FTransform` matrix/decomposition behavior once attachments are
/// involved, so they are deliberately reported instead of approximated. Absolute location is safe
/// to resolve because Unreal copies its translation directly from the relative transform.
#[must_use]
pub fn resolve_saved_world_positions(
    fragments: &[SavedWorldPackageFragment],
) -> Vec<SavedWorldActorPosition> {
    let mut components = BTreeMap::new();
    let mut duplicates = BTreeSet::new();
    for component in fragments.iter().flat_map(|fragment| &fragment.components) {
        let key = component.object_path.as_str().to_owned();
        if components.insert(key.clone(), component).is_some() {
            duplicates.insert(key);
        }
    }

    let mut cache = BTreeMap::new();
    let mut positions = Vec::new();
    for fragment in fragments {
        for actor in &fragment.actors {
            let position = match actor.root_component.as_ref() {
                None => SavedWorldPosition::MissingRootComponent,
                Some(root_component) if duplicates.contains(root_component.as_str()) => {
                    SavedWorldPosition::AmbiguousComponentPath {
                        component_path: root_component.clone(),
                    }
                }
                Some(root_component) if !components.contains_key(root_component.as_str()) => {
                    SavedWorldPosition::MissingRootComponent
                }
                Some(root_component) => match resolve_component(
                    root_component.as_str(),
                    &components,
                    &duplicates,
                    &mut cache,
                    &mut BTreeSet::new(),
                ) {
                    Ok(transform) => SavedWorldPosition::Resolved {
                        location: transform.location,
                    },
                    Err(ComponentResolution::MissingParent(parent_path)) => {
                        SavedWorldPosition::MissingAttachmentParent { parent_path }
                    }
                    Err(ComponentResolution::Cycle(component_path)) => {
                        SavedWorldPosition::AttachmentCycle { component_path }
                    }
                    Err(ComponentResolution::Ambiguous(component_path)) => {
                        SavedWorldPosition::AmbiguousComponentPath { component_path }
                    }
                    Err(ComponentResolution::UnsupportedAbsoluteTransform(component_path)) => {
                        SavedWorldPosition::UnsupportedAbsoluteTransform { component_path }
                    }
                },
            };
            positions.push(SavedWorldActorPosition {
                actor_guid: actor.actor_guid,
                actor_path: actor.actor_path.clone(),
                class_path: actor.class_path.clone(),
                label: actor.label.clone(),
                package_name: fragment.package_name.clone(),
                position,
            });
        }
    }
    positions
}

#[derive(Clone, Debug)]
enum ComponentResolution {
    Ambiguous(ObjectPath),
    Cycle(ObjectPath),
    MissingParent(ObjectPath),
    UnsupportedAbsoluteTransform(ObjectPath),
}

#[derive(Clone, Copy, Debug)]
struct ComponentTransform {
    location: SavedWorldVector,
    rotation: Quaternion,
    scale: SavedWorldVector,
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
        let relative = ComponentTransform {
            location: component.relative_location,
            rotation: Quaternion::from_rotator(component.relative_rotation),
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
        Ok(ComponentTransform {
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
        })
    })();
    resolving.remove(path);
    cache.insert(path.to_owned(), result.clone());
    result
}

#[derive(Clone, Copy, Debug)]
struct Quaternion {
    x: f64,
    y: f64,
    z: f64,
    w: f64,
}

impl Quaternion {
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

    fn vector(x: f64, y: f64, z: f64) -> SavedWorldVector {
        SavedWorldVector { x, y, z }
    }

    fn component(
        path: &str,
        location: SavedWorldVector,
        parent: Option<&str>,
    ) -> SavedWorldComponentFragment {
        SavedWorldComponentFragment {
            attach_parent: parent.map(ObjectPath::new),
            absolute_location: false,
            absolute_rotation: false,
            absolute_scale: false,
            object_path: ObjectPath::new(path),
            relative_location: location,
            relative_rotation: SavedWorldRotator::ZERO,
            relative_scale: SavedWorldVector::ONE,
        }
    }

    fn actor(path: &str, root: Option<&str>) -> SavedWorldActorFragment {
        SavedWorldActorFragment {
            actor_guid: None,
            actor_path: ObjectPath::new(path),
            class_path: ObjectPath::new("/Script/Engine.StaticMeshActor"),
            label: None,
            root_component: root.map(ObjectPath::new),
        }
    }

    #[test]
    fn resolves_root_location_with_unreal_parent_rotation_and_scale_order() {
        let mut parent = component("/Game/Parent.Root", vector(100.0, 200.0, 300.0), None);
        parent.relative_rotation = SavedWorldRotator {
            pitch: 0.0,
            yaw: 90.0,
            roll: 0.0,
        };
        parent.relative_scale = vector(2.0, 3.0, 4.0);
        let child = component(
            "/Game/Child.Root",
            vector(10.0, 20.0, 30.0),
            Some("/Game/Parent.Root"),
        );
        let positions = resolve_saved_world_positions(&[SavedWorldPackageFragment {
            actors: vec![actor("/Game/Child.Child", Some("/Game/Child.Root"))],
            components: vec![parent, child],
            package_name: "/Game/ExternalActors/Child".to_owned(),
        }]);

        let SavedWorldPosition::Resolved { location } = positions[0].position else {
            panic!("expected a resolved child position");
        };
        assert!((location.x - 40.0).abs() < 1e-10);
        assert!((location.y - 220.0).abs() < 1e-10);
        assert!((location.z - 420.0).abs() < 1e-10);
    }

    #[test]
    fn absolute_location_does_not_inherit_parent_translation() {
        let parent = component("/Game/Parent.Root", vector(100.0, 200.0, 300.0), None);
        let mut child = component(
            "/Game/Child.Root",
            vector(10.0, 20.0, 30.0),
            Some("/Game/Parent.Root"),
        );
        child.absolute_location = true;
        let positions = resolve_saved_world_positions(&[SavedWorldPackageFragment {
            actors: vec![actor("/Game/Child.Child", Some("/Game/Child.Root"))],
            components: vec![parent, child],
            package_name: "/Game/ExternalActors/Child".to_owned(),
        }]);

        assert_eq!(
            positions[0].position,
            SavedWorldPosition::Resolved {
                location: vector(10.0, 20.0, 30.0)
            }
        );
    }

    #[test]
    fn reports_missing_parents_cycles_and_unsupported_absolute_transforms() {
        let missing = component(
            "/Game/Missing.Root",
            vector(0.0, 0.0, 0.0),
            Some("/Game/Nope.Root"),
        );
        let left = component(
            "/Game/Left.Root",
            vector(0.0, 0.0, 0.0),
            Some("/Game/Right.Root"),
        );
        let right = component(
            "/Game/Right.Root",
            vector(0.0, 0.0, 0.0),
            Some("/Game/Left.Root"),
        );
        let mut absolute = component(
            "/Game/Absolute.Root",
            vector(0.0, 0.0, 0.0),
            Some("/Game/Parent.Root"),
        );
        absolute.absolute_rotation = true;
        let parent = component("/Game/Parent.Root", vector(0.0, 0.0, 0.0), None);
        let positions = resolve_saved_world_positions(&[SavedWorldPackageFragment {
            actors: vec![
                actor("/Game/Missing.Actor", Some("/Game/Missing.Root")),
                actor("/Game/Left.Actor", Some("/Game/Left.Root")),
                actor("/Game/Absolute.Actor", Some("/Game/Absolute.Root")),
            ],
            components: vec![missing, left, right, absolute, parent],
            package_name: "/Game/ExternalActors/States".to_owned(),
        }]);

        assert_eq!(
            positions[0].position,
            SavedWorldPosition::MissingAttachmentParent {
                parent_path: ObjectPath::new("/Game/Nope.Root")
            }
        );
        assert_eq!(
            positions[1].position,
            SavedWorldPosition::AttachmentCycle {
                component_path: ObjectPath::new("/Game/Left.Root")
            }
        );
        assert_eq!(
            positions[2].position,
            SavedWorldPosition::UnsupportedAbsoluteTransform {
                component_path: ObjectPath::new("/Game/Absolute.Root")
            }
        );
    }
}
