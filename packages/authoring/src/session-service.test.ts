import type { AuthoringTableSnapshot, AuthoringTableSnapshotV1 } from "@ue-shed/protocol";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	authoringIdGeneratorLayer,
	authoringSessionLivePortLayer,
	buildSetCellCommand,
	makeAuthoringSessionService,
	workingTable
} from "./index.js";

function snapshot(value = "1"): AuthoringTableSnapshotV1 {
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

function snapshotAt(objectPath: string, value = "1"): AuthoringTableSnapshot {
	const base = snapshot(value);
	return { ...base, table: { ...base.table, objectPath } };
}

function snapshotV2(value = "1", readOnly = false): AuthoringTableSnapshot {
	return {
		authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
		completeness: "complete",
		contract: { name: "unreal-authoring", version: { major: 2, minor: 0 } },
		diagnostics: [],
		fingerprint: { algorithm: "sha256", status: "available", value: "fixture", version: 1 },
		producer: { name: "fixture", version: "1" },
		table: {
			kind: "data_table",
			objectPath: "/Game/Fixture/DT_Test.DT_Test",
			packageName: "/Game/Fixture/DT_Test",
			parentTables: [],
			rows: snapshot(value).table.rows,
			rowStruct: "/Script/Fixture.Row",
			schema: {
				fields: [
					{
						annotations: { deprecated: false, readOnly },
						defaultValue: { status: "known", value: { kind: "int", value: "0" } },
						editability: readOnly
							? { kind: "read_only", reason: "Fixture policy" }
							: { kind: "editable" },
						id: "field:Count",
						name: "Count",
						presence: "required",
						type: { kind: "scalar", valueKind: "int" },
						typeName: "IntProperty"
					}
				],
				source: "saved_package",
				status: "available"
			}
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
			const review = await Effect.runPromise(restarted.review("draft-1"));
			expect(review.tables[0]?.changes).toContainEqual(
				expect.objectContaining({
					fieldName: "Count",
					kind: "cell_changed",
					newValue: { kind: "int", value: "3" },
					oldValue: { kind: "int", value: "1" },
					rowId: "row:Alpha"
				})
			);
			expect(review.tables[0]?.dirtyCells).toEqual([
				{ fieldName: "Count", rowId: "row:Alpha" }
			]);
			expect(review.commandGroups).toHaveLength(2);
			expect((await Effect.runPromise(restarted.undo("draft-1"))).draft.undoPointer).toBe(1);
			const branched = await Effect.runPromise(
				restarted.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "4" }
						}
					],
					sessionId: "draft-1",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			expect(branched.draft.commands).toHaveLength(2);
			expect((await Effect.runPromise(restarted.redo("draft-1"))).draft.undoPointer).toBe(2);
			expect((await Effect.runPromise(restarted.close("draft-1"))).lifecycle).toBe("closed");
			expect((await Effect.runPromise(restarted.resume("draft-1"))).lifecycle).toBe("open");
			expect((await Effect.runPromise(restarted.list())).sessions).toHaveLength(1);
			await Effect.runPromise(restarted.discard("draft-1"));
			expect((await Effect.runPromise(restarted.list())).sessions).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("serializes concurrent mutations and derives multi-table review", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-concurrent-"));
		const otherPath = "/Game/Fixture/DT_Other.DT_Other";
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({ projectId: "fixture", projectRoot: root })
			);
			await Effect.runPromise(
				service.create([snapshot(), snapshotAt(otherPath)], { id: "multi" })
			);
			await Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					Effect.runPromise(
						service.setCells({
							edits: [
								{
									fieldName: "Count",
									rowId: "row:Alpha",
									value: { kind: "int", value: String(index + 2) }
								}
							],
							sessionId: "multi",
							tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
						})
					)
				)
			);
			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "20" }
						}
					],
					sessionId: "multi",
					tableObjectPath: otherPath
				})
			);
			const review = await Effect.runPromise(service.review("multi"));
			expect(review.activeCommandCount).toBe(9);
			expect(review.tables.map((table) => table.objectPath)).toEqual([
				otherPath,
				"/Game/Fixture/DT_Test.DT_Test"
			]);
			expect(review.tables.every((table) => table.changes.length === 1)).toBe(true);
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

	it("migrates legacy draft documents and atomically persists the current version", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-migration-"));
		const storageRoot = join(root, "sessions");
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({
					projectId: "fixture",
					projectRoot: root,
					storageRoot
				})
			);
			const created = await Effect.runPromise(
				service.create([snapshot()], { id: "legacy-session" })
			);
			const { saveReceipts: _saveReceipts, ...legacyDraft } = created.draft;
			await writeFile(
				join(storageRoot, "legacy-session.json"),
				JSON.stringify({ ...created, draft: { ...legacyDraft, version: 1 } }),
				"utf8"
			);
			const restarted = await Effect.runPromise(
				makeAuthoringSessionService({
					projectId: "fixture",
					projectRoot: root,
					storageRoot
				})
			);
			const migrated = await Effect.runPromise(restarted.open("legacy-session"));
			expect(migrated.draft.version).toBe(2);
			expect(migrated.draft.saveReceipts).toEqual([]);
			const persisted = Schema.decodeUnknownSync(
				Schema.Struct({ draft: Schema.Struct({ version: Schema.Number }) })
			)(JSON.parse(await readFile(join(storageRoot, "legacy-session.json"), "utf8")));
			expect(persisted.draft.version).toBe(2);
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

	it("persists safe add, duplicate, rename, reorder, and remove row intents", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-rows-"));
		const storageRoot = join(root, "sessions");
		let nextId = 0;
		const makeService = () =>
			Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() => `id-${nextId++}`)
				)
			);
		try {
			const service = await makeService();
			await Effect.runPromise(service.create([snapshotV2()], { id: "rows" }));
			const added = await Effect.runPromise(
				service.addRow({
					atIndex: 0,
					rowName: "BeforeAlpha",
					sessionId: "rows",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			expect(
				workingTable(added.draft, "/Game/Fixture/DT_Test.DT_Test").table.rows[0]
			).toMatchObject({
				fields: [{ value: { kind: "int", value: "0" } }],
				name: "BeforeAlpha"
			});

			const duplicated = await Effect.runPromise(
				service.duplicateRow({
					rowName: "Beta",
					sessionId: "rows",
					sourceRowId: "row:Alpha",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			const duplicatedTable = workingTable(duplicated.draft, "/Game/Fixture/DT_Test.DT_Test");
			const beta = duplicatedTable.table.rows.find((row) => row.name === "Beta");
			const alpha = duplicatedTable.table.rows.find((row) => row.name === "Alpha");
			if (!beta || !alpha) throw new Error("Expected source and duplicated rows");
			expect(beta.fields).toEqual(alpha.fields);

			const renamed = await Effect.runPromise(
				service.renameRow({
					rowId: beta.id,
					rowName: "Gamma",
					sessionId: "rows",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			const beforeReorder = workingTable(renamed.draft, "/Game/Fixture/DT_Test.DT_Test").table
				.rows;
			const reordered = await Effect.runPromise(
				service.reorderRows({
					rowIds: [...beforeReorder].reverse().map((row) => row.id),
					sessionId: "rows",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			expect(
				workingTable(reordered.draft, "/Game/Fixture/DT_Test.DT_Test").table.rows.map(
					(row) => row.name
				)
			).toEqual(["Gamma", "Alpha", "BeforeAlpha"]);

			await Effect.runPromise(
				service.removeRow({
					rowId: "row:Alpha",
					sessionId: "rows",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			const restarted = await makeService();
			const reopened = await Effect.runPromise(restarted.open("rows"));
			expect(
				workingTable(reopened.draft, "/Game/Fixture/DT_Test.DT_Test").table.rows.map(
					(row) => row.name
				)
			).toEqual(["Gamma", "BeforeAlpha"]);
			const review = await Effect.runPromise(restarted.review("rows"));
			expect(review.validation).toMatchObject({ errorCount: 0, valid: true });
			expect(review.tables[0]?.changes.map((change) => change.kind)).toEqual([
				"row_removed",
				"row_added",
				"row_added",
				"rows_reordered"
			]);
			expect(review.tables[0]?.dirtyRowIds).toEqual(
				expect.arrayContaining(["row:Alpha", beta.id])
			);
			expect(await Effect.runPromise(restarted.diff("rows"))).toEqual(
				review.tables.flatMap((table) => table.changes)
			);
			expect(await Effect.runPromise(restarted.validate("rows"))).toEqual(review.validation);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("returns typed row intent failures without persisting rejected commands", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-row-errors-"));
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({ projectId: "fixture", projectRoot: root })
			);
			await Effect.runPromise(service.create([snapshot()], { id: "row-errors" }));
			const duplicated = await Effect.runPromise(
				service.duplicateRow({
					rowName: "Beta",
					sessionId: "row-errors",
					sourceRowId: "row:Alpha",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			const beta = workingTable(
				duplicated.draft,
				"/Game/Fixture/DT_Test.DT_Test"
			).table.rows.find((row) => row.name === "Beta");
			if (!beta) throw new Error("Expected duplicated row");
			const duplicate = await Effect.runPromise(
				Effect.flip(
					service.renameRow({
						rowId: beta.id,
						rowName: "alpha",
						sessionId: "row-errors",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(duplicate).toMatchObject({
				_tag: "DraftIntentError",
				code: "duplicate_row_name"
			});
			const invalidOrder = await Effect.runPromise(
				Effect.flip(
					service.reorderRows({
						rowIds: [],
						sessionId: "row-errors",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(invalidOrder).toMatchObject({
				_tag: "DraftIntentError",
				code: "invalid_row_order"
			});
			const unsupportedAdd = await Effect.runPromise(
				Effect.flip(
					service.addRow({
						rowName: "Gamma",
						sessionId: "row-errors",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(unsupportedAdd).toMatchObject({
				_tag: "DraftIntentError",
				code: "unsupported_add"
			});
			expect(
				(await Effect.runPromise(service.open("row-errors"))).draft.commands
			).toHaveLength(1);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("rejects schema-incompatible and read-only cell edits without persistence", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-value-errors-"));
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({ projectId: "fixture", projectRoot: root })
			);
			await Effect.runPromise(service.create([snapshotV2()], { id: "typed" }));
			const incompatible = await Effect.runPromise(
				Effect.flip(
					service.setCells({
						edits: [
							{
								fieldName: "Count",
								rowId: "row:Alpha",
								value: { kind: "string", value: "2" }
							}
						],
						sessionId: "typed",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(incompatible).toMatchObject({
				_tag: "DraftIntentError",
				code: "incompatible_value"
			});
			const malformedInteger = await Effect.runPromise(
				Effect.flip(
					service.setCells({
						edits: [
							{
								fieldName: "Count",
								rowId: "row:Alpha",
								value: { kind: "int", value: "not-an-integer" }
							}
						],
						sessionId: "typed",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(malformedInteger).toMatchObject({
				_tag: "DraftIntentError",
				code: "incompatible_value"
			});
			await Effect.runPromise(service.create([snapshotV2("1", true)], { id: "read-only" }));
			const unsupported = await Effect.runPromise(
				Effect.flip(
					service.setCells({
						edits: [
							{
								fieldName: "Count",
								rowId: "row:Alpha",
								value: { kind: "int", value: "2" }
							}
						],
						sessionId: "read-only",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					})
				)
			);
			expect(unsupported).toMatchObject({
				_tag: "DraftIntentError",
				code: "unsupported_edit"
			});
			expect((await Effect.runPromise(service.open("typed"))).draft.commands).toEqual([]);
			expect((await Effect.runPromise(service.open("read-only"))).draft.commands).toEqual([]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("blocks Apply when review finds an invalid persisted working value", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-invalid-review-"));
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService({ projectId: "fixture", projectRoot: root })
			);
			const created = await Effect.runPromise(
				service.create([snapshotV2()], { id: "invalid-review" })
			);
			const fingerprint = created.draft.fingerprints["/Game/Fixture/DT_Test.DT_Test"];
			if (fingerprint === undefined) throw new Error("Expected fixture fingerprint");
			await Effect.runPromise(
				service.append("invalid-review", [
					{
						authoredAt: "2026-07-16T00:00:00.000Z",
						baseFingerprint: fingerprint,
						body: {
							fieldName: "Count",
							kind: "set_cell",
							newValue: { kind: "int", value: "invalid" },
							oldValue: { kind: "int", value: "1" },
							rowId: "row:Alpha"
						},
						groupId: "invalid-group",
						id: "invalid-command",
						tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
					}
				])
			);
			const review = await Effect.runPromise(service.review("invalid-review"));
			expect(review.validation).toMatchObject({ errorCount: 1, valid: false });
			expect(review.validation.diagnostics[0]).toMatchObject({
				code: "incompatible_value",
				severity: "error"
			});
			const blocked = await Effect.runPromise(
				Effect.flip(
					service.prepareApply("invalid-review", {
						maxCommands: 10,
						maxPayloadBytes: 10_000,
						maxTables: 1
					})
				)
			);
			expect(blocked).toMatchObject({
				_tag: "DraftIntentError",
				code: "incompatible_value"
			});
			expect(
				(await Effect.runPromise(service.open("invalid-review"))).pendingOperation
			).toEqual({
				kind: "none"
			});
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

	it("marks Apply indeterminate when dispatch is interrupted before durable completion", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-apply-interrupt-"));
		const storageRoot = join(root, "sessions");
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() => "generated")
				)
			);
			await Effect.runPromise(service.create([snapshot()], { id: "interrupt" }));
			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "2" }
						}
					],
					sessionId: "interrupt",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);

			const started = await Effect.runPromise(Deferred.make<void>());
			const release = await Effect.runPromise(Deferred.make<void>());
			const fiber = Effect.runFork(
				service
					.apply(
						"interrupt",
						{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
						"apply-interrupt"
					)
					.pipe(
						Effect.provide(
							authoringSessionLivePortLayer({
								apply: () =>
									Effect.gen(function* () {
										yield* Deferred.succeed(started, undefined);
										yield* Deferred.await(release);
										return null as never;
									}),
								lookupApplyResult: () => Effect.die("unused"),
								save: () => Effect.die("unused")
							})
						)
					)
			);
			await Effect.runPromise(Deferred.await(started));
			await Effect.runPromise(Fiber.interrupt(fiber));
			await Effect.runPromise(Fiber.await(fiber));
			const pending = await Effect.runPromise(service.open("interrupt"));
			expect(pending.pendingOperation).toMatchObject({
				kind: "apply",
				status: "indeterminate"
			});
			await Effect.runPromise(Deferred.succeed(release, undefined).pipe(Effect.ignore));
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("marks Apply indeterminate when completion fails after a successful dispatch", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-apply-complete-fail-"));
		const storageRoot = join(root, "sessions");
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() => "generated")
				)
			);
			await Effect.runPromise(service.create([snapshot()], { id: "complete-fail" }));
			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "2" }
						}
					],
					sessionId: "complete-fail",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);

			await expect(
				Effect.runPromise(
					service
						.apply(
							"complete-fail",
							{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
							"apply-complete-fail"
						)
						.pipe(
							Effect.provide(
								authoringSessionLivePortLayer({
									apply: () =>
										Effect.succeed({
											contract: {
												name: "unreal-authoring-apply" as const,
												version: { major: 1 as const, minor: 0 as const }
											},
											errors: [],
											operationId: "wrong-operation",
											snapshots: [snapshot("2")],
											status: "committed" as const
										}),
									lookupApplyResult: () => Effect.die("unused"),
									save: () => Effect.die("unused")
								})
							)
						)
				)
			).rejects.toThrow();

			const pending = await Effect.runPromise(service.open("complete-fail"));
			expect(pending.pendingOperation).toMatchObject({
				kind: "apply",
				request: { operationId: "apply-complete-fail" },
				status: "indeterminate"
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it("applies and reconciles through the composed session workflows", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-session-apply-flow-"));
		const storageRoot = join(root, "sessions");
		try {
			const service = await Effect.runPromise(
				makeAuthoringSessionService(
					{ projectId: "fixture", projectRoot: root, storageRoot },
					authoringIdGeneratorLayer(() => "generated")
				)
			);
			await Effect.runPromise(service.create([snapshot()], { id: "flow" }));
			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "2" }
						}
					],
					sessionId: "flow",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);

			const livePort = authoringSessionLivePortLayer({
				apply: (request) =>
					Effect.succeed({
						contract: {
							name: "unreal-authoring-apply" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						errors: [],
						operationId: request.operationId,
						snapshots: [snapshot("2")],
						status: "committed" as const
					}),
				lookupApplyResult: (operationId) =>
					Effect.succeed({
						contract: {
							name: "unreal-authoring-apply" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						errors: [],
						operationId,
						snapshots: [snapshot("3")],
						status: "committed" as const
					}),
				save: () => Effect.die("unused")
			});
			const applied = await Effect.runPromise(
				service
					.apply(
						"flow",
						{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
						"apply-flow"
					)
					.pipe(Effect.provide(livePort))
			);
			expect(applied.pendingOperation).toEqual({ kind: "none" });
			expect(applied.draft.awaitingSave).toEqual(["/Game/Fixture/DT_Test.DT_Test"]);

			await Effect.runPromise(
				service.setCells({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "3" }
						}
					],
					sessionId: "flow",
					tableObjectPath: "/Game/Fixture/DT_Test.DT_Test"
				})
			);
			expect((await Effect.runPromise(service.review("flow"))).pipeline).toEqual({
				canApply: true,
				kind: "draft"
			});
			await Effect.runPromise(
				service.prepareApply(
					"flow",
					{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
					"apply-reconcile"
				)
			);
			await Effect.runPromise(service.markApplyIndeterminate("flow", "transport lost"));
			const reconciled = await Effect.runPromise(
				service.reconcileApply("flow").pipe(Effect.provide(livePort))
			);
			expect(reconciled.pendingOperation).toEqual({ kind: "none" });
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
