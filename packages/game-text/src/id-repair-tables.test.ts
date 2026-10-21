import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import type {
	AuthoringApplyRequest,
	AuthoringFieldDescriptor,
	GameTextActionsResult
} from "@ue-shed/protocol";
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

const tablePath = "/Game/Items/DT_Items.DT_Items";
// A User Defined Struct member: saved packages and the reader use the FName, rows the authored name.
const memberName = "DisplayName_2_1F2E3D4C5B6A79808F9EADBCCBDAE9F8";

/** A live 2.x snapshot of one localized text column; omit `propertyName` for pre-2.4 plugins. */
function tableSnapshot(column: { name: string; propertyName?: string }, key = before.key) {
	const authored = {
		annotations: { deprecated: false, readOnly: false },
		defaultValue: { status: "unknown" },
		editability: { kind: "editable" },
		id: `field:${column.name}`,
		name: column.name,
		presence: "required",
		type: { kind: "scalar", valueKind: "text" },
		typeName: "TextProperty"
	} satisfies AuthoringFieldDescriptor;
	const descriptor: AuthoringFieldDescriptor =
		column.propertyName === undefined
			? authored
			: { ...authored, propertyName: column.propertyName };
	return {
		authority: { kind: "live_editor", producerId: "producer", sessionId: "session" },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 2, minor: 4 } },
		diagnostics: [],
		fingerprint: {
			algorithm: "sha256",
			status: "available",
			value: "sha256-v1:items",
			version: 1
		},
		producer: { name: "UEShedAuthoring", version: "1" },
		table: {
			kind: "data_table",
			objectPath: tablePath,
			packageName: "/Game/Items/DT_Items",
			parentTables: [],
			rowStruct: "/Game/Items/S_Item.S_Item",
			rows: [
				{
					id: "row:Lamp",
					name: "Lamp",
					fields: [
						{
							name: column.name,
							typeName: "TextProperty",
							value: {
								kind: "text",
								value: before.source,
								identity: {
									kind: "localized",
									namespace: before.namespace,
									key,
									sourceString: before.source
								}
							}
						}
					]
				}
			],
			schema: {
				status: "available",
				source: "live_reflection",
				fields: [descriptor]
			}
		}
	};
}

/** A key fix for the saved reader's cell `Lamp.<propertyPath>` in DT_Items. */
function tableRequest(propertyPath: string) {
	return Schema.decodeUnknownSync(TextIdRepairRequest)({
		projectKey: "C:/Fixture",
		title: "Fix table key",
		changes: [
			{
				unitId: "lamp",
				occurrence: {
					id: "place",
					packageFile: "Content/Items/DT_Items.uasset",
					source: before.source,
					devNotes: "",
					identity: { status: "resolved", ...before },
					editCapability: "source_editable",
					location: {
						kind: "data_table_cell",
						objectPath: tablePath,
						row: "Lamp",
						propertyPath
					}
				},
				edit: { kind: "change_key", namespace: "UI", key: "New" }
			}
		]
	});
}

function connection(snapshot?: ReturnType<typeof tableSnapshot>) {
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
				if (call.functionName === "GetTableSnapshot" && snapshot)
					return Schema.decodeUnknownSync(Schema.Json)(snapshot);
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

const prepare = (propertyPath: string, snapshot: ReturnType<typeof tableSnapshot>) =>
	prepareTextIdTableRepair("http://localhost:30010", tableRequest(propertyPath), "repair").pipe(
		Effect.provide(connection(snapshot).layer)
	);

it.effect("binds a User Defined Struct cell by its FName rather than its authored name", () =>
	Effect.gen(function* () {
		const { authoring, preview } = yield* prepare(
			memberName,
			tableSnapshot({ name: "DisplayName", propertyName: memberName })
		);
		expect(authoring.tables).toEqual([
			{ objectPath: tablePath, expectedFingerprint: "sha256-v1:items" }
		]);
		expect(authoring.commands[0]?.body).toMatchObject({
			kind: "set_cell",
			fieldName: memberName,
			rowId: "row:Lamp",
			oldValue: { kind: "text", identity: { key: "Old" } },
			newValue: { kind: "text", identity: { kind: "localized", key: "New" } }
		});
		expect(preview.actions[0]?.after).toEqual({ ...before, key: "New" });
	})
);

it.effect("binds native struct cells, whose FName is their name, with and without 2.4", () =>
	Effect.gen(function* () {
		for (const column of [{ name: "Text", propertyName: "Text" }, { name: "Text" }]) {
			const { authoring } = yield* prepare("Text", tableSnapshot(column));
			expect(authoring.commands[0]?.body).toMatchObject({
				kind: "set_cell",
				fieldName: "Text"
			});
		}
	})
);

it.effect("reports an unbound column apart from a cell whose text changed", () =>
	Effect.gen(function* () {
		const legacy = yield* prepare(memberName, tableSnapshot({ name: "DisplayName" })).pipe(
			Effect.flip
		);
		expect(legacy).toMatchObject({
			_tag: "TextIdTableColumnError",
			objectPath: tablePath,
			propertyName: memberName,
			liveColumns: ["DisplayName"]
		});
		expect(legacy.recovery).toContain("Update the UE Shed plugins");

		const changedStruct = yield* prepare(
			memberName,
			tableSnapshot({
				name: "Title",
				propertyName: "Title_3_0A1B2C3D4E5F60718293A4B5C6D7E8F9"
			})
		).pipe(Effect.flip);
		expect(changedStruct._tag).toBe("TextIdTableColumnError");
		expect(changedStruct.recovery).toContain("row struct changed");

		const changedCell = yield* prepare(
			memberName,
			tableSnapshot({ name: "DisplayName", propertyName: memberName }, "Edited")
		).pipe(Effect.flip);
		expect(changedCell).toMatchObject({
			_tag: "TextIdTableRepairError",
			message: "The live cell no longer holds the source and key you reviewed."
		});
	})
);
