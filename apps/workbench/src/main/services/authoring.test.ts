import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import {
	makeAuthoringCatalogTestLayer,
	type AuthoringCatalogShape
} from "@ue-shed/authoring-catalog";
import { makeAssetReaderTestLayer, type AssetReaderShape } from "@ue-shed/unreal-assets";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClient,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeElectronDialogTestLayer } from "../adapters/electron-dialog.js";
import { makeWorkbenchWindowTestLayer } from "../adapters/electron-window.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationShape
} from "../workbench-config.js";
import {
	WorkbenchAuthoring,
	WorkbenchAuthoringLive,
	WorkbenchAuthoringSessionsLive
} from "./authoring.js";

function fixtureSnapshot(): AuthoringTableSnapshot {
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
							value: { kind: "int", value: "1" }
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

const unconfigured: WorkbenchConfigurationShape = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
};

const failingRemoteControl = makeRemoteControlClientTestLayer(() =>
	Effect.fail(
		new RemoteControlClientError({
			endpoint: "http://127.0.0.1:30001",
			functionName: "GetCapabilityManifest",
			message: "Editor is not connected",
			operation: "authoring.live_connection",
			retrySafe: true
		})
	)
);

const emptyCatalog: AuthoringCatalogShape = {
	discover: () => Effect.succeed({ diagnostics: [], scannedSavedAssets: 0, tables: [] })
};

const dyingReader: AssetReaderShape = {
	discoverAssets: () => Effect.die("not used"),
	discoverTables: () => Effect.die("not used"),
	readAsset: () => Effect.die("not used"),
	readTable: () => Effect.die("not used"),
	source: () => Effect.succeed("configured")
};

const dialogLayer = (openDialog: Parameters<typeof makeWorkbenchWindowTestLayer>[0]) =>
	makeElectronDialogTestLayer.pipe(Layer.provide(makeWorkbenchWindowTestLayer(openDialog)));

it.effect("returns not_configured when no authoring asset is configured", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchAuthoring;
		const result = yield* service.configuredTable();
		expect(result).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			WorkbenchAuthoringLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeAssetReaderTestLayer(dyingReader),
						makeAuthoringCatalogTestLayer(emptyCatalog),
						dialogLayer({}),
						failingRemoteControl
					)
				)
			)
		)
	)
);

it.effect("loads the configured saved DataTable", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchAuthoring;
		const result = yield* service.configuredTable();
		expect(result.status).toBe("ready");
	}).pipe(
		Effect.provide(
			WorkbenchAuthoringLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							...unconfigured,
							authoringAsset: {
								path: "C:/Fixture/DT_Test.uasset",
								status: "configured"
							}
						}),
						makeAssetReaderTestLayer({
							...dyingReader,
							readTable: () => Effect.succeed(fixtureSnapshot())
						}),
						makeAuthoringCatalogTestLayer(emptyCatalog),
						dialogLayer({}),
						failingRemoteControl
					)
				)
			)
		)
	)
);

it.effect("cancels choosing a saved DataTable", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchAuthoring;
		const result = yield* service.chooseTable();
		expect(result).toEqual({ status: "cancelled" });
	}).pipe(
		Effect.provide(
			WorkbenchAuthoringLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeAssetReaderTestLayer(dyingReader),
						makeAuthoringCatalogTestLayer(emptyCatalog),
						dialogLayer({
							openDialog: Effect.fn("test.openDialog")(() =>
								Effect.succeed({ status: "cancelled" as const })
							)
						}),
						failingRemoteControl
					)
				)
			)
		)
	)
);

it.effect("returns not_configured for the catalog without a project root", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchAuthoring;
		const result = yield* service.configuredCatalog();
		expect(result).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			WorkbenchAuthoringLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeAssetReaderTestLayer(dyingReader),
						makeAuthoringCatalogTestLayer(emptyCatalog),
						dialogLayer({}),
						failingRemoteControl
					)
				)
			)
		)
	)
);

