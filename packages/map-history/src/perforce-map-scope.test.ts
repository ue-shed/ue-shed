import type { SavedWorld } from "@ue-shed/protocol";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import { describe, expect, it } from "@effect/vitest";
import { Stream, Effect, Layer, Schema } from "effect";
import {
	makePerforceHistorySourceTestLayer,
	type PerforceHistorySourceApi,
	type PerforceMapLineageOptions
} from "./perforce.js";
import { PerforceMapHistoryQuery } from "./schema.js";
import {
	resolvePerforceMapLineage,
	resolvePerforceMapScope,
	scopedPerforceFile
} from "./perforce-map-scope.js";
const decodePerforceMapHistoryQuery = Schema.decodeSync(PerforceMapHistoryQuery);

function query() {
	return decodePerforceMapHistoryQuery({
		limits: {
			maxChangelists: 100,
			maxConcurrency: 4,
			maxDurationMs: 60_000,
			maxMaterializedFiles: 10_000,
			maxPackages: 10_000
		},
		mapPath: "Content/Maps/L_Example.umap",
		projectRoot: "C:/Project",
		range: {
			since: "2026-07-21T00:00:00.000Z",
			until: "2026-07-28T00:00:00.000Z"
		}
	});
}

function world(
	externalActorRoot?: string,
	sourceKind: SavedWorld["sourceKind"] = externalActorRoot === undefined
		? "level"
		: "world_partition"
): SavedWorld {
	return {
		authority: { kind: "project_files", mapPackage: "/Game/Maps/L_Example" },
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
		diagnostics: [],
		...(externalActorRoot === undefined ? undefined : { externalActorRoot }),
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind,
		actors: [],
		summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 0, scannedPackages: 1 }
	};
}

function perforceSource(): PerforceHistorySourceApi {
	return {
		describeChangelist: () => Effect.die("Scope resolution must not describe changelists."),
		listDepotFilesAtChange: () => Effect.die("Scope resolution must not inventory files."),
		listSubmittedChangelists: () => Effect.die("Scope resolution must not list changes."),
		materializeDepotFiles: () => Effect.die("Scope resolution must not materialize files."),
		resolveLocalPath: (path) =>
			Effect.succeed({
				depotPath: path.endsWith("L_Example.umap")
					? "//Project/Main/Content/Maps/L_Example.umap"
					: "//Project/Main/Content/__ExternalActors__/Maps/L_Example"
			})
	};
}

function readerLayer(savedWorld: SavedWorld) {
	return makeAssetReaderTestLayer({
		configuration: Effect.sync(() => ({
			executable: "uasset",
			timeoutMs: 30_000,
			catalogTimeoutMs: 50 * 60_000
		})),
		catalogProgress: Effect.sync(() => ({
			phase: "idle",
			cacheHits: 0,
			processedAssets: 0,
			tablesFound: 0,
			totalAssets: 0
		})),
		scanProgress: Effect.sync(() => ({
			phase: "idle",
			cacheHits: 0,
			emittedAssets: 0,
			processedAssets: 0,
			totalAssets: 0
		})),
		savedWorldProgress: Effect.sync(() => ({
			phase: "idle",
			actorsFound: 0,
			processedPackages: 0,
			totalPackages: 0
		})),
		readBlueprint: () =>
			Effect.die(new Error("Unexpected readBlueprint in this reader fixture")),
		readLevelSequence: () =>
			Effect.die(new Error("Unexpected readLevelSequence in this reader fixture")),
		scanProject: () => Effect.die(new Error("Unexpected scanProject in this reader fixture")),
		extractProjectText: () =>
			Stream.die(new Error("Unexpected extractProjectText in this reader fixture")),
		extractProjectTextPackages: () =>
			Stream.die(new Error("Unexpected extractProjectTextPackages in this reader fixture")),
		extractProjectTextures: () =>
			Stream.die(new Error("Unexpected extractProjectTextures in this reader fixture")),
		discoverAssets: () => Effect.die("Scope resolution must not discover assets."),
		discoverTables: () => Effect.die("Scope resolution must not discover tables."),
		readAsset: () => Effect.die("Scope resolution must not read an asset."),
		readSavedWorld: () => Effect.succeed(savedWorld),
		readTable: () => Effect.die("Scope resolution must not read a table."),
		source: Effect.succeed("configured")
	});
}

