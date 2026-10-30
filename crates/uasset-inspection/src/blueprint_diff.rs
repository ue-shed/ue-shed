//! What a change did to a Blueprint's logic: two saved graph projections compared by identity.
//!
//! Graphs pair by `GraphGuid`, then object path, then name. Nodes pair by a `NodeGuid` that is
//! unique on both sides, else by object path; pins pair by id, then by direction and name. Wires
//! compare through those pairings, so a recompile that renumbers `K2Node_CallFunction_12` to `_13`
//! keeps its wires.
//!
//! Moving a node, renumbering it and editor or compiler bookkeeping (comment bubbles, compiler
//! messages, a pin's hidden flag) are not changes. Moves and renumbering are counted, so a reader
//! can tell a tidied graph from an untouched one. A node one side could not read is neither added
//! nor removed: it is counted as unread.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::blueprint::{
    BlueprintComponentNode, BlueprintGraph, BlueprintGraphCoverageGapReason,
    BlueprintGraphProjection, BlueprintNode, BlueprintPin, BlueprintPinContainerType,
    BlueprintPinDirection, BlueprintPinReference, BlueprintPinType, BlueprintVariable,
};
use crate::generic::PropertyOutput;

/// Longest value a change shows; longer ones are cut with an ellipsis.
const VALUE_CHARS: usize = 160;

/// Most changed leaves one property lists before saying how many more.
const LEAVES_PER_PROPERTY: usize = 6;

/// The "before" of a default on a pin that had a wire.
const WIRED: &str = "(wired)";

/// `bHidden`, the first bit of a saved pin's flags. The editor hides a pin it fills in itself,
/// such as a static function's target, whose default object it rewrites as it likes.
const PIN_HIDDEN: u32 = 1;

fn hidden(pin: &BlueprintPin) -> bool {
    pin.flags & PIN_HIDDEN != 0
}

/// Node properties that record layout, editor state or compiler output rather than logic, or
/// that repeat pins the diff already lists as added and removed.
const QUIET_NODE_PROPERTIES: &[&str] = &[
    "ShowPinForProperties",
    "NumAdditionalInputs",
    "NumOptionPins",
    "NodePosX",
    "NodePosY",
    "NodeGuid",
    "NodeWidth",
    "NodeHeight",
    "ErrorType",
    "ErrorMsg",
    "bHasCompilerMessage",
    "bCommentBubbleVisible",
    "bCommentBubblePinned",
    "bCommentBubbleMakeVisible",
    "AdvancedPinDisplay",
    "bDisplayAsDisabled",
    "NodeUpgradeMessage",
];

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintDiff {
    pub counts: BlueprintDiffCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_class: Option<BlueprintValueChange>,
    pub variables: Vec<BlueprintVariableChange>,
    /// Components the Blueprint adds, by the after side's order, then removed ones.
    pub components: Vec<BlueprintComponentChange>,
    /// Changed class defaults, by property path.
    pub defaults: Vec<BlueprintFieldEdit>,
    /// Graphs with at least one change: the after side's order, then removed graphs.
    pub graphs: Vec<BlueprintGraphDiff>,
}

