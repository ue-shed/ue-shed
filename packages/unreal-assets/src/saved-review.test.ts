import { readFileSync } from "node:fs";
import {
	BlueprintGraphRead,
	LevelSequenceRead,
	SequenceDiscreteChannel,
	UAssetIoEvent,
	type SavedProperty
} from "@ue-shed/protocol";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	blueprintReferences,
	compareSavedBlueprints,
	compareSavedSequences,
	resolveSavedReference,
	SavedReviewComparison
} from "./saved-review.js";
import { SavedReviewOutput } from "./saved-review.js";

function blueprint(): BlueprintGraphRead {
	const event = Schema.decodeUnknownSync(UAssetIoEvent)(
		JSON.parse(
			readFileSync(
				new URL(
					"../../protocol/contracts/uasset-io/v1/fixtures/valid/blueprint-result-event.json",
					import.meta.url
				),
				"utf8"
			)
		)
	);
	if (event.kind !== "result" || event.result.kind !== "blueprint")
		throw new Error("fixture kind");
	return { blueprint: event.result.blueprint, diagnostics: [], outcome: "complete" };
}

function sequence(): LevelSequenceRead {
	return {
		outcome: "complete",
		diagnostics: [],
		sequence: {
			schema_version: 6,
			object_path: "/Game/LS.LS",
			movie_scene_path: "/Game/LS.LS.MovieScene",
			tick_resolution: { numerator: 24000, denominator: 1 },
			display_rate: { numerator: 30, denominator: 1 },
			playback_range: null,
			bindings: [],
			references: [],
			reference_coverage_gaps: [],
			coverage_gaps: [],
			root_tracks: [
				{
					object_path: "/Game/LS.LS.MovieScene.FloatTrack",
					class_path: "/Script/MovieSceneTracks.MovieSceneFloatTrack",
					property_path: "Intensity",
					content: "numeric",
					sections: [
						{
							object_path: "/Game/LS.LS.MovieScene.FloatTrack.Section",
							class_path: "/Script/MovieSceneTracks.MovieSceneFloatSection",
							range: null,
							sequence_path: null,
							shot_display_name: null,
							text_keys: [],
							discrete_channels: [],
							value_channels: [],
							settings: {
								row_index: null,
								overlap_priority: null,
								is_active: null,
								is_locked: null,
								pre_roll_frames: null,
								post_roll_frames: null,
								blend_type: null,
								easing: null
							},
							camera_cut: null,
							numeric_channels: [
								{
									property_path: "FloatCurve",
									enabled: true,
									default_value: null,
									pre_extrapolation: 0,
									post_extrapolation: 0,
									tick_resolution: { numerator: 24000, denominator: 1 },
									show_curve: true,
									keys: [
										{
											frame: 0,
											value: 1,
											interpolation: 1,
											tangent_mode: 0,
											tangent_weight_mode: 0,
											arrive_tangent: 0,
											leave_tangent: 0,
											arrive_tangent_weight: 0,
											leave_tangent_weight: 0
										}
									]
								}
							]
						}
					]
				}
			]
		}
	};
}

