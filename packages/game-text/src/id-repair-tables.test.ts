import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import type { AuthoringApplyRequest, GameTextActionsResult } from "@ue-shed/protocol";
import { applyTextIdTableRepair, prepareTextIdTableRepair } from "./id-repair-tables.js";
import { TextIdRepairRequest } from "./id-repair-schema.js";

const contract = { name: "unreal-authoring-apply", version: { major: 1, minor: 2 } } as const;
const authoring: AuthoringApplyRequest = {
	contract,
	operationId: "repair",
	commands: [],
	tables: []
};
const before = { namespace: "UI", key: "Old", source: "Lamp on" };
const preview: GameTextActionsResult = {
	contract: "ue-shed-game-text-actions",
	version: "1.0",
	mode: "dry_run",
	status: "ok",
	rolledBack: false,
	errors: [],
	blueprints: [],
	actions: [
		{
			id: "place",
			place: {
				packageFile: "Content/Lamp.uasset",
				objectPath: "/Game/Lamp.Lamp",
				propertyPath: "On.Text"
			},
			status: "planned",
			before,
			after: { ...before, key: "New" }
		}
	],
	packages: [
		{
			packageName: "/Game/Lamp",
			packageFile: "Content/Lamp.uasset",
			saved: false,
			persistence: "unsaved"
		}
	]
};

function connection() {
	const calls: string[] = [];
	return {
		calls,
		layer: makeRemoteControlClientTestLayer((call) =>
			Effect.gen(function* () {
				calls.push(call.functionName);
				if (call.functionName === "GetCapabilityManifest")
					return Schema.decodeUnknownSync(Schema.Json)({
						schemaVersion: 1,
						producerKind: "unreal_editor",
						authoringObjectPath:
							"/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
						authoringLimits: {
							maxCommands: 1024,
							maxPayloadBytes: 1048576,
							maxTables: 16
						},
						capabilities: [
							"authoring.snapshot.v2",
							"authoring.table-list.v1",
							"authoring.apply.v1",
							"authoring.apply-result.v1",
							"authoring.save.v1"
						]
					});
				if (call.functionName === "Apply")
					return Schema.decodeUnknownSync(Schema.Json)({
						contract,
						operationId: "repair",
						errors: [],
						snapshots: [],
						status: "committed"
					});
				return yield* new RemoteControlClientError({
					code: "request_timeout",
					endpoint: call.endpoint,
					functionName: call.functionName,
					operation: call.operation ?? "table repair",
					message: "Save reply lost",
					recovery: "Reconcile saved tables",
					retrySafe: false,
					nextStep: "reconcile"
				});
			})
		)
	};
}

it.effect("retains committed table edits before a save reply is lost", () =>
	Effect.gen(function* () {
		const remote = connection();
		let retained: GameTextActionsResult | undefined;
		yield* applyTextIdTableRepair("http://localhost:30010", authoring, preview, (result) =>
			Effect.sync(() => {
				retained = result;
			})
		).pipe(Effect.provide(remote.layer), Effect.flip);
		expect(retained?.actions[0]?.status).toBe("applied");
		expect(retained?.packages[0]?.persistence).toBe("unsaved");
		expect(retained?.errors[0]?.nextStep).toBe("reconcile");
		expect(remote.calls).toEqual(["GetCapabilityManifest", "Apply", "Save"]);
	})
);

it.effect("refuses copied table paths that still point at another physical package", () =>
	Effect.gen(function* () {
		const remote = connection();
		const request = Schema.decodeUnknownSync(TextIdRepairRequest)({
			projectKey: "C:/Fixture",
			title: "Fix copied table",
			changes: [
				{
					unitId: "lamp",
					occurrence: {
						id: "place",
						packageFile: "Content/Lamp_Copy.uasset",
						source: before.source,
						devNotes: "",
						identity: { status: "resolved", ...before },
						editCapability: "source_editable",
						location: {
							kind: "data_table_cell",
							objectPath: "/Game/Lamp.Lamp",
							row: "On",
							propertyPath: "Text"
						}
					},
					edit: { kind: "change_key", namespace: "UI", key: "New" }
				}
			]
		});
		const error = yield* prepareTextIdTableRepair(
			"http://localhost:30010",
			request,
			"repair"
		).pipe(Effect.provide(remote.layer), Effect.flip);
		expect(error.message).toContain("reviewed file");
		expect(remote.calls).toEqual(["GetCapabilityManifest"]);
	})
);