/// How much changed, and how much moved or was renumbered without changing.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintDiffCounts {
    pub graphs_added: u32,
    pub graphs_removed: u32,
    pub graphs_changed: u32,
    pub graphs_unchanged: u32,
    pub nodes_added: u32,
    pub nodes_removed: u32,
    pub nodes_changed: u32,
    pub nodes_unchanged: u32,
    /// Paired nodes whose position changed; changed or not.
    pub nodes_moved: u32,
    /// Paired nodes whose object path changed, as a recompile or a copy renumbers them.
    pub nodes_renumbered: u32,
    /// Nodes one side lists but could not read, left out of the comparison.
    pub nodes_unread: u32,
    pub wires_added: u32,
    pub wires_removed: u32,
    pub wires_rewired: u32,
    pub variables_changed: u32,
    pub components_changed: u32,
    pub defaults_changed: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlueprintChangeStatus {
    Added,
    Removed,
    Changed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintValueChange {
    pub before: String,
    pub after: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintGraphDiff {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    pub status: BlueprintChangeStatus,
    pub nodes: Vec<BlueprintNodeChange>,
    /// Wires between nodes on both sides; wires of added and removed nodes are on those nodes.
    pub wires: Vec<BlueprintWireChange>,
}

/// A node as a change names it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintNodeLabel {
    pub title: String,
    /// The node class's short name, such as `K2Node_IfThenElse`.
    pub class: String,
    pub object_path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintNodeChange {
    pub status: BlueprintChangeStatus,
    pub node: BlueprintNodeLabel,
    /// The before side's label, when its title or class differs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<BlueprintNodeLabel>,
    pub edits: Vec<BlueprintNodeEdit>,
    /// An added or removed node's wires, from its pin to the other node's.
    pub wires: Vec<BlueprintNodeWire>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlueprintNodeEdit {
    PinAdded {
        pin: String,
        direction: BlueprintPinDirection,
        pin_type: String,
    },
    PinRemoved {
        pin: String,
        direction: BlueprintPinDirection,
        pin_type: String,
    },
    PinDefault {
        pin: String,
        before: String,
        after: String,
    },
    PinType {
        pin: String,
        before: String,
        after: String,
    },
    Property {
        name: String,
        before: String,
        after: String,
    },
}

/// One end of a wire, named by node title and pin.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct BlueprintEndpoint {
    pub node: String,
    pub pin: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintNodeWire {
    pub pin: String,
    pub other: BlueprintEndpoint,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintWireChange {
    pub status: BlueprintChangeStatus,
    pub from: BlueprintEndpoint,
    pub to: BlueprintEndpoint,
    /// For a rewired wire, the end that moved: where it went before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<BlueprintWireEnd>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintWireEnd {
    /// `from` or `to`: which end moved.
    pub end: BlueprintWireSide,
    pub endpoint: BlueprintEndpoint,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlueprintWireSide {
    From,
    To,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintVariableChange {
    pub status: BlueprintChangeStatus,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    pub edits: Vec<BlueprintFieldEdit>,
}

/// A component the Blueprint's construction script adds, as a change names it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintComponentChange {
    pub status: BlueprintChangeStatus,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    /// The component class's short name, such as `StaticMeshComponent`.
    pub class: String,
    /// What changed on a kept component: `class`, `parent`, `socket` or a template property.
    pub edits: Vec<BlueprintFieldEdit>,
}

/// One changed field of a variable, a component or the class defaults.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintFieldEdit {
    /// `type`, `default`, `category`, `flags`, a component's `class`, `parent` or `socket`, or a
    /// property's path.
    pub field: String,
    pub before: String,
    pub after: String,
}

/// One page of a diff: its counts and parent class always, and up to `limit` of its entries from
/// `offset`, in the diff's order. An entry is a variable, a component, a class default, or a node
/// or wire of a graph; a graph with no node or wire entry (renamed only) is one entry itself.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlueprintDiffPage {
    pub counts: BlueprintDiffCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_class: Option<BlueprintValueChange>,
    /// Entries in the whole diff.
    pub total: u32,
    pub offset: u32,
    pub variables: Vec<BlueprintVariableChange>,
    pub components: Vec<BlueprintComponentChange>,
    pub defaults: Vec<BlueprintFieldEdit>,
    /// The graphs this page's entries belong to, each with only those entries.
    pub graphs: Vec<BlueprintGraphDiff>,
}

impl BlueprintDiff {
    /// Entries in the diff, as [`BlueprintDiff::page`] counts them.
    #[must_use]
    pub fn total(&self) -> usize {
        self.variables.len()
            + self.components.len()
            + self.defaults.len()
            + self
                .graphs
                .iter()
                .map(|graph| (graph.nodes.len() + graph.wires.len()).max(1))
                .sum::<usize>()
    }

    /// Up to `limit` entries from `offset`.
    #[must_use]
    pub fn page(&self, offset: usize, limit: usize) -> BlueprintDiffPage {
        let end = offset.saturating_add(limit);
        let mut at = 0;
        // The part of the next `length` entries the page holds, as positions within them.
        let mut window = |length: usize| {
            let start = at;
            at += length;
            let from = offset.clamp(start, at) - start;
            let to = end.clamp(start, at) - start;
            from..to
        };
        let variables = self.variables[window(self.variables.len())].to_vec();
        let components = self.components[window(self.components.len())].to_vec();
        let defaults = self.defaults[window(self.defaults.len())].to_vec();
        let mut graphs = Vec::new();
        for graph in &self.graphs {
            let nodes = graph.nodes.len();
            let range = window((nodes + graph.wires.len()).max(1));
            if range.is_empty() {
                continue;
            }
            let wires = range.start.max(nodes) - nodes..range.end.max(nodes) - nodes;
            graphs.push(BlueprintGraphDiff {
                name: graph.name.clone(),
                previous_name: graph.previous_name.clone(),
                status: graph.status,
                nodes: graph.nodes[range.start.min(nodes)..range.end.min(nodes)].to_vec(),
                wires: graph
                    .wires
                    .get(wires)
                    .map(<[_]>::to_vec)
                    .unwrap_or_default(),
            });
        }
        BlueprintDiffPage {
            counts: self.counts,
            parent_class: self.parent_class.clone(),
            total: count(self.total()),
            offset: count(offset),
            variables,
            components,
            defaults,
            graphs,
        }
    }
}

/// Compares two projections of one Blueprint.
#[must_use]
pub fn diff_blueprints(
    before: &BlueprintGraphProjection,
    after: &BlueprintGraphProjection,
) -> BlueprintDiff {
    let mut diff = BlueprintDiff::default();
    let unread = Unread {
        before: missing_nodes(before),
        after: missing_nodes(after),
    };

    let before_parent = before.definition.parent_class.clone().unwrap_or_default();
    let after_parent = after.definition.parent_class.clone().unwrap_or_default();
    if before_parent != after_parent {
        diff.parent_class = Some(BlueprintValueChange {
            before: before_parent,
            after: after_parent,
        });
    }
    diff.variables = diff_variables(
        before.definition.variables.as_deref().unwrap_or_default(),
        after.definition.variables.as_deref().unwrap_or_default(),
    );
    diff.counts.variables_changed = count(diff.variables.len());
    diff.components = diff_components(
        before
            .definition
            .construction_script
            .as_ref()
            .map_or(&[], |script| &script.nodes),
        after
            .definition
            .construction_script
            .as_ref()
            .map_or(&[], |script| &script.nodes),
    );
    diff.counts.components_changed = count(diff.components.len());
    let defaults = |projection: &BlueprintGraphProjection| {
        projection
            .definition
            .default_object
            .as_ref()
            .map(|object| object.properties.clone())
            .unwrap_or_default()
    };
    diff.defaults = property_changes(&defaults(before), &defaults(after))
        .into_iter()
        .map(|(field, before, after)| BlueprintFieldEdit {
            field,
            before,
            after,
        })
        .collect();
    diff.counts.defaults_changed = count(diff.defaults.len());

    let pairs = pair_graphs(&before.graphs, &after.graphs);
    let mut paired_before = HashSet::new();
    for (after_index, graph) in after.graphs.iter().enumerate() {
        let previous = pairs.get(&after_index).map(|&index| &before.graphs[index]);
        if let Some(index) = pairs.get(&after_index) {
            paired_before.insert(*index);
        }
        let graph_diff = match previous {
            Some(previous) => diff_graph(previous, graph, &unread, &mut diff.counts),
            None => {
                diff.counts.graphs_added += 1;
                Some(whole_graph(
                    graph,
                    BlueprintChangeStatus::Added,
                    &mut diff.counts,
                ))
            }
        };
        match graph_diff {
            Some(graph_diff) => {
                if graph_diff.status == BlueprintChangeStatus::Changed {
                    diff.counts.graphs_changed += 1;
                }
                diff.graphs.push(graph_diff);
            }
            None => diff.counts.graphs_unchanged += 1,
        }
    }
    for (index, graph) in before.graphs.iter().enumerate() {
        if !paired_before.contains(&index) {
            diff.counts.graphs_removed += 1;
            diff.graphs.push(whole_graph(
                graph,
                BlueprintChangeStatus::Removed,
                &mut diff.counts,
            ));
        }
    }
    diff
}

/// Node paths each side lists in a graph but could not read.
struct Unread {
    before: HashSet<String>,
    after: HashSet<String>,
}

fn missing_nodes(projection: &BlueprintGraphProjection) -> HashSet<String> {
    projection
        .coverage_gaps
        .iter()
        .filter(|gap| gap.reason == BlueprintGraphCoverageGapReason::MissingNodeReference)
        .map(|gap| gap.object_path.clone())
        .collect()
}

fn pair_graphs(before: &[BlueprintGraph], after: &[BlueprintGraph]) -> HashMap<usize, usize> {
    let mut pairs = HashMap::new();
    let mut taken = HashSet::new();
    let keys: [fn(&BlueprintGraph) -> Option<&str>; 3] = [
        |graph| graph.guid.as_deref(),
        |graph| Some(graph.object_path.as_str()),
        |graph| Some(graph.name.as_str()),
    ];
    for key in keys {
        let index: HashMap<&str, usize> = unique_by(before, |graph| key(graph));
        for (after_index, graph) in after.iter().enumerate() {
            if pairs.contains_key(&after_index) {
                continue;
            }
            let Some(&before_index) = key(graph).and_then(|value| index.get(value)) else {
                continue;
            };
            if taken.insert(before_index) {
                pairs.insert(after_index, before_index);
            }
        }
    }
    pairs
}

/// Index by a key that appears once; repeated keys are left out, as they cannot pair.
fn unique_by<'a, T>(
    items: &'a [T],
    key: impl Fn(&'a T) -> Option<&'a str>,
) -> HashMap<&'a str, usize> {
    let mut index = HashMap::new();
    let mut repeated = HashSet::new();
    for (position, item) in items.iter().enumerate() {
        let Some(value) = key(item) else { continue };
        if index.insert(value, position).is_some() {
            repeated.insert(value);
        }
    }
    for value in repeated {
        index.remove(value);
    }
    index
}

/// A graph that only one side has: every node added or removed, with its wires.
fn whole_graph(
    graph: &BlueprintGraph,
    status: BlueprintChangeStatus,
    counts: &mut BlueprintDiffCounts,
) -> BlueprintGraphDiff {
    let side = Side::new(graph);
    let nodes: Vec<_> = graph
        .nodes
        .iter()
        .map(|node| BlueprintNodeChange {
            status,
            node: label(node),
            previous: None,
            edits: Vec::new(),
            wires: side.node_wires(node, |_| true),
        })
        .collect();
    match status {
        BlueprintChangeStatus::Added => counts.nodes_added += count(nodes.len()),
        _ => counts.nodes_removed += count(nodes.len()),
    }
    BlueprintGraphDiff {
        name: graph.name.clone(),
        previous_name: None,
        status,
        nodes,
        wires: Vec::new(),
    }
}

/// One side of a graph, indexed for wire lookups.
struct Side<'a> {
    nodes: HashMap<&'a str, &'a BlueprintNode>,
    pins: HashMap<(&'a str, &'a str), &'a BlueprintPin>,
    graph: &'a BlueprintGraph,
}

impl<'a> Side<'a> {
    fn new(graph: &'a BlueprintGraph) -> Self {
        let nodes = graph
            .nodes
            .iter()
            .map(|node| (node.object_path.as_str(), node))
            .collect();
        let pins = graph
            .nodes
            .iter()
            .flat_map(|node| {
                node.pins
                    .iter()
                    .map(move |pin| ((node.object_path.as_str(), pin.id.as_str()), pin))
            })
            .collect();
        Self { nodes, pins, graph }
    }

    fn endpoint(&self, reference: &BlueprintPinReference) -> BlueprintEndpoint {
        let node_path = reference.node_object_path.as_deref().unwrap_or_default();
        BlueprintEndpoint {
            node: self
                .nodes
                .get(node_path)
                .map_or_else(|| short_name(node_path).to_owned(), |node| node_title(node)),
            pin: self
                .pins
                .get(&(node_path, reference.pin_id.as_str()))
                .map_or_else(|| reference.pin_id.clone(), |pin| pin_name(pin)),
        }
    }

    /// A node's wires to other nodes that `keep` accepts, by the other node's path.
    fn node_wires(
        &self,
        node: &BlueprintNode,
        keep: impl Fn(&str) -> bool,
    ) -> Vec<BlueprintNodeWire> {
        let own = node.object_path.as_str();
        self.graph
            .links
            .iter()
            .filter_map(|link| {
                let (mine, other) = if link.from.node_object_path.as_deref() == Some(own) {
                    (&link.from, &link.to)
                } else if link.to.node_object_path.as_deref() == Some(own) {
                    (&link.to, &link.from)
                } else {
                    return None;
                };
                let other_path = other.node_object_path.as_deref().unwrap_or_default();
                (other_path != own && keep(other_path)).then(|| BlueprintNodeWire {
                    pin: self.endpoint(mine).pin,
                    other: self.endpoint(other),
                })
            })
            .collect()
    }
}

fn diff_graph(
    before: &BlueprintGraph,
    after: &BlueprintGraph,
    unread: &Unread,
    counts: &mut BlueprintDiffCounts,
) -> Option<BlueprintGraphDiff> {
    let old = Side::new(before);
    let new = Side::new(after);
    let node_pairs = pair_nodes(before, after);
    let paired_before: HashSet<&str> = node_pairs.values().copied().collect();
    // The after side's node path for each paired before node.
    let renamed: HashMap<&str, &str> = node_pairs
        .iter()
        .map(|(after_path, before_path)| (*before_path, *after_path))
        .collect();

    let mut nodes = Vec::new();
    // Each before pin's after pin id, for wires on paired nodes.
    let mut pin_map: HashMap<(&str, &str), &str> = HashMap::new();
    let mut added: HashSet<&str> = HashSet::new();
    for node in &after.nodes {
        let path = node.object_path.as_str();
        let Some(previous) = node_pairs.get(path).and_then(|path| old.nodes.get(path)) else {
            if unread.before.contains(path) {
                counts.nodes_unread += 1;
                continue;
            }
            added.insert(path);
            continue;
        };
        if previous.position != node.position {
            counts.nodes_moved += 1;
        }
        if previous.object_path != node.object_path {
            counts.nodes_renumbered += 1;
        }
        let pins = pair_pins(&previous.pins, &node.pins);
        for (after_pin, before_pin) in &pins {
            pin_map.insert(
                (previous.object_path.as_str(), before_pin.id.as_str()),
                after_pin.id.as_str(),
            );
        }
        let edits = node_edits(previous, node, &pins);
        let relabeled =
            node_title(previous) != node_title(node) || previous.class_path != node.class_path;
        if edits.is_empty() && !relabeled {
            counts.nodes_unchanged += 1;
            continue;
        }
        counts.nodes_changed += 1;
        nodes.push(BlueprintNodeChange {
            status: BlueprintChangeStatus::Changed,
            node: label(node),
            previous: relabeled.then(|| label(previous)),
            edits,
            wires: Vec::new(),
        });
    }
    let mut removed: HashSet<&str> = HashSet::new();
    for node in &before.nodes {
        let path = node.object_path.as_str();
        if paired_before.contains(path) {
            continue;
        }
        if unread.after.contains(path) {
            counts.nodes_unread += 1;
            continue;
        }
        removed.insert(path);
    }

    // Added nodes in the after order, then removed nodes in the before order, each with its wires
    // to nodes both sides have.
    for node in after
        .nodes
        .iter()
        .filter(|node| added.contains(node.object_path.as_str()))
    {
        counts.nodes_added += 1;
        nodes.push(BlueprintNodeChange {
            status: BlueprintChangeStatus::Added,
            node: label(node),
            previous: None,
            edits: Vec::new(),
            wires: new.node_wires(node, |other| {
                !added.contains(other) || other < node.object_path.as_str()
            }),
        });
    }
    for node in before
        .nodes
        .iter()
        .filter(|node| removed.contains(node.object_path.as_str()))
    {
        counts.nodes_removed += 1;
        nodes.push(BlueprintNodeChange {
            status: BlueprintChangeStatus::Removed,
            node: label(node),
            previous: None,
            edits: Vec::new(),
            wires: old.node_wires(node, |other| {
                !removed.contains(other) || other < node.object_path.as_str()
            }),
        });
    }

    // Wires between paired nodes, in after-side identity. A pin the after side no longer has keeps
    // its before id, which no after wire uses, so its wires read as removed.
    let translate = |reference: &BlueprintPinReference| -> Option<(String, String)> {
        let node = reference.node_object_path.as_deref()?;
        let after_node = renamed.get(node)?;
        let pin = pin_map.get(&(node, reference.pin_id.as_str())).map_or_else(
            || format!("removed:{}", reference.pin_id),
            |pin| (*pin).to_owned(),
        );
        Some(((*after_node).to_owned(), pin))
    };
    let own = |reference: &BlueprintPinReference| -> Option<(String, String)> {
        let node = reference.node_object_path.as_deref()?;
        node_pairs
            .contains_key(node)
            .then(|| (node.to_owned(), reference.pin_id.clone()))
    };
    let before_wires: HashSet<_> = before
        .links
        .iter()
        .filter_map(|link| Some(((translate(&link.from)?, translate(&link.to)?), link)))
        .map(|(key, _)| key)
        .collect();
    let after_wires: Vec<_> = after
        .links
        .iter()
        .filter_map(|link| Some(((own(&link.from)?, own(&link.to)?), link)))
        .collect();
    let after_keys: HashSet<_> = after_wires.iter().map(|(key, _)| key.clone()).collect();
    let mut gone: Vec<_> = before
        .links
        .iter()
        .filter_map(|link| {
            let key = (translate(&link.from)?, translate(&link.to)?);
            (!after_keys.contains(&key)).then_some((key, link))
        })
        .collect();
    let mut new_wires: Vec<_> = after_wires
        .into_iter()
        .filter(|(key, _)| !before_wires.contains(key))
        .collect();

    let mut wires = Vec::new();
    // A wire whose one end stayed and whose other moved is rewired, when that end lost and gained
    // exactly one wire.
    for end in [BlueprintWireSide::From, BlueprintWireSide::To] {
        let kept = |key: &((String, String), (String, String))| match end {
            BlueprintWireSide::From => key.1.clone(),
            BlueprintWireSide::To => key.0.clone(),
        };
        let mut lost: HashMap<(String, String), Vec<usize>> = HashMap::new();
        for (index, (key, _)) in gone.iter().enumerate() {
            lost.entry(kept(key)).or_default().push(index);
        }
        let mut gained: HashMap<(String, String), Vec<usize>> = HashMap::new();
        for (index, (key, _)) in new_wires.iter().enumerate() {
            gained.entry(kept(key)).or_default().push(index);
        }
        let mut used_gone = HashSet::new();
        let mut used_new = HashSet::new();
        for (index, (key, link)) in new_wires.iter().enumerate() {
            let anchor = kept(key);
            let (Some([old_index]), Some([_])) = (
                lost.get(&anchor).map(Vec::as_slice),
                gained.get(&anchor).map(Vec::as_slice),
            ) else {
                continue;
            };
            let (_, old_link) = &gone[*old_index];
            let moved = match end {
                BlueprintWireSide::From => &old_link.from,
                BlueprintWireSide::To => &old_link.to,
            };
            counts.wires_rewired += 1;
            wires.push(BlueprintWireChange {
                status: BlueprintChangeStatus::Changed,
                from: new.endpoint(&link.from),
                to: new.endpoint(&link.to),
                previous: Some(BlueprintWireEnd {
                    end,
                    endpoint: old.endpoint(moved),
                }),
            });
            used_gone.insert(*old_index);
            used_new.insert(index);
        }
        gone = gone
            .into_iter()
            .enumerate()
            .filter_map(|(index, wire)| (!used_gone.contains(&index)).then_some(wire))
            .collect();
        new_wires = new_wires
            .into_iter()
            .enumerate()
            .filter_map(|(index, wire)| (!used_new.contains(&index)).then_some(wire))
            .collect();
    }
    for (_, link) in &new_wires {
        counts.wires_added += 1;
        wires.push(BlueprintWireChange {
            status: BlueprintChangeStatus::Added,
            from: new.endpoint(&link.from),
            to: new.endpoint(&link.to),
            previous: None,
        });
    }
    for (_, link) in &gone {
        counts.wires_removed += 1;
        wires.push(BlueprintWireChange {
            status: BlueprintChangeStatus::Removed,
            from: old.endpoint(&link.from),
            to: old.endpoint(&link.to),
            previous: None,
        });
    }

    let renamed_graph = before.name != after.name;
    (renamed_graph || !nodes.is_empty() || !wires.is_empty()).then(|| BlueprintGraphDiff {
        name: after.name.clone(),
        previous_name: renamed_graph.then(|| before.name.clone()),
        status: BlueprintChangeStatus::Changed,
        nodes,
        wires,
    })
}

/// After node path → before node path, by a GUID unique on both sides, then by object path.
fn pair_nodes<'a>(
    before: &'a BlueprintGraph,
    after: &'a BlueprintGraph,
) -> HashMap<&'a str, &'a str> {
    let mut pairs = HashMap::new();
    let mut taken = HashSet::new();
    let before_guids = unique_by(&before.nodes, |node| node.guid.as_deref());
    let after_guids = unique_by(&after.nodes, |node| node.guid.as_deref());
    for node in &after.nodes {
        let Some(guid) = node.guid.as_deref() else {
            continue;
        };
        if !after_guids.contains_key(guid) {
            continue;
        }
        if let Some(&index) = before_guids.get(guid) {
            let previous = before.nodes[index].object_path.as_str();
            taken.insert(previous);
            pairs.insert(node.object_path.as_str(), previous);
        }
    }
    let before_paths: HashSet<&str> = before
        .nodes
        .iter()
        .map(|node| node.object_path.as_str())
        .collect();
    for node in &after.nodes {
        let path = node.object_path.as_str();
        if !pairs.contains_key(path) && before_paths.contains(path) && taken.insert(path) {
            pairs.insert(path, path);
        }
    }
    pairs
}

