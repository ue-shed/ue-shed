import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import {
	connectUnrealAuthoring,
	connectUnrealAutomation,
	findUnrealActorsReferencingRow,
	locateUnrealAsset,
	makeRemoteControlClientTestLayer,
	openUnrealAsset
} from "./index.js";

const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const version = { major: 1, minor: 0 } as const;
const worldObjectPath = "/Engine/Transient.SelectedWorld";
const manifest = {
	producerKind: "unreal_editor",
	schemaVersion: 1,
	authoringObjectPath: "/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
	automationObjectPath: "/Script/UEShedAutomation.Default__UEShedAutomationLibrary",
	assetNavigationObjectPath:
		"/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary",
	authoringLimits: { maxCommands: 1024, maxPayloadBytes: 1_048_576, maxTables: 16 },
	capabilities: [
		"authoring.snapshot.v2",
		"authoring.table-list.v1",
		"authoring.apply.v1",
		"authoring.apply-result.v1",
		"authoring.save.v1",
		"authoring.actor-references.v1",
		"automation.players.v1",
		"automation.input.v1",
		"automation.csv.v1",
		"editor.asset-navigation.v1",
		"editor.asset-open.v1"
	]
};

/** Records each call's function and operation; every reply but the manifest fails to decode. */
function recording() {
	const calls: Array<{ readonly functionName: string; readonly operation: string | undefined }> =
		[];
	const layer = makeRemoteControlClientTestLayer((request) => {
		calls.push({ functionName: request.functionName, operation: request.operation });
		return decodeJson(request.functionName === "GetCapabilityManifest" ? manifest : {}).pipe(
			Effect.orDie
		);
	});
	return { calls, layer };
}

it.effect("every call names a stable operation a host can give its own timeout", () =>
	Effect.gen(function* () {
		const { calls, layer } = recording();
		const endpoint = "http://127.0.0.1:30010";
		yield* Effect.gen(function* () {
			const authoring = yield* connectUnrealAuthoring(endpoint);
			yield* Effect.ignore(authoring.listTableObjectPaths);
			yield* Effect.ignore(authoring.getTableSnapshot("/Game/Data/DT_Items.DT_Items"));
			yield* Effect.ignore(
				authoring.apply({
					contract: { name: "unreal-authoring-apply", version },
					operationId: "apply-1",
					tables: [],
					commands: []
				})
			);
			yield* Effect.ignore(authoring.lookupApplyResult("apply-1"));
			yield* Effect.ignore(
				authoring.save({
					contract: { name: "unreal-authoring-save", version },
					objectPaths: [],
					requestId: "save-1"
				})
			);
			yield* Effect.ignore(
				findUnrealActorsReferencingRow({
					endpoint,
					request: {
						contract: { name: "unreal-authoring-actor-references", version },
						worldObjectPath,
						tableObjectPath: "/Game/Data/DT_Items.DT_Items",
						rowName: "Item",
						maxActors: 100_000,
						maxResults: 10
					}
				})
			);
			const automation = yield* connectUnrealAutomation(endpoint);
			yield* Effect.ignore(
				automation.listPlayers({
					contract: { name: "unreal-automation-players", version },
					worldObjectPath
				})
			);
			yield* Effect.ignore(
				automation.injectInput({
					contract: { name: "unreal-automation-input", version },
					worldObjectPath,
					playerControllerObjectPath: `${worldObjectPath}:PersistentLevel.Controller`,
					actionObjectPath: "/Game/Input/IA_Camera.IA_Camera",
					value: { kind: "axis2d", x: 0.25, y: -0.5 }
				})
			);
			yield* Effect.ignore(
				automation.csvProfiler({
					contract: { name: "unreal-automation-csv", version },
					command: "status"
				})
			);
			yield* Effect.ignore(
				locateUnrealAsset({ endpoint, objectPath: "/Game/A.A", bringToFront: false })
			);
			yield* Effect.ignore(
				openUnrealAsset({ endpoint, objectPath: "/Game/A.A", bringToFront: false })
			);
		}).pipe(Effect.provide(layer));
		expect(
			Object.fromEntries(calls.map((call) => [call.functionName, call.operation]))
		).toEqual({
			GetCapabilityManifest: "unreal.producer.inspect",
			ListTableObjectPaths: "unreal.authoring.list_tables",
			GetTableSnapshot: "unreal.authoring.table_snapshot",
			Apply: "unreal.authoring.apply",
			LookupApplyResult: "unreal.authoring.lookup_apply",
			Save: "unreal.authoring.save",
			FindActorsReferencingRow: "unreal.authoring.actor_references",
			ListPlayers: "unreal.automation.list_players",
			InjectInput: "unreal.automation.inject_input",
			CsvProfiler: "unreal.automation.csv_profiler",
			LocateAsset: "unreal.asset_navigation.locate",
			OpenAsset: "unreal.asset_navigation.open"
		});
		// Every manifest read shares one name, so one host setting covers them all.
		expect(
			new Set(
				calls
					.filter((call) => call.functionName === "GetCapabilityManifest")
					.map((call) => call.operation)
			)
		).toEqual(new Set(["unreal.producer.inspect"]));
	})
);
