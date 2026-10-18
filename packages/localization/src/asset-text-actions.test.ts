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