/// After pin → before pin, by id, then by direction and name.
fn pair_pins<'a>(
    before: &'a [BlueprintPin],
    after: &'a [BlueprintPin],
) -> Vec<(&'a BlueprintPin, &'a BlueprintPin)> {
    let by_id: HashMap<&str, &BlueprintPin> =
        before.iter().map(|pin| (pin.id.as_str(), pin)).collect();
    let mut taken: HashSet<&str> = HashSet::new();
    let mut pairs = Vec::new();
    let mut unpaired = Vec::new();
    for pin in after {
        match by_id.get(pin.id.as_str()) {
            Some(previous) if taken.insert(previous.id.as_str()) => pairs.push((pin, *previous)),
            _ => unpaired.push(pin),
        }
    }
    for pin in unpaired {
        if let Some(previous) = before.iter().find(|previous| {
            !taken.contains(previous.id.as_str())
                && previous.direction == pin.direction
                && previous.name == pin.name
        }) {
            taken.insert(previous.id.as_str());
            pairs.push((pin, previous));
        }
    }
    pairs
}

fn node_edits(
    before: &BlueprintNode,
    after: &BlueprintNode,
    pins: &[(&BlueprintPin, &BlueprintPin)],
) -> Vec<BlueprintNodeEdit> {
    let mut edits = Vec::new();
    let paired_after: HashSet<&str> = pins.iter().map(|(pin, _)| pin.id.as_str()).collect();
    let paired_before: HashSet<&str> = pins.iter().map(|(_, pin)| pin.id.as_str()).collect();
    // Hidden pins are the editor's: their coming and going, types and defaults are not listed.
    for pin in after
        .pins
        .iter()
        .filter(|pin| !paired_after.contains(pin.id.as_str()) && !hidden(pin))
    {
        edits.push(BlueprintNodeEdit::PinAdded {
            pin: pin_name(pin),
            direction: pin.direction,
            pin_type: type_label(&pin.pin_type),
        });
    }
    for pin in before
        .pins
        .iter()
        .filter(|pin| !paired_before.contains(pin.id.as_str()) && !hidden(pin))
    {
        edits.push(BlueprintNodeEdit::PinRemoved {
            pin: pin_name(pin),
            direction: pin.direction,
            pin_type: type_label(&pin.pin_type),
        });
    }
    // Pins in the after node's order.
    for pin in &after.pins {
        let Some((_, previous)) = pins.iter().find(|(paired, _)| paired.id == pin.id) else {
            continue;
        };
        if hidden(pin) {
            continue;
        }
        let (old_type, new_type) = (type_label(&previous.pin_type), type_label(&pin.pin_type));
        if !same_type(&previous.pin_type, &pin.pin_type) {
            edits.push(BlueprintNodeEdit::PinType {
                pin: pin_name(pin),
                before: old_type,
                after: new_type,
            });
        }
        // A linked pin's default is unused: a pin that is now wired lists the wire instead. An
        // input that lost its wire shows the default that now applies, if it has one; the wire
        // it lost is listed already.
        let old_default = if hidden(previous) {
            String::new()
        } else {
            pin_default(previous)
        };
        let new_default = pin_default(pin);
        let unwired = !previous.linked_to.is_empty()
            && pin.direction == BlueprintPinDirection::Input
            && !new_default.is_empty();
        if pin.linked_to.is_empty()
            && (unwired || (previous.linked_to.is_empty() && old_default != new_default))
        {
            edits.push(BlueprintNodeEdit::PinDefault {
                pin: pin_name(pin),
                before: if previous.linked_to.is_empty() {
                    clip(&old_default)
                } else {
                    WIRED.to_owned()
                },
                after: clip(&new_default),
            });
        }
    }
    for (name, old_value, new_value) in property_changes(&before.properties, &after.properties) {
        edits.push(BlueprintNodeEdit::Property {
            name,
            before: old_value,
            after: new_value,
        });
    }
    edits
}

