// Research only: a lossless saved-graph text carrier and a deliberately small SVG renderer.
// This is not a public authoring format or an Unreal asset writer.
import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
	BlueprintGraph,
	BlueprintNode,
	BlueprintPin,
	type BlueprintPinReference
} from "../packages/protocol/dist/index.js";
import {
	BLUEPRINT_LAYOUT,
	blueprintClassLabel,
	blueprintLinkPath,
	blueprintNodeDisplay,
	blueprintPinDefaults,
	blueprintPinLabel,
	blueprintPinTone,
	blueprintPinTypeLabel,
	findBlueprintPin,
	indexBlueprintGraph,
	layoutBlueprintGraph
} from "../packages/blueprints/dist/index.js";
import { parseJsonObject } from "./json.ts";

const alias = (prefix: string, value: string) =>
	prefix + createHash("sha256").update(value).digest("hex").slice(0, 12);
const nodeAlias = (node: BlueprintNode) => alias("n", node.guid ?? node.object_path);
const pinAlias = (id: string) => alias("p", id);

// Pele preprocesses Mermaid entities before calling diagram.parse(). Unicode escapes keep
// arbitrary saved strings intact through that stage, including literal #quot; and %% text.
type DiagramJson =
	| string
	| Omit<BlueprintGraph, "nodes" | "links">
	| Omit<BlueprintNode, "title" | "position" | "pins">
	| Omit<BlueprintPin, "name" | "direction">
	| BlueprintGraph["links"][number];
