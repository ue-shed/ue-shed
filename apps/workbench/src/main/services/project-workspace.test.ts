import { it } from "@effect/vitest";
import {
	makeAssetReaderTestLayer,
	makeProjectIndexTestLayer,
	ProjectIndexMap,
	ProjectIndexPage,
	PROJECT_INDEX_MAX_PAGE_SIZE,
	ProjectIndexRefreshEvent,
	ProjectIndexStaleGeneration,
	ProjectIdentity,
	ProjectIndexGeneration,
	ProjectIndexSummary,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import { Effect, Layer, Stream } from "effect";
import { expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { WorkbenchProject, WorkbenchProjectLive } from "./project-workspace.js";

const projectRoot = "C:/Projects/Selected";

const configuredProject = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "configured", projectRoot },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

function legacyProjectIndex(mapSize = 256): SavedAssetScan {
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
					matched_names: [],
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

it.effect("uses bounded Project Index pages without loading a legacy inventory", () =>
	Effect.gen(function* () {
		const projectId = ProjectIdentity.make(projectRoot);
		const generation = ProjectIndexGeneration.make(1);
		const summary = ProjectIndexSummary.make({
			changedPackages: 2,
			completeness: "complete",
			diagnostics: [],
			generation,
			mapCount: 1,
			packageCount: 2,
			projectId,
			removedPackages: 0
		});
		const page = ProjectIndexPage.make({
			generation: summary.generation,
			items: [
				ProjectIndexMap.make({
					kind: "map",
					mapPath: "Content/Maps/L_Playground.umap",
					packageName: "/Game/Maps/L_Playground"
				})
			],
			projectId: summary.projectId
		});
		const headerPage = ProjectIndexPage.make({
			generation: summary.generation,
			items: [
				{
					classes: ["/Script/EnhancedInput.InputAction"],
					kind: "header",
					packageName: "/Game/Input/IA_Test",
					packagePath: "Content/Input/IA_Test.uasset",
					serializedNames: []
				}
			],
			projectId: summary.projectId
		});
		const tablePage = ProjectIndexPage.make({
			generation: summary.generation,
			items: [
				{
					classes: ["/Script/Engine.DataTable"],
					kind: "header",
					packageName: "/Game/Tables/DT_Test",
					packagePath: "Content/Tables/DT_Test.uasset",
					serializedNames: []
				}
			],
			projectId: summary.projectId
		});
		const refresh = Stream.fromIterable([
			ProjectIndexRefreshEvent.cases.Started.make({ operation: "refresh" }),
			ProjectIndexRefreshEvent.cases.Progress.make({
				completedPackages: summary.packageCount,
				phase: "committing",
				totalPackages: summary.packageCount
			}),
			ProjectIndexRefreshEvent.cases.Completed.make({ summary })
		]);
		const assetReader = makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("legacy inventory should not be loaded"),
			discoverTables: () => Effect.die("legacy inventory should not be loaded"),
			readAsset: () => Effect.die("legacy inventory should not be loaded"),
			readTable: () => Effect.die("legacy inventory should not be loaded"),
			scanProject: (options) => {
				expect(options.inventory).toBeUndefined();
				expect(options.paths).toEqual(
					options.classes?.includes("/Script/Engine.DataTable")
						? ["Content/Tables/DT_Test.uasset"]
						: ["Content/Input/IA_Test.uasset"]
				);
				return Effect.succeed(legacyProjectIndex());
			},
			source: () => Effect.succeed("configured" as const)
		});
		const projectIndex = makeProjectIndexTestLayer({
			rebuild: () => refresh,
			refresh: () => refresh,
			query: (request) => {
				expect(request.limit).toBe(PROJECT_INDEX_MAX_PAGE_SIZE);
				if (request._tag === "Maps") return Effect.succeed(page);
				if (
					request._tag === "ExactClasses" &&
					request.values.includes("/Script/Engine.DataTable")
				) {
					return Effect.succeed(tablePage);
				}
				return Effect.succeed(headerPage);
			},
			status: () => Effect.succeed({ status: "ready", summary })
		});

		yield* Effect.gen(function* () {
			const service = yield* WorkbenchProject;
			expect(yield* service.current()).toMatchObject({
				project: { inputAtlas: "deferred", mapCount: 1, packageCount: 2, projectRoot },
				status: "ready"
			});
			expect(yield* service.savedProject()).toEqual({
				maps: [{ label: "Playground", mapPath: "Content/Maps/L_Playground.umap" }],
				projectRoot
			});
			const index = yield* service.candidates("enhanced_input");
			expect(index.summary.scannedAssets).toBe(2);
			expect(index.assets).toHaveLength(1);
			expect(index.assets[0]).toMatchObject({
				depth: "header",
				header: { path: "Content/Input/IA_Test.uasset" }
			});
			expect((yield* service.inputAtlas()).status).toBe("completed");
			expect((yield* service.savedTables()).tables).toEqual([
				expect.objectContaining({ objectPath: "/Game/Tables/DT_Test.DT_Test" })
			]);
			expect((yield* service.progress()).phase).toBe("ready");
		}).pipe(
			Effect.provide(WorkbenchProjectLive),
			Effect.provide(Layer.mergeAll(configuredProject, dialog, assetReader, projectIndex))
		);
	})
);

