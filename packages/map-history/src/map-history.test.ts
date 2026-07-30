import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type { SavedWorld } from "@ue-shed/protocol";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
	mapHistoryLayer,
	mapHistoryProgress,
	readPerforceFastMapHistory,
	readPerforceMapHistory
} from "./map-history.js";
import { makePerforceHistorySourceTestLayer, type PerforceHistorySourceShape } from "./perforce.js";
import { PerforceFastMapHistoryQuery, PerforceMapHistoryQuery } from "./schema.js";

const projectRoot = "C:/Project";
const mapPath = "Content/Maps/L_Example.umap";
const mapDepotPath = "//Project/Main/Content/Maps/L_Example.umap";
const externalActorDepotPath =
	"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/Actor.uasset";
const externalActorRoot = "C:/Project/Content/__ExternalActors__/Maps/L_Example";

function query(maxMaterializedFiles = 10, maxDurationMs = 60_000) {
	return Schema.decodeUnknownSync(PerforceMapHistoryQuery)({
		limits: {
			maxChangelists: 10,
			maxConcurrency: 2,
			maxDurationMs,
			maxMaterializedFiles,
			maxPackages: 10
		},
		mapPath,
		projectRoot,
		range: {
			since: "2026-07-21T00:00:00.000Z",
			until: "2026-07-28T00:00:00.000Z"
		}
	});
}

function world(actors: SavedWorld["actors"]): SavedWorld {
	return {
		authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 1, minor: 1 } },
		diagnostics: [],
		externalActorRoot,
		mapPath,
		sourceKind: "world_partition",
		actors,
		summary: {
			failedPackages: 0,
			partialPackages: 0,
			resolvedActors: actors.length,
			scannedPackages: 1 + actors.length
		}
	};
}

const actor: SavedWorld["actors"][number] = {
	actorGuid: "12345678-12345678-12345678-12345678",
	actorPath: "/Game/Maps/L_Example.L_Example:PersistentLevel.Actor_1",
	classPath: "/Script/Engine.Actor",
	label: "Actor One",
	packageName: "/Game/__ExternalActors__/Maps/L_Example/A/Actor",
	position: { location: { x: 10, y: 20, z: 30 }, status: "resolved" }
};

function readerLayer(observedHistoricalRoots: string[]) {
	return makeAssetReaderTestLayer({
		discoverAssets: () => Effect.die("Map History must not discover arbitrary assets."),
		discoverTables: () => Effect.die("Map History must not discover tables."),
		readAsset: () => Effect.die("Map History must not read individual assets."),
		readSavedWorld: (options) => {
			if (options.projectRoot === projectRoot) return Effect.succeed(world([actor]));
			observedHistoricalRoots.push(options.projectRoot);
			return Effect.promise(async () => {
				const historicalMap = await readFile(resolve(options.projectRoot, mapPath), "utf8");
				const actorExists = existsSync(
					resolve(
						options.projectRoot,
						"Content/__ExternalActors__/Maps/L_Example/A/Actor.uasset"
					)
				);
				if (historicalMap === "baseline") return world([]);
				if (historicalMap === "revision") return world(actorExists ? [actor] : []);
				throw new Error(`Unexpected historical map state ${historicalMap}.`);
			});
		},
		readTable: () => Effect.die("Map History must not read tables."),
		source: () => Effect.succeed("configured")
	});
}

