import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	decodeAuthoringTableSnapshot as decodeAuthoringTableSnapshotEffect,
	type AuthoringApplyRequest,
	type AuthoringCommand,
	type AuthoringSaveRequest,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import {
	connectUnrealAuthoring,
	RemoteControlClientLive,
	type UnrealAuthoringConnection
} from "@ue-shed/unreal-connection";
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { AuthoringIdGeneratorLive, makeAuthoringSessionService } from "./session-service.js";
import { fingerprintTable } from "./fingerprint.js";

const sessionService = (config: Parameters<typeof makeAuthoringSessionService>[0]) =>
	makeAuthoringSessionService(config).pipe(Effect.provide(AuthoringIdGeneratorLive));

const decodeAuthoringTableSnapshot = <Input>(input: Input) =>
	Effect.runSync(decodeAuthoringTableSnapshotEffect(input));

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const enabled = endpoint !== undefined && executable !== undefined;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const objectPath = "/Game/Fixture/Authoring/DT_Scalars.DT_Scalars";
const enumObjectPath = "/Game/Fixture/Authoring/DT_Enums.DT_Enums";
const rowReferenceObjectPath = "/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences";
const missingObjectPath = "/Game/Fixture/Authoring/DT_Missing.DT_Missing";
const assetPath = join(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Authoring/DT_Scalars.uasset"
);
const rowReferenceAssetPath = join(
	repositoryRoot,
	"fixtures/unreal-project/Content/Fixture/Authoring/DT_LeftReferences.uasset"
);
const authoringContent = join(repositoryRoot, "fixtures/unreal-project/Content/Fixture/Authoring");
const applyContract = { name: "unreal-authoring-apply", version: { major: 1, minor: 0 } } as const;
const saveContract = { name: "unreal-authoring-save", version: { major: 1, minor: 0 } } as const;

/**
 * Reads the committed Authoring packages this test saves over. Restoring these bytes afterwards
 * leaves the fixture as committed; `fixture:generate` would re-save every fixture asset instead.
 */