it.effect("recovers a candidate query when the committed generation changes", () =>
	Effect.gen(function* () {
		const projectId = ProjectIdentity.make(projectRoot);
		const firstGeneration = ProjectIndexGeneration.make(1);
		const latestGeneration = ProjectIndexGeneration.make(2);
		const makeSummary = (generation: ProjectIndexGeneration) =>
			ProjectIndexSummary.make({
				changedPackages: 0,
				completeness: "complete",
				diagnostics: [],
				generation,
				mapCount: 1,
				packageCount: 2,
				projectId,
				removedPackages: 0
			});
		const firstSummary = makeSummary(firstGeneration);
		const latestSummary = makeSummary(latestGeneration);
		const generations: number[] = [];
		let statusCalls = 0;
		const projectIndex = makeProjectIndexTestLayer({
			rebuild: () => Stream.empty,
			refresh: () => Stream.empty,
			query: (request) => {
				generations.push(request.expectedGeneration);
				if (request._tag === "Maps") {
					return Effect.succeed(
						ProjectIndexPage.make({
							generation: request.expectedGeneration,
							items: [
								ProjectIndexMap.make({
									kind: "map",
									mapPath: "Content/Maps/L_Playground.umap",
									packageName: "/Game/Maps/L_Playground"
								})
							],
							projectId
						})
					);
				}
				if (request.expectedGeneration === firstGeneration) {
					return Effect.fail(
						new ProjectIndexStaleGeneration({
							actualGeneration: latestGeneration,
							expectedGeneration: firstGeneration,
							message:
								"The Project Index generation changed since this query started.",
							recovery: "Retry against the current generation.",
							retrySafe: true
						})
					);
				}
				return Effect.succeed(
					ProjectIndexPage.make({
						generation: latestGeneration,
						items: [
							{
								classes: ["/Script/Engine.DataTable"],
								kind: "header",
								packageName: "/Game/Tables/DT_Test",
								packagePath: "Content/Tables/DT_Test.uasset",
								serializedNames: []
							}
						],
						projectId
					})
				);
			},
			status: () =>
				Effect.sync(() => ({
					status: "ready" as const,
					summary: statusCalls++ === 0 ? firstSummary : latestSummary
				}))
		});
		const assetReader = makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("not used"),
			discoverTables: () => Effect.die("not used"),
			readAsset: () => Effect.die("not used"),
			readTable: () => Effect.die("not used"),
			scanProject: () => Effect.die("not used"),
			source: () => Effect.succeed("configured" as const)
		});

		yield* Effect.gen(function* () {
			const service = yield* WorkbenchProject;
			expect((yield* service.current()).status).toBe("ready");
			const candidates = yield* service.candidates("saved_tables");
			expect(candidates.assets).toHaveLength(1);
			expect(generations).toEqual([1, 1, 2, 2]);
		}).pipe(
			Effect.provide(WorkbenchProjectLive),
			Effect.provide(Layer.mergeAll(configuredProject, dialog, assetReader, projectIndex))
		);
	})
);