/// Changed node properties, leaving out layout and editor state. A struct or array compares by
/// its leaves, named by path (`FunctionReference.MemberParent`, `Options[2]`), so a change shows
/// the field that changed rather than the whole value; a property lists at most
/// `LEAVES_PER_PROPERTY` of them, then how many more.
fn property_changes(
    before: &[PropertyOutput],
    after: &[PropertyOutput],
) -> Vec<(String, String, String)> {
    let leaves = |properties: &[PropertyOutput]| -> Vec<(String, Vec<(String, String)>)> {
        properties
            .iter()
            .filter(|property| !QUIET_NODE_PROPERTIES.contains(&property.name.as_str()))
            .map(|property| {
                let mut leaves = Vec::new();
                let value = serde_json::to_value(&property.value).unwrap_or_default();
                flatten(&property.name, &value, &mut leaves);
                (property.name.clone(), leaves)
            })
            .collect()
    };
    let old = leaves(before);
    let new = leaves(after);
    let mut names: Vec<&str> = new.iter().map(|(name, _)| name.as_str()).collect();
    for (name, _) in &old {
        if !names.contains(&name.as_str()) {
            names.push(name);
        }
    }
    let find = |side: &[(String, Vec<(String, String)>)], name: &str| -> HashMap<String, String> {
        side.iter()
            .find(|(property, _)| property == name)
            .map(|(_, leaves)| leaves.iter().cloned().collect())
            .unwrap_or_default()
    };
    let mut changes = Vec::new();
    for name in names {
        let (old_leaves, new_leaves) = (find(&old, name), find(&new, name));
        let mut paths: Vec<&String> = new_leaves.keys().chain(old_leaves.keys()).collect();
        paths.sort();
        paths.dedup();
        let changed: Vec<_> = paths
            .into_iter()
            .filter_map(|path| {
                // A member's GUID is how the reference was saved; its name and parent say what
                // it refers to.
                if path.ends_with(".MemberGuid") {
                    return None;
                }
                let previous = old_leaves.get(path).map_or("", String::as_str);
                let value = new_leaves.get(path).map_or("", String::as_str);
                (previous != value).then(|| (path.clone(), clip(previous), clip(value)))
            })
            .collect();
        let more = changed.len().saturating_sub(LEAVES_PER_PROPERTY);
        changes.extend(changed.into_iter().take(LEAVES_PER_PROPERTY));
        if more > 0 {
            changes.push((format!("{name} …"), String::new(), format!("{more} more")));
        }
    }
    changes
}

