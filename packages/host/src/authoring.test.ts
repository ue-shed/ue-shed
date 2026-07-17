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
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { AuthoringClientLive, ShedAuthoringLive, ShedAuthoringSessionsLive } from "./authoring.js";
import { shedHostConfigurationLayer } from "./configuration.js";
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
