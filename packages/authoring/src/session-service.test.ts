import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	authoringIdGeneratorLayer,
	buildSetCellCommand,
	makeAuthoringSessionService,
	workingTable
} from "./index.js";

function snapshot(value = "1"): AuthoringTableSnapshot {
	return {
		authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 1, minor: 0 } },
		diagnostics: [],
		table: {
			kind: "data_table",
			objectPath: "/Game/Fixture/DT_Test.DT_Test",
			parentTables: [],
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
			],
			rowStruct: "/Script/Fixture.Row"
		}
	};
}

describe("AuthoringSessionService", () => {
	it("persists create, append, undo, close, and resume across service restarts", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-service-"));
		const storageRoot = join(root, "sessions");
		let tick = 0;
		const makeService = () =>
			Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() =>
						tick++ === 0 ? "draft-1" : `generated-${tick}`
					)
				)
			);
		try {
			const first = await makeService();
			const created = await Effect.runPromise(first.create([snapshot()]));
			const command = buildSetCellCommand({
				authoredAt: "2026-07-15T00:00:01.000Z",
				commandId: "command-1",
				fieldName: "Count",
				groupId: "gesture-1",
				rowName: "Alpha",
				session: created.draft,
				tableObjectPath: "/Game/Fixture/DT_Test.DT_Test",
				value: { kind: "int", value: "2" }
			});
			await Effect.runPromise(first.append("draft-1", [command]));

			const restarted = await makeService();
			const reopened = await Effect.runPromise(restarted.open("draft-1"));
			expect(
				workingTable(reopened.draft, "/Game/Fixture/DT_Test.DT_Test").table.rows[0]
			).toMatchObject({ fields: [{ value: { value: "2" } }] });
			const batch = await Effect.runPromise(
				restarted.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "3" }
						}
					],
					sessionId: "draft-1",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			expect(batch.draft.commands.at(-1)?.groupId).not.toBe(batch.draft.commands[0]?.groupId);
			expect((await Effect.runPromise(restarted.undo("draft-1"))).draft.undoPointer).toBe(1);
			expect((await Effect.runPromise(restarted.close("draft-1"))).lifecycle).toBe("closed");
			expect((await Effect.runPromise(restarted.resume("draft-1"))).lifecycle).toBe("open");
			expect((await Effect.runPromise(restarted.list())).sessions).toHaveLength(1);
			await Effect.runPromise(restarted.discard("draft-1"));
			expect((await Effect.runPromise(restarted.list())).sessions).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("quarantines malformed sessions instead of overwriting them", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-corrupt-"));
		const storageRoot = join(root, "sessions");
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({
					projectId: "fixture",
					projectRoot: root,
					storageRoot
				})
			);
			await Effect.runPromise(service.list());
			await writeFile(join(storageRoot, "broken.json"), "{ truncated", "utf8");
			const listed = await Effect.runPromise(service.list());
			expect(listed.sessions).toEqual([]);
			expect(listed.diagnostics).toHaveLength(1);
			expect(
				(await readdir(storageRoot)).some((name) => name.startsWith("broken.json.corrupt-"))
			).toBe(true);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("does not persist a partial cell gesture when one edit is invalid", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-atomic-"));
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root },
					authoringIdGeneratorLayer(() => "generated")
				)
			);
			const created = await Effect.runPromise(service.create([snapshot()], { id: "atomic" }));
			await Effect.runPromise(
				Effect.flip(
					service.setCells({
						edits: [
							{
								fieldName: "Count",
								rowId: "row:Alpha",
								value: { kind: "int", value: "2" }
							},
							{
								fieldName: "Missing",
								rowId: "row:Alpha",
								value: { kind: "int", value: "3" }
							}
						],
						sessionId: created.draft.id,
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			const reopened = await Effect.runPromise(service.open("atomic"));
			expect(reopened.draft.commands).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("persists Apply before dispatch and reconciles it safely after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-recovery-"));
		const storageRoot = join(root, "sessions");
		const makeService = () =>
			Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() => "generated")
				)
			);
		try {
			const service = await makeService();
			await Effect.runPromise(service.create([snapshot()], { id: "recovery" }));
			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "2" }
						}
					],
					sessionId: "recovery",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			await Effect.runPromise(
				service.prepareApply(
					"recovery",
					{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
					"apply-1"
				)
			);

			const restarted = await makeService();
			const pending = await Effect.runPromise(restarted.open("recovery"));
			expect(pending.pendingOperation).toMatchObject({
				kind: "apply",
				request: { operationId: "apply-1" },
				status: "dispatching"
			});
			await expect(
				Effect.runPromise(
					restarted.setCells({
						edits: [],
						sessionId: "recovery",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			).rejects.toThrow(/reconcile it first/);
			const live = snapshot("2");
			const completed = await Effect.runPromise(
				restarted.completeApply("recovery", {
					contract: { name: "unreal-authoring-apply", version: { major: 1, minor: 0 } },
					errors: [],
					operationId: "apply-1",
					snapshots: [live],
					status: "committed"
				})
			);
			expect(completed.pendingOperation).toEqual({ kind: "none" });
			expect(completed.draft.commands).toEqual([]);
			expect(completed.draft.awaitingSave).toEqual(["/Game/Fixture/DT_Test.DT_Test"]);

			await Effect.runPromise(restarted.prepareSave("recovery", "save-1"));
			const saveRestarted = await makeService();
			const failedSave = await Effect.runPromise(
				saveRestarted.completeSave("recovery", {
					contract: { name: "unreal-authoring-save", version: { major: 1, minor: 0 } },
					packages: [
						{
							message: "temporarily unavailable",
							objectPath: "/Game/Fixture/DT_Test.DT_Test",
							packageName: "/Game/Fixture/DT_Test",
							retrySafe: true,
							status: "failed"
						}
					],
					requestId: "save-1",
					status: "failed"
				})
			);
			expect(failedSave.draft.awaitingSave).toEqual(["/Game/Fixture/DT_Test.DT_Test"]);
			const retried = await Effect.runPromise(
				saveRestarted.prepareSave("recovery", "save-2")
			);
			expect(retried.pendingOperation).toMatchObject({
				kind: "save",
				request: { objectPaths: ["/Game/Fixture/DT_Test.DT_Test"], requestId: "save-2" }
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