/// A property value's leaves, by path: struct fields by name, array and set items by position,
/// everything else as its value.
fn flatten(path: &str, value: &serde_json::Value, leaves: &mut Vec<(String, String)>) {
    use serde_json::Value;
    let kind = value.get("value_kind").and_then(Value::as_str);
    let named = |key: &str| -> Option<&Vec<Value>> { value.get(key).and_then(Value::as_array) };
    match (kind, named("properties"), named("fields"), named("values")) {
        (Some("struct"), Some(fields), _, _) | (Some("native_struct"), _, Some(fields), _) => {
            for field in fields {
                let name = field.get("name").and_then(Value::as_str).unwrap_or("?");
                let inner = field
                    .get("value")
                    .filter(|inner| inner.is_object())
                    .unwrap_or(field);
                flatten(&format!("{path}.{name}"), inner, leaves);
            }
        }
        (Some("array" | "set"), _, _, Some(items)) => {
            for (index, item) in items.iter().enumerate() {
                flatten(&format!("{path}[{index}]"), item, leaves);
            }
        }
        _ => leaves.push((path.to_owned(), leaf(value))),
    }
}

/// A leaf as written: a string bare, anything else as compact JSON.
fn leaf(value: &serde_json::Value) -> String {
    match value.get("value") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(inner) => inner.to_string(),
        None => value.to_string(),
    }
}