async function readAuthoringPackages(): Promise<ReadonlyMap<string, Uint8Array>> {
	const packages = new Map<string, Uint8Array>();
	for (const entry of await readdir(authoringContent, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		packages.set(path, await readFile(path));
	}
	return packages;
}

/**
 * Rewrites only the packages whose bytes changed: the editor keeps loaded packages it did not save
 * (such as referenced tables) open, so writing those fails with EBUSY.
 */
async function restoreAuthoringPackages(packages: ReadonlyMap<string, Uint8Array>) {
	for (const entry of await readdir(authoringContent, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		if (entry.isFile() && !packages.has(path)) await rm(path, { force: true });
	}
	for (const [path, bytes] of packages) {
		if (!Buffer.from(bytes).equals(await readFile(path))) await writeFile(path, bytes);
	}
}

function readDiskSnapshot(path = assetPath): Schema.Json {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(
			execFileSync(executable!, ["authoring", path, "--format", "json"], {
				encoding: "utf8",
				windowsHide: true
			})
		)
	);
}

function snapshotOf(snapshots: readonly AuthoringTableSnapshot[], path: string) {
	const snapshot = snapshots.find((entry) => entry.table.objectPath === path);
	if (snapshot === undefined) throw new Error(`No snapshot for ${path}`);
	return snapshot;
}

describe.skipIf(!enabled)("real Unreal authoring mutation through Remote Control", () => {
	it("rolls back a failed batch, commits all command shapes, caches the result, and saves separately", async () => {
		const connection: UnrealAuthoringConnection = await Effect.runPromise(
			connectUnrealAuthoring(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
		);
		const run = (operation: string) => `${randomUUID().slice(0, 8)}-${operation}`;
		const directory = await mkdtemp(join(tmpdir(), "ue-shed-authoring-"));
		const committedPackages = await readAuthoringPackages();
		let restore: AuthoringApplyRequest | undefined;
		try {
			const readLive = (path: string) => Effect.runPromise(connection.getTableSnapshot(path));
			const base = await readLive(objectPath);
			const enumBase = await readLive(enumObjectPath);
			const rowReferenceBase = await readLive(rowReferenceObjectPath);
			for (const snapshot of [base, enumBase, rowReferenceBase]) {
				expect(snapshot.authority.kind).toBe("live_editor");
				expect("fingerprint" in snapshot).toBe(true);
				if ("fingerprint" in snapshot) {
					expect(snapshot.fingerprint.status).toBe("available");
					if (snapshot.fingerprint.status === "available") {
						expect(fingerprintTable(snapshot)).toBe(snapshot.fingerprint.value);
					}
				}
			}
			const alpha = base.table.rows[0]!;
			const beta = base.table.rows[1]!;
			const enabledField = alpha.fields.find((field) => field.name === "Enabled")!;
			const enumRow = enumBase.table.rows[0]!;
			const enumField = enumRow.fields[0]!;
			const enumChangedValue = enumBase.table.rows[1]!.fields[0]!.value;
			const rowReferenceRow = rowReferenceBase.table.rows[0]!;
			const rowReferenceField = rowReferenceRow.fields[0]!;
			const rightBeta = {
				kind: "row_reference" as const,
				rowName: "Right_Beta",
				tableObjectPath: "/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
			};
			const changedValue = { kind: "bool", value: false } as const;

			const rollbackRequest: AuthoringApplyRequest = {
				contract: applyContract,
				operationId: run("rollback-probe"),
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
			const rollback = await Effect.runPromise(connection.apply(rollbackRequest));
			expect(rollback.status, JSON.stringify(rollback.errors)).toBe("rolled_back");
			expect(fingerprintTable(snapshotOf(rollback.snapshots, objectPath))).toBe(
				fingerprintTable(base)
			);
			expect(fingerprintTable(snapshotOf(rollback.snapshots, enumObjectPath))).toBe(
				fingerprintTable(enumBase)
			);

			// The editor remembers the operation, so reusing its ID with another payload collides.
			const collision = await Effect.runPromise(
				connection.apply({ ...rollbackRequest, commands: [] })
			);
			expect(collision.status).toBe("rejected");
			expect(collision.errors[0]?.code).toBe("operation_id_collision");

			const drift = await Effect.runPromise(
				connection.apply({
					commands: [],
					contract: applyContract,
					operationId: run("drift-probe"),
					tables: [{ expectedFingerprint: "sha256-v1:stale", objectPath }]
				})
			);
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
						newValue: enumChangedValue,
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
						newValue: rightBeta,
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
				sessionService({
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
				contract: saveContract,
				objectPaths: [
					objectPath,
					enumObjectPath,
					rowReferenceObjectPath,
					missingObjectPath
				],
				requestId: run("save-after-commit")
			};
			const committed = await Effect.runPromise(connection.apply(commitRequest));
			expect(committed.status, JSON.stringify(committed.errors)).toBe("committed");
			const live = snapshotOf(committed.snapshots, objectPath);
			const addedRow = live.table.rows.find((row) => row.name === "Scalar_Added")!;
			// Put the live editor back as found, so other tests and reruns see the committed tables.
			restore = {
				contract: applyContract,
				operationId: run("restore"),
				tables: [objectPath, enumObjectPath, rowReferenceObjectPath].map((path) => ({
					expectedFingerprint: fingerprintTable(snapshotOf(committed.snapshots, path)),
					objectPath: path
				})),
				commands: [
					{
						body: {
							fieldName: "Enabled",
							kind: "set_cell",
							newValue: enabledField.value,
							oldValue: changedValue,
							rowId: alpha.id
						},
						id: "restore-enabled",
						tableObjectPath: objectPath
					},
					{
						body: {
							atIndex: live.table.rows.indexOf(addedRow),
							kind: "remove_row",
							row: addedRow
						},
						id: "restore-remove-added",
						tableObjectPath: objectPath
					},
					{
						body: { atIndex: 1, kind: "add_row", row: beta },
						id: "restore-beta",
						tableObjectPath: objectPath
					},
					{
						body: {
							fieldName: enumField.name,
							kind: "set_cell",
							newValue: enumField.value,
							oldValue: enumChangedValue,
							rowId: enumRow.id
						},
						id: "restore-enum",
						tableObjectPath: enumObjectPath
					},
					{
						body: {
							fieldName: rowReferenceField.name,
							kind: "set_cell",
							newValue: rowReferenceField.value,
							oldValue: rightBeta,
							rowId: rowReferenceRow.id
						},
						id: "restore-row-reference",
						tableObjectPath: rowReferenceObjectPath
					}
				]
			};
			const lookup = await Effect.runPromise(
				connection.lookupApplyResult(commitRequest.operationId)
			);
			expect(lookup).toEqual(committed);
			const saved = await Effect.runPromise(connection.save(saveRequest));
			await Effect.runPromise(service.markApplyIndeterminate("recovery", "transport lost"));
			const restarted = await Effect.runPromise(
				sessionService({
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
				{ objectPath: missingObjectPath, retrySafe: true, status: "failed" }
			]);
			expect(live.table.rows.map((row) => row.name)).toEqual([
				"Scalar_Added",
				"Scalar_Alpha"
			]);
			const disk = decodeAuthoringTableSnapshot(readDiskSnapshot());
			expect(fingerprintTable(disk)).toBe(fingerprintTable(live));
			const rowReferenceLive = snapshotOf(committed.snapshots, rowReferenceObjectPath);
			const rowReferenceDisk = decodeAuthoringTableSnapshot(
				readDiskSnapshot(rowReferenceAssetPath)
			);
			expect(rowReferenceLive.table.rows[0]?.fields[0]?.value).toEqual(rightBeta);
			expect(fingerprintTable(rowReferenceDisk)).toBe(fingerprintTable(rowReferenceLive));

			const failedSave = await Effect.runPromise(
				connection.save({
					contract: saveContract,
					objectPaths: [missingObjectPath],
					requestId: run("all-failed")
				})
			);
			expect(failedSave.status).toBe("failed");
			expect(failedSave.packages[0]).toMatchObject({ retrySafe: true, status: "failed" });

			const restored = await Effect.runPromise(connection.apply(restore));
			restore = undefined;
			expect(restored.status, JSON.stringify(restored.errors)).toBe("committed");
			for (const snapshot of [base, enumBase, rowReferenceBase]) {
				expect(
					fingerprintTable(snapshotOf(restored.snapshots, snapshot.table.objectPath))
				).toBe(fingerprintTable(snapshot));
			}
		} finally {
			// Best effort when an assertion failed between the commit and the restore above.
			if (restore !== undefined)
				await Effect.runPromise(Effect.ignore(connection.apply(restore)));
			await restoreAuthoringPackages(committedPackages);
			await rm(directory, { force: true, recursive: true });
		}
	}, 600_000);
});
