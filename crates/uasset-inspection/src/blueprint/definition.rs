//! Saved declarations and component templates, independent of Blueprint execution.
use super::*;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BlueprintDefinition {
    pub parent_class: Option<String>,
    pub variables: Option<Vec<BlueprintVariable>>,
    pub default_object: Option<BlueprintSavedObject>,
    pub construction_script: Option<BlueprintConstructionScript>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BlueprintVariable {
    pub name: Option<String>,
    pub guid: Option<String>,
    pub pin_type: Option<BlueprintPinType>,
    pub category: Option<BlueprintText>,
    /// Decimal string preserves all 64 property flag bits across JavaScript boundaries.
    pub property_flags: Option<String>,
    pub default_value: Option<String>,
    pub properties: Vec<PropertyOutput>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BlueprintSavedObject {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_data: Option<Box<crate::generic::PropertyValueOutput>>,
    pub object_path: String,
    pub class_path: String,
    pub properties: Vec<PropertyOutput>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BlueprintConstructionScript {
    pub object_path: String,
    pub root_nodes: Option<Vec<String>>,
    pub nodes: Vec<BlueprintComponentNode>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct BlueprintComponentNode {
    pub object_path: String,
    pub variable_name: Option<String>,
    pub guid: Option<String>,
    pub component_class: Option<String>,
    pub template: Option<BlueprintSavedObject>,
    pub children: Option<Vec<String>>,
    pub attach_to_name: Option<String>,
    pub parent_component_name: Option<String>,
    pub parent_owner_class_name: Option<String>,
    pub parent_is_native: Option<bool>,
}

fn issue(gaps: &mut Vec<BlueprintGraphCoverageGap>, owner: &str, detail: impl Into<String>) {
    coverage_gap(
        gaps,
        owner,
        BlueprintGraphCoverageGapReason::IncompleteDefinition,
        detail,
    );
}

pub(super) fn project(
    package: &Package,
    assets: &[DecodedAsset],
    path: &str,
    gaps: &mut Vec<BlueprintGraphCoverageGap>,
) -> BlueprintDefinition {
    let all: HashMap<_, _> = objects(assets)
        .map(|o| (o.object_path.as_str(), o))
        .collect();
    let Some(root) = all.get(path) else {
        issue(gaps, path, "Blueprint root properties were not decoded");
        return BlueprintDefinition {
            parent_class: None,
            variables: None,
            default_object: None,
            construction_script: None,
        };
    };
    let fields = &root.properties;
    let variables = match property(package, fields, "NewVariables") {
        None => None,
        Some(PropertyValue::Array(values)) => Some(
            values
                .iter()
                .filter_map(|v| {
                    let PropertyValue::Struct(v) = v else {
                        issue(gaps, path, "NewVariables contains a non-record value");
                        return None;
                    };
                    let pin_type =
                        property(package, v, "VarType").and_then(|v| pin_type(package, v));
                    check_properties(v, path, gaps);
                    if pin_type.is_none() {
                        issue(gaps, path, "NewVariables.VarType is absent or unsupported");
                    }
                    let category = property(package, v, "Category").and_then(|v| {
                        if let PropertyValue::Text(v) = v {
                            Some(BlueprintText {
                                source: v.source.clone(),
                                namespace: text_identity_parts(v).0,
                                key: text_identity_parts(v).1,
                            })
                        } else {
                            None
                        }
                    });
                    let property_flags =
                        property(package, v, "PropertyFlags").and_then(|v| match v {
                            PropertyValue::UInt(v) => Some(v.to_string()),
                            PropertyValue::Int(v) => Some(v.to_string()),
                            _ => None,
                        });
                    Some(BlueprintVariable {
                        name: name_property(package, v, "VarName"),
                        guid: guid_property(package, v, "VarGuid"),
                        pin_type,
                        category,
                        property_flags,
                        default_value: string_property(package, v, "DefaultValue"),
                        properties: property_outputs(package, v.clone()),
                    })
                })
                .collect(),
        ),
        _ => {
            issue(gaps, path, "NewVariables is not an array");
            None
        }
    };
    let generated = reference(package, fields, "GeneratedClass", path, gaps);
    // RF_ClassDefaultObject proves identity; avoid guessing from a Default__ name.
    let default_object = generated.as_ref().and_then(|class| {
        let matches: Vec<_> = package
            .exports
            .iter()
            .filter(|e| {
                e.object_flags & 0x10 != 0
                    && e.class_path.as_ref().is_some_and(|v| v.as_str() == class)
            })
            .collect();
        if matches.len() != 1 {
            issue(
                gaps,
                path,
                "saved class default object is unavailable or ambiguous",
            );
            return None;
        }
        let object = all.get(matches[0].object_path.as_str());
        if object.is_none() {
            issue(gaps, path, "saved class default object was not decoded");
        }
        object.map(|o| saved_object(package, o, gaps))
    });
    let scs_path = reference(package, fields, "SimpleConstructionScript", path, gaps);
    let construction_script = scs_path.and_then(|p| {
        let Some(scs) = all.get(p.as_str()) else {
            issue(gaps, path, format!("construction script {p} unavailable"));
            return None;
        };
        let root_nodes = references(package, &scs.properties, "RootNodes", &p, gaps);
        let mut pending =
            references(package, &scs.properties, "AllNodes", &p, gaps).unwrap_or_default();
        pending.extend(root_nodes.iter().flatten().cloned());
        let mut seen = HashSet::new();
        let mut nodes = Vec::new();
        while let Some(node_path) = pending.pop() {
            if !seen.insert(node_path.clone()) {
                continue;
            }
            let Some(node) = all.get(node_path.as_str()) else {
                issue(gaps, &p, format!("component node {node_path} unavailable"));
                continue;
            };
            let f = &node.properties;
            let children = references(package, f, "ChildNodes", &node_path, gaps);
            pending.extend(children.iter().flatten().cloned());
            let template_path = reference(package, f, "ComponentTemplate", &node_path, gaps);
            let template = template_path.and_then(|p| {
                let object = all.get(p.as_str());
                if object.is_none() {
                    issue(
                        gaps,
                        &node_path,
                        format!("component template {p} unavailable"),
                    );
                }
                object.map(|o| saved_object(package, o, gaps))
            });
            nodes.push(BlueprintComponentNode {
                object_path: node_path.clone(),
                variable_name: name_property(package, f, "InternalVariableName"),
                guid: guid_property(package, f, "VariableGuid"),
                component_class: reference(package, f, "ComponentClass", &node_path, gaps),
                template,
                children,
                attach_to_name: name_property(package, f, "AttachToName"),
                parent_component_name: name_property(package, f, "ParentComponentOrVariableName"),
                parent_owner_class_name: name_property(package, f, "ParentComponentOwnerClassName"),
                parent_is_native: property(package, f, "bIsParentComponentNative").and_then(|v| {
                    if let PropertyValue::Bool(v) = v {
                        Some(*v)
                    } else {
                        None
                    }
                }),
            });
        }
        nodes.sort_by(|a, b| a.object_path.cmp(&b.object_path));
        // A malformed saved graph must remain bounded and visibly incomplete.
        let mut states = HashMap::<&str, u8>::new();
        let children: HashMap<_, _> = nodes
            .iter()
            .map(|n| {
                (
                    n.object_path.as_str(),
                    n.children.as_deref().unwrap_or_default(),
                )
            })
            .collect();
        for node in &nodes {
            let mut stack = vec![(node.object_path.as_str(), false)];
            while let Some((path, done)) = stack.pop() {
                if done {
                    states.insert(path, 2);
                    continue;
                }
                match states.get(path) {
                    Some(1) => {
                        issue(gaps, &p, "component child links contain a cycle");
                        continue;
                    }
                    Some(2) => continue,
                    _ => {}
                }
                states.insert(path, 1);
                stack.push((path, true));
                if let Some(children) = children.get(path) {
                    stack.extend(children.iter().map(|c| (c.as_str(), false)));
                }
            }
        }
        Some(BlueprintConstructionScript {
            object_path: p,
            root_nodes,
            nodes,
        })
    });
    BlueprintDefinition {
        parent_class: reference(package, fields, "ParentClass", path, gaps),
        variables,
        default_object,
        construction_script,
    }
}

fn saved_object(
    package: &Package,
    object: &DecodedUObject,
    gaps: &mut Vec<BlueprintGraphCoverageGap>,
) -> BlueprintSavedObject {
    check_properties(&object.properties, object.object_path.as_str(), gaps);
    if !object.tail.is_empty() {
        issue(
            gaps,
            object.object_path.as_str(),
            format!("{} native object bytes remain undecoded", object.tail.len()),
        );
    }
    BlueprintSavedObject {
        native_data: object
            .native_data
            .clone()
            .map(|value| Box::new(crate::generic::value_output(package, *value))),
        object_path: object.object_path.to_string(),
        class_path: object.class_path.to_string(),
        properties: property_outputs(package, object.properties.clone()),
    }
}
fn check_properties(
    stream: &PropertyStream,
    owner: &str,
    gaps: &mut Vec<BlueprintGraphCoverageGap>,
) {
    if stream.records.iter().any(|v| contains_raw(&v.value)) {
        issue(
            gaps,
            owner,
            "saved definition properties contain undecoded values",
        );
    }
}
fn contains_raw(value: &PropertyValue) -> bool {
    match value {
        PropertyValue::Raw { .. } => true,
        PropertyValue::Struct(v) => v.records.iter().any(|v| contains_raw(&v.value)),
        PropertyValue::NativeStruct { fields } => fields.iter().any(|v| contains_raw(&v.value)),
        PropertyValue::Array(v) | PropertyValue::Set(v) => v.iter().any(contains_raw),
        PropertyValue::Map(v) => v
            .iter()
            .any(|v| contains_raw(&v.key) || contains_raw(&v.value)),
        PropertyValue::InstancedStruct { value, .. } => value.as_deref().is_some_and(contains_raw),
        _ => false,
    }
}
fn name_property(package: &Package, stream: &PropertyStream, name: &str) -> Option<String> {
    let PropertyValue::Name(v) = property(package, stream, name)? else {
        return None;
    };
    package.resolve_name(*v)
}
fn string_property(package: &Package, stream: &PropertyStream, name: &str) -> Option<String> {
    let PropertyValue::String(v) = property(package, stream, name)? else {
        return None;
    };
    Some(v.clone())
}
fn reference(
    package: &Package,
    fields: &PropertyStream,
    field: &str,
    owner: &str,
    gaps: &mut Vec<BlueprintGraphCoverageGap>,
) -> Option<String> {
    match property(package, fields, field)? {
        PropertyValue::ObjectRef(PackageIndex::Null) => None,
        PropertyValue::ObjectRef(v) => {
            let path = resolve_object(package, *v);
            if path.is_none() {
                issue(gaps, owner, format!("{field} has an unresolved reference"));
            }
            path
        }
        _ => {
            issue(gaps, owner, format!("{field} is not an object reference"));
            None
        }
    }
}
fn references(
    package: &Package,
    fields: &PropertyStream,
    field: &str,
    owner: &str,
    gaps: &mut Vec<BlueprintGraphCoverageGap>,
) -> Option<Vec<String>> {
    let PropertyValue::Array(values) = property(package, fields, field)? else {
        issue(gaps, owner, format!("{field} is not an array"));
        return None;
    };
    Some(
        values
            .iter()
            .filter_map(|v| {
                if let PropertyValue::ObjectRef(v) = v
                    && let Some(p) = resolve_object(package, *v)
                {
                    return Some(p);
                }
                issue(
                    gaps,
                    owner,
                    format!("{field} contains an unavailable node reference"),
                );
                None
            })
            .collect(),
    )
}

fn pin_type(package: &Package, value: &PropertyValue) -> Option<BlueprintPinType> {
    let PropertyValue::NativeStruct { fields } = value else {
        return None;
    };
    let field = |name: &str| fields.iter().find(|v| v.name == name).map(|v| &v.value);
    let name = |name: &str| {
        if let Some(PropertyValue::Name(v)) = field(name) {
            package.resolve_name(*v)
        } else {
            None
        }
    };
    let flag = |name: &str| {
        if let Some(PropertyValue::Bool(v)) = field(name) {
            Some(*v)
        } else {
            None
        }
    };
    let object = |name: &str| {
        if let Some(PropertyValue::ObjectRef(v)) = field(name) {
            resolve_object(package, *v)
        } else {
            None
        }
    };
    let container_type = match field("ContainerType")? {
        PropertyValue::UInt(0) => BlueprintPinContainerType::None,
        PropertyValue::UInt(1) => BlueprintPinContainerType::Array,
        PropertyValue::UInt(2) => BlueprintPinContainerType::Set,
        PropertyValue::UInt(3) => BlueprintPinContainerType::Map,
        _ => return None,
    };
    let value_type = if container_type == BlueprintPinContainerType::Map {
        let PropertyValue::NativeStruct { fields } = field("PinValueType")? else {
            return None;
        };
        let f = |name: &str| fields.iter().find(|v| v.name == name).map(|v| &v.value);
        let n = |name: &str| {
            if let Some(PropertyValue::Name(v)) = f(name) {
                package.resolve_name(*v)
            } else {
                None
            }
        };
        let b = |name: &str| {
            if let Some(PropertyValue::Bool(v)) = f(name) {
                Some(*v)
            } else {
                None
            }
        };
        Some(BlueprintTerminalType {
            category: n("TerminalCategory")?,
            subcategory: n("TerminalSubCategory")?,
            subcategory_object: if let Some(PropertyValue::ObjectRef(v)) =
                f("TerminalSubCategoryObject")
            {
                resolve_object(package, *v)
            } else {
                None
            },
            is_const: b("bTerminalIsConst")?,
            is_weak_pointer: b("bTerminalIsWeakPointer")?,
            is_uobject_wrapper: b("bTerminalIsUObjectWrapper")?,
        })
    } else {
        None
    };
    Some(BlueprintPinType {
        category: name("PinCategory")?,
        subcategory: name("PinSubCategory")?,
        subcategory_object: object("PinSubCategoryObject"),
        container_type,
        value_type,
        is_reference: flag("bIsReference")?,
        is_weak_pointer: flag("bIsWeakPointer")?,
        member_reference: BlueprintMemberReference {
            parent: object("MemberParent"),
            name: name("MemberName")?,
            guid: if let Some(PropertyValue::Guid(v)) = field("MemberGuid") {
                (!v.is_zero()).then(|| v.to_string())
            } else {
                None
            },
        },
        is_const: flag("bIsConst")?,
        is_uobject_wrapper: flag("bIsUObjectWrapper")?,
        serialize_as_single_precision_float: flag("bSerializeAsSinglePrecisionFloat")?,
    })
}