it.effect(
	"reports a live_connection_unavailable diagnostic and does not retain the failed connection",
	() =>
		Effect.gen(function* () {
			const requestCalls = yield* Ref.make(0);
			const flakyRemoteControl = Layer.succeed(
				RemoteControlClient,
				RemoteControlClient.of({
					request: () =>
						Ref.update(requestCalls, (count) => count + 1).pipe(
							Effect.flatMap(() =>
								Effect.fail(
									new RemoteControlClientError({
										endpoint: "http://127.0.0.1:30001",
										functionName: "GetCapabilityManifest",
										message: "Editor is not connected",
										operation: "authoring.live_connection",
										retrySafe: true
									})
								)
							)
						)
				})
			);

			const results = yield* Effect.provide(
				Effect.gen(function* () {
					const service = yield* WorkbenchAuthoring;
					const first = yield* service.configuredCatalog();
					const second = yield* service.configuredCatalog();
					return { first, second };
				}),
				WorkbenchAuthoringLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							makeWorkbenchConfigurationLayer({
								...unconfigured,
								project: { projectRoot: "C:/FixtureProject", status: "configured" }
							}),
							makeAssetReaderTestLayer({
								...dyingReader,
								discoverTables: () =>
									Effect.succeed({
										diagnostics: [],
										projectRoot: "",
										scannedAssets: 0,
										tables: []
									})
							}),
							makeAuthoringCatalogTestLayer(emptyCatalog),
							dialogLayer({}),
							flakyRemoteControl
						)
					)
				)
			);

			const { first, second } = results;
			if (first.status !== "ready" || second.status !== "ready") {
				throw new Error("expected ready catalog results");
			}
			expect(first.diagnostics.some((d) => d.code === "live_connection_unavailable")).toBe(
				true
			);
			expect(second.diagnostics.some((d) => d.code === "live_connection_unavailable")).toBe(
				true
			);
			expect(yield* Ref.get(requestCalls)).toBe(2);
		})
);

it.effect("invalidates negotiated authoring connections after live catalog failures", () =>
	Effect.gen(function* () {
		const manifestCalls = yield* Ref.make(0);
		const remoteControl = Layer.succeed(
			RemoteControlClient,
			RemoteControlClient.of({
				request: ({ functionName }) => {
					if (functionName !== "GetCapabilityManifest") {
						return Effect.die(`unexpected Remote Control call ${functionName}`);
					}
					return Ref.update(manifestCalls, (count) => count + 1).pipe(
						Effect.as({
							authoringLimits: {
								maxCommands: 1024,
								maxPayloadBytes: 1_048_576,
								maxTables: 16
							},
							authoringObjectPath:
								"/Script/UEShedAuthoring.Default__UEShedAuthoringLibrary",
							capabilities: [
								"authoring.snapshot.v2",
								"authoring.table-list.v1",
								"authoring.apply.v1",
								"authoring.apply-result.v1",
								"authoring.save.v1"
							],
							producerKind: "unreal_editor",
							schemaVersion: 1
						})
					);
				}
			})
		);
		const liveFailureCatalog: AuthoringCatalogShape = {
			discover: () =>
				Effect.succeed({
					diagnostics: [
						{
							authority: "live" as const,
							code: "table_list_failed",
							message: "editor restarted",
							retrySafe: true
						}
					],
					scannedSavedAssets: 0,
					tables: []
				})
		};
		const layer = WorkbenchAuthoringLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					makeWorkbenchConfigurationLayer({
						...unconfigured,
						project: { projectRoot: "C:/FixtureProject", status: "configured" }
					}),
					makeAssetReaderTestLayer({
						...dyingReader,
						discoverTables: () =>
							Effect.succeed({
								diagnostics: [],
								projectRoot: "C:/FixtureProject",
								scannedAssets: 0,
								tables: []
							})
					}),
					makeAuthoringCatalogTestLayer(liveFailureCatalog),
					dialogLayer({}),
					remoteControl
				)
			)
		);

		yield* Effect.provide(
			Effect.gen(function* () {
				const service = yield* WorkbenchAuthoring;
				yield* service.configuredCatalog();
				yield* service.configuredCatalog();
			}),
			layer
		);
		expect(yield* Ref.get(manifestCalls)).toBe(2);
	})
);

it.effect("fails to begin a session without a configured project root", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchAuthoring;
		const result = yield* service.beginSession("/Game/Fixture/DT_Test.DT_Test");
		expect(result.status).toBe("failed");
	}).pipe(
		Effect.provide(
			WorkbenchAuthoringLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer(unconfigured),
						makeAssetReaderTestLayer(dyingReader),
						makeAuthoringCatalogTestLayer(emptyCatalog),
						dialogLayer({}),
						failingRemoteControl
					)
				)
			)
		)
	)
);

const withTempProjectRoot = (prefix: string) =>
	Effect.acquireRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
		(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
	);

