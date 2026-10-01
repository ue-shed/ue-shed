//! Saved-world wire models and pure conversions from resolved actor evidence.

use serde::{Deserialize, Serialize};

use crate::authoring::Completeness;
use crate::saved_world::{SavedWorldActorEvidence, SavedWorldTransform as ProjectedWorldTransform};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorld {
    pub authority: SavedWorldAuthority,
    pub completeness: Completeness,
    pub contract: SavedWorldContract,
    pub diagnostics: Vec<SavedWorldDiagnostic>,
    #[serde(
        default,
        rename = "externalActorRoot",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_actor_root: Option<String>,
    #[serde(rename = "mapPath")]
    pub map_path: String,
    #[serde(rename = "sourceKind")]
    pub source_kind: SavedWorldSourceKind,
    pub actors: Vec<SavedWorldActor>,
    pub summary: SavedWorldSummary,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldAuthority {
    pub kind: ProjectFilesKind,
    #[serde(rename = "mapPackage")]
    pub map_package: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectFilesKind;

impl<'de> Deserialize<'de> for ProjectFilesKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value == "project_files" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected project_files"))
        }
    }
}

impl Serialize for ProjectFilesKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("project_files")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldContract {
    pub name: SavedWorldContractName,
    pub version: SavedWorldContractVersion,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SavedWorldContractName;

impl<'de> Deserialize<'de> for SavedWorldContractName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value == "unreal-saved-world" {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom("expected unreal-saved-world"))
        }
    }
}