const json = (value: DiagramJson) =>
	JSON.stringify(value).replace(
		/[&<>%#]/gu,
		(character) => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
	);

function checkedIndex(graph: BlueprintGraph) {
	const index = indexBlueprintGraph(graph);
	if (index.issues.length > 0)
		throw new Error("Ambiguous saved graph identities: " + JSON.stringify(index.issues));
	return index;
}

/** Native metadata is retained as JSON tails; readable authoring syntax is intentionally undecided. */
export function exportBlueprintDiagram(graph: BlueprintGraph): string {
	const index = checkedIndex(graph);
	const { nodes, links, ...metadata } = graph;
	const lines = ["blueprint v1", "graph " + json(metadata)];
	const aliases = new Set<string>();
	const endpoint = (reference: BlueprintPinReference) => {
		const node = index.nodes.get(reference.node_object_path ?? "");
		return node && findBlueprintPin(index, reference)
			? nodeAlias(node) + "." + pinAlias(reference.pin_id)
			: undefined;
	};
	for (const node of nodes) {
		const id = nodeAlias(node);
		if (aliases.has(id)) throw new Error("Duplicate node alias: " + id);
		aliases.add(id);
		const { title, position, pins, ...source } = node;
		lines.push(`node ${id}[${json(title)}] @${position.x},${position.y} ${json(source)}`);
		const pinAliases = new Set<string>();
		for (const pin of pins) {
			const { name, direction, ...sourcePin } = pin;
			const pinId = pinAlias(pin.id);
			if (pinAliases.has(pinId)) throw new Error("Duplicate pin alias: " + pinId);
			pinAliases.add(pinId);
			lines.push(
				`  ${direction === "input" ? "in" : "out"} ${pinId}[${json(name)}] ${json(sourcePin)}`
			);
		}
	}
	for (const link of links) {
		const from = endpoint(link.from);
		const to = endpoint(link.to);
		lines.push(from && to ? `${from} --> ${to}` : "unresolved " + json(link));
	}
	return lines.join("\n") + "\n";
}

/** Parse only this experiment's grammar; validate the reconstructed graph with the existing schema. */
export function parseBlueprintDiagram(source: string): BlueprintGraph {
	const lines = source.trimEnd().split(/\r?\n/u);
	if (lines.shift() !== "blueprint v1") throw new Error("Expected blueprint v1.");
	const header = lines.shift();
	if (!header?.startsWith("graph ")) throw new Error("Expected graph metadata.");
	const metadata = parseJsonObject(header.slice(6));
	const nodes: Array<Omit<BlueprintNode, "pins"> & { pins: BlueprintPin[] }> = [];
	const endpoints = new Map<string, BlueprintPinReference>();
	const links: BlueprintGraph["links"][number][] = [];
	let current: (typeof nodes)[number] | undefined;
	let currentId = "";
	const ids = new Set<string>();
	for (const [lineIndex, line] of lines.entries()) {
		const node = /^node (\w+)\[("(?:[^"\\]|\\.)*")\] @(-?\d+),(-?\d+) (.+)$/u.exec(line);
		const pin = /^  (in|out) (\w+)\[("(?:[^"\\]|\\.)*")\] (.+)$/u.exec(line);
		const wire = /^(\w+\.\w+) --> (\w+\.\w+)$/u.exec(line);
		if (node) {
			currentId = node[1]!;
			if (ids.has(currentId)) throw new Error("Duplicate node alias: " + currentId);
			ids.add(currentId);
			const fields = Schema.decodeUnknownSync(BlueprintNode)({
				...parseJsonObject(node[5]!),
				title: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(node[2]!),
				position: { x: Number(node[3]), y: Number(node[4]) },
				pins: []
			});
			current = { ...fields, pins: [] };
			nodes.push(current);
		} else if (pin && current) {
			const fields = Schema.decodeUnknownSync(BlueprintPin)({
				...parseJsonObject(pin[4]!),
				name: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(pin[3]!),
				direction: pin[1] === "in" ? "input" : "output"
			});
			const key = currentId + "." + pin[2];
			if (endpoints.has(key)) throw new Error("Duplicate pin alias: " + key);
			endpoints.set(key, { node_object_path: current.object_path, pin_id: fields.id });
			current.pins.push(fields);
		} else if (wire) {
			const from = endpoints.get(wire[1]!);
			const to = endpoints.get(wire[2]!);
			if (!from || !to) throw new Error("Unresolved wire: " + line);
			links.push({ from, to });
			current = undefined;
		} else if (line.startsWith("unresolved ")) {
			links.push(
				Schema.decodeUnknownSync(BlueprintGraph.fields.links.value)(
					parseJsonObject(line.slice(11))
				)
			);
			current = undefined;
		} else throw new Error(`Invalid diagram line ${lineIndex + 3}: ${line}`);
	}
	const graph = Schema.decodeUnknownSync(BlueprintGraph)({ ...metadata, nodes, links });
	checkedIndex(graph);
	return graph;
}

export const escapeSvg = (value: string) =>
	value.replace(/[&<>"']/gu, (character) => {
		const entities = new Map([
			["&", "&amp;"],
			["<", "&lt;"],
			[">", "&gt;"],
			['"', "&quot;"],
			["'", "&apos;"]
		]);
		return entities.get(character)!;
	});

const colors = {
	boolean: "#dc6475",
	exec: "var(--bp-exec,#dddfe7)",
	numeric: "#78c996",
	object: "#69a9e8",
	struct: "#e6bc69",
	text: "#d886c1",
	wildcard: "#a8a8b8"
};

export function renderBlueprintSvg(graph: BlueprintGraph) {
	const index = checkedIndex(graph);
	const layout = layoutBlueprintGraph(graph);
	const comments: string[] = [];
	const cards: string[] = [];
	let width = layout.width;
	let height = layout.height;
	for (const [path, placement] of layout.nodes) {
		const { node, x, y } = placement;
		const display = blueprintNodeDisplay(node);
		const sourceId = `data-node-id="${escapeSvg(path)}"`;
		if (node.class_path.endsWith(".EdGraphNode_Comment")) {
			const w = Math.max(268, (display.width ?? 268) * BLUEPRINT_LAYOUT.positionScale);
			const h = Math.max(80, (display.height ?? 160) * BLUEPRINT_LAYOUT.positionScale);
			width = Math.max(width, x + w + 72);
			height = Math.max(height, y + h + 72);
			comments.push(
				`<g ${sourceId}><title>${escapeSvg(display.comment ?? node.title)}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#a2a5bb" fill-opacity=".08" stroke="#8b90a8" stroke-dasharray="5 4"/><text x="${x + 12}" y="${y + 23}" fill="var(--bp-fg,#e3e5ec)" font-size="12">${escapeSvg(display.comment ?? node.title)}</text></g>`
			);
			continue;
		}
		const headerColor =
			node.kind === "event"
				? "#994251"
				: node.kind.startsWith("variable")
					? "#536c57"
					: "#345c82";
		const clip = nodeAlias(node) + "_clip";
		const title = escapeSvg(node.title);
		const pinRows = node.pins
			.map((pin) => {
				const point = layout.pinPoints.get(path)?.get(pin.id);
				if (!point) return "";
				const output = pin.direction === "output";
				const color = colors[blueprintPinTone(pin)];
				const defaults = blueprintPinDefaults(pin).map(
					(item) => item.label + ": " + item.value
				);
				const tooltip = [blueprintPinTypeLabel(pin), ...defaults, pin.tooltip].join("\n");
				const label = blueprintPinLabel(pin);
				const mark =
					pin.pin_type.category === "exec"
						? `<path d="M ${point.x - 4} ${point.y - 5} h 5 l 5 5 l -5 5 h -5 Z" fill="var(--bp-card,#20242c)" stroke="${color}" stroke-width="1.8"/>`
						: `<circle cx="${point.x}" cy="${point.y}" r="4.5" fill="var(--bp-card,#20242c)" stroke="${color}" stroke-width="1.8"/>`;
				const defaultLabel =
					pin.default_value !== "" && pin.linked_to.length === 0
						? " = " + pin.default_value
						: "";
				return `<g data-pin-id="${escapeSvg(pin.id)}"><title>${escapeSvg(tooltip)}</title>${mark}<text x="${output ? point.x - 13 : point.x + 13}" y="${point.y + 4}" text-anchor="${output ? "end" : "start"}" clip-path="url(#${clip})" fill="var(--bp-fg,#e3e5ec)" font-size="11">${escapeSvg(label + defaultLabel)}</text></g>`;
			})
			.join("");
		cards.push(
			`<g ${sourceId}><title>${title}\n${escapeSvg(blueprintClassLabel(node.class_path))}\n${escapeSvg(display.comment ?? "")}</title><defs><clipPath id="${clip}"><rect x="${x + 10}" y="${y}" width="248" height="${placement.height}"/></clipPath></defs><rect x="${x}" y="${y}" width="268" height="${placement.height}" rx="7" fill="var(--bp-card,#20242c)" stroke="var(--bp-border,#626c80)"/><path d="M ${x + 7} ${y} h 254 q 7 0 7 7 v 29 h -268 v -29 q 0 -7 7 -7" fill="${headerColor}"/><text x="${x + 12}" y="${y + 23}" clip-path="url(#${clip})" font-size="13" font-weight="600" fill="#fff">${title}</text>${pinRows}</g>`
		);
	}
	let renderedLinks = 0;
	const wires = graph.links
		.map((link) => {
			const d = blueprintLinkPath(layout, link);
			if (!d) return "";
			renderedLinks++;
			const pin = findBlueprintPin(index, link.from);
			return `<path data-from="${escapeSvg((link.from.node_object_path ?? "") + "." + link.from.pin_id)}" data-to="${escapeSvg((link.to.node_object_path ?? "") + "." + link.to.pin_id)}" d="${d}" fill="none" stroke="${colors[blueprintPinTone(pin)]}" stroke-width="2.2"/>`;
		})
		.join("");
	return {
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvg(graph.name)} saved Blueprint graph" style="font-family:system-ui,sans-serif"><title>${escapeSvg(graph.name)}</title>${comments.join("")}${wires}${cards.join("")}</svg>`,
		width,
		height,
		links: [],
		renderedLinks,
		unresolvedLinks: graph.links.length - renderedLinks
	};
}

