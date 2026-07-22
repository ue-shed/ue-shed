import type {
	AuthoringApplyResult,
	AuthoringSaveResult,
	AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	acceptApplyResult,
	acceptSaveResult,
	buildApplyRequest,
	dispatchApply,
	type AuthoringLivePort
} from "./live.js";
import { appendCommandGroup, buildSetCellCommand, createDraftSession } from "./draft.js";
import { fingerprintTable } from "./fingerprint.js";

function snapshot(value = "1"): AuthoringTableSnapshot {
	return {
		authority: {
			kind: "live_editor",
			producerId: "producer",
			sessionId: "session"
		},
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
		diagnostics: [],
		table: {
			kind: "data_table",
			objectPath: "/Game/Fixture/DT_Test.DT_Test",
			parentTables: [],
			rowStruct: "/Script/Fixture.Row",
			rows: [
				{
					fields: [
						{
							name: "Count",
							typeName: "IntProperty",
							value: { kind: "int", value }
						}
					],
					id: "row:Alpha",
					name: "Alpha"
				}
			]
		}
	};
}

function editedSession() {
	const base = snapshot();
	const initial = createDraftSession("draft", [base], fingerprintTable);
	return appendCommandGroup(initial, [
		buildSetCellCommand({
			authoredAt: "2026-07-14T00:00:00Z",
			commandId: "command",
			fieldName: "Count",
			groupId: "group",
			rowName: "Alpha",
			session: initial,
			tableObjectPath: base.table.objectPath,
			value: { kind: "int", value: "2" }
		})
	]);
}

describe("live authoring workflow", () => {
	it("builds a bounded wire plan and rebases committed snapshots while retaining Save state", () => {
		const session = editedSession();
		const request = buildApplyRequest(session, "operation");
		expect(request.tables).toEqual([
			{
				expectedFingerprint: session.fingerprints[request.tables[0]!.objectPath],
				objectPath: "/Game/Fixture/DT_Test.DT_Test"
			}
		]);
		const result: AuthoringApplyResult = {
			contract: {
				name: "unreal-authoring-apply",
				version: { major: 1, minor: 0 }
			},
			errors: [],
			operationId: "operation",
			snapshots: [snapshot("2")],
			status: "committed"
		};
		const rebased = acceptApplyResult(session, request, result, "2026-07-14T00:01:00Z");
		expect(rebased.commands).toEqual([]);
		expect(rebased.applyReceipts.at(-1)?.errors).toEqual([]);
		expect(rebased.awaitingSave).toEqual(["/Game/Fixture/DT_Test.DT_Test"]);
		expect(rebased.fingerprints[result.snapshots[0]!.table.objectPath]).toBe(
			fingerprintTable(result.snapshots[0]!)
		);
	});

	it("retains structured engine errors when Apply is rejected", () => {
		const session = editedSession();
		const request = buildApplyRequest(session, "operation");
		const rejected = acceptApplyResult(
			session,
			request,
			{
				contract: { name: "unreal-authoring-apply", version: { major: 1, minor: 0 } },
				errors: [
					{
						code: "read_only_table",
						message: "CompositeDataTable rows are derived",
						objectPath: snapshot().table.objectPath,
						retrySafe: false
					}
				],
				operationId: "operation",
				snapshots: [],
				status: "rejected"
			},
			"now"
		);
		expect(rejected.commands).toEqual(session.commands);
		expect(rejected.applyReceipts.at(-1)?.errors?.[0]?.code).toBe("read_only_table");
	});

	it("records an indeterminate receipt instead of replaying an uncertain mutation", async () => {
		const session = editedSession();
		const transportError = { message: "connection lost" };
		const port: AuthoringLivePort<typeof transportError> = {
			apply: () => Effect.fail(transportError),
			lookupApplyResult: () => Effect.fail(transportError),
			save: () => Effect.fail(transportError)
		};
		const outcome = await Effect.runPromise(
			dispatchApply({
				appliedAt: "2026-07-14T00:01:00Z",
				operationId: "uncertain",
				port,
				session
			})
		);
		expect(outcome.kind).toBe("indeterminate");
		expect(outcome.session.applyReceipts.at(-1)?.status).toBe("indeterminate");
		expect(outcome.session.commands).toEqual(session.commands);
	});

	it("rejects over-limit plans and mismatched results without clearing commands", () => {
		const session = editedSession();
		expect(() =>
			buildApplyRequest(session, "limited", {
				maxCommands: 0,
				maxPayloadBytes: 1_048_576,
				maxTables: 16
			})
		).toThrow(/editor limit is 0/);
		const request = buildApplyRequest(session, "expected");
		const wrongOperation: AuthoringApplyResult = {
			contract: { name: "unreal-authoring-apply", version: { major: 1, minor: 0 } },
			errors: [],
			operationId: "other",
			snapshots: [snapshot("2")],
			status: "committed"
		};
		expect(() => acceptApplyResult(session, request, wrongOperation, "now")).toThrow(
			/Expected operation expected/
		);
		expect(session.commands).toHaveLength(1);
	});

	it("rejects a committed snapshot that does not equal the drafted working state", () => {
		const session = editedSession();
		const request = buildApplyRequest(session, "operation");
		const result: AuthoringApplyResult = {
			contract: { name: "unreal-authoring-apply", version: { major: 1, minor: 0 } },
			errors: [],
			operationId: "operation",
			snapshots: [snapshot("999")],
			status: "committed"
		};
		expect(() => acceptApplyResult(session, request, result, "now")).toThrow(
			/does not match the drafted result/
		);
	});

	it("records Save independently and retains only failed packages", () => {
		const session = { ...editedSession(), awaitingSave: ["/Game/A.A", "/Game/B.B"] };
		const result: AuthoringSaveResult = {
			contract: {
				name: "unreal-authoring-save",
				version: { major: 1, minor: 0 }
			},
			packages: [
				{
					objectPath: "/Game/A.A",
					packageName: "/Game/A",
					retrySafe: true,
					status: "saved"
				},
				{
					message: "read only",
					objectPath: "/Game/B.B",
					packageName: "/Game/B",
					retrySafe: true,
					status: "failed"
				}
			],
			requestId: "save",
			status: "partial"
		};
		const request = {
			contract: {
				name: "unreal-authoring-save" as const,
				version: { major: 1 as const, minor: 0 }
			},
			objectPaths: ["/Game/A.A", "/Game/B.B"],
			requestId: "save"
		};
		const updated = acceptSaveResult(session, request, result, "2026-07-14T00:02:00Z");
		expect(updated.awaitingSave).toEqual(["/Game/B.B"]);
		expect(updated.saveReceipts.at(-1)?.status).toBe("partial");
	});
});