fn diff_variables(
    before: &[BlueprintVariable],
    after: &[BlueprintVariable],
) -> Vec<BlueprintVariableChange> {
    let name = |variable: &BlueprintVariable| variable.name.clone().unwrap_or_default();
    let mut taken = HashSet::new();
    let mut changes = Vec::new();
    for variable in after {
        let previous = before.iter().enumerate().find(|(index, previous)| {
            !taken.contains(index)
                && match (&previous.guid, &variable.guid) {
                    (Some(old), Some(new)) => old == new,
                    _ => previous.name == variable.name,
                }
        });
        let Some((index, previous)) = previous else {
            changes.push(BlueprintVariableChange {
                status: BlueprintChangeStatus::Added,
                name: name(variable),
                previous_name: None,
                edits: Vec::new(),
            });
            continue;
        };
        taken.insert(index);
        let mut edits = Vec::new();
        let old_type = previous
            .pin_type
            .as_ref()
            .map(type_label)
            .unwrap_or_default();
        let new_type = variable
            .pin_type
            .as_ref()
            .map(type_label)
            .unwrap_or_default();
        if old_type != new_type {
            edits.push(BlueprintFieldEdit {
                field: "type".to_owned(),
                before: old_type,
                after: new_type,
            });
        }
        let fields = [
            (
                "default",
                previous.default_value.clone(),
                variable.default_value.clone(),
            ),
            (
                "category",
                previous.category.as_ref().map(|text| text.source.clone()),
                variable.category.as_ref().map(|text| text.source.clone()),
            ),
            (
                "flags",
                previous.property_flags.clone(),
                variable.property_flags.clone(),
            ),
        ];
        for (field, old, new) in fields {
            if old != new {
                edits.push(BlueprintFieldEdit {
                    field: field.to_owned(),
                    before: clip(&old.unwrap_or_default()),
                    after: clip(&new.unwrap_or_default()),
                });
            }
        }
        for (field, old, new) in property_changes(&previous.properties, &variable.properties) {
            edits.push(BlueprintFieldEdit {
                field,
                before: old,
                after: new,
            });
        }
        let renamed = previous.name != variable.name;
        if renamed || !edits.is_empty() {
            changes.push(BlueprintVariableChange {
                status: BlueprintChangeStatus::Changed,
                name: name(variable),
                previous_name: renamed.then(|| name(previous)),
                edits,
            });
        }
    }
    for (index, variable) in before.iter().enumerate() {
        if !taken.contains(&index) {
            changes.push(BlueprintVariableChange {
                status: BlueprintChangeStatus::Removed,
                name: name(variable),
                previous_name: None,
                edits: Vec::new(),
            });
        }
    }
    changes
}

