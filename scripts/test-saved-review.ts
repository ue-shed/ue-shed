import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Schema } from "effect";
import {
	assetReaderLayer,
	readSavedAsset,
	readSavedBlueprint,
	readSavedLevelSequence
} from "../packages/unreal-assets/dist/index.js";
import {
	compareSavedBlueprints,
	compareSavedSequences
} from "../packages/unreal-assets/dist/saved-review.js";
import { ensureUassetExecutable } from "./native-tools.ts";
import { LevelSequenceProjection, SavedAssetInspection } from "../packages/protocol/dist/index.js";

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
	variables: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			guid: Schema.String,
			category: Schema.String,
			type_category: Schema.String,
			container: Schema.Int,
			declaration_default: Schema.String,
			loaded_default: Schema.String
		})
	),
	components: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			name: Schema.String,
			class: Schema.String,
			guid: Schema.String,
			template: Schema.String,
			socket: Schema.String,
			children: Schema.Array(Schema.String),
			parent: Schema.String,
			parent_owner: Schema.String,
			parent_native: Schema.Boolean,
			x: Schema.optionalKey(Schema.Number),
			y: Schema.optionalKey(Schema.Number),
			z: Schema.optionalKey(Schema.Number)
		})
	),
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
const definition = blueprint.blueprint.definition;
assert.deepEqual(
	definition.variables?.map((variable) => ({
		name: variable.name,
		guid: variable.guid,
		category: variable.category?.source,
		type_category: variable.pin_type?.category,
		container: ["none", "array", "set", "map"].indexOf(variable.pin_type?.container_type ?? ""),
		// Empty descriptor strings may be omitted by tagged delta serialization.
		declaration_default: variable.default_value ?? ""
	})),
	oracle.variables.map(({ loaded_default: _default, ...variable }) => variable),
	"Unreal loaded variable declarations mismatch"
);
assert.equal(
	definition.variables?.find((v) => v.name === "ReviewAssets")?.pin_type?.value_type
		?.subcategory_object,
	"/Script/CoreUObject.Object"
);
assert.equal(
	definition.variables?.find((v) => v.name === "ReviewObject")?.pin_type?.subcategory_object,
	"/Script/Engine.StaticMesh"
);
assert.ok(
	definition.variables
		?.find((v) => v.name === "ReviewCount")
		?.properties.some((p) => p.name === "MetaDataArray")
);
const defaults = definition.default_object?.properties ?? [];
for (const variable of oracle.variables) {
	const property = defaults.find((p) => p.name === variable.name);
	// No serialized override is evidence of absence, not an inferred effective default.
	if (!property) {
		assert.equal(variable.name, "ReviewAssets");
		continue;
	}
	const value =
		property.value_kind === "bool"
			? property.value
				? "True"
				: "False"
			: property.value_kind === "array"
				? `(${property.values.map((v) => (v.value_kind === "int" ? v.value : "unsupported")).join(",")})`
				: property.value_kind === "object_ref"
					? property.value
					: "value" in property
						? String(property.value)
						: "unsupported";
	if (property.value_kind === "object_ref")
		assert.ok(variable.loaded_default.includes(value ?? ""));
	else assert.equal(value, variable.loaded_default, `Unreal CDO ${variable.name}`);
}
const scs = definition.construction_script;
assert.ok(scs);
assert.deepEqual(
	sort(
		scs.nodes.map((node) => ({
			path: node.object_path,
			name: node.variable_name,
			class: node.component_class,
			guid: node.guid,
			template: node.template?.object_path,
			socket: node.attach_to_name ?? "None",
			children: node.children ?? [],
			parent: node.parent_component_name ?? "None",
			parent_owner: node.parent_owner_class_name ?? "None",
			parent_native: node.parent_is_native ?? false
		}))
	),
	sort(
		oracle.components.map(({ x: _x, y: _y, z: _z, ...node }) => ({
			...node,
			path: objectPath(node.path),
			template: objectPath(node.template),
			children: node.children.map(objectPath)
		}))
	),
	"Unreal component hierarchy/attachment mismatch"
);
const child = scs.nodes.find((node) => node.variable_name === "ReviewChild");
const location = child?.template?.properties.find((p) => p.name === "RelativeLocation");
assert.ok(location?.value_kind === "vector");
const childOracle = oracle.components.find((node) => node.name === "ReviewChild");
assert.deepEqual(
	[location.x, location.y, location.z],
	[childOracle?.x, childOracle?.y, childOracle?.z]
);

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

