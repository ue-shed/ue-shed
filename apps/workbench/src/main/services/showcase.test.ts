import { it } from "@effect/vitest";
import { makeAssetReaderTestLayer, type AssetReaderTestShape } from "@ue-shed/unreal-assets";
import { aggregateHealth, defaultHealthInput, runtimeHealthLayer } from "@ue-shed/observability";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { makeLocalFilesTestLayer } from "../adapters/local-files.js";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { Showcase, ShowcaseLive } from "./showcase.js";

const stubReader = (source: "configured" | "path"): AssetReaderTestShape => ({
	discoverAssets: () => Effect.succeed([]),
	discoverTables: () =>
		Effect.succeed({ diagnostics: [], projectRoot: "", scannedAssets: 0, tables: [] }),
	readAsset: () => Effect.die("not used"),
	readTable: () => Effect.die("not used"),
	source: () => Effect.succeed(source)
});

const emptyCandidates = {
	assets: [],
	failures: [],
	summary: {
		cacheHits: 0,
		depth: "header" as const,
		diagnostics: [],
		emittedAssets: 0,
		failedAssets: 0,
		partialAssets: 0,
		projectRoot: "C:/FixtureProject",
		roots: ["C:/FixtureProject/Content"],
		scannedAssets: 12,
		schema_version: 8 as const,
		skippedAssets: 12
	}
};

const readyProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.die("not used"),
	current: () =>
		Effect.succeed({
			project: {
				inputAtlas: "deferred" as const,
				mapCount: 3,
				packageCount: 12,
				projectName: "FixtureProject",
				projectRoot: "C:/FixtureProject"
			},
			status: "ready" as const
		}),
	inputAtlas: () => Effect.die("not used"),
	savedProject: () => Effect.die("not used"),
	savedTables: () => Effect.die("not used"),
	candidates: () => Effect.succeed(emptyCandidates)
});

const unconfiguredProject = makeWorkbenchProjectTestLayer({
	choose: () => Effect.die("not used"),
	current: () => Effect.succeed({ status: "not_configured" as const }),
	inputAtlas: () => Effect.die("not used"),
	savedProject: () => Effect.die("not used"),
	savedTables: () => Effect.die("not used")
});

it.effect("reports fixture configured when project and rules exist", () =>
	Effect.gen(function* () {
		const showcase = yield* Showcase;
		const context = yield* showcase.context();
		expect(context).toEqual({
			fixtureConfigured: true,
			health: aggregateHealth(defaultHealthInput),
			project: {
				candidates: {
					dataTablePackages: 0,
					enhancedInputPackages: 0,
					gameTextPackages: 0,
					status: "ready",
					texturePackages: 0
				},
				mapCount: 3,
				packageCount: 12,
				projectName: "FixtureProject",
				projectRoot: "C:/FixtureProject",
				status: "ready"
			},
			projectRoot: "C:/FixtureProject",
			reader: "configured",
			ruleFile: "C:/rules.json"
		});
	}).pipe(
		Effect.provide(
			ShowcaseLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							authoringAsset: { status: "not_configured" },
							expectedProject: { status: "not_configured" },
							project: { status: "configured", projectRoot: "C:/FixtureProject" },
							remoteControlEndpoint: "http://127.0.0.1:30001",
							review: { status: "not_configured" },
							sourceCheckout: { status: "not_configured" },
							textureAuditRules: { status: "configured", path: "C:/rules.json" }
						}),
						makeAssetReaderTestLayer(stubReader("configured")),
						readyProject,
						runtimeHealthLayer(),
						makeLocalFilesTestLayer(
							new Map([
								["C:/FixtureProject", new Uint8Array()],
								["C:/rules.json", new Uint8Array()]
							])
						)
					)
				)
			)
		)
	)
);

it.effect("reports fixture not configured when nothing is set", () =>
	Effect.gen(function* () {
		const showcase = yield* Showcase;
		const context = yield* showcase.context();
		expect(context).toEqual({
			fixtureConfigured: false,
			health: aggregateHealth(defaultHealthInput),
			project: { status: "not_configured" },
			reader: "path"
		});
	}).pipe(
		Effect.provide(
			ShowcaseLive.pipe(
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
						makeAssetReaderTestLayer(stubReader("path")),
						unconfiguredProject,
						runtimeHealthLayer(),
						makeLocalFilesTestLayer()
					)
				)
			)
		)
	)
);

it.effect("reports fixture not configured when configured paths are missing on disk", () =>
	Effect.gen(function* () {
		const showcase = yield* Showcase;
		const context = yield* showcase.context();
		expect(context.fixtureConfigured).toBe(false);
	}).pipe(
		Effect.provide(
			ShowcaseLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						makeWorkbenchConfigurationLayer({
							authoringAsset: { status: "not_configured" },
							expectedProject: { status: "not_configured" },
							project: { status: "configured", projectRoot: "C:/FixtureProject" },
							remoteControlEndpoint: "http://127.0.0.1:30001",
							review: { status: "not_configured" },
							sourceCheckout: { status: "not_configured" },
							textureAuditRules: { status: "configured", path: "C:/rules.json" }
						}),
						makeAssetReaderTestLayer(stubReader("configured")),
						readyProject,
						runtimeHealthLayer(),
						makeLocalFilesTestLayer()
					)
				)
			)
		)
	)
);
