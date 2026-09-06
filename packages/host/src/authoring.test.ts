import type { AuthoringTableSnapshot } from "@ue-shed/protocol";
import { makeAuthoringCatalogTestLayer } from "@ue-shed/authoring-catalog";
import { AuthoringClient } from "@ue-shed/authoring-sdk";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import {
	makeRemoteControlClientTestLayer,
	RemoteControlClientError
} from "@ue-shed/unreal-connection";
import { it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { AuthoringClientLive, ShedAuthoringLive, ShedAuthoringSessionsLive } from "./authoring.js";
import { SavedTableIndexLive } from "./saved-table-index.js";
import {
	ShedHostConfiguration,
	shedHostConfigurationLayer,
	type ConfiguredProject
} from "./configuration.js";
import { AuthoringFilePickerCancelled } from "./file-picker.js";

const snapshot: AuthoringTableSnapshot = {
	authority: { kind: "project_files", packageName: "/Game/Fixture/DT_Test" },
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
					{ name: "Count", typeName: "IntProperty", value: { kind: "int", value: "1" } }
				],
				id: "row:Alpha",
				name: "Alpha"
			}
		]
	}
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

it.effect(
	"acquires sessions after selection and isolates matching table paths across projects",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-selected-sessions-"))),
					(path) => Effect.promise(() => rm(path, { recursive: true, force: true }))
				);
				const selected = yield* Ref.make<ConfiguredProject>({ status: "not_configured" });
				const endpoint = yield* Ref.make("http://editor-a:30001");
				const projectA = { status: "configured" as const, projectRoot: join(root, "A") };
				const projectB = { status: "configured" as const, projectRoot: join(root, "B") };
				const dependencies = Layer.mergeAll(
					Layer.succeed(ShedHostConfiguration, {
						project: () => Ref.get(selected),
						authoringAsset: () =>
							Effect.succeed({
								status: "configured" as const,
								path: "DT_Test.uasset"
							}),
						remoteControlEndpoint: () => Ref.get(endpoint)
					}),
					AuthoringFilePickerCancelled,
					failingRemoteControl,
					makeAuthoringCatalogTestLayer({ discover: () => Effect.die("unused") }),
					makeAssetReaderTestLayer({
						discoverAssets: () => Effect.die("unused"),
						discoverTables: () => Effect.die("unused"),
						readAsset: () => Effect.die("unused"),
						readTable: () => Effect.succeed(snapshot),
						source: () => Effect.succeed("configured")
					})
				);
				const host = ShedAuthoringLive.pipe(
					Layer.provide(SavedTableIndexLive.pipe(Layer.provide(dependencies))),
					Layer.provide(dependencies)
				);
				const sessionId = yield* Effect.gen(function* () {
					const client = yield* AuthoringClient;
					expect((yield* client.listSessions()).status).toBe("failed");
					yield* Ref.set(selected, projectA);
					yield* client.loadConfiguredTable();
					const a = yield* client.beginSession(snapshot.table.objectPath);
					if (a.status !== "ready") throw new Error("A did not acquire its repository");
					yield* Ref.set(endpoint, "http://editor-b:30001");
					// Same project and table path: a different editor must reacquire its snapshot.
					expect((yield* client.beginSession(snapshot.table.objectPath)).status).toBe(
						"failed"
					);
					yield* Ref.set(endpoint, "http://editor-a:30001");
					yield* Ref.set(selected, projectB);
					expect((yield* client.beginSession(snapshot.table.objectPath)).status).toBe(
						"failed"
					);
					yield* client.loadConfiguredTable();
					const b = yield* client.beginSession(snapshot.table.objectPath);
					if (b.status !== "ready") throw new Error("B did not acquire its repository");
					expect(b.view.sessionId).not.toBe(a.view.sessionId);
					expect((yield* client.openSession(a.view.sessionId)).status).toBe("failed");
					yield* Ref.set(selected, projectA);
					expect((yield* client.openSession(a.view.sessionId)).status).toBe("ready");
					expect((yield* client.openSession(b.view.sessionId)).status).toBe("failed");
					return a.view.sessionId;
				}).pipe(Effect.provide(AuthoringClientLive.pipe(Layer.provide(host))));
				// A new host scope restores the selected project's persisted repository.
				yield* Effect.gen(function* () {
					const client = yield* AuthoringClient;
					expect((yield* client.openSession(sessionId)).status).toBe("ready");
				}).pipe(Effect.provide(AuthoringClientLive.pipe(Layer.provide(host))));
			})
		)
);

