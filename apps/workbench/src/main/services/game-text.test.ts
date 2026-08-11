import { it } from "@effect/vitest";
import { makeTextCorpusServiceTestLayer, TextCorpusScanError } from "@ue-shed/game-text";
import type { SavedAssetScan } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { WorkbenchGameText, WorkbenchGameTextLive } from "./game-text.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";

const gameTextAdapters = Layer.mergeAll(
	Layer.succeed(
		ElectronDialog,
		ElectronDialog.of({
			chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
			chooseFile: () => Effect.succeed({ status: "cancelled" }),
			chooseFiles: () => Effect.succeed({ status: "cancelled" })
		})
	),
	makeLocalFilesTestLayer()
);
const gameTextLive = WorkbenchGameTextLive.pipe(Layer.provide(gameTextAdapters));

function qualityGameTextLive(contents: string) {
	const path = "C:/FixtureProject/game-text-quality.json";
	return WorkbenchGameTextLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					ElectronDialog,
					ElectronDialog.of({
						chooseDirectory: () => Effect.succeed({ status: "cancelled" }),
						chooseFile: () => Effect.succeed({ path, status: "selected" }),
						chooseFiles: () => Effect.succeed({ status: "cancelled" })
					})
				),
				makeLocalFilesTestLayer(new Map([[path, new TextEncoder().encode(contents)]]))
			)
		)
	);
}

const emptyCorpus = {
	coverage: {
		discoveredPackages: 0,
		failedPackages: 0,
		inspectedPackages: 0,
		partialPackages: 0,
		resolvedOccurrences: 0,
		textOccurrences: 0,
		textUnits: 0,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1 as const,
	status: "complete" as const,
	units: []
};

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "configured", projectRoot: "C:/FixtureProject" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

const projectSummary = {
	inputAtlas: "ready" as const,
	mapCount: 0,
	packageCount: 0,
	projectName: "FixtureProject",
	projectRoot: "C:/FixtureProject"
};
const projectIndex: SavedAssetScan = {
	assets: [],
	failures: [],
	summary: {
		cacheHits: 0,
		depth: "header",
		diagnostics: [],
		emittedAssets: 0,
		failedAssets: 0,
		partialAssets: 0,
		projectRoot: "C:/FixtureProject",
		roots: ["C:/FixtureProject/Content"],
		scannedAssets: 0,
		schema_version: 8,
		skippedAssets: 0
	}
};
const selectedProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.succeed({ project: projectSummary, status: "ready" as const }),
	current: () => Effect.succeed({ project: projectSummary, status: "ready" as const }),
	inputAtlas: () => Effect.die("not used"),
	candidates: (kind) => {
		expect(kind).toBe("game_text");
		return Effect.succeed(projectIndex);
	},
	savedTables: () => Effect.die("savedTables is not used"),
	savedProject: () => Effect.succeed({ maps: [], projectRoot: "C:/FixtureProject" })
});
const unselectedProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.succeed({ status: "cancelled" as const }),
	current: () => Effect.succeed({ status: "not_configured" as const }),
	inputAtlas: () => Effect.die("not used"),
	savedTables: () => Effect.die("savedTables is not used"),
	savedProject: () => Effect.die("not used")
});

it.effect("returns not_configured without a project root", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							authoringAsset: { status: "not_configured" },
							expectedProject: { status: "not_configured" },
							project: { status: "not_configured" },
							remoteControlEndpoint: "http://127.0.0.1:30001",
							review: { status: "not_configured" },
							sourceCheckout: { status: "not_configured" },
							textureAuditRules: { status: "not_configured" }
						}),
						makeTextCorpusServiceTestLayer({ scan: () => Effect.die("not used") }),
						unselectedProject
					)
				)
			)
		)
	)
);

it.effect("scans the configured project", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({ corpus: emptyCorpus, status: "completed" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("keeps refreshed corpus data in main and serves bounded query results", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const refreshed = yield* service.configuredRefresh();
		expect(refreshed).toEqual({
			status: "completed",
			summary: {
				coverage: emptyCorpus.coverage,
				diagnosticCount: 0,
				review: {
					all: 0,
					conflicting: 0,
					duplicateSource: 0,
					long: 0,
					shared: 0,
					unresolved: 0
				},
				schemaVersion: 1,
				sources: { assetProperty: 0, dataTable: 0, mixed: 0, stringTable: 0 },
				status: "complete"
			}
		});
		expect(yield* service.search({ capability: "all", pageSize: 50, query: "" })).toEqual({
			page: { total: 0, units: [] },
			status: "ready"
		});
		expect(yield* service.focus({ id: "unreal:UI:Missing" as never, pageSize: 50 })).toEqual({
			status: "not_found"
		});
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("translates a typed scan failure into the failed result variant", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.configuredScan();
		expect(result).toEqual({
			error: {
				code: "invalid_project",
				message: "boom",
				recovery: "retry",
				retrySafe: false
			},
			status: "failed"
		});
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () =>
								Effect.fail(
									new TextCorpusScanError({
										code: "invalid_project",
										message: "boom",
										recovery: "retry",
										retrySafe: false
									})
								)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("uses the globally selected project when scanning", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.chooseAndScan();
		expect(result).toEqual({ corpus: emptyCorpus, status: "completed" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({
							scan: () => Effect.die("full project scan is not used"),
							scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
						}),
						selectedProject
					)
				)
			)
		)
	)
);

it.effect("cancels choose-and-scan when global project selection is cancelled", () =>
	Effect.gen(function* () {
		const service = yield* WorkbenchGameText;
		const result = yield* service.chooseAndScan();
		expect(result).toEqual({ status: "cancelled" });
	}).pipe(
		Effect.provide(
			gameTextLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						configuration,
						makeTextCorpusServiceTestLayer({ scan: () => Effect.die("not used") }),
						unselectedProject
					)
				)
			)
		)
	)
);

it.effect(
	"returns typed actionable rule failures without replacing the retained corpus query",
	() =>
		Effect.gen(function* () {
			const service = yield* WorkbenchGameText;
			expect(yield* service.chooseQualityRules()).toEqual({ status: "not_ready" });
			expect((yield* service.configuredRefresh()).status).toBe("completed");
			const reviewed = yield* service.chooseQualityRules();
			expect(reviewed).toEqual({
				error: {
					code: "invalid_rules",
					message: "The Game Text quality rule file is not valid JSON.",
					recovery: "Correct the JSON syntax and retry with a version-1 rule document.",
					retrySafe: true
				},
				status: "failed"
			});
			expect(yield* service.search({ capability: "all", pageSize: 50, query: "" })).toEqual({
				page: { total: 0, units: [] },
				status: "ready"
			});
			expect(yield* service.qualitySearch({ filter: "all", pageSize: 50 })).toEqual({
				status: "not_ready"
			});
		}).pipe(
			Effect.provide(
				qualityGameTextLive("{secret-authored-term").pipe(
					Layer.provide(
						Layer.mergeAll(
							configuration,
							makeTextCorpusServiceTestLayer({
								scan: () => Effect.die("full project scan is not used"),
								scanFromProjectIndex: () => Effect.succeed(emptyCorpus)
							}),
							selectedProject
						)
					)
				)
			)
		)
);
