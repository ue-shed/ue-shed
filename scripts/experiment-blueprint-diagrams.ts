// Opt-in research runner. See docs/research/blueprint-diagrams-2026-10-17.md.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Predicate, Schema } from "effect";
import {
	BlueprintGraphProjection,
	BlueprintNode,
	BlueprintPin,
	type BlueprintGraph
} from "../packages/protocol/dist/index.js";
import { createNodeRuntime } from "../packages/uasset-inspection-wasm/dist/node.js";
import {
	exportBlueprintDiagram,
	exportMermaidOverview,
	parseBlueprintDiagram,
	renderBlueprintSvg
} from "./blueprint-diagram-prototype.ts";
import { parseJsonObject } from "./json.ts";
import {
	blueprintDiagramReport,
	type BlueprintDiagramExample
} from "./blueprint-diagram-report.ts";

const { values } = parseArgs({
	options: {
		"fixture-root": { type: "string", multiple: true },
		"evidence-root": { type: "string", multiple: true },
		"pele-root": { type: "string" },
		output: { type: "string", default: "out/blueprint-diagrams/results" }
	}
});
const output = resolve(values.output);
const peleRoot = resolve(values["pele-root"] ?? "out/blueprint-diagrams/pele/node_modules/pele");
const fixtureRoots = values["fixture-root"] ?? ["fixtures/unreal-project"];
if (values["evidence-root"]) assert.equal(values["evidence-root"].length, fixtureRoots.length);
const packageInfo = parseJsonObject(readFileSync(join(peleRoot, "package.json"), "utf8"));
assert.equal(packageInfo.version, "1.6.0", "This spike's runtime patch is pinned to Pele 1.6.0.");
mkdirSync(output, { recursive: true });

type Svg = { svg: string; width: number; height: number; type?: string };
type Diagram = {
	type: string;
	keepComments: boolean;
	parse: (
		source: string,
		config: Schema.JsonObject,
		title: string | undefined,
		offset: number,
		limits: { maxEdges: number }
	) => BlueprintGraph;
	render: (graph: BlueprintGraph) => Svg & { links: never[] };
};
type Pele = {
	register: (diagram: Diagram) => void;
	supports: (source: string) => boolean;
	render: (source: string, options?: { limit?: number; outputLimit?: number }) => Svg;
};
const PeleApi = Schema.Struct({
	register: Schema.declare((value): value is Pele["register"] => Predicate.isFunction(value)),
	supports: Schema.declare((value): value is Pele["supports"] => Predicate.isFunction(value)),
	render: Schema.declare((value): value is Pele["render"] => Predicate.isFunction(value))
});
async function loadPele(root: string): Promise<Pele> {
	const module = await import(pathToFileURL(join(root, "dist/esm/core.js")).href);
	// Check foreign exports at entry; smoke calls below verify the pinned library's behavior.
	return Schema.decodeUnknownSync(PeleApi)(module);
}

const stock = await loadPele(peleRoot);
const flowchart = await import(
	pathToFileURL(join(peleRoot, "dist/esm/diagrams/flowchart.js")).href
);
stock.register(flowchart.default);
const adapter: Diagram = {
	type: "blueprint",
	keepComments: true,
	parse(source, _config, _title, _offset, limits) {
		const graph = parseBlueprintDiagram(source);
		if (graph.links.length > limits.maxEdges) throw new Error("Blueprint edge limit exceeded.");
		return graph;
	},
	render: renderBlueprintSvg
};
stock.register(adapter);
assert.equal(stock.supports("blueprint v1"), false, "Registration does not extend detection.");
assert.throws(() => stock.render("blueprint v1"), /No diagram type detected/u);