it.effect("creates a session from a loaded snapshot, edits it, and undoes the edit", () =>
	Effect.gen(function* () {
		const root = yield* withTempProjectRoot("ue-shed-workbench-authoring-");
		const objectPath = "/Game/Fixture/DT_Test.DT_Test";
		const configuration = makeWorkbenchConfigurationLayer({
			...unconfigured,
			authoringAsset: { path: "C:/Fixture/DT_Test.uasset", status: "configured" },
			project: { projectRoot: root, status: "configured" }
		});
		const layer = WorkbenchAuthoringLive.pipe(
			Layer.provide(WorkbenchAuthoringSessionsLive.pipe(Layer.provide(configuration))),
			Layer.provide(
				Layer.mergeAll(
					configuration,
					makeAssetReaderTestLayer({
						...dyingReader,
						readTable: () => Effect.succeed(fixtureSnapshot())
					}),
					makeAuthoringCatalogTestLayer(emptyCatalog),
					dialogLayer({}),
					failingRemoteControl
				)
			)
		);

		yield* Effect.provide(
			Effect.gen(function* () {
				const service = yield* WorkbenchAuthoring;
				yield* service.configuredTable();
				const begun = yield* service.beginSession(objectPath);
				if (begun.status !== "ready") throw new Error("expected a ready session");
				const sessionId = begun.view.sessionId;

				const edited = yield* service.editSession({
					edits: [
						{
							fieldName: "Count",
							rowId: "row:Alpha",
							value: { kind: "int", value: "9" }
						}
					],
					kind: "set_cells",
					sessionId,
					tableObjectPath: objectPath
				});
				if (edited.status !== "ready")
					throw new Error("expected a ready session after edit");
				expect(edited.view.dirty).toBe(true);
				expect(edited.view.canUndo).toBe(true);

				const undone = yield* service.undoSession(sessionId);
				if (undone.status !== "ready")
					throw new Error("expected a ready session after undo");
				expect(undone.view.canUndo).toBe(false);

				const redone = yield* service.redoSession(sessionId);
				if (redone.status !== "ready")
					throw new Error("expected a ready session after redo");
				expect(redone.view.canUndo).toBe(true);
				const duplicated = yield* service.editSession({
					kind: "duplicate_row",
					rowName: "Beta",
					sessionId,
					sourceRowId: "row:Alpha",
					tableObjectPath: objectPath
				});
				if (duplicated.status !== "ready") {
					throw new Error("expected a ready session after row duplication");
				}
				expect(duplicated.view.snapshot.table.rows.map((row) => row.name)).toEqual([
					"Alpha",
					"Beta"
				]);
				const review = yield* service.reviewSession(sessionId);
				if (review.status !== "ready") throw new Error("expected a ready session review");
				expect(review.review.tables[0]?.changes).toContainEqual(
					expect.objectContaining({ fieldName: "Count", kind: "cell_changed" })
				);
				expect(review.review.tables[0]?.changes).toContainEqual(
					expect.objectContaining({
						kind: "row_added",
						row: expect.objectContaining({ name: "Beta" })
					})
				);
				const listed = yield* service.listSessions();
				if (listed.status !== "ready") throw new Error("expected a ready session list");
				expect(listed.sessions.map((candidate) => candidate.id)).toContain(sessionId);
				const reopened = yield* service.openSession(sessionId);
				if (reopened.status !== "ready") throw new Error("expected a reopened session");
				expect(reopened.view.snapshot.table.rows.map((row) => row.name)).toEqual([
					"Alpha",
					"Beta"
				]);
				const discarded = yield* service.discardSession(sessionId);
				if (discarded.status !== "ready")
					throw new Error("expected a ready discard result");
				expect(discarded.sessions).toEqual([]);
			}),
			layer
		);
	}).pipe(Effect.scoped)
);

it.effect("fails to apply a session when the live connection is unavailable", () =>
	Effect.gen(function* () {
		const root = yield* withTempProjectRoot("ue-shed-workbench-authoring-apply-");
		const objectPath = "/Game/Fixture/DT_Test.DT_Test";
		const configuration = makeWorkbenchConfigurationLayer({
			...unconfigured,
			authoringAsset: { path: "C:/Fixture/DT_Test.uasset", status: "configured" },
			project: { projectRoot: root, status: "configured" }
		});
		const layer = WorkbenchAuthoringLive.pipe(
			Layer.provide(WorkbenchAuthoringSessionsLive.pipe(Layer.provide(configuration))),
			Layer.provide(
				Layer.mergeAll(
					configuration,
					makeAssetReaderTestLayer({
						...dyingReader,
						readTable: () => Effect.succeed(fixtureSnapshot())
					}),
					makeAuthoringCatalogTestLayer(emptyCatalog),
					dialogLayer({}),
					failingRemoteControl
				)
			)
		);

		yield* Effect.provide(
			Effect.gen(function* () {
				const service = yield* WorkbenchAuthoring;
				yield* service.configuredTable();
				const begun = yield* service.beginSession(objectPath);
				if (begun.status !== "ready") throw new Error("expected a ready session");

				const applied = yield* service.applySession(begun.view.sessionId);
				expect(applied.status).toBe("failed");
			}),
			layer
		);
	}).pipe(Effect.scoped)
);
