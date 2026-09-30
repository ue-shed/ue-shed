import type {
	BlueprintGraph,
	BlueprintGraphCoverageGap,
	BlueprintNode,
	BlueprintPin,
	BlueprintPinReference
} from "@ue-shed/protocol";

export interface BlueprintGraphIndexIssue {
	readonly reason: "duplicate_node_path" | "duplicate_pin_id";
	readonly nodeObjectPath: string;
	readonly pinId: string | null;
}

export interface BlueprintGraphIndex {
	readonly graph: BlueprintGraph;
	readonly nodes: ReadonlyMap<string, BlueprintNode>;
	readonly pins: ReadonlyMap<string, ReadonlyMap<string, BlueprintPin>>;
	readonly issues: readonly BlueprintGraphIndexIssue[];
}

/** Ambiguous saved identities are omitted from lookup maps and reported explicitly. */
export function indexBlueprintGraph(graph: BlueprintGraph): BlueprintGraphIndex {
	const nodes = new Map<string, BlueprintNode>();
	const pins = new Map<string, ReadonlyMap<string, BlueprintPin>>();
	const duplicateNodes = new Set<string>();
	const issues: BlueprintGraphIndexIssue[] = [];
	for (const node of graph.nodes) {
		const path = node.object_path;
		if (duplicateNodes.has(path)) continue;
		if (nodes.has(path)) {
			duplicateNodes.add(path);
			nodes.delete(path);
			pins.delete(path);
			issues.push({ reason: "duplicate_node_path", nodeObjectPath: path, pinId: null });
			continue;
		}
		nodes.set(path, node);
		const nodePins = new Map<string, BlueprintPin>();
		const duplicates = new Set<string>();
		for (const pin of node.pins) {
			if (duplicates.has(pin.id)) continue;
			if (nodePins.has(pin.id)) {
				duplicates.add(pin.id);
				nodePins.delete(pin.id);
				issues.push({ reason: "duplicate_pin_id", nodeObjectPath: path, pinId: pin.id });
			} else nodePins.set(pin.id, pin);
		}
		pins.set(path, nodePins);
	}
	return { graph, nodes, pins, issues };
}

export function findBlueprintPin(
	index: BlueprintGraphIndex,
	reference: BlueprintPinReference
): BlueprintPin | undefined {
	return reference.node_object_path === undefined
		? undefined
		: index.pins.get(reference.node_object_path)?.get(reference.pin_id);
}

/** Saved link neighbors in link order, deduplicated; unavailable identities remain unresolved. */
export function blueprintNeighbors(input: {
	readonly index: BlueprintGraphIndex;
	readonly nodeObjectPath: string;
	readonly direction: "incoming" | "outgoing" | "both";
}): readonly BlueprintNode[] {
	if (!input.index.nodes.has(input.nodeObjectPath)) return [];
	const paths = new Set<string>();
	for (const link of input.index.graph.links) {
		if (!findBlueprintPin(input.index, link.from) || !findBlueprintPin(input.index, link.to)) {
			continue;
		}
		if (input.direction !== "incoming" && link.from.node_object_path === input.nodeObjectPath) {
			if (link.to.node_object_path !== undefined) paths.add(link.to.node_object_path);
		}
		if (input.direction !== "outgoing" && link.to.node_object_path === input.nodeObjectPath) {
			if (link.from.node_object_path !== undefined) paths.add(link.from.node_object_path);
		}
	}
	return [...paths].flatMap((path) => {
		const node = input.index.nodes.get(path);
		return node === undefined ? [] : [node];
	});
}

export function isBlueprintTopologyGap(gap: BlueprintGraphCoverageGap): boolean {
	return ![
		"native_node_subclass_tail",
		"undecoded_node_property",
		"incomplete_definition"
	].includes(gap.reason);
}