// A disposable runtime fork, with the original package's license retained. No workspace dependency.
const forkRoot = join(output, "pele-fork");
cpSync(join(peleRoot, "dist"), join(forkRoot, "dist"), { recursive: true });
cpSync(join(peleRoot, "LICENSE"), join(forkRoot, "LICENSE"));
writeFileSync(join(forkRoot, "package.json"), JSON.stringify({ type: "module" }));
const chunks = join(forkRoot, "dist/esm/chunks");
const needle = '[["flowchart",/^\\s*flowchart-elk/]';
const replacement = '[["blueprint",/^\\s*blueprint\\s+v1\\b/],["flowchart",/^\\s*flowchart-elk/]';
const patches: unknown[] = [];
for (const file of readdirSync(chunks).filter((file) => file.endsWith(".js"))) {
	const path = join(chunks, file);
	const original = readFileSync(path, "utf8");
	if (!original.includes(needle)) continue;
	assert.equal(original.split(needle).length, 2, "Expected exactly one detector table.");
	const patched = original.replace(needle, replacement);
	writeFileSync(path, patched);
	patches.push({
		file: relative(forkRoot, path),
		needle,
		replacement,
		originalSha256: createHash("sha256").update(original).digest("hex"),
		patchedSha256: createHash("sha256").update(patched).digest("hex")
	});
}
assert.equal(patches.length, 1, "The published detector layout changed.");
writeFileSync(join(output, "pele-runtime-patch.json"), JSON.stringify(patches, null, 2) + "\n");
const fork = await loadPele(forkRoot);
fork.register(adapter);
assert.equal(fork.supports("blueprint v1"), true);
const renderFork = (source: string) =>
	fork.render(source, { limit: 2_000_000, outputLimit: 16_000_000 });

function measure(run: () => Svg) {
	for (let i = 0; i < 10; i++) run();
	const samples: number[] = [];
	for (let round = 0; round < 9; round++) {
		const start = performance.now();
		for (let iteration = 0; iteration < 25; iteration++) run();
		samples.push((performance.now() - start) / 25);
	}
	return { medianMs: samples.toSorted((a, b) => a - b)[4], samplesMs: samples };
}

function exerciseEdgeCases(graph: BlueprintGraph) {
	const original = graph.nodes[0]!;
	const hostile = '#quot; &amp; #x3c; %% <script>alert("saved text")</script> 雨 🐉';
	const changed = { ...graph, name: hostile, nodes: [{ ...original, title: hostile }] };
	const text = exportBlueprintDiagram(changed);
	assert.deepEqual(parseBlueprintDiagram(text), changed);
	const svg = renderBlueprintSvg(changed).svg;
	assert.ok(!svg.includes("<script>"));
	assert.equal(
		renderFork(text).svg,
		svg,
		"Pele preprocessing must preserve arbitrary saved strings."
	);
	assert.throws(
		() => parseBlueprintDiagram(text + "unknown instruction\n"),
		/Invalid diagram line/u
	);
	assert.throws(
		() => parseBlueprintDiagram(text.replace("blueprint v1", "blueprint v2")),
		/Expected blueprint v1/u
	);
	assert.throws(
		() => exportBlueprintDiagram({ ...graph, nodes: [original, original] }),
		/Ambiguous/u
	);
	const firstPin = original.pins[0]!;
	assert.throws(
		() =>
			exportBlueprintDiagram({
				...graph,
				nodes: [{ ...original, pins: [firstPin, firstPin] }]
			}),
		/Ambiguous/u
	);
	const missing = {
		from: { node_object_path: original.object_path, pin_id: firstPin.id },
		to: { pin_id: "missing" }
	};
	const partial = { ...graph, links: [...graph.links, missing] };
	assert.deepEqual(parseBlueprintDiagram(exportBlueprintDiagram(partial)), partial);
	assert.equal(renderBlueprintSvg(partial).unresolvedLinks, 1);
	const sameIdNodes = graph.nodes
		.filter((node) => node.pins.length > 0)
		.slice(0, 2)
		.map((node) => ({
			...node,
			pins: [{ ...node.pins[0]!, id: "same-on-different-owners" }]
		}));
	const a = sameIdNodes[0]!,
		b = sameIdNodes[1]!;
	const reference = (node: typeof a) => ({
		node_object_path: node.object_path,
		pin_id: node.pins[0]!.id
	});
	const cycle = {
		...graph,
		nodes: sameIdNodes,
		links: [
			{ from: reference(a), to: reference(b) },
			{ from: reference(b), to: reference(a) }
		]
	};
	assert.deepEqual(parseBlueprintDiagram(exportBlueprintDiagram(cycle)), cycle);
	assert.equal(renderBlueprintSvg(cycle).renderedLinks, 2);
	return 10;
}