const savedOracle = Schema.decodeUnknownSync(
	Schema.Struct({
		saved_sequence: Schema.Struct({
			native_objects: Schema.Array(
				Schema.Struct({
					path: Schema.String,
					class: Schema.String,
					modified_members: Schema.optionalKey(
						Schema.Array(Schema.Struct({ name: Schema.String, owner: Schema.String }))
					),
					compute_static_bounds: Schema.optionalKey(Schema.Boolean)
				})
			),
			tracks: Schema.Array(
				Schema.Struct({
					property: Schema.String,
					row: Schema.Int,
					priority: Schema.Int,
					active: Schema.Boolean,
					locked: Schema.Boolean,
					pre: Schema.Int,
					post: Schema.Int,
					ease_in: Schema.Int,
					ease_out: Schema.Int,
					has_default: Schema.optionalKey(Schema.Boolean),
					default: Schema.optionalKey(Schema.String),
					property_class: Schema.optionalKey(Schema.String),
					keys: Schema.Array(Schema.Struct({ frame: Schema.Int, value: Schema.String }))
				})
			),
			bindings: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					name: Schema.String,
					kind: Schema.String,
					template: Schema.optionalKey(Schema.String)
				})
			),
			cuts: Schema.Array(
				Schema.Struct({
					guid: Schema.String,
					sequence_id: Schema.Int,
					lock: Schema.Boolean,
					start: Schema.Int,
					end: Schema.Int
				})
			)
		})
	})
)(readJson("native-coverage.json")).saved_sequence;

