import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { GameTextActionsRequest } from "@ue-shed/protocol";
import {
	localizationTextActionsRequest,
	runLocalizationTextActions
} from "./asset-text-actions.js";

it.each([0.5, -1, 2147483648, "0"])(
	"rejects invalid graph pin index %s at the shared boundary",
	(index) => {
		expect(
			Schema.is(GameTextActionsRequest)({
				contract: "ue-shed-game-text-actions",
				version: "1.0",
				mode: "apply",
				actions: [
					{
						id: "pin",
						place: {
							packageFile: "Content/BP.uasset",
							objectPath: "/Game/BP.BP:EventGraph.Node",
							propertyPath: "Pins[0].DefaultTextValue",
							selector: { kind: "graph_pin", index }
						},
						expected: { namespace: "UI", key: "Key", source: "Source" },
						edit: { kind: "regenerate_key" }
					}
				]
			})
		).toBe(false);
	}
);

it.effect("refuses extended actions on older plugins before sending a mutation", () =>
	Effect.gen(function* () {
		const calls: string[] = [];
		const result = yield* Effect.result(
			runLocalizationTextActions({
				endpoint: "http://fixture",
				request: localizationTextActionsRequest({
					mode: "apply",
					save: true,
					actions: [
						{
							id: "table",
							place: {
								packageFile: "Content/ST.uasset",
								objectPath: "/Game/ST.ST",
								propertyPath: "Old",
								selector: { kind: "string_table_entry", entryKey: "Old" }
							},
							expected: { namespace: "Words", key: "Old", source: "Welcome" },
							edit: { kind: "remove_string_table_entry" }
						}
					]
				})
			}).pipe(
				Effect.provide(
					makeRemoteControlClientTestLayer((call) =>
						Effect.sync(() => {
							calls.push(call.functionName);
							return Schema.decodeUnknownSync(Schema.Json)({
								schemaVersion: 1,
								producerKind: "unreal_editor",
								gameTextObjectPath:
									"/Script/UEShedGameText.Default__UEShedGameTextLibrary",
								capabilities: ["game-text.actions.v1"]
							});
						})
					)
				)
			)
		);
		expect(result).toMatchObject({
			_tag: "Failure",
			failure: { code: "capability_missing", retrySafe: false }
		});
		expect(calls).toEqual(["GetCapabilityManifest"]);
	})
);

it.effect(
	"the narrow key-repairs capability admits cells and pins but refuses table migrations and source edits",
	() =>
		Effect.gen(function* () {
			for (const kind of ["data_table_cell", "graph_pin", "string_table_entry"] as const) {
				for (const edit of [
					{ kind: "regenerate_key" } as const,
					{ kind: "change_source", source: "New" } as const
				]) {
					let mutations = 0;
					const selector =
						kind === "data_table_cell"
							? { kind, row: "Row" }
							: kind === "graph_pin"
								? { kind, index: 0 }
								: { kind, entryKey: "Old" };
					const request = localizationTextActionsRequest({
						mode: "apply",
						actions: [
							{
								id: "repair",
								place: {
									packageFile: "Content/Text.uasset",
									objectPath: "/Game/Text.Text",
									propertyPath: "Text",
									selector
								},
								expected: { namespace: "Words", key: "Old", source: "Source" },
								edit
							}
						]
					});
					const result = yield* Effect.result(
						runLocalizationTextActions({ endpoint: "http://fixture", request }).pipe(
							Effect.provide(
								makeRemoteControlClientTestLayer((call) =>
									Effect.sync(() => {
										if (call.functionName === "GetCapabilityManifest")
											return Schema.decodeUnknownSync(Schema.Json)({
												schemaVersion: 1,
												producerKind: "unreal_editor",
												capabilities: [
													"game-text.actions.v1",
													"game-text.actions.key-repairs.v1"
												],
												gameTextObjectPath:
													"/Script/UEShedGameText.Default__UEShedGameTextLibrary"
											});
										mutations++;
										return Schema.decodeUnknownSync(Schema.Json)({
											...request,
											status: "ok",
											rolledBack: false,
											actions: [],
											packages: [],
											blueprints: [],
											errors: []
										});
									})
								)
							)
						)
					);
					const allowed = kind !== "string_table_entry" && edit.kind === "regenerate_key";
					expect(mutations).toBe(allowed ? 1 : 0);
					if (!allowed)
						expect(result).toMatchObject({
							_tag: "Failure",
							failure: { code: "capability_missing" }
						});
				}
			}
		})
);
