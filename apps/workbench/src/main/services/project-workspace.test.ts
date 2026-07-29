import { it } from "@effect/vitest";
import { makeAssetReaderTestLayer, type SavedAssetScan } from "@ue-shed/unreal-assets";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { ProjectInventoryCache } from "../adapters/project-inventory-cache.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { WorkbenchProject, WorkbenchProjectLive } from "./project-workspace.js";

const projectRoot = "C:/Projects/Selected";

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

const configuredProject = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "configured", projectRoot },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

function projectIndex(mapSize = 256): SavedAssetScan {
	return {
		assets: [
			{
				depth: "header",
				fileBytes: 128,
				header: {
					exports: [
						{
							class_name: "DataTable",
							class_path: "/Script/Engine.DataTable",
							object_path: "/Game/Tables/DT_Test.DT_Test"
						}
					],
					package: { name: "/Game/Tables/DT_Test" },
					path: `${projectRoot}/Content/Tables/DT_Test.uasset`,
					schema_version: 8
				}
			}
		],
		failures: [],
		inventory: [
			{
				kind: "package",
				modifiedMs: 1_735_689_600_000,
				path: `${projectRoot}/Content/Maps/L_Playground.umap`,
				size: mapSize
			},
			{
				kind: "package",
				modifiedMs: 1_735_689_600_000,
				path: `${projectRoot}/Content/Tables/DT_Test.uasset`,
				size: 128
			}
		],
		summary: {
			cacheHits: 0,
			depth: "header",
			diagnostics: [],
			emittedAssets: 1,
			failedAssets: 0,
			inventoryComplete: true,
			inventoryFiles: 2,
			partialAssets: 0,
			projectRoot,
			roots: [`${projectRoot}/Content`],
			scannedAssets: 2,
			schema_version: 8,
			skippedAssets: 1
		}
	};
}

const dialog = Layer.succeed(
	ElectronDialog,
	ElectronDialog.of({
		chooseDirectory: () => Effect.succeed({ path: projectRoot, status: "selected" as const }),
		chooseFile: () => Effect.die("not used"),
		chooseFiles: () => Effect.die("not used")
	})
);

it.effect("builds maps, tables, and Input Atlas from one shared header index", () =>
	Effect.gen(function* () {
		const indexScans = yield* Ref.make(0);
		const assetReader = makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("not used"),
			discoverTables: () => Effect.die("not used"),
			readAsset: () => Effect.die("not used"),
			readTable: () => Effect.die("not used"),
			scanProject: (options) => {
				expect(options.depth).toBe("header");
				expect(options.inventory).toBe(true);
				return Ref.update(indexScans, (count) => count + 1).pipe(Effect.as(projectIndex()));
			},
			source: () => Effect.succeed("configured" as const)
		});

		yield* Effect.gen(function* () {
			const service = yield* WorkbenchProject;
			for (let open = 0; open < 10; open += 1) {
				expect((yield* service.current()).status).toBe("ready");
				expect(yield* service.savedProject()).toMatchObject({ projectRoot });
			}
			expect(yield* Ref.get(indexScans)).toBe(1);
			expect((yield* service.savedTables()).tables).toHaveLength(1);
		}).pipe(
			Effect.provide(WorkbenchProjectLive),
			Effect.provide(Layer.mergeAll(configuredProject, dialog, assetReader))
		);
	})
);

it.effect("uses the native signature index to validate a persisted inventory", () =>
	Effect.gen(function* () {
		const indexScans = yield* Ref.make(0);
		const cacheWrites = yield* Ref.make(0);
		const mapSize = yield* Ref.make(256);
		const persistedInventory = yield* Ref.make<unknown | undefined>(undefined);
		const assetReader = makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("not used"),
			discoverTables: () => Effect.die("not used"),
			readAsset: () => Effect.die("not used"),
			readTable: () => Effect.die("not used"),
			scanProject: () =>
				Ref.update(indexScans, (count) => count + 1).pipe(
					Effect.flatMap(() => Ref.get(mapSize)),
					Effect.map(projectIndex)
				),
			source: () => Effect.succeed("configured" as const)
		});
		const projectInventoryCache = Layer.succeed(
			ProjectInventoryCache,
			ProjectInventoryCache.of({
				read: () => Ref.get(persistedInventory),
				write: (_, inventory) =>
					Ref.update(cacheWrites, (count) => count + 1).pipe(
						Effect.flatMap(() => Ref.set(persistedInventory, inventory))
					)
			})
		);
		const runWorkbench = Effect.gen(function* () {
			const service = yield* WorkbenchProject;
			expect(yield* service.choose()).toMatchObject({
				project: { inputAtlas: "ready", mapCount: 1, packageCount: 2 },
				status: "ready"
			});
			expect((yield* service.choose()).status).toBe("ready");
		}).pipe(
			Effect.provide(WorkbenchProjectLive),
			Effect.provide(
				Layer.mergeAll(configuration, dialog, assetReader, projectInventoryCache)
			)
		);

		yield* runWorkbench;
		yield* runWorkbench;
		expect(yield* Ref.get(indexScans)).toBe(4);
		expect(yield* Ref.get(cacheWrites)).toBe(1);
		yield* Ref.set(mapSize, 512);
		yield* runWorkbench;
		expect(yield* Ref.get(indexScans)).toBe(6);
		expect(yield* Ref.get(cacheWrites)).toBe(2);
	})
);
