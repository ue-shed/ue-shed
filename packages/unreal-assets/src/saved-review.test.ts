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
			schema_version: 5,
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
