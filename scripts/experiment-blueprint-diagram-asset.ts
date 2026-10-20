// Opt-in real-asset stress case. Private source paths and output stay caller-selected.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Predicate, Schema } from "effect";
import { BlueprintGraphProjection } from "../packages/protocol/dist/index.js";
import { createNodeRuntime } from "../packages/uasset-inspection-wasm/dist/node.js";
import { isBlueprintTopologyGap } from "../packages/blueprints/dist/index.js";
import { blueprintDiagramReport } from "./blueprint-diagram-report.ts";
import {
	exportBlueprintDiagram,
	exportMermaidOverview,
	parseBlueprintDiagram,
	renderBlueprintSvg
} from "./blueprint-diagram-prototype.ts";

const { values } = parseArgs({
	options: {
		asset: { type: "string" },
		graph: { type: "string" },
		output: { type: "string" },
		"pele-root": { type: "string", default: "out/blueprint-diagrams/pele/node_modules/pele" },
		"fork-root": { type: "string", default: "out/blueprint-diagrams/results/pele-fork" }
	}
});
assert.ok(
	values.asset && values.output,
	"Pass --asset and --output; project evidence stays in that output directory."
);
const path = resolve(values.asset),
	output = resolve(values.output);
mkdirSync(output, { recursive: true });
const bytes = readFileSync(path);
const sha = () => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceSha256 = sha();
const extractionStarted = performance.now();
const read = createNodeRuntime().extractBlueprints(path, bytes);
const extractionMs = performance.now() - extractionStarted;
if (read.status === "error") throw new Error(read.message);
assert.equal(read.blueprints.length, 1);
const projection = Schema.decodeUnknownSync(BlueprintGraphProjection)(read.blueprints[0]);
const adapter = {
	type: "blueprint",
	keepComments: true,
	parse: parseBlueprintDiagram,
	render: renderBlueprintSvg
};
type Svg = { svg: string; width: number; height: number };
type Render = (
	source: string,
	options?: { limit?: number; outputLimit?: number; maxEdges?: number }
) => Svg;
const Pele = Schema.Struct({
	register: Schema.declare((value): value is (diagram: typeof adapter) => void =>
		Predicate.isFunction(value)
	),
	render: Schema.declare((value): value is Render => Predicate.isFunction(value))
});
const fork = Schema.decodeUnknownSync(Pele)(
	await import(pathToFileURL(join(resolve(values["fork-root"]), "dist/esm/core.js")).href)
);
fork.register(adapter);
const stock = Schema.decodeUnknownSync(Pele)(
	await import(pathToFileURL(join(resolve(values["pele-root"]), "dist/esm/core.js")).href)
);
stock.register(
	(
		await import(
			pathToFileURL(join(resolve(values["pele-root"]), "dist/esm/diagrams/flowchart.js")).href
		)
	).default
);
const rows = [];
for (const graph of projection.graphs) {
	const text = exportBlueprintDiagram(graph);
	assert.deepEqual(parseBlueprintDiagram(text), graph);
	const direct = renderBlueprintSvg(graph);
	const options = {
		limit: Math.max(50_000, text.length),
		outputLimit: Math.max(4_000_000, direct.svg.length + 1),
		maxEdges: Math.max(5000, graph.links.length)
	};
	assert.equal(fork.render(text, options).svg, direct.svg);
	rows.push({ graph, text, direct, options });
}
const selected = values.graph
	? rows.find((row) => row.graph.name === values.graph)
	: rows.toSorted((a, b) => b.graph.nodes.length - a.graph.nodes.length)[0];
assert.ok(selected, "No matching saved graph.");
const { graph, text, direct, options } = selected;
const mermaid = exportMermaidOverview(graph);
let defaultBlueprintLimit = "accepted";
try {
	fork.render(text);
} catch (error) {
	defaultBlueprintLimit = String(error);
}
let defaultMermaidLimit = "accepted";
let overview;
try {
	overview = stock.render(mermaid);
} catch (error) {
	defaultMermaidLimit = String(error);
	overview = stock.render(mermaid, {
		limit: Math.max(50_000, mermaid.length),
		outputLimit: 16_000_000,
		maxEdges: Math.max(5000, graph.links.length)
	});
}
const measure = (run: () => Svg) => {
	for (let i = 0; i < 5; i++) run();
	const samplesMs = Array.from({ length: 11 }, () => {
		const started = performance.now();
		run();
		return performance.now() - started;
	});
	return { medianMs: samplesMs.toSorted((a, b) => a - b)[5], samplesMs };
};
const counts = {
	nodes: graph.nodes.length,
	pins: graph.nodes.flatMap((node) => node.pins).length,
	links: graph.links.length
};
const summary = {
	asset: basename(path),
	graph: graph.name,
	sourceSha256,
	node: process.version,
	status: read.status,
	extractionMs,
	graphCount: projection.graphs.length,
	totalNodes: projection.graphs.reduce((count, graph) => count + graph.nodes.length, 0),
	totalPins: projection.graphs.reduce(
		(count, graph) => count + graph.nodes.flatMap((node) => node.pins).length,
		0
	),
	totalLinks: projection.graphs.reduce((count, graph) => count + graph.links.length, 0),
	coverageGaps: projection.coverage_gaps.length,
	topologyGaps: projection.coverage_gaps.filter(isBlueprintTopologyGap).length,
	coverageReasons: Object.fromEntries(
		[...new Set(projection.coverage_gaps.map((gap) => gap.reason))].map((reason) => [
			reason,
			projection.coverage_gaps.filter((gap) => gap.reason === reason).length
		])
	),
	selected: counts,
	renderedLinks: direct.renderedLinks,
	unresolvedLinks: direct.unresolvedLinks,
	textBytes: Buffer.byteLength(text),
	mermaidBytes: Buffer.byteLength(mermaid),
	svgBytes: Buffer.byteLength(direct.svg),
	overviewSvgBytes: Buffer.byteLength(overview.svg),
	dimensions: { width: direct.width, height: direct.height },
	defaultBlueprintLimit,
	defaultMermaidLimit,
	timings: {
		directGraphToSvg: measure(() => renderBlueprintSvg(graph)),
		directTextToSvg: measure(() => renderBlueprintSvg(parseBlueprintDiagram(text))),
		peleTextToSvg: measure(() => fork.render(text, options)),
		stockMermaidToSvg: measure(() =>
			stock.render(mermaid, {
				limit: Math.max(50_000, mermaid.length),
				outputLimit: 16_000_000
			})
		)
	}
};
assert.equal(sha(), sourceSha256, "The source asset must remain unchanged.");
const example = {
	id: "heavy-case",
	label: basename(path) + " · " + graph.name,
	direct,
	pele: fork.render(text, options),
	overview,
	text,
	mermaid,
	counts
};
for (const [name, contents] of [
	["results.json", JSON.stringify(summary, null, 2)],
	["evidence.json", JSON.stringify({ path, read }, null, 2)],
	["diagram.bpgraph", text],
	["diagram.mmd", mermaid],
	["direct.svg", direct.svg],
	["pele.svg", example.pele.svg],
	["overview.svg", overview.svg],
	[
		"report.html",
		blueprintDiagramReport(
			[example],
			`Read-only project stress case. Source positions are retained. Source read: ${read.status === "ok" ? "complete" : "partial"}; ${projection.coverage_gaps.length} coverage gaps are retained in the local evidence file.`
		)
	]
])
	writeFileSync(join(output, name!), contents!);
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