function source(materializedRoot: string): PerforceHistorySourceShape {
	const materializedPath = (file: { readonly depotPath: string; readonly revision: number }) =>
		resolve(materializedRoot, `${file.revision}-${basename(file.depotPath)}`);
	return {
		describeChangelist: (change) => {
			if (change === 101) {
				return Effect.succeed({
					change,
					files: [
						{ action: "edit", depotPath: mapDepotPath, revision: 2, type: "binary" },
						{
							action: "add",
							depotPath: externalActorDepotPath,
							revision: 1,
							type: "binary"
						}
					],
					status: "submitted"
				});
			}
			if (change === 102) {
				return Effect.succeed({
					change,
					files: [
						{
							action: "delete",
							depotPath: externalActorDepotPath,
							revision: 2,
							type: "binary"
						}
					],
					status: "submitted"
				});
			}
			return Effect.die(`Unexpected changelist ${change}.`);
		},
		listDepotFilesAtChange: (options) =>
			Effect.succeed({
				files: options.depotPath.endsWith("L_Example.*")
					? [
							{
								action: "add",
								changelist: 100,
								depotPath: mapDepotPath,
								revision: 1,
								type: "binary"
							}
						]
					: [],
				hasMore: false
			}),
		listSubmittedChangelists: () =>
			Effect.succeed({
				hasMore: false,
				items: [
					{
						change: 102,
						description: "Delete the actor",
						submittedAt: "2026-07-23T00:00:00.000Z",
						user: "unreal"
					},
					{
						change: 101,
						description: "Add the actor",
						submittedAt: "2026-07-22T00:00:00.000Z",
						user: "unreal"
					},
					{
						change: 100,
						submittedAt: "2026-07-20T00:00:00.000Z",
						user: "unreal"
					}
				],
				nextBeforeChange: null
			}),
		materializeDepotFiles: (options) =>
			Effect.forEach(options.files, (file) =>
				Effect.promise(async () => {
					const path = materializedPath(file);
					await writeFile(
						path,
						file.depotPath === mapDepotPath && file.revision === 1
							? "baseline"
							: "revision"
					);
					return { file, localPath: path };
				})
			).pipe(
				Effect.map((files) => ({
					directory: options.directory,
					files,
					totalCount: files.length
				}))
			),
		resolveLocalPath: (path) =>
			Effect.succeed({
				depotPath: path.endsWith("L_Example.umap")
					? mapDepotPath
					: "//Project/Main/Content/__ExternalActors__/Maps/L_Example"
			})
	};
}

function historyLayer(materializedRoot: string, observedHistoricalRoots: string[]) {
	return Layer.provide(
		mapHistoryLayer,
		Layer.merge(
			readerLayer(observedHistoricalRoots),
			makePerforceHistorySourceTestLayer(source(materializedRoot))
		)
	);
}

function futureOnlySource(): PerforceHistorySourceShape {
	return {
		describeChangelist: () => Effect.die("An empty range must not describe changelists."),
		listDepotFilesAtChange: () => Effect.die("An empty range must not inventory a baseline."),
		listSubmittedChangelists: () =>
			Effect.succeed({
				hasMore: false,
				items: [{ change: 200, submittedAt: "2026-07-29T00:00:00.000Z" }],
				nextBeforeChange: null
			}),
		materializeDepotFiles: () => Effect.die("An empty range must not materialize files."),
		resolveLocalPath: (path) =>
			Effect.succeed({
				depotPath: path.endsWith("L_Example.umap")
					? mapDepotPath
					: "//Project/Main/Content/__ExternalActors__/Maps/L_Example"
			})
	};
}