impl Serialize for SavedWorldContractName {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str("unreal-saved-world")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldContractVersion {
    pub major: u8,
    pub minor: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldDiagnostic {
    pub code: String,
    pub message: String,
    #[serde(rename = "retrySafe")]
    pub retry_safe: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedWorldSourceKind {
    Level,
    WorldPartition,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldActor {
    #[serde(default, rename = "actorGuid", skip_serializing_if = "Option::is_none")]
    pub actor_guid: Option<String>,
    #[serde(rename = "actorPath")]
    pub actor_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<SavedWorldAttachment>,
    #[serde(rename = "classPath")]
    pub class_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "packageName")]
    pub package_name: String,
    pub transform: SavedWorldTransform,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub enum SavedWorldTransform {
    #[serde(rename = "missing_root_component")]
    MissingRootComponent,
    #[serde(rename = "missing_attachment_parent")]
    MissingAttachmentParent {
        #[serde(rename = "parentPath")]
        parent_path: String,
    },
    #[serde(rename = "attachment_cycle")]
    AttachmentCycle {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "ambiguous_component_path")]
    AmbiguousComponentPath {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "unsupported_absolute_transform")]
    UnsupportedAbsoluteTransform {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "non_finite_transform")]
    NonFiniteTransform {
        #[serde(rename = "componentPath")]
        component_path: String,
    },
    #[serde(rename = "resolved")]
    Resolved {
        location: SavedWorldVector,
        rotation: SavedWorldQuaternion,
        scale: SavedWorldVector,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldAttachment {
    #[serde(rename = "componentPath")]
    pub component_path: String,
    #[serde(rename = "parentComponentPath")]
    pub parent_component_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldQuaternion {
    pub w: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SavedWorldSummary {
    #[serde(rename = "failedPackages")]
    pub failed_packages: u64,
    #[serde(rename = "partialPackages")]
    pub partial_packages: u64,
    #[serde(rename = "resolvedActors")]
    pub resolved_actors: u64,
    #[serde(rename = "scannedPackages")]
    pub scanned_packages: u64,
}

pub fn saved_world_actor(actor: SavedWorldActorEvidence) -> SavedWorldActor {
    SavedWorldActor {
        actor_guid: actor.actor_guid.map(|guid| guid.to_string()),
        actor_path: actor.actor_path.to_string(),
        attachment: actor.attachment.map(|attachment| SavedWorldAttachment {
            component_path: attachment.component_path.to_string(),
            parent_component_path: attachment.parent_component_path.to_string(),
        }),
        class_path: actor.class_path.to_string(),
        label: actor.label,
        package_name: actor.package_name,
        transform: saved_world_transform(actor.transform),
    }
}

pub fn saved_world_transform(transform: ProjectedWorldTransform) -> SavedWorldTransform {
    match transform {
        ProjectedWorldTransform::Resolved {
            location,
            rotation,
            scale,
        } => SavedWorldTransform::Resolved {
            location: SavedWorldVector {
                x: location.x,
                y: location.y,
                z: location.z,
            },
            rotation: SavedWorldQuaternion {
                w: rotation.w,
                x: rotation.x,
                y: rotation.y,
                z: rotation.z,
            },
            scale: SavedWorldVector {
                x: scale.x,
                y: scale.y,
                z: scale.z,
            },
        },
        ProjectedWorldTransform::MissingRootComponent => SavedWorldTransform::MissingRootComponent,
        ProjectedWorldTransform::MissingAttachmentParent { parent_path } => {
            SavedWorldTransform::MissingAttachmentParent {
                parent_path: parent_path.to_string(),
            }
        }
        ProjectedWorldTransform::AttachmentCycle { component_path } => {
            SavedWorldTransform::AttachmentCycle {
                component_path: component_path.to_string(),
            }
        }
        ProjectedWorldTransform::AmbiguousComponentPath { component_path } => {
            SavedWorldTransform::AmbiguousComponentPath {
                component_path: component_path.to_string(),
            }
        }
        ProjectedWorldTransform::UnsupportedAbsoluteTransform { component_path } => {
            SavedWorldTransform::UnsupportedAbsoluteTransform {
                component_path: component_path.to_string(),
            }
        }
        ProjectedWorldTransform::NonFiniteTransform { component_path } => {
            SavedWorldTransform::NonFiniteTransform {
                component_path: component_path.to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uasset_parser::archive::Guid;
    use uasset_parser::package::ObjectPath;

    fn actor_evidence(transform: ProjectedWorldTransform) -> SavedWorldActorEvidence {
        SavedWorldActorEvidence {
            actor_guid: None,
            actor_path: ObjectPath::new("/Game/Fixture/L.L:Actor"),
            attachment: None,
            class_path: ObjectPath::new("/Script/Engine.Actor"),
            label: None,
            package_name: "/Game/Fixture/L".to_owned(),
            transform,
        }
    }

    #[test]
    fn actor_wire_json_preserves_all_transform_variants_and_omits_missing_options() {
        let cases = [
            (
                ProjectedWorldTransform::Resolved {
                    location: crate::saved_world::SavedWorldVector {
                        x: 1.0,
                        y: 2.0,
                        z: 3.0,
                    },
                    rotation: crate::saved_world::SavedWorldQuaternion {
                        w: 0.5,
                        x: 0.0,
                        y: 0.5,
                        z: 0.0,
                    },
                    scale: crate::saved_world::SavedWorldVector {
                        x: 1.0,
                        y: 1.0,
                        z: 1.0,
                    },
                },
                concat!(
                    r#"{"status":"resolved","location":{"x":1.0,"y":2.0,"z":3.0},"#,
                    r#""rotation":{"w":0.5,"x":0.0,"y":0.5,"z":0.0},"#,
                    r#""scale":{"x":1.0,"y":1.0,"z":1.0}}"#
                ),
            ),
            (
                ProjectedWorldTransform::MissingRootComponent,
                r#"{"status":"missing_root_component"}"#,
            ),
            (
                ProjectedWorldTransform::MissingAttachmentParent {
                    parent_path: ObjectPath::new("Parent"),
                },
                r#"{"status":"missing_attachment_parent","parentPath":"Parent"}"#,
            ),
            (
                ProjectedWorldTransform::AttachmentCycle {
                    component_path: ObjectPath::new("Root"),
                },
                r#"{"status":"attachment_cycle","componentPath":"Root"}"#,
            ),
            (
                ProjectedWorldTransform::AmbiguousComponentPath {
                    component_path: ObjectPath::new("Root"),
                },
                r#"{"status":"ambiguous_component_path","componentPath":"Root"}"#,
            ),
            (
                ProjectedWorldTransform::UnsupportedAbsoluteTransform {
                    component_path: ObjectPath::new("Root"),
                },
                r#"{"status":"unsupported_absolute_transform","componentPath":"Root"}"#,
            ),
            (
                ProjectedWorldTransform::NonFiniteTransform {
                    component_path: ObjectPath::new("Root"),
                },
                r#"{"status":"non_finite_transform","componentPath":"Root"}"#,
            ),
        ];
        for (transform, expected_transform) in cases {
            let wire = saved_world_actor(actor_evidence(transform));
            let expected = format!(
                concat!(
                    r#"{{"actorPath":"/Game/Fixture/L.L:Actor","classPath":"/Script/Engine.Actor","#,
                    r#""packageName":"/Game/Fixture/L","transform":{}}}"#
                ),
                expected_transform
            );
            assert_eq!(serde_json::to_string(&wire).expect("actor JSON"), expected);
            assert_eq!(
                serde_json::from_str::<SavedWorldActor>(&expected).expect("actor wire"),
                wire
            );
            let explicit_nulls = expected.replacen(
                "{",
                r#"{"actorGuid":null,"attachment":null,"label":null,"#,
                1,
            );
            let from_nulls: SavedWorldActor =
                serde_json::from_str(&explicit_nulls).expect("null actor options");
            assert_eq!(
                serde_json::to_string(&from_nulls).expect("actor JSON"),
                expected
            );
        }
    }

    #[test]
    fn actor_wire_json_preserves_present_and_empty_options() {
        let mut actor = actor_evidence(ProjectedWorldTransform::MissingRootComponent);
        actor.actor_guid = Some(Guid {
            a: 1,
            b: 2,
            c: 3,
            d: 4,
        });
        actor.attachment = Some(crate::saved_world::SavedWorldAttachment {
            component_path: ObjectPath::new("Root"),
            parent_component_path: ObjectPath::new("Parent"),
        });
        actor.label = Some(String::new());
        let wire = saved_world_actor(actor);
        assert_eq!(
            serde_json::to_string(&wire).expect("actor JSON"),
            concat!(
                r#"{"actorGuid":"00000001-00000002-00000003-00000004","#,
                r#""actorPath":"/Game/Fixture/L.L:Actor","attachment":{"componentPath":"Root","#,
                r#""parentComponentPath":"Parent"},"classPath":"/Script/Engine.Actor","label":"","#,
                r#""packageName":"/Game/Fixture/L","transform":{"status":"missing_root_component"}}"#
            )
        );
    }

    #[test]
    fn world_wire_json_preserves_contract_summary_and_optional_root() {
        let mut world = SavedWorld {
            authority: SavedWorldAuthority {
                kind: ProjectFilesKind,
                map_package: "/Game/Fixture/L".to_owned(),
            },
            completeness: Completeness::Complete,
            contract: SavedWorldContract {
                name: SavedWorldContractName,
                version: SavedWorldContractVersion { major: 2, minor: 0 },
            },
            diagnostics: vec![SavedWorldDiagnostic {
                code: "unsupported".to_owned(),
                message: "Partial package".to_owned(),
                retry_safe: true,
            }],
            external_actor_root: None,
            map_path: "Content/Fixture/L.umap".to_owned(),
            source_kind: SavedWorldSourceKind::Level,
            actors: Vec::new(),
            summary: SavedWorldSummary {
                failed_packages: 1,
                partial_packages: 2,
                resolved_actors: 3,
                scanned_packages: 4,
            },
        };
        for (completeness, source_kind, root, expected) in [
            (
                Completeness::Complete,
                SavedWorldSourceKind::Level,
                None,
                concat!(
                    r#"{"authority":{"kind":"project_files","mapPackage":"/Game/Fixture/L"},"#,
                    r#""completeness":"complete","contract":{"name":"unreal-saved-world","#,
                    r#""version":{"major":2,"minor":0}},"diagnostics":[{"code":"unsupported","#,
                    r#""message":"Partial package","retrySafe":true}],"mapPath":"Content/Fixture/L.umap","#,
                    r#""sourceKind":"level","actors":[],"summary":{"failedPackages":1,"#,
                    r#""partialPackages":2,"resolvedActors":3,"scannedPackages":4}}"#
                ),
            ),
            (
                Completeness::Partial,
                SavedWorldSourceKind::WorldPartition,
                Some(String::new()),
                concat!(
                    r#"{"authority":{"kind":"project_files","mapPackage":"/Game/Fixture/L"},"#,
                    r#""completeness":"partial","contract":{"name":"unreal-saved-world","#,
                    r#""version":{"major":2,"minor":0}},"diagnostics":[{"code":"unsupported","#,
                    r#""message":"Partial package","retrySafe":true}],"externalActorRoot":"","#,
                    r#""mapPath":"Content/Fixture/L.umap","sourceKind":"world_partition","actors":[],"#,
                    r#""summary":{"failedPackages":1,"partialPackages":2,"resolvedActors":3,"#,
                    r#""scannedPackages":4}}"#
                ),
            ),
        ] {
            world.completeness = completeness;
            world.source_kind = source_kind;
            world.external_actor_root = root;
            assert_eq!(serde_json::to_string(&world).expect("world JSON"), expected);
            assert_eq!(
                serde_json::from_str::<SavedWorld>(expected).expect("world wire"),
                world
            );
        }
    }
}
