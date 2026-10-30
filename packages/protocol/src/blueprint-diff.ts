import { Schema } from "effect";
import { BlueprintGraphDiagnostic } from "./blueprint-graph.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Whether a graph, node, wire, variable or component was added, removed or changed. */
export const BlueprintChangeStatus = Schema.Literals(["added", "removed", "changed"]);
export type BlueprintChangeStatus = typeof BlueprintChangeStatus.Type;

/**
 * How much a change did, and how much moved or was renumbered without changing. Moved and
 * renumbered nodes are counted, never listed; unread nodes are ones a side could not read, left
 * out of the comparison rather than shown as removed.
 */
export const BlueprintDiffCounts = Schema.Struct({
	graphs_added: Count,
	graphs_removed: Count,
	graphs_changed: Count,
	graphs_unchanged: Count,
	nodes_added: Count,
	nodes_removed: Count,
	nodes_changed: Count,
	nodes_unchanged: Count,
	nodes_moved: Count,
	nodes_renumbered: Count,
	nodes_unread: Count,
	wires_added: Count,
	wires_removed: Count,
	wires_rewired: Count,
	variables_changed: Count,
	components_changed: Count,
	defaults_changed: Count
}).annotate({ identifier: "BlueprintDiffCounts" });
export interface BlueprintDiffCounts extends Schema.Schema.Type<typeof BlueprintDiffCounts> {}

/** A value before and after, each cut at 160 characters. */
export const BlueprintValueChange = Schema.Struct({
	before: Schema.String,
	after: Schema.String
}).annotate({ identifier: "BlueprintValueChange" });
export interface BlueprintValueChange extends Schema.Schema.Type<typeof BlueprintValueChange> {}

/**
 * One changed field of a variable, a component or the class defaults: `type`, `default`,
 * `category`, `flags`, a component's `class`, `parent` or `socket`, or a property's path such as
 * `FunctionReference.MemberParent`. A property with more changed leaves than it lists ends with
 * `<name> …`, whose `after` says how many more.
 */
export const BlueprintFieldEdit = Schema.Struct({
	field: Schema.String,
	before: Schema.String,
	after: Schema.String
}).annotate({ identifier: "BlueprintFieldEdit" });
export interface BlueprintFieldEdit extends Schema.Schema.Type<typeof BlueprintFieldEdit> {}

/** A node as a change names it: the editor's title, its class's short name and its path. */
export const BlueprintNodeLabel = Schema.Struct({
	title: Schema.String,
	class: Schema.String,
	object_path: Schema.String
}).annotate({ identifier: "BlueprintNodeLabel" });
export interface BlueprintNodeLabel extends Schema.Schema.Type<typeof BlueprintNodeLabel> {}

const PinDirection = Schema.Literals(["input", "output"]);

/** One change on a kept node: a pin added, removed or retyped, a pin default or a property. */
export const BlueprintNodeEdit = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("pin_added"),
		pin: Schema.String,
		direction: PinDirection,
		pin_type: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("pin_removed"),
		pin: Schema.String,
		direction: PinDirection,
		pin_type: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("pin_default"),
		pin: Schema.String,
		before: Schema.String,
		after: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("pin_type"),
		pin: Schema.String,
		before: Schema.String,
		after: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("property"),
		name: Schema.String,
		before: Schema.String,
		after: Schema.String
	})
]).annotate({ identifier: "BlueprintNodeEdit" });
export type BlueprintNodeEdit = typeof BlueprintNodeEdit.Type;

/** One end of a wire, named by the node's title and the pin's name. */
export const BlueprintEndpoint = Schema.Struct({
	node: Schema.String,
	pin: Schema.String
}).annotate({ identifier: "BlueprintEndpoint" });
export interface BlueprintEndpoint extends Schema.Schema.Type<typeof BlueprintEndpoint> {}

/**
 * A node added or removed, or changed in place. An added or removed node carries its wires to
 * other nodes; `previous` is the before side's label when the title or class changed.
 */
export const BlueprintNodeChange = Schema.Struct({
	status: BlueprintChangeStatus,
	node: BlueprintNodeLabel,
	previous: Schema.optionalKey(BlueprintNodeLabel),
	edits: Schema.Array(BlueprintNodeEdit),
	wires: Schema.Array(Schema.Struct({ pin: Schema.String, other: BlueprintEndpoint }))
}).annotate({ identifier: "BlueprintNodeChange" });
export interface BlueprintNodeChange extends Schema.Schema.Type<typeof BlueprintNodeChange> {}