/** A portable overview: edge labels describe pin names, but endpoints remain nodes. */
export function exportMermaidOverview(graph: BlueprintGraph): string {
	const index = checkedIndex(graph);
	const quote = (label: string) =>
		'"' + label.replace(/[&<>"#\r\n]/gu, (character) => `#${character.charCodeAt(0)};`) + '"';
	const lines = ["flowchart LR"];
	for (const node of graph.nodes) {
		const comment = node.class_path.endsWith(".EdGraphNode_Comment")
			? blueprintNodeDisplay(node).comment
			: undefined;
		lines.push(`  ${nodeAlias(node)}[${quote(comment ?? node.title)}]`);
	}
	for (const link of graph.links) {
		const from = index.nodes.get(link.from.node_object_path ?? "");
		const to = index.nodes.get(link.to.node_object_path ?? "");
		const fromPin = findBlueprintPin(index, link.from);
		const toPin = findBlueprintPin(index, link.to);
		if (!from || !to || !fromPin || !toPin) continue;
		const label = quote(blueprintPinLabel(fromPin) + " → " + blueprintPinLabel(toPin));
		const arrow = fromPin.pin_type.category === "exec" ? "-->" : "-.->";
		lines.push(`  ${nodeAlias(from)} ${arrow}|${label}| ${nodeAlias(to)}`);
	}
	return lines.join("\n") + "\n";
}