it.effect("checks selected identity while reusing the table catalog", () =>
	Effect.gen(function* () {
		const projectRoot = "C:/Projects/Fixture";
		const assetPath = "C:/Projects/Fixture/Content/Fixture/DT_Test.uasset";
		const objectPath = snapshot.table.objectPath;
		const projectResolutions = yield* Ref.make(0);
		const tableReads = yield* Ref.make(0);
		const configuration = Layer.succeed(
			ShedHostConfiguration,
			ShedHostConfiguration.of({
				authoringAsset: () => Effect.succeed({ status: "not_configured" as const }),
				project: () =>
					Ref.update(projectResolutions, (count) => count + 1).pipe(
						Effect.as({ projectRoot, status: "configured" as const })
					),
				remoteControlEndpoint: () => Effect.succeed("http://127.0.0.1:30001")
			})
		);
		const reader = makeAssetReaderTestLayer({
			catalogProgress: () =>
				Effect.succeed({
					cacheHits: 0,
					phase: "idle" as const,
					processedAssets: 0,
					tablesFound: 0,
					totalAssets: 0
				}),
			discoverAssets: () => Effect.succeed([]),
			discoverTables: () =>
				Effect.succeed({
					diagnostics: [],
					projectRoot,
					scannedAssets: 1,
					tables: [
						{
							assetPath,
							authority: {
								kind: "project_files" as const,
								packageName: "/Game/Fixture/DT_Test"
							},
							completeness: "complete" as const,
							kind: "data_table" as const,
							objectPath,
							parentTables: [],
							rowStruct: "/Script/Fixture.Row",
							schema: {
								reason: "Saved packages carry no field schema.",
								status: "unavailable" as const
							}
						}
					]
				}),
			readAsset: () => Effect.die("not used"),
			readTable: () => Ref.update(tableReads, (count) => count + 1).pipe(Effect.as(snapshot)),
			source: () => Effect.succeed("configured")
		});
		const catalog = makeAuthoringCatalogTestLayer({
			discover: () =>
				Effect.succeed({
					diagnostics: [],
					scannedSavedAssets: 1,
					tables: [
						{
							authorities: [
								{
									authority: "saved" as const,
									completeness: "complete" as const,
									schema: {
										reason: "Saved packages carry no field schema.",
										status: "unavailable" as const
									}
								}
							],
							divergence: { status: "none" as const },
							kind: "data_table" as const,
							objectPath,
							packageName: "/Game/Fixture/DT_Test",
							parentTables: [],
							rowStruct: "/Script/Fixture.Row"
						}
					]
				})
		});
		const dependencies = Layer.mergeAll(
			configuration,
			AuthoringFilePickerCancelled,
			reader,
			catalog,
			failingRemoteControl
		);
		const authoring = ShedAuthoringLive.pipe(
			Layer.provide(SavedTableIndexLive.pipe(Layer.provide(dependencies))),
			Layer.provide(dependencies)
		);

		yield* Effect.gen(function* () {
			const client = yield* AuthoringClient;
			expect((yield* client.loadConfiguredCatalog()).status).toBe("ready");
			const afterCatalog = yield* Ref.get(projectResolutions);

			for (let open = 0; open < 5; open += 1) {
				const opened = yield* client.openCatalogTable(objectPath, "saved");
				expect(opened.status).toBe("ready");
			}

			expect(yield* Ref.get(projectResolutions)).toBe(afterCatalog + 5);
			expect(yield* Ref.get(tableReads)).toBe(5);
		}).pipe(Effect.provide(AuthoringClientLive.pipe(Layer.provide(authoring))));
	})
);

it.effect("loads a saved table and begins a session through the direct client", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const projectRoot = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-host-"))),
				(path) => Effect.promise(() => rm(path, { force: true, recursive: true }))
			);
			const configuration = shedHostConfigurationLayer({
				authoringAsset: { path: join(projectRoot, "DT_Test.uasset"), status: "configured" },
				project: { projectRoot, status: "configured" },
				remoteControlEndpoint: "http://127.0.0.1:30001"
			});
			const reader = makeAssetReaderTestLayer({
				catalogProgress: () =>
					Effect.succeed({
						cacheHits: 0,
						phase: "idle" as const,
						processedAssets: 0,
						tablesFound: 0,
						totalAssets: 0
					}),
				discoverAssets: () => Effect.succeed([]),
				discoverTables: () =>
					Effect.succeed({ diagnostics: [], projectRoot, scannedAssets: 0, tables: [] }),
				readAsset: () => Effect.die("not used"),
				readTable: () => Effect.succeed(snapshot),
				source: () => Effect.succeed("configured")
			});
			const catalog = makeAuthoringCatalogTestLayer({
				discover: () =>
					Effect.succeed({ diagnostics: [], scannedSavedAssets: 0, tables: [] })
			});
			const dependencies = Layer.mergeAll(
				configuration,
				AuthoringFilePickerCancelled,
				reader,
				catalog,
				failingRemoteControl
			);
			const sessions = ShedAuthoringSessionsLive.pipe(Layer.provide(configuration));
			const authoring = ShedAuthoringLive.pipe(
				Layer.provide(sessions),
				Layer.provide(SavedTableIndexLive.pipe(Layer.provide(dependencies))),
				Layer.provide(dependencies)
			);
			const clientLayer = AuthoringClientLive.pipe(Layer.provide(authoring));

			const result = yield* Effect.gen(function* () {
				const client = yield* AuthoringClient;
				const loaded = yield* client.loadConfiguredTable();
				expect(loaded.status).toBe("ready");
				const session = yield* client.beginSession(snapshot.table.objectPath);
				expect(session.status).toBe("ready");
				return session;
			}).pipe(Effect.provide(clientLayer));

			expect(result.status).toBe("ready");
		})
	)
);