describe("readPerforceMapHistory", () => {
	it.effect(
		"folds one baseline and atomic changelists into actor history, then cleans its tree",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const materializedRoot = yield* Effect.acquireRelease(
						Effect.promise(() =>
							mkdtemp(resolve(tmpdir(), "ue-shed-map-history-operation-"))
						),
						(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
					);
					const observedHistoricalRoots: string[] = [];
					const history = yield* Effect.gen(function* () {
						const result = yield* readPerforceMapHistory(query());
						const finalProgress = yield* mapHistoryProgress();
						return { finalProgress, result };
					}).pipe(
						Effect.provide(historyLayer(materializedRoot, observedHistoricalRoots))
					);
					const { result } = history;

					expect(result.baseline).toEqual({ change: 100, status: "available" });
					expect(result.revisions.map((revision) => revision.change)).toEqual([101, 102]);
					expect(result.revisions[0]?.changes.map((change) => change.kind)).toEqual([
						"actor_added"
					]);
					expect(result.revisions[1]?.changes.map((change) => change.kind)).toEqual([
						"actor_removed"
					]);
					expect(result.revisions[0]?.unclassifiedPackageChanges).toMatchObject([
						{ depotPath: mapDepotPath, reason: "projection_unchanged" }
					]);
					expect(result.revisions[1]?.unclassifiedPackageChanges).toEqual([]);
					expect(result.rangeEndSnapshot?.actors).toEqual([]);
					expect(result.rangeEndSnapshot?.mapPackage).toBe("/Game/Maps/L_Example");
					expect(result.rangeEndSnapshot).not.toHaveProperty("externalActorRoot");
					expect(result.rangeStartSnapshot?.actors).toEqual([]);
					expect(result.rangeStartSnapshot?.mapPackage).toBe("/Game/Maps/L_Example");
					expect(result.rangeStartSnapshot).not.toHaveProperty("externalActorRoot");
					expect(history.finalProgress.phase).toBe("ready");
					expect(observedHistoricalRoots.length).toBeGreaterThan(0);
					for (const root of observedHistoricalRoots)
						expect(existsSync(root)).toBe(false);
				})
			)
	);

	it.effect("reports a successful empty range before the map was created", () => {
		const observedHistoricalRoots: string[] = [];
		const layer = Layer.provide(
			mapHistoryLayer,
			Layer.merge(
				readerLayer(observedHistoricalRoots),
				makePerforceHistorySourceTestLayer(futureOnlySource())
			)
		);
		return Effect.gen(function* () {
			const result = yield* readPerforceMapHistory(query());
			expect(result.baseline).toEqual({ status: "map_not_yet_created" });
			expect(result.revisions).toEqual([]);
			expect(result.rangeStartSnapshot).toBeUndefined();
			expect(result.rangeEndSnapshot).toBeUndefined();
			expect(result.completeness).toBe("complete");
			expect(observedHistoricalRoots).toEqual([]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("applies maxMaterializedFiles across the baseline and every changelist", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const materializedRoot = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(resolve(tmpdir(), "ue-shed-map-history-limit-"))),
					(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
				);
				const observedHistoricalRoots: string[] = [];
				const error = yield* readPerforceMapHistory(query(2)).pipe(
					Effect.provide(historyLayer(materializedRoot, observedHistoricalRoots)),
					Effect.flip
				);

				expect(error.kind).toBe("resource_limit");
				expect(observedHistoricalRoots.length).toBeGreaterThan(0);
				for (const root of observedHistoricalRoots) expect(existsSync(root)).toBe(false);
			})
		)
	);

	it.effect("cleans the owned historical tree when the operation duration expires", () => {
		const observedHistoricalRoots: string[] = [];
		const materializationDirectories: string[] = [];
		return Effect.gen(function* () {
			const materializationStarted = yield* Deferred.make<void>();
			const slowSource = {
				...source("unused"),
				materializeDepotFiles: (
					options: Parameters<PerforceHistorySourceShape["materializeDepotFiles"]>[0]
				) =>
					Effect.gen(function* () {
						materializationDirectories.push(options.directory);
						yield* Deferred.succeed(materializationStarted, undefined);
						return yield* Effect.never;
					})
			} satisfies PerforceHistorySourceShape;
			const layer = Layer.provide(
				mapHistoryLayer,
				Layer.merge(
					readerLayer(observedHistoricalRoots),
					makePerforceHistorySourceTestLayer(slowSource)
				)
			);
			const fiber = yield* Effect.forkChild(
				readPerforceMapHistory(query(10, 1)).pipe(Effect.provide(layer), Effect.flip)
			);
			yield* Deferred.await(materializationStarted);
			yield* TestClock.adjust("1 millis");
			const error = yield* Fiber.join(fiber);

			expect(error.kind).toBe("resource_limit");
			expect(materializationDirectories).toHaveLength(1);
			expect(existsSync(materializationDirectories[0] ?? "")).toBe(false);
		});
	});
});

function fastQuery() {
	return Schema.decodeUnknownSync(PerforceFastMapHistoryQuery)({
		limits: {
			maxChangelists: 10,
			maxConcurrency: 2,
			maxDurationMs: 60_000,
			maxMaterializedFiles: 10,
			maxPackages: 10
		},
		mapPath,
		mode: "fast",
		projectRoot,
		range: {
			since: "2026-07-21T00:00:00.000Z",
			until: "2026-07-28T00:00:00.000Z"
		},
		target: {
			identity: { actorGuid: actor.actorGuid!, kind: "actor_guid" },
			kind: "actor"
		}
	});
}