/// A node's title as the editor would read it: the member it calls or reads, else its class
/// without the `K2Node_` prefix, as the graph viewer shows it.
fn node_title(node: &BlueprintNode) -> String {
    let class = short_name(&node.class_path);
    if node.title == class {
        class.strip_prefix("K2Node_").unwrap_or(class).to_owned()
    } else {
        node.title.clone()
    }
}

/// Components pair by GUID, then by variable name. A kept component lists its class, the parent
/// it attaches to and the socket it uses if they changed, then its template's changed properties.
fn diff_components(
    before: &[BlueprintComponentNode],
    after: &[BlueprintComponentNode],
) -> Vec<BlueprintComponentChange> {
    let (old_parents, new_parents) = (component_parents(before), component_parents(after));
    let by_guid = unique_by(before, |node| node.guid.as_deref());
    let by_name = unique_by(before, |node| node.variable_name.as_deref());
    let mut taken = HashSet::new();
    let mut changes = Vec::new();
    for node in after {
        let previous = [
            node.guid.as_deref().and_then(|guid| by_guid.get(guid)),
            node.variable_name
                .as_deref()
                .and_then(|variable| by_name.get(variable)),
        ]
        .into_iter()
        .flatten()
        .copied()
        .find(|index| !taken.contains(index));
        let Some(index) = previous else {
            changes.push(BlueprintComponentChange {
                status: BlueprintChangeStatus::Added,
                name: component_name(node),
                previous_name: None,
                class: component_class(node),
                edits: Vec::new(),
            });
            continue;
        };
        taken.insert(index);
        let previous = &before[index];
        let mut edits = Vec::new();
        let fields = [
            ("class", component_class(previous), component_class(node)),
            (
                "parent",
                old_parents
                    .get(&previous.object_path)
                    .cloned()
                    .unwrap_or_default(),
                new_parents
                    .get(&node.object_path)
                    .cloned()
                    .unwrap_or_default(),
            ),
            (
                "socket",
                previous.attach_to_name.clone().unwrap_or_default(),
                node.attach_to_name.clone().unwrap_or_default(),
            ),
        ];
        for (field, old, new) in fields {
            if old != new {
                edits.push(BlueprintFieldEdit {
                    field: field.to_owned(),
                    before: clip(&old),
                    after: clip(&new),
                });
            }
        }
        let template = |node: &BlueprintComponentNode| {
            node.template
                .as_ref()
                .map(|template| template.properties.clone())
                .unwrap_or_default()
        };
        for (field, old, new) in property_changes(&template(previous), &template(node)) {
            edits.push(BlueprintFieldEdit {
                field,
                before: old,
                after: new,
            });
        }
        let renamed = component_name(previous) != component_name(node);
        if renamed || !edits.is_empty() {
            changes.push(BlueprintComponentChange {
                status: BlueprintChangeStatus::Changed,
                name: component_name(node),
                previous_name: renamed.then(|| component_name(previous)),
                class: component_class(node),
                edits,
            });
        }
    }
    for (index, node) in before.iter().enumerate() {
        if !taken.contains(&index) {
            changes.push(BlueprintComponentChange {
                status: BlueprintChangeStatus::Removed,
                name: component_name(node),
                previous_name: None,
                class: component_class(node),
                edits: Vec::new(),
            });
        }
    }
    changes
}