const runtime = createNodeRuntime();
const LoadedBlueprint = Schema.Struct({
	producer: Schema.String,
	graphs: Schema.Array(
		Schema.Struct({
			path: BlueprintNode.fields.object_path,
			name: Schema.String,
			guid: Schema.String,
			nodes: Schema.Array(
				Schema.Struct({
					path: BlueprintNode.fields.object_path,
					class: BlueprintNode.fields.class_path,
					guid: Schema.String,
					x: Schema.Int,
					y: Schema.Int,
					pins: Schema.Array(
						Schema.Struct({
							id: BlueprintPin.fields.id,
							name: BlueprintPin.fields.name,
							direction: BlueprintPin.fields.direction,
							category: Schema.String,
							defaultValue: BlueprintPin.fields.default_value,
							links: Schema.Array(
								Schema.Struct({ node: Schema.String, pin: Schema.String })
							)
						})
					)
				})
			)
		})
	)
});
function normalizeLoadedGraphs(graphs: (typeof LoadedBlueprint.Type)["graphs"]) {
	const path = (value: string) => value.replace(":", ".");
	return graphs
		.map((graph) => ({
			...graph,
			path: path(graph.path),
			nodes: graph.nodes
				.map((node) => ({
					...node,
					path: path(node.path),
					pins: node.pins
						.map((pin) => ({
							...pin,
							links: pin.links
								.map((link) => ({ ...link, node: path(link.node) }))
								.toSorted((a, b) => (a.node + a.pin).localeCompare(b.node + b.pin))
						}))
						.toSorted((a, b) => a.id.localeCompare(b.id))
				}))
				.toSorted((a, b) => a.path.localeCompare(b.path))
		}))
		.toSorted((a, b) => a.path.localeCompare(b.path));
}
const results: unknown[] = [];
const examples: BlueprintDiagramExample[] = [];
let edgeCaseChecks = 0;
let unrealTopologyChecks = 0;
for (const [fixtureIndex, fixtureRoot] of fixtureRoots.entries()) {
	const root = resolve(fixtureRoot);
	const evidence = resolve(
		values["evidence-root"]?.[fixtureIndex] ?? join(root, "FixtureExpected/parser-targets")
	);
	const oracle = Schema.decodeUnknownSync(Schema.fromJsonString(LoadedBlueprint))(
		readFileSync(join(evidence, "blueprint-review.json"), "utf8")
	);
	for (const asset of ["BP_ReviewFixture", "BP_GraphFixture"]) {
		const path = join(root, "Content/Fixture/Blueprints", asset + ".uasset");
		const bytes = readFileSync(path);
		const result = runtime.extractBlueprints(path, bytes);
		if (result.status === "error") throw new Error(result.message);
		assert.equal(result.blueprints.length, 1);
		const projection = Schema.decodeUnknownSync(BlueprintGraphProjection)(result.blueprints[0]);
		if (asset === "BP_ReviewFixture") {
			const loaded = projection.graphs.map((graph) => ({
				path: graph.object_path,
				name: graph.name,
				guid: graph.guid ?? "",
				nodes: graph.nodes.map((node) => ({
					path: node.object_path,
					class: node.class_path,
					guid: node.guid ?? "",
					x: node.position.x,
					y: node.position.y,
					pins: node.pins.map((pin) => ({
						id: pin.id,
						name: pin.name,
						direction: pin.direction,
						category: pin.pin_type.category,
						defaultValue: pin.default_value,
						links: pin.linked_to.map((link) => ({
							node: link.node_object_path ?? "",
							pin: link.pin_id
						}))
					}))
				}))
			}));
			assert.deepEqual(
				normalizeLoadedGraphs(loaded),
				normalizeLoadedGraphs(oracle.graphs),
				"Saved graph topology and defaults must match Unreal's loaded graph APIs."
			);
			unrealTopologyChecks++;
		}
		const name = `fixture-${fixtureIndex + 1}-${asset}`;
		writeFileSync(
			join(output, name + ".evidence.json"),
			JSON.stringify(
				{
					fixtureRoot,
					producer: oracle.producer,
					assetSha256: createHash("sha256").update(bytes).digest("hex"),
					status: result.status,
					diagnostics: result.diagnostics,
					projection
				},
				null,
				2
			) + "\n"
		);
		for (const graph of projection.graphs) {
			const id = name + "-" + graph.name.replace(/[^a-zA-Z0-9_-]/gu, "_");
			const text = exportBlueprintDiagram(graph);
			const parsed = parseBlueprintDiagram(text);
			assert.deepEqual(parsed, graph, "Native graph evidence must survive the text carrier.");
			assert.equal(exportBlueprintDiagram(parsed), text, "Text export must be repeatable.");
			const direct = renderBlueprintSvg(graph);
			assert.equal(direct.renderedLinks, graph.links.length);
			assert.equal((direct.svg.match(/data-node-id=/gu) ?? []).length, graph.nodes.length);
			assert.equal(
				(direct.svg.match(/data-pin-id=/gu) ?? []).length,
				graph.nodes.flatMap((node) => node.pins).length
			);
			const pele = renderFork(text);
			assert.equal(pele.type, "blueprint");
			assert.equal(pele.svg, direct.svg, "Pele must call the same custom geometry renderer.");
			const mermaid = exportMermaidOverview(graph);
			const overview = stock.render(mermaid);
			assert.ok(overview.svg.startsWith("<svg"));
			for (const [suffix, contents] of [
				["bpgraph", text],
				["mmd", mermaid],
				["direct.svg", direct.svg],
				["pele.svg", pele.svg],
				["overview.svg", overview.svg]
			])
				writeFileSync(join(output, id + "." + suffix), contents!);
			if (asset === "BP_ReviewFixture" && graph.name === "EventGraph") {
				edgeCaseChecks += exerciseEdgeCases(graph);
				examples.push({
					id,
					label: String(oracle.producer).split(" loaded")[0] + " · EventGraph",
					direct,
					pele,
					overview,
					text,
					mermaid,
					counts: {
						nodes: graph.nodes.length,
						pins: graph.nodes.flatMap((node) => node.pins).length,
						links: graph.links.length
					}
				});
			}
			results.push({
				id,
				producer: oracle.producer,
				status: result.status,
				nodes: graph.nodes.length,
				pins: graph.nodes.flatMap((node) => node.pins).length,
				links: graph.links.length,
				coverageGaps: projection.coverage_gaps.length,
				textBytes: Buffer.byteLength(text),
				directSvgBytes: Buffer.byteLength(direct.svg),
				overviewSvgBytes: Buffer.byteLength(overview.svg),
				timings: {
					directGraphToSvg: measure(() => renderBlueprintSvg(graph)),
					directTextToSvg: measure(() => renderBlueprintSvg(parseBlueprintDiagram(text))),
					peleTextToSvg: measure(() => renderFork(text)),
					stockMermaidToSvg: measure(() => stock.render(mermaid))
				}
			});
		}
	}
}
const summary = {
	node: process.version,
	pele: packageInfo.version,
	graphs: results.length,
	unrealTopologyChecks,
	edgeCaseChecks,
	stockRegistrationRecognizesBlueprint: false,
	runtimeDetectorPatches: patches.length,
	geometryOwnedByPele: false,
	results
};
writeFileSync(join(output, "results.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(join(output, "examples.json"), JSON.stringify(examples) + "\n");
writeFileSync(join(output, "report.html"), blueprintDiagramReport(examples));
process.stdout.write(
	JSON.stringify(
		{
			output,
			graphs: results.length,
			edgeCaseChecks,
			examples: examples.map((example) => example.label)
		},
		null,
		2
	) + "\n"
);
