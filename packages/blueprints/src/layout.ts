import type { BlueprintGraph, BlueprintNode, BlueprintPinReference } from "@ue-shed/protocol";
import { indexBlueprintGraph } from "./graph.js";

/** Reference card geometry; hosts retain the original saved coordinates and own their styling. */
export const BLUEPRINT_LAYOUT = {
	nodeWidth: 268,
	headerHeight: 43,
	pinRowHeight: 25,
	margin: 72,
	positionScale: 0.82
} as const;

export interface BlueprintPoint {
	readonly x: number;
	readonly y: number;
}

export interface BlueprintLaidOutNode extends BlueprintPoint {
	readonly height: number;
	readonly node: BlueprintNode;
}

export interface BlueprintGraphLayout {
	readonly height: number;
	readonly nodes: ReadonlyMap<string, BlueprintLaidOutNode>;
	readonly width: number;
	readonly pinPoints: ReadonlyMap<string, ReadonlyMap<string, BlueprintPoint>>;
}

export function blueprintNodeHeight(node: BlueprintNode): number {
	return (
		BLUEPRINT_LAYOUT.headerHeight +
		Math.max(node.pins.length, 1) * BLUEPRINT_LAYOUT.pinRowHeight +
		8
	);
}

export function layoutBlueprintGraph(graph: BlueprintGraph | undefined): BlueprintGraphLayout {
	const nodes = new Map<string, BlueprintLaidOutNode>();
	const pinPoints = new Map<string, ReadonlyMap<string, BlueprintPoint>>();
	if (graph === undefined || graph.nodes.length === 0) {
		return { height: 480, nodes, width: 760, pinPoints };
	}
	const index = indexBlueprintGraph(graph);
	let minimumX = Infinity;
	let minimumY = Infinity;
	for (const node of index.nodes.values()) {
		minimumX = Math.min(minimumX, node.position.x);
		minimumY = Math.min(minimumY, node.position.y);
	}
	let width = 0;
	let height = 0;
	for (const node of index.nodes.values()) {
		const x =
			BLUEPRINT_LAYOUT.margin + (node.position.x - minimumX) * BLUEPRINT_LAYOUT.positionScale;
		const y =
			BLUEPRINT_LAYOUT.margin + (node.position.y - minimumY) * BLUEPRINT_LAYOUT.positionScale;
		const nodeHeight = blueprintNodeHeight(node);
		nodes.set(node.object_path, { height: nodeHeight, node, x, y });
		width = Math.max(width, x + BLUEPRINT_LAYOUT.nodeWidth + BLUEPRINT_LAYOUT.margin);
		height = Math.max(height, y + nodeHeight + BLUEPRINT_LAYOUT.margin);
		const points = new Map<string, BlueprintPoint>();
		for (const [row, pin] of node.pins.entries()) {
			if (!index.pins.get(node.object_path)?.has(pin.id)) continue;
			points.set(pin.id, {
				x: pin.direction === "output" ? x + BLUEPRINT_LAYOUT.nodeWidth : x,
				y: y + BLUEPRINT_LAYOUT.headerHeight + (row + 0.5) * BLUEPRINT_LAYOUT.pinRowHeight
			});
		}
		pinPoints.set(node.object_path, points);
	}
	return { height: Math.max(height, 480), nodes, width: Math.max(width, 760), pinPoints };
}

export function blueprintPinPoint(
	layout: BlueprintGraphLayout,
	reference: BlueprintPinReference
): BlueprintPoint | undefined {
	return reference.node_object_path === undefined
		? undefined
		: layout.pinPoints.get(reference.node_object_path)?.get(reference.pin_id);
}

/** A portable SVG cubic path; unresolved or ambiguous endpoints produce no path. */
export function blueprintLinkPath(
	layout: BlueprintGraphLayout,
	link: BlueprintGraph["links"][number]
): string | undefined {
	const from = blueprintPinPoint(layout, link.from);
	const to = blueprintPinPoint(layout, link.to);
	if (from === undefined || to === undefined) return undefined;
	const handle = Math.max(64, Math.abs(to.x - from.x) * 0.46);
	return `M ${from.x} ${from.y} C ${from.x + handle} ${from.y}, ${to.x - handle} ${to.y}, ${to.x} ${to.y}`;
}