fn component_name(node: &BlueprintComponentNode) -> String {
    node.variable_name
        .clone()
        .unwrap_or_else(|| short_name(&node.object_path).to_owned())
}

fn component_class(node: &BlueprintComponentNode) -> String {
    node.component_class
        .as_deref()
        .map(short_name)
        .unwrap_or_default()
        .to_owned()
}

/// Each component's parent, by its object path: the component whose children name it, else the
/// inherited component a root attaches to.
fn component_parents(nodes: &[BlueprintComponentNode]) -> HashMap<String, String> {
    let mut parents = HashMap::new();
    for node in nodes {
        for child in node.children.iter().flatten() {
            parents.insert(child.clone(), component_name(node));
        }
    }
    for node in nodes {
        if let Some(parent) = &node.parent_component_name {
            parents
                .entry(node.object_path.clone())
                .or_insert_with(|| parent.clone());
        }
    }
    parents
}

fn label(node: &BlueprintNode) -> BlueprintNodeLabel {
    BlueprintNodeLabel {
        title: node_title(node),
        class: short_name(&node.class_path).to_owned(),
        object_path: node.object_path.clone(),
    }
}

fn pin_name(pin: &BlueprintPin) -> String {
    pin.friendly_name
        .as_ref()
        .map(|text| text.source.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| pin.name.clone())
}

/// A pin's default as written: its text, its object or its value.
fn pin_default(pin: &BlueprintPin) -> String {
    pin.default_text_value
        .as_ref()
        .map(|text| text.source.clone())
        .or_else(|| pin.default_object.clone())
        .unwrap_or_else(|| pin.default_value.clone())
}

/// Types compare by what they hold, not by how a member reference was saved.
fn same_type(before: &BlueprintPinType, after: &BlueprintPinType) -> bool {
    before.category == after.category
        && before.subcategory == after.subcategory
        && before.subcategory_object == after.subcategory_object
        && before.container_type == after.container_type
        && before.value_type == after.value_type
        && before.is_reference == after.is_reference
        && before.is_const == after.is_const
}

fn type_label(pin_type: &BlueprintPinType) -> String {
    let inner = pin_type
        .subcategory_object
        .as_deref()
        .map(short_name)
        .filter(|name| !name.is_empty() && *name != "None")
        .or_else(|| (!pin_type.subcategory.is_empty()).then_some(pin_type.subcategory.as_str()))
        .unwrap_or(pin_type.category.as_str());
    let mut label = match pin_type.container_type {
        BlueprintPinContainerType::None => inner.to_owned(),
        BlueprintPinContainerType::Array => format!("Array of {inner}"),
        BlueprintPinContainerType::Set => format!("Set of {inner}"),
        BlueprintPinContainerType::Map => {
            let value = pin_type.value_type.as_ref().map_or("", |value| {
                value
                    .subcategory_object
                    .as_deref()
                    .map(short_name)
                    .unwrap_or(value.category.as_str())
            });
            format!("Map of {inner} to {value}")
        }
    };
    if pin_type.is_reference {
        label.push_str(" (by ref)");
    }
    label
}

fn short_name(path: &str) -> &str {
    path.rsplit(['.', ':', '/']).next().unwrap_or(path)
}

fn clip(value: &str) -> String {
    if value.chars().count() <= VALUE_CHARS {
        return value.to_owned();
    }
    let mut clipped: String = value.chars().take(VALUE_CHARS - 1).collect();
    clipped.push('…');
    clipped
}

fn count(length: usize) -> u32 {
    u32::try_from(length).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests;