function fastSource(materializedRoot: string): PerforceHistorySourceShape {
	const base = source(materializedRoot);
	return {
		...base,
		listDepotFilesAtChange: (options) => {
			if (options.depotPath.endsWith("L_Example.*")) {
				return base.listDepotFilesAtChange(options);
			}
			if (options.depotPath.includes("/A/Actor.")) {
				return Effect.succeed({
					files: [
						{
							action: "add",
							changelist: 100,
							depotPath: externalActorDepotPath,
							revision: 1,
							type: "binary"
						}
					],
					hasMore: false
				});
			}
			return Effect.succeed({ files: [], hasMore: false });
		},
		listSubmittedChangelists: (options) => {
			expect(options.fileSpec).toEqual([
				"//Project/Main/Content/Maps/L_Example.*",
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/Actor.*"
			]);
			return base.listSubmittedChangelists(options);
		},
		resolveLocalPath: (path) => {
			if (path.endsWith("L_Example.umap")) {
				return Effect.succeed({ depotPath: mapDepotPath });
			}
			if (path.replaceAll("\\", "/").endsWith("/A/Actor.uasset")) {
				return Effect.succeed({ depotPath: externalActorDepotPath });
			}
			return Effect.succeed({
				depotPath: "//Project/Main/Content/__ExternalActors__/Maps/L_Example"
			});
		}
	};
}

describe("readPerforceFastMapHistory", () => {
	it.effect("scans only the selected map and proven Investigation Target actor package", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const materializedRoot = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(resolve(tmpdir(), "ue-shed-map-history-fast-"))),
					(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
				);
				const observedHistoricalRoots: string[] = [];
				const layer = Layer.provide(
					mapHistoryLayer,
					Layer.merge(
						readerLayer(observedHistoricalRoots),
						makePerforceHistorySourceTestLayer(fastSource(materializedRoot))
					)
				);
				const result = yield* readPerforceFastMapHistory(fastQuery()).pipe(
					Effect.provide(layer)
				);

				expect(result.mode).toBe("fast");
				expect(result.coverage.kind).toBe("targeted");
				expect(result.coverage.claimsCompleteMapCoverage).toBe(false);
				expect(result.coverage.claimsHistoricalClassCoverage).toBe(false);
				expect(result.coverage.investigationTarget.packageName).toBe(actor.packageName);
				expect(result.coverage.acquiredPackages.map((pkg) => pkg.role)).toEqual([
					"selected_map",
					"investigation_target_actor"
				]);
				expect(result.revisions.map((revision) => revision.change)).toEqual([101, 102]);
				expect(result.revisions[0]?.changes.map((change) => change.kind)).toEqual([
					"actor_added"
				]);
				for (const root of observedHistoricalRoots) expect(existsSync(root)).toBe(false);
			})
		)
	);

	it.effect("fails before Perforce when the Investigation Target is absent", () => {
		const observedHistoricalRoots: string[] = [];
		const layer = Layer.provide(
			mapHistoryLayer,
			Layer.merge(
				readerLayer(observedHistoricalRoots),
				makePerforceHistorySourceTestLayer({
					...fastSource("unused"),
					listSubmittedChangelists: () =>
						Effect.die("Missing Fast History targets must not list changelists."),
					materializeDepotFiles: () =>
						Effect.die("Missing Fast History targets must not materialize files.")
				})
			)
		);
		return Effect.gen(function* () {
			const missing = Schema.decodeUnknownSync(PerforceFastMapHistoryQuery)({
				...Schema.encodeSync(PerforceFastMapHistoryQuery)(fastQuery()),
				target: {
					identity: {
						actorGuid: "00000000-0000-0000-0000-000000000099",
						kind: "actor_guid"
					},
					kind: "actor"
				}
			});
			const error = yield* readPerforceFastMapHistory(missing).pipe(
				Effect.provide(layer),
				Effect.flip
			);
			expect(error.kind).toBe("invalid_target");
			expect(observedHistoricalRoots).toEqual([]);
		});
	});
});
