import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
	assetReaderLayer,
	readSavedBlueprint,
	readSavedLevelSequence
} from "../packages/unreal-assets/dist/index.js";
import {
	compareSavedBlueprints,
	compareSavedSequences
} from "../packages/unreal-assets/dist/saved-review.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import { LevelSequenceProjection } from "../packages/protocol/src/level-sequence.ts";

const root = resolve(process.env.UE_SHED_UASSET_FIXTURE_ROOT ?? "fixtures/unreal-project");
const evidence =
	process.env.UE_SHED_NATIVE_EVIDENCE_DIR ?? join(root, "FixtureExpected/parser-targets");
const reader = assetReaderLayer({ executable: ensureUassetExecutable() });
const wasmEntry = new URL("../packages/uasset-inspection-wasm/dist/node.js", import.meta.url);
const { createNodeRuntime }: typeof import("../packages/uasset-inspection-wasm/src/node.js") =
	await import(wasmEntry.href);
const runtime = createNodeRuntime();
const readJson = (name: string) =>
	Schema.decodeUnknownSync(Schema.Json)(JSON.parse(readFileSync(join(evidence, name), "utf8")));
const Link = Schema.Struct({ node: Schema.String, pin: Schema.String });
const Oracle = Schema.Struct({
	producer: Schema.String,
	objectPath: Schema.String,
	graphs: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			name: Schema.String,
			guid: Schema.String,
			nodes: Schema.Array(
				Schema.Struct({
					path: Schema.String,
					class: Schema.String,
					guid: Schema.String,
					x: Schema.Int,
					y: Schema.Int,
					pins: Schema.Array(
						Schema.Struct({
							id: Schema.String,
							name: Schema.String,
							direction: Schema.String,
							category: Schema.String,
							defaultValue: Schema.String,
							links: Schema.Array(Link)
						})
					)
				})
			)
		})
	)
});
const oracle = Schema.decodeUnknownSync(Oracle)(readJson("blueprint-review.json"));
const sort = <A>(values: readonly A[]) =>
	values.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
// GetPathName uses ':' at the first subobject; the package reader retains the export outer chain.
const objectPath = (path: string) => path.replace(":", ".");
const normalizeGraphs = (graphs: typeof oracle.graphs) =>
	sort(
		graphs.map((graph) => ({
			...graph,
			path: objectPath(graph.path),
			nodes: sort(
				graph.nodes.map((node) => ({
					...node,
					path: objectPath(node.path),
					pins: sort(
						node.pins.map((pin) => ({
							...pin,
							links: sort(
								pin.links.map((link) => ({ ...link, node: objectPath(link.node) }))
							)
						}))
					)
				}))
			)
		}))
	);