describe("resolvePerforceMapScope", () => {
	it.effect("uses only the selected conventional map depot file", () => {
		const layer = Layer.merge(
			readerLayer(world()),
			makePerforceHistorySourceTestLayer(perforceSource())
		);
		return Effect.gen(function* () {
			const scope = yield* resolvePerforceMapScope(query());
			expect(scope).toEqual({
				fileSpecs: ["//Project/Main/Content/Maps/L_Example.*"],
				mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
				mapPackageName: "/Game/Maps/L_Example",
				mapProjectRelativePath: "Content/Maps/L_Example.umap",
				sourceKind: "level"
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect("adds exactly the matching World Partition actor subtree", () => {
		const layer = Layer.merge(
			readerLayer(world("C:/Project/Content/__ExternalActors__/Maps/L_Example")),
			makePerforceHistorySourceTestLayer(perforceSource())
		);
		return Effect.gen(function* () {
			const scope = yield* resolvePerforceMapScope(query());
			expect(scope).toEqual({
				externalActorDepotRoot: "//Project/Main/Content/__ExternalActors__/Maps/L_Example",
				externalActorProjectRoot: "Content/__ExternalActors__/Maps/L_Example",
				fileSpecs: [
					"//Project/Main/Content/Maps/L_Example.*",
					"//Project/Main/Content/__ExternalActors__/Maps/L_Example/..."
				],
				mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
				mapPackageName: "/Game/Maps/L_Example",
				mapProjectRelativePath: "Content/Maps/L_Example.umap",
				sourceKind: "world_partition"
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect("accepts the Windows extended-path spelling of a contained actor subtree", () => {
		const externalActorRoot = "C:/Project/Content/__ExternalActors__/Maps/L_Example";
		const layer = Layer.merge(
			readerLayer(world(`\\\\?\\${externalActorRoot}`)),
			makePerforceHistorySourceTestLayer(perforceSource())
		);
		return Effect.gen(function* () {
			const scope = yield* resolvePerforceMapScope(query());
			expect(scope.externalActorProjectRoot).toBe(
				"Content/__ExternalActors__/Maps/L_Example"
			);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"refuses to guess a World Partition actor subtree when the reader did not report one",
		() => {
			const layer = Layer.merge(
				readerLayer(world(undefined, "world_partition")),
				makePerforceHistorySourceTestLayer(perforceSource())
			);
			return Effect.gen(function* () {
				const error = yield* Effect.flip(resolvePerforceMapScope(query()));
				expect(error.kind).toBe("saved_world_decode");
			}).pipe(Effect.provide(layer));
		}
	);

	it("maps only exact map and saved external-actor package files into the historical project", () => {
		const scope = {
			externalActorDepotRoot: "//Project/Main/Content/__ExternalActors__/Maps/L_Example",
			externalActorProjectRoot: "Content/__ExternalActors__/Maps/L_Example",
			fileSpecs: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			mapPackageName: "/Game/Maps/L_Example",
			mapProjectRelativePath: "Content/Maps/L_Example.umap",
			sourceKind: "world_partition" as const
		};

		expect(scopedPerforceFile(scope, scope.mapDepotPath)).toEqual({
			depotPath: scope.mapDepotPath,
			packageName: "/Game/Maps/L_Example",
			projectRelativePath: "Content/Maps/L_Example.umap"
		});
		expect(scopedPerforceFile(scope, "//Project/Main/Content/Maps/L_Example.uexp")).toEqual({
			depotPath: "//Project/Main/Content/Maps/L_Example.uexp",
			packageName: "/Game/Maps/L_Example",
			projectRelativePath: "Content/Maps/L_Example.uexp"
		});
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset"
			)
		).toEqual({
			depotPath: "//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset",
			packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor",
			projectRelativePath: "Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset"
		});
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uexp"
			)
		).toMatchObject({ packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor" });
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.m.ubulk"
			)
		).toMatchObject({ packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor" });
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/Other/Actor.uasset"
			)
		).toBeUndefined();
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/metadata.json"
			)
		).toBeUndefined();
	});

	it("honors an allowedPackageNames allowlist for Fast History materialization", () => {
		const scope = {
			allowedPackageNames: new Set([
				"/Game/Maps/L_Example",
				"/Game/__ExternalActors__/Maps/L_Example/A/B/Actor"
			]),
			externalActorDepotRoot: "//Project/Main/Content/__ExternalActors__/Maps/L_Example",
			externalActorProjectRoot: "Content/__ExternalActors__/Maps/L_Example",
			fileSpecs: [],
			mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
			mapPackageName: "/Game/Maps/L_Example",
			mapProjectRelativePath: "Content/Maps/L_Example.umap",
			sourceKind: "world_partition" as const
		};
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B/Actor.uasset"
			)
		).toMatchObject({ packageName: "/Game/__ExternalActors__/Maps/L_Example/A/B/Actor" });
		expect(
			scopedPerforceFile(
				scope,
				"//Project/Main/Content/__ExternalActors__/Maps/L_Example/C/D/Other.uasset"
			)
		).toBeUndefined();
	});
});

describe("resolvePerforceMapLineage", () => {
	const scope = {
		fileSpecs: ["//Project/Main/Content/Maps/L_Example.*"],
		mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
		mapPackageName: "/Game/Maps/L_Example",
		mapProjectRelativePath: "Content/Maps/L_Example.umap",
		sourceKind: "level" as const
	};
	const lineage = (
		limits: Partial<PerforceMapHistoryQuery["limits"]>,
		filelogsAtLimit?: readonly string[]
	) => {
		const requests: PerforceMapLineageOptions[] = [];
		const layer = makePerforceHistorySourceTestLayer({
			...perforceSource(),
			resolveMapLineage: (request) => {
				requests.push(request);
				return Effect.succeed({
					locations: [
						{
							depotPath: scope.mapDepotPath,
							localPath: "C:/Project/" + scope.mapProjectRelativePath
						}
					],
					moves: [],
					...(filelogsAtLimit === undefined ? undefined : { filelogsAtLimit })
				});
			}
		});
		return resolvePerforceMapLineage({
			limits: { ...query().limits, ...limits },
			projectRoot: query().projectRoot,
			scope
		}).pipe(
			Effect.map((resolved) => ({ resolved, request: requests[0] })),
			Effect.provide(layer)
		);
	};

	it.effect("reads 16 direct moves and maxChangelists + 18 filelog revisions by default", () =>
		Effect.gen(function* () {
			const { resolved, request } = yield* lineage({});
			expect(request).toMatchObject({ maxMoves: 16, maxRevisionRecords: 118 });
			expect(resolved).toEqual({ locations: [scope], moves: [] });
		})
	);

	it.effect("takes both lineage limits from the query", () =>
		Effect.gen(function* () {
			expect((yield* lineage({ maxDirectMapMoves: 4 })).request).toMatchObject({
				maxMoves: 4,
				maxRevisionRecords: 106
			});
			expect(
				(yield* lineage({ maxDirectMapMoves: 4, maxFilelogRevisions: 5000 })).request
			).toMatchObject({ maxMoves: 4, maxRevisionRecords: 5000 });
		})
	);

	it.effect("says lineage may be incomplete when a filelog fills its window", () =>
		Effect.gen(function* () {
			const { resolved } = yield* lineage({ maxFilelogRevisions: 40 }, [scope.mapDepotPath]);
			expect(resolved.locations).toEqual([scope]);
			expect(resolved.diagnostics).toEqual([
				{
					code: "map_lineage_may_be_incomplete",
					message: expect.stringContaining("limits.maxFilelogRevisions"),
					retrySafe: false
				}
			]);
			expect(resolved.diagnostics?.[0]?.message).toContain(
				`returned 40 revisions of ${scope.mapDepotPath}`
			);
		})
	);
});