describe("saved review", () => {
	it("compares and navigates native saved-object references without treating them as properties", () => {
		const before = blueprint();
		const native = {
			value_kind: "native_struct" as const,
			fields: [
				{
					name: "MemberParent",
					value: {
						value_kind: "object_ref" as const,
						value: "/Script/Engine.CameraComponent"
					}
				}
			]
		};
		const left = BlueprintGraphRead.make({
			...before,
			blueprint: {
				...before.blueprint,
				definition: {
					...before.blueprint.definition,
					default_object: {
						object_path: "/Game/BP.Default__BP_C",
						class_path: "/Game/BP.BP_C",
						properties: [],
						native_data: native
					}
				}
			}
		});
		const right = BlueprintGraphRead.make({
			...left,
			blueprint: {
				...left.blueprint,
				definition: {
					...left.blueprint.definition,
					default_object: {
						...left.blueprint.definition.default_object!,
						native_data: { ...native, fields: [] }
					}
				}
			}
		});
		expect(compareSavedBlueprints(left, right).changes.map((change) => change.path)).toContain(
			"default_object/native_data"
		);
		expect(blueprintReferences(left)).toContainEqual(
			expect.objectContaining({
				targetPath: "/Script/Engine.CameraComponent",
				propertyPath: "$native_data.MemberParent"
			})
		);
	});

	it("compares section settings, binding scope and null/omitted/string/object keys", () => {
		const before = sequence();
		const after = LevelSequenceRead.make({
			...before,
			sequence: {
				...before.sequence,
				bindings: [
					{
						id: "camera",
						name: "Camera",
						possessed_object_class: null,
						kind: "spawnable",
						parent_id: null,
						object_template: "/Game/LS.LS.Template",
						object_template_class: "/Script/Engine.CameraActor",
						tracks: []
					}
				],
				root_tracks: before.sequence.root_tracks.map((track) => ({
					...track,
					sections: track.sections.map((section) => ({
						...section,
						settings: { ...section.settings, row_index: 2, is_active: false },
						camera_cut: {
							binding: { guid: "camera", sequence_id: 42, resolve_parent_index: 1 },
							lock_previous_camera: false
						},
						value_channels: [
							{
								value_type: "string",
								property_path: "Label",
								has_default_value: true,
								default_value: "",
								keys: [{ frame: 24, value: "世界 🌟" }]
							},
							{
								value_type: "object",
								property_path: "Object",
								property_class: null,
								default_value: null,
								keys: [{ frame: 0, value: { soft_path: "", hard_path: null } }]
							}
						]
					}))
				}))
			}
		});
		const changes = compareSavedSequences(before, after).changes;
		expect(changes.some((c) => c.path.endsWith("/settings"))).toBe(true);
		expect(changes.find((c) => c.path.endsWith("/camera_cut"))?.after).toMatchObject({
			binding: { sequence_id: 42 }
		});
		expect(changes.find((c) => c.path.endsWith("/channels/Object/keys/0"))?.after).toEqual({
			frame: 0,
			value: { soft_path: "", hard_path: null }
		});
		expect(changes.find((c) => c.path.endsWith("/channels/Label/keys/24"))?.after).toEqual({
			frame: 24,
			value: "世界 🌟"
		});
	});
	it("compares declarations, saved defaults, templates and child order by stable identity", () => {
		const before = blueprint();
		const definition = {
			...before.blueprint.definition,
			variables: [
				{
					name: "Count",
					guid: "variable-guid",
					pin_type: null,
					category: null,
					property_flags: "18446744073709551615",
					default_value: null,
					properties: []
				}
			],
			default_object: {
				object_path: "/Game/BP.Default__BP_C",
				class_path: "/Game/BP.BP_C",
				properties: [
					{ name: "Count", type: "IntProperty", value_kind: "int" as const, value: 23 }
				]
			},
			construction_script: {
				object_path: "/Game/BP.BP.SCS",
				root_nodes: ["/Game/BP.BP.Root"],
				nodes: [
					{
						object_path: "/Game/BP.BP.Root",
						variable_name: "Root",
						guid: "root-guid",
						component_class: "/Script/Engine.SceneComponent",
						template: {
							object_path: "/Game/BP.BP_C.Root",
							class_path: "/Script/Engine.SceneComponent",
							properties: [
								{
									name: "Target",
									type: "ObjectProperty",
									value_kind: "object_ref" as const,
									value: "/Game/Other.Other"
								}
							]
						},
						children: ["/Game/BP.BP.A", "/Game/BP.BP.B"],
						attach_to_name: "Socket",
						parent_component_name: "NativeRoot",
						parent_owner_class_name: null,
						parent_is_native: true
					}
				]
			}
		};
		const left = BlueprintGraphRead.make({
			...before,
			blueprint: { ...before.blueprint, object_path: "/Game/BP.BP", definition }
		});
		const right = BlueprintGraphRead.make({
			...left,
			blueprint: {
				...left.blueprint,
				definition: {
					...definition,
					variables: definition.variables.map((v) => ({ ...v, default_value: "17" })),
					default_object: {
						...definition.default_object,
						properties: [
							{ name: "Count", type: "IntProperty", value_kind: "int", value: 24 }
						]
					},
					construction_script: {
						...definition.construction_script,
						nodes: definition.construction_script.nodes.map((n) => ({
							...n,
							children: n.children.toReversed()
						}))
					}
				}
			}
		});
		const changes = compareSavedBlueprints(left, right).changes;
		expect(changes.map((c) => c.path)).toEqual(
			expect.arrayContaining([
				"variables/variable-guid/declaration",
				"default_object/properties/Count",
				"components/root-guid/children"
			])
		);
		expect(blueprintReferences(left)).toContainEqual({
			ownerPath: "/Game/BP.BP_C.Root",
			propertyPath: "Target",
			targetPath: "/Game/Other.Other"
		});
		const renamed = Schema.decodeUnknownSync(BlueprintGraphRead)(
			JSON.parse(
				JSON.stringify(left)
					.replaceAll("/Game/BP.BP", "/Game/Renamed.Renamed")
					.replaceAll("/Game/BP.Default__BP_C", "/Game/Renamed.Default__Renamed_C")
			)
		);
		expect(compareSavedBlueprints(left, renamed).changes).toEqual([]);
	});
	it("validates discrete value types and compares saved flags and boolean keys", () => {
		const channel: Extract<SequenceDiscreteChannel, { value_type: "bool" }> = {
			value_type: "bool",
			property_path: "BoolCurve",
			has_default_value: null,
			default_value: false,
			pre_extrapolation: null,
			post_extrapolation: null,
			interpolate_linear_keys: null,
			externally_inverted: true,
			enum_path: null,
			keys: [{ frame: -12, value: false }]
		};
		const decode = Schema.decodeUnknownSync(SequenceDiscreteChannel);
		expect(() => decode({ ...channel, keys: [{ frame: 0, value: 1 }] })).toThrow();
		expect(() => decode({ ...channel, value_type: "byte", default_value: 256 })).toThrow();
		expect(() =>
			decode({ ...channel, value_type: "integer", default_value: 2147483648 })
		).toThrow();
		const withChannel = (value: SequenceDiscreteChannel): LevelSequenceRead => {
			const read = sequence();
			return {
				...read,
				sequence: {
					...read.sequence,
					root_tracks: read.sequence.root_tracks.map((track) => ({
						...track,
						content: "discrete",
						sections: track.sections.map((section) => ({
							...section,
							numeric_channels: [],
							discrete_channels: [value]
						}))
					}))
				}
			};
		};
		const before = withChannel(channel);
		const after = withChannel({
			...channel,
			has_default_value: false,
			keys: [{ frame: -12, value: true }]
		});
		const changes = compareSavedSequences(before, after).changes;
		expect(changes).toHaveLength(2);
		expect(changes.every((change) => change.category === "value")).toBe(true);
		expect(JSON.stringify(changes)).toContain('"has_default_value":null');
		expect(JSON.stringify(changes)).toContain('"has_default_value":false');
	});
	it("normalizes unordered sets while preserving array order", () => {
		const withProperty = (property: SavedProperty): BlueprintGraphRead => {
			const read = blueprint();
			return {
				...read,
				blueprint: {
					...read.blueprint,
					graphs: read.blueprint.graphs.map((graph) => ({
						...graph,
						nodes: graph.nodes.map((node) => ({ ...node, properties: [property] }))
					}))
				}
			};
		};
		const values = [
			{ value_kind: "int" as const, value: 1 },
			{ value_kind: "int" as const, value: 2 }
		];
		const before = withProperty({
			name: "Values",
			type: "SetProperty",
			value_kind: "set",
			values
		});
		const after = withProperty({
			name: "Values",
			type: "SetProperty",
			value_kind: "set",
			values: values.toReversed()
		});
		expect(compareSavedBlueprints(before, after).changes).toEqual([]);
		const arrayBefore = withProperty({
			name: "Values",
			type: "ArrayProperty",
			value_kind: "array",
			values
		});
		const arrayAfter = withProperty({
			name: "Values",
			type: "ArrayProperty",
			value_kind: "array",
			values: values.toReversed()
		});
		expect(compareSavedBlueprints(arrayBefore, arrayAfter).changes).toHaveLength(1);
	});
	it("bounds comparison output and preserves incomplete coverage when truncated", () => {
		const before = sequence();
		const after: LevelSequenceRead = {
			...before,
			sequence: {
				...before.sequence,
				root_tracks: before.sequence.root_tracks.map((track) => ({
					...track,
					sections: track.sections.map((section) => ({
						...section,
						numeric_channels: section.numeric_channels.map((channel) => ({
							...channel,
							keys: channel.keys.flatMap((key) =>
								Array.from({ length: 5002 }, (_, frame) => ({ ...key, frame }))
							)
						}))
					}))
				}))
			}
		};
		const result = compareSavedSequences(before, after);
		expect(result.changes).toHaveLength(5000);
		expect(result.truncated).toBe(true);
		expect(result.outcome).toBe("partial");
	});
	it("keeps published CLI JSON output conformant with the runtime schema", () => {
		const document = Schema.toJsonSchemaDocument(SavedReviewOutput);
		const expected = JSON.parse(
			readFileSync(
				new URL("../contracts/saved-review.v1.schema.json", import.meta.url),
				"utf8"
			)
		);
		expect({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$defs: document.definitions,
			...document.schema
		}).toEqual(expected);
	});
	it("distinguishes layout from pin defaults without treating export order as changes", () => {
		const before = blueprint();
		const after = BlueprintGraphRead.make({
			...before,
			blueprint: {
				...before.blueprint,
				graphs: before.blueprint.graphs.map((graph) => ({
					...graph,
					nodes: graph.nodes.toReversed().map((node) => ({
						...node,
						position: { x: node.position.x + 32, y: node.position.y },
						pins: node.pins.map((pin) => ({ ...pin, default_value: "changed" }))
					}))
				}))
			}
		});
		const comparison = compareSavedBlueprints(before, after);
		expect(comparison.changes.some((change) => change.category === "layout")).toBe(true);
		expect(
			comparison.changes.some(
				(change) => change.path.includes("/pins/") && change.kind === "changed"
			)
		).toBe(true);
		expect(comparison.changes.some((change) => change.kind !== "changed")).toBe(false);
		expect(Schema.decodeUnknownSync(SavedReviewComparison)(comparison)).toEqual(comparison);
	});
	it("does not claim equality when a read has missing evidence", () => {
		const read = { ...blueprint(), outcome: "partial" as const };
		const result = compareSavedBlueprints(read, read);
		expect(result.changes).toEqual([]);
		expect(result.outcome).toBe("partial");
		expect(result.warnings).toHaveLength(2);
	});
	it("reports frame values and tangents at the affected key", () => {
		const before = sequence();
		const after = LevelSequenceRead.make({
			...before,
			sequence: {
				...before.sequence,
				root_tracks: before.sequence.root_tracks.map((track) => ({
					...track,
					sections: track.sections.map((section) => ({
						...section,
						numeric_channels: section.numeric_channels.map((channel) => ({
							...channel,
							keys: channel.keys.map((key) => ({
								...key,
								value: 2,
								leave_tangent: 3
							}))
						}))
					}))
				}))
			}
		});
		const result = compareSavedSequences(before, after);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.path).toMatch(/keys\/0$/);
		expect(result.changes[0]?.after).toMatchObject({ value: 2, leave_tangent: 3 });
	});
	it("reports ambiguous saved track identities without claiming complete coverage", () => {
		const before = sequence();
		const after = {
			...before,
			sequence: {
				...before.sequence,
				root_tracks: [...before.sequence.root_tracks, ...before.sequence.root_tracks]
			}
		};
		expect(compareSavedSequences(before, after).outcome).toBe("partial");
		expect(compareSavedSequences(before, before).changes).toEqual([]);
	});
	it("resolves references only from explicit package inventory", () => {
		const asset = {
			packageName: "/Game/BP",
			assetPath: "D:/Project/Content/BP.uasset",
			kind: "blueprint" as const
		};
		expect(resolveSavedReference("/Game/BP.BP_C:Node", "/Game/LS.LS", [asset])).toMatchObject({
			status: "resolved",
			asset
		});
		expect(resolveSavedReference("/Game/LS.LS.Section", "/Game/LS.LS", [])).toMatchObject({
			status: "internal"
		});
		expect(resolveSavedReference("/Script/Engine.Actor", "/Game/LS.LS", [])).toMatchObject({
			status: "native"
		});
		expect(resolveSavedReference("/Game/Missing.Missing", "/Game/LS.LS", [])).toMatchObject({
			status: "unavailable"
		});
		expect(
			resolveSavedReference("/Game/BP.BP", "/Game/LS.LS", [
				asset,
				{ ...asset, assetPath: "D:/Other/BP.uasset" }
			])
		).toMatchObject({ status: "ambiguous" });
	});
	it("inventories native type references as well as saved defaults", () => {
		expect(blueprintReferences(blueprint())).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					propertyPath: "class",
					targetPath: "/Script/Example.K2Node_Example"
				})
			])
		);
	});
});