/**
 * A wire between two kept nodes, added, removed or rewired. A rewired wire kept one end and
 * moved the other; `previous` says which end moved and where it went before.
 */
export const BlueprintWireChange = Schema.Struct({
	status: BlueprintChangeStatus,
	from: BlueprintEndpoint,
	to: BlueprintEndpoint,
	previous: Schema.optionalKey(
		Schema.Struct({ end: Schema.Literals(["from", "to"]), endpoint: BlueprintEndpoint })
	)
}).annotate({ identifier: "BlueprintWireChange" });
export interface BlueprintWireChange extends Schema.Schema.Type<typeof BlueprintWireChange> {}

/** A graph with at least one change, holding only the entries a page carries. */
export const BlueprintGraphDiff = Schema.Struct({
	name: Schema.String,
	previous_name: Schema.optionalKey(Schema.String),
	status: BlueprintChangeStatus,
	nodes: Schema.Array(BlueprintNodeChange),
	wires: Schema.Array(BlueprintWireChange)
}).annotate({ identifier: "BlueprintGraphDiff" });
export interface BlueprintGraphDiff extends Schema.Schema.Type<typeof BlueprintGraphDiff> {}

/** A variable added, removed, renamed or changed. */
export const BlueprintVariableChange = Schema.Struct({
	status: BlueprintChangeStatus,
	name: Schema.String,
	previous_name: Schema.optionalKey(Schema.String),
	edits: Schema.Array(BlueprintFieldEdit)
}).annotate({ identifier: "BlueprintVariableChange" });
export interface BlueprintVariableChange extends Schema.Schema.Type<
	typeof BlueprintVariableChange
> {}

/** A component the construction script adds: added, removed, renamed or changed. */
export const BlueprintComponentChange = Schema.Struct({
	status: BlueprintChangeStatus,
	name: Schema.String,
	previous_name: Schema.optionalKey(Schema.String),
	class: Schema.String,
	edits: Schema.Array(BlueprintFieldEdit)
}).annotate({ identifier: "BlueprintComponentChange" });
export interface BlueprintComponentChange extends Schema.Schema.Type<
	typeof BlueprintComponentChange
> {}

/**
 * One page of a Blueprint comparison: the whole diff's counts and parent class, and up to the
 * asked-for number of entries from `offset`. An entry is a variable, a component, a class
 * default, or a node or wire of a graph; a graph that is only renamed is one entry. `total`
 * counts the whole diff's entries.
 */
export const BlueprintDiffPage = Schema.Struct({
	counts: BlueprintDiffCounts,
	parent_class: Schema.optionalKey(BlueprintValueChange),
	total: Count,
	offset: Count,
	variables: Schema.Array(BlueprintVariableChange),
	components: Schema.Array(BlueprintComponentChange),
	defaults: Schema.Array(BlueprintFieldEdit),
	graphs: Schema.Array(BlueprintGraphDiff)
}).annotate({ identifier: "BlueprintDiffPage" });
export interface BlueprintDiffPage extends Schema.Schema.Type<typeof BlueprintDiffPage> {}

/**
 * `compare_blueprints`'s result: one page of what a change did to a Blueprint, which sides read
 * in part, what either side holds that the comparison does not read (`widget_layout`,
 * `widget_animations`, `timelines`), and the seconds spent reading, projecting and comparing.
 */
export const BlueprintComparison = Schema.Struct({
	page: BlueprintDiffPage,
	partial: Schema.Struct({ before: Schema.Boolean, after: Schema.Boolean }),
	not_compared: Schema.Array(
		Schema.Literals(["widget_layout", "widget_animations", "timelines"])
	),
	stage_seconds: Schema.Struct({
		read: Schema.Number,
		project: Schema.Number,
		diff: Schema.Number
	})
}).annotate({ identifier: "BlueprintComparison" });
export interface BlueprintComparison extends Schema.Schema.Type<typeof BlueprintComparison> {}

/** One comparison page as a host receives it, with the reader's diagnostics for either side. */
export const BlueprintComparisonRead = Schema.Struct({
	comparison: BlueprintComparison,
	diagnostics: Schema.Array(BlueprintGraphDiagnostic),
	outcome: Schema.Literals(["complete", "partial"])
}).annotate({ identifier: "BlueprintComparisonRead" });
export interface BlueprintComparisonRead extends Schema.Schema.Type<
	typeof BlueprintComparisonRead
> {}
