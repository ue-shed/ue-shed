import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	decodeAuthoringApplyResult as decodeAuthoringApplyResultEffect,
	decodeAuthoringSaveResult as decodeAuthoringSaveResultEffect,
	decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect,
	type AuthoringApplyRequest,
	type AuthoringCommand,
	type AuthoringSaveRequest
} from "@ue-shed/protocol";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { makeAuthoringSessionService } from "./session-service.js";
import { fingerprintTable } from "./fingerprint.js";

const decodeAuthoringApplyResult = (input: unknown) =>
	Effect.runSync(decodeAuthoringApplyResultEffect(input));
const decodeAuthoringSaveResult = (input: unknown) =>
	Effect.runSync(decodeAuthoringSaveResultEffect(input));
const decodeAuthoringTableSnapshot = (input: unknown) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const enabled = process.env.UE_SHED_UNREAL_INTEGRATION === "1" && executable;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const objectPath = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars";
const enumObjectPath = "/Game/Fixture/Authoring/DT_Enums.DT_Enums";
const rowReferenceObjectPath = "/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences";
const assetPath = join(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
);
const rowReferenceAssetPath = join(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Authoring/DT_LeftReferences.uasset"
);

function runFixture(...args: string[]): void {
	execFileSync(process.execPath, ["scripts/unreal-fixture.mjs", ...args], {
		cwd: repositoryRoot,
		stdio: "pipe",
		timeout: 120_000,
		windowsHide: true
	});
}

function readDiskSnapshot(path = assetPath): unknown {
	return JSON.parse(
		execFileSync(executable!, ["authoring", path, "--format", "json"], {
			encoding: "utf8",
			windowsHide: true
		})
	);
}

async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8"));
}