const blueprintPath = join(root, "Content/Fixture/Blueprints/BP_ReviewFixture.uasset");
const blueprint = await Effect.runPromise(
	readSavedBlueprint({ assetPath: blueprintPath }).pipe(Effect.provide(reader))
);
const portable = runtime.extractBlueprints(blueprintPath, readFileSync(blueprintPath));
if (portable.status === "error") throw new Error(portable.message);
assert.deepEqual(blueprint.blueprint, portable.blueprints[0], "native/WASM Blueprint mismatch");
assert.deepEqual(
	normalizeGraphs(
		blueprint.blueprint.graphs.map((graph) => ({
			path: graph.object_path,
			name: graph.name,
			guid: graph.guid ?? "00000000-00000000-00000000-00000000",
			nodes: graph.nodes.map((node) => ({
				path: node.object_path,
				class: node.class_path,
				guid: node.guid ?? "00000000-00000000-00000000-00000000",
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
		}))
	),
	normalizeGraphs(oracle.graphs),
	"Unreal loaded Blueprint topology/defaults mismatch"
);
assert.ok(blueprint.blueprint.graphs.some((graph) => graph.name === "ReviewFunction"));
const nodes = blueprint.blueprint.graphs.flatMap((graph) => graph.nodes);
for (const type of [
	"K2Node_IfThenElse",
	"K2Node_Knot",
	"K2Node_VariableGet",
	"K2Node_VariableSet",
	"EdGraphNode_Comment"
])
	assert.ok(
		nodes.some((node) => node.class_path.endsWith(`.${type}`)),
		`missing ${type}`
	);
assert.deepEqual(compareSavedBlueprints(blueprint, blueprint).changes, []);

const Rate = Schema.Struct({ numerator: Schema.Int, denominator: Schema.Int });
const sequenceOracle = Schema.decodeUnknownSync(
	Schema.Struct({
		timeline: Schema.Struct({
			tickResolution: Rate,
			displayRate: Rate,
			playbackStart: Schema.Int,
			playbackEnd: Schema.Int
		}),
		bindings: Schema.Array(
			Schema.Struct({
				tracks: Schema.Array(
					Schema.Struct({
						propertyPath: Schema.String,
						sections: Schema.Array(
							Schema.Struct({
								start: Schema.Int,
								end: Schema.Int,
								keys: Schema.Array(
									Schema.Struct({
										frame: Schema.Int,
										text: Schema.Struct({ sourceString: Schema.String })
									})
								)
							})
						)
					})
				)
			})
		),
		nestedTimeline: Schema.Struct({
			rootTracks: Schema.Array(
				Schema.Struct({
					classPath: Schema.String,
					sections: Schema.Array(
						Schema.Struct({
							start: Schema.Int,
							end: Schema.Int,
							sequencePath: Schema.String,
							shotDisplayName: Schema.optionalKey(Schema.String)
						})
					)
				})
			)
		})
	})
)(
	readJson(
		process.env.UE_SHED_NATIVE_EVIDENCE_DIR
			? "parser-targets/level-sequence.json"
			: "level-sequence.json"
	)
);

for (const fixture of [
	"Sequences/LS_TextTimeline",
	"Sequences/LS_NestedTimeline",
	"ParserNative/LS_Numeric",
	"ParserNative/LS_Discrete"
]) {
	const path = join(root, "Content/Fixture", `${fixture}.uasset`);
	const native = await Effect.runPromise(
		readSavedLevelSequence({ assetPath: path }).pipe(Effect.provide(reader))
	);
	const portable = runtime.extractLevelSequences(path, readFileSync(path));
	if (portable.status === "error") throw new Error(portable.message);
	assert.deepEqual(
		native.sequence,
		Schema.decodeUnknownSync(LevelSequenceProjection)(portable.sequences[0]),
		`native/WASM sequence mismatch: ${fixture}`
	);
	assert.deepEqual(compareSavedSequences(native, native).changes, []);
	if (fixture === "ParserNative/LS_Discrete") {
		assert.equal(native.sequence.root_tracks.length, 8);
		assert.equal(native.outcome, "partial");
		assert.deepEqual(
			native.sequence.coverage_gaps.map((gap) => gap.reason),
			["missing_channel"]
		);
		assert.deepEqual(native.sequence.reference_coverage_gaps, []);
	}
	if (fixture === "Sequences/LS_TextTimeline") {
		assert.deepEqual(native.sequence.tick_resolution, sequenceOracle.timeline.tickResolution);
		assert.deepEqual(native.sequence.display_rate, sequenceOracle.timeline.displayRate);
		assert.equal(
			native.sequence.playback_range?.lower.frame,
			sequenceOracle.timeline.playbackStart
		);
		assert.equal(
			native.sequence.playback_range?.upper.frame,
			sequenceOracle.timeline.playbackEnd
		);
		assert.deepEqual(
			native.sequence.bindings.flatMap((binding) =>
				binding.tracks.map((track) => ({
					propertyPath: track.property_path,
					sections: track.sections.map((section) => ({
						start: section.range?.lower.frame,
						end: section.range?.upper.frame,
						keys: section.text_keys.map((key) => ({
							frame: key.frame,
							text: { sourceString: key.source }
						}))
					}))
				}))
			),
			sequenceOracle.bindings.flatMap((binding) => binding.tracks)
		);
	}
	if (fixture === "Sequences/LS_NestedTimeline") {
		assert.deepEqual(
			native.sequence.root_tracks.map((track) => ({
				classPath: track.class_path,
				sections: track.sections.map((section) => ({
					start: section.range?.lower.frame,
					end: section.range?.upper.frame,
					sequencePath: section.sequence_path,
					...(section.shot_display_name === null
						? undefined
						: { shotDisplayName: section.shot_display_name })
				}))
			})),
			sequenceOracle.nestedTimeline.rootTracks
		);
	}
	assert.equal(
		native.outcome,
		native.sequence.coverage_gaps.length ||
			native.sequence.reference_coverage_gaps.length ||
			native.diagnostics.length
			? "partial"
			: "complete"
	);
}
process.stdout.write(
	`Saved review passed: ${oracle.producer}; Blueprint topology/defaults and four native/WASM sequence projections.\n`
);