for (const fixture of [
	"Sequences/LS_TextTimeline",
	"Sequences/LS_NestedTimeline",
	"ParserNative/LS_Numeric",
	"ParserNative/LS_Discrete",
	"ParserNative/LS_SavedDetails"
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
	if (fixture === "ParserNative/LS_SavedDetails") {
		const sequence = native.sequence;
		assert.deepEqual(sequence.coverage_gaps, []);
		assert.deepEqual(sequence.reference_coverage_gaps, []);
		const inspected = await Effect.runPromise(
			readSavedAsset({ assetPath: path }).pipe(Effect.provide(reader))
		);
		const portableInspection = runtime.inspect(path, readFileSync(path));
		assert.deepEqual(
			inspected.assets,
			Schema.decodeUnknownSync(SavedAssetInspection)(portableInspection).assets
		);
		for (const object of savedOracle.native_objects) {
			const asset = inspected.assets.find(
				(asset) => asset.object_path === object.path.replaceAll(":", ".")
			);
			assert.ok(asset?.kind === "UObject");
			assert.equal(asset.class_path, object.class);
			assert.equal(asset.tail_bytes, undefined);
			assert.ok(asset.native_data?.value_kind === "native_struct");
			const fields = asset.native_data.fields;
			if (object.modified_members) {
				const members = fields.find(
					(field) => field.name === "UCSModifiedProperties"
				)?.value;
				assert.ok(members?.value_kind === "array");
				assert.deepEqual(
					sort(
						members.values.map((member) => {
							assert.ok(member.value_kind === "native_struct");
							const name = member.fields.find(
								(field) => field.name === "MemberName"
							)?.value;
							const owner = member.fields.find(
								(field) => field.name === "MemberParent"
							)?.value;
							const guid = member.fields.find(
								(field) => field.name === "MemberGuid"
							)?.value;
							assert.ok(
								name?.value_kind === "name" &&
									owner?.value_kind === "object_ref" &&
									guid?.value_kind === "guid"
							);
							assert.equal(guid.value, "00000000-00000000-00000000-00000000");
							return { name: name.value, owner: owner.value };
						})
					),
					sort(object.modified_members)
				);
				const bounds = fields.find((field) => field.name === "StaticBoundsIsCooked")?.value;
				if (object.compute_static_bounds)
					assert.deepEqual(bounds, { value_kind: "bool", value: false });
				else assert.equal(bounds, undefined);
			} else
				assert.deepEqual(fields, [
					{ name: "ActorLabelIsCooked", value: { value_kind: "bool", value: false } }
				]);
		}
		assert.equal(
			sequence.references.filter((reference) =>
				reference.property_path.startsWith("$native_data.UCSModifiedProperties")
			).length,
			2
		);

		assert.deepEqual(
			sort(
				sequence.bindings.map((b) => ({
					id: b.id,
					name: b.name,
					kind: b.kind,
					template: b.object_template
				}))
			),
			sort(
				savedOracle.bindings.map((b) => ({
					id: b.id,
					name: b.name,
					kind: b.kind,
					template: b.template === undefined ? null : objectPath(b.template)
				}))
			)
		);
		for (const trackOracle of savedOracle.tracks) {
			const track = sequence.root_tracks.find(
				(t) => t.property_path === trackOracle.property
			);
			assert.ok(track);
			const section = track.sections[0];
			assert.ok(section);
			if (trackOracle.property === "Label") {
				const s = section.settings;
				assert.deepEqual(
					[
						s.row_index,
						s.overlap_priority,
						s.is_active,
						s.is_locked,
						s.pre_roll_frames,
						s.post_roll_frames
					],
					[
						trackOracle.row,
						trackOracle.priority,
						trackOracle.active,
						trackOracle.locked,
						trackOracle.pre,
						trackOracle.post
					]
				);
				assert.ok(
					s.easing?.some(
						(p) =>
							p.name === "ManualEaseInDuration" &&
							p.value_kind === "int" &&
							p.value === trackOracle.ease_in
					)
				);
				assert.ok(
					s.easing?.some(
						(p) =>
							p.name === "ManualEaseOutDuration" &&
							p.value_kind === "int" &&
							p.value === trackOracle.ease_out
					)
				);
			}
			const channel = section.value_channels[0];
			if (trackOracle.property === "Amount") {
				assert.ok(section.settings.blend_type);
				continue;
			}
			assert.ok(channel);
			if (channel.value_type === "string") {
				assert.equal(channel.default_value, trackOracle.default);
				assert.equal(channel.has_default_value, trackOracle.has_default);
				assert.deepEqual(channel.keys ?? [], trackOracle.keys);
			} else {
				assert.equal(channel.property_class, trackOracle.property_class);
				assert.equal(channel.default_value?.soft_path, trackOracle.default);
				assert.deepEqual(
					channel.keys?.map((k) => ({ frame: k.frame, value: k.value.soft_path })),
					trackOracle.keys
				);
				assert.equal(channel.keys?.[1]?.value.hard_path, null);
				assert.ok(
					sequence.references.some(
						(r) => r.target_path === "/Engine/BasicShapes/Cube.Cube"
					)
				);
			}
		}
		const cuts = sequence.root_tracks.find((t) => t.content === "camera_cut");
		assert.ok(cuts);
		assert.deepEqual(
			cuts.sections.map((s) => ({
				guid: s.camera_cut?.binding?.guid,
				sequence_id: s.camera_cut?.binding?.sequence_id ?? 0,
				lock: s.camera_cut?.lock_previous_camera ?? false,
				start: s.range?.lower.frame,
				end: s.range?.upper.frame
			})),
			savedOracle.cuts
		);
		assert.equal(cuts.sections[2]?.camera_cut?.binding?.resolve_parent_index, 1);
	}
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
	`Saved review passed: ${oracle.producer}; Blueprint topology, variables, defaults, components and five native/WASM sequence projections.\n`
);