describe.skipIf(!enabled)("real Unreal authoring mutation", () => {
	it("rolls back a failed batch, commits all command shapes, caches the result, and saves separately", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-authoring-"));
		try {
			runFixture("generate");
			const snapshots = join(directory, "snapshots");
			runFixture("snapshot", snapshots);
			const base = decodeAuthoringTableSnapshot(
				await json(join(snapshots, "DT_Scalars.json"))
			);
			const enumBase = decodeAuthoringTableSnapshot(
				await json(join(snapshots, "DT_Enums.json"))
			);
			const rowReferenceBase = decodeAuthoringTableSnapshot(
				await json(join(snapshots, "DT_LeftReferences.json"))
			);
			const alpha = base.table.rows[0]!;
			const beta = base.table.rows[1]!;
			const enabledField = alpha.fields.find((field) => field.name === "Enabled")!;
			const enumRow = enumBase.table.rows[0]!;
			const enumField = enumRow.fields[0]!;
			const rowReferenceRow = rowReferenceBase.table.rows[0]!;
			const rowReferenceField = rowReferenceRow.fields[0]!;
			const changedValue = { kind: "bool", value: false } as const;
			const applyContract = {
				name: "unreal-authoring-apply",
				version: { major: 1, minor: 0 }
			} as const;

			const rollbackRequest: AuthoringApplyRequest = {
				contract: applyContract,
				operationId: "rollback-probe",
				tables: [
					{ expectedFingerprint: fingerprintTable(base), objectPath },
					{ expectedFingerprint: fingerprintTable(enumBase), objectPath: enumObjectPath }
				],
				commands: [
					{
						body: {
							fieldName: "Enabled",
							kind: "set_cell",
							newValue: changedValue,
							oldValue: enabledField.value,
							rowId: alpha.id
						},
						id: "rollback-valid",
						tableObjectPath: objectPath
					},
					{
						body: {
							fieldName: "Missing",
							kind: "set_cell",
							newValue: enumField.value,
							oldValue: enumField.value,
							rowId: enumRow.id
						},
						id: "rollback-invalid",
						tableObjectPath: enumObjectPath
					}
				]
			};
			const rollbackInput = join(directory, "rollback-request.json");
			const rollbackOutput = join(directory, "rollback-result.json");
			await writeFile(rollbackInput, JSON.stringify(rollbackRequest), "utf8");
			runFixture("apply", rollbackInput, rollbackOutput);
			const rollback = decodeAuthoringApplyResult(await json(rollbackOutput));
			expect(rollback.status, JSON.stringify(rollback.errors)).toBe("rolled_back");
			expect(
				fingerprintTable(
					rollback.snapshots.find((entry) => entry.table.objectPath === objectPath)!
				)
			).toBe(fingerprintTable(base));
			expect(
				fingerprintTable(
					rollback.snapshots.find((entry) => entry.table.objectPath === enumObjectPath)!
				)
			).toBe(fingerprintTable(enumBase));

			const collisionInput = join(directory, "collision-request.json");
			const collisionOutput = join(directory, "collision-result.json");
			await writeFile(
				collisionInput,
				JSON.stringify({ ...rollbackRequest, commands: [], operationId: "rollback-probe" }),
				"utf8"
			);
			runFixture(
				"apply-pair",
				rollbackInput,
				rollbackOutput,
				collisionInput,
				collisionOutput
			);
			const collision = decodeAuthoringApplyResult(await json(collisionOutput));
			expect(collision.status).toBe("rejected");
			expect(collision.errors[0]?.code).toBe("operation_id_collision");

			const driftInput = join(directory, "drift-request.json");
			const driftOutput = join(directory, "drift-result.json");
			await writeFile(
				driftInput,
				JSON.stringify({
					commands: [],
					contract: applyContract,
					operationId: "drift-probe",
					tables: [{ expectedFingerprint: "sha256-v1:stale", objectPath }]
				}),
				"utf8"
			);
			runFixture("apply", driftInput, driftOutput);
			const drift = decodeAuthoringApplyResult(await json(driftOutput));
			expect(drift.status).toBe("rejected");
			expect(drift.errors[0]?.code).toBe("fingerprint_mismatch");

			const added = { ...alpha, id: "session:added", name: "Temporary" };
			const bodies: readonly AuthoringCommand[] = [
				{
					fieldName: "Enabled",
					kind: "set_cell",
					newValue: changedValue,
					oldValue: enabledField.value,
					rowId: alpha.id
				},
				{ atIndex: 2, kind: "add_row", row: added },
				{
					kind: "rename_row",
					newName: "Scalar_Added",
					oldName: "Temporary",
					rowId: added.id
				},
				{
					kind: "reorder_rows",
					newOrder: [added.id, alpha.id, beta.id],
					oldOrder: [alpha.id, beta.id, added.id]
				},
				{ atIndex: 2, kind: "remove_row", row: beta }
			];
			const wireCommands = [
				...bodies.map((body, index) => ({
					body,
					id: `command-${index}`,
					tableObjectPath: objectPath
				})),
				{
					body: {
						fieldName: enumField.name,
						kind: "set_cell" as const,
						newValue: enumBase.table.rows[1]!.fields[0]!.value,
						oldValue: enumField.value,
						rowId: enumRow.id
					},
					id: "command-enum",
					tableObjectPath: enumObjectPath
				},
				{
					body: {
						fieldName: rowReferenceField.name,
						kind: "set_cell" as const,
						newValue: {
							kind: "row_reference" as const,
							rowName: "Right_Beta",
							tableObjectPath:
								"/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
						},
						oldValue: rowReferenceField.value,
						rowId: rowReferenceRow.id
					},
					id: "command-row-reference",
					tableObjectPath: rowReferenceObjectPath
				}
			];
			const bases = new Map(
				[base, enumBase, rowReferenceBase].map((snapshot) => [
					snapshot.table.objectPath,
					snapshot
				])
			);
			const service = await Effect.runPromise(
				makeAuthoringSessionService({
					projectId: "real-unreal",
					projectRoot: repositoryRoot,
					storageRoot: join(directory, "sessions")
				})
			);
			await Effect.runPromise(
				service.create([base, enumBase, rowReferenceBase], { id: "recovery" })
			);
			await Effect.runPromise(
				service.append(
					"recovery",
					wireCommands.map((command) => ({
						...command,
						authoredAt: "2026-07-15T00:00:00.000Z",
						baseFingerprint: fingerprintTable(bases.get(command.tableObjectPath)!),
						groupId: "real-unreal-gesture"
					}))
				)
			);
			const prepared = await Effect.runPromise(
				service.prepareApply(
					"recovery",
					{ maxCommands: 1024, maxPayloadBytes: 1048576, maxTables: 16 },
					"commit-and-save"
				)
			);
			if (prepared.pendingOperation.kind !== "apply") throw new Error("Apply not prepared");
			const commitRequest = prepared.pendingOperation.request;
			const saveRequest: AuthoringSaveRequest = {
				contract: {
					name: "unreal-authoring-save",
					version: { major: 1, minor: 0 }
				},
				objectPaths: [
					objectPath,
					enumObjectPath,
					rowReferenceObjectPath,
					"/Game/Fixture/Authoring/DT_Missing.DT_Missing"
				],
				requestId: "save-after-commit"
			};
			const commitInput = join(directory, "commit-request.json");
			const commitOutput = join(directory, "commit-result.json");
			const saveInput = join(directory, "save-request.json");
			const saveOutput = join(directory, "save-result.json");
			const lookupOutput = join(directory, "lookup-result.json");
			await writeFile(commitInput, JSON.stringify(commitRequest), "utf8");
			await writeFile(saveInput, JSON.stringify(saveRequest), "utf8");
			runFixture(
				"apply",
				commitInput,
				commitOutput,
				saveInput,
				saveOutput,
				commitRequest.operationId,
				lookupOutput
			);
			const committed = decodeAuthoringApplyResult(await json(commitOutput));
			const lookup = decodeAuthoringApplyResult(await json(lookupOutput));
			const saved = decodeAuthoringSaveResult(await json(saveOutput));
			expect(committed.status).toBe("committed");
			expect(lookup).toEqual(committed);
			await Effect.runPromise(service.markApplyIndeterminate("recovery", "transport lost"));
			const restarted = await Effect.runPromise(
				makeAuthoringSessionService({
					projectId: "real-unreal",
					projectRoot: repositoryRoot,
					storageRoot: join(directory, "sessions")
				})
			);
			const recovered = await Effect.runPromise(restarted.completeApply("recovery", lookup));
			expect(recovered.pendingOperation).toEqual({ kind: "none" });
			expect(recovered.draft.commands).toEqual([]);
			expect(saved.status).toBe("partial");
			expect(saved.packages).toMatchObject([
				{ objectPath, retrySafe: true, status: "saved" },
				{ objectPath: enumObjectPath, retrySafe: true, status: "saved" },
				{ objectPath: rowReferenceObjectPath, retrySafe: true, status: "saved" },
				{
					objectPath: "/Game/Fixture/Authoring/DT_Missing.DT_Missing",
					retrySafe: true,
					status: "failed"
				}
			]);
			const live = committed.snapshots[0]!;
			expect(live.table.rows.map((row) => row.name)).toEqual([
				"Scalar_Added",
				"Scalar_Alpha"
			]);
			const disk = decodeAuthoringTableSnapshot(readDiskSnapshot());
			expect(fingerprintTable(disk)).toBe(fingerprintTable(live));
			const rowReferenceLive = committed.snapshots.find(
				(snapshot) => snapshot.table.objectPath === rowReferenceObjectPath
			)!;
			const rowReferenceDisk = decodeAuthoringTableSnapshot(
				readDiskSnapshot(rowReferenceAssetPath)
			);
			expect(rowReferenceLive.table.rows[0]?.fields[0]?.value).toEqual({
				kind: "row_reference",
				rowName: "Right_Beta",
				tableObjectPath: "/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
			});
			expect(fingerprintTable(rowReferenceDisk)).toBe(fingerprintTable(rowReferenceLive));

			const failedSaveInput = join(directory, "failed-save-request.json");
			const failedSaveOutput = join(directory, "failed-save-result.json");
			await writeFile(
				failedSaveInput,
				JSON.stringify({
					contract: saveRequest.contract,
					objectPaths: ["/Game/Fixture/Authoring/DT_Missing.DT_Missing"],
					requestId: "all-failed"
				}),
				"utf8"
			);
			runFixture("save", failedSaveInput, failedSaveOutput);
			const failedSave = decodeAuthoringSaveResult(await json(failedSaveOutput));
			expect(failedSave.status).toBe("failed");
			expect(failedSave.packages[0]).toMatchObject({ retrySafe: true, status: "failed" });
		} finally {
			runFixture("generate");
			await rm(directory, { force: true, recursive: true });
		}
	}, 120_000);
});
