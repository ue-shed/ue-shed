import type { SavedWorld } from "@ue-shed/protocol";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { makePerforceHistorySourceTestLayer, type PerforceHistorySourceShape } from "./perforce.js";
import { PerforceMapHistoryQuery } from "./schema.js";
import { resolvePerforceMapScope, scopedPerforceFile } from "./perforce-map-scope.js";

function query() {
	return Schema.decodeUnknownSync(PerforceMapHistoryQuery)({
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
		contract: { name: "unreal-saved-world", version: { major: 1, minor: 1 } },
		diagnostics: [],
		...(externalActorRoot === undefined ? {} : { externalActorRoot }),
		mapPath: "Content/Maps/L_Example.umap",
		sourceKind,
		actors: [],
		summary: { failedPackages: 0, partialPackages: 0, resolvedActors: 0, scannedPackages: 1 }
	};
}

function perforceSource(): PerforceHistorySourceShape {
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
		discoverAssets: () => Effect.die("Scope resolution must not discover assets."),
		discoverTables: () => Effect.die("Scope resolution must not discover tables."),
		readAsset: () => Effect.die("Scope resolution must not read an asset."),
		readSavedWorld: () => Effect.succeed(savedWorld),
		readTable: () => Effect.die("Scope resolution must not read a table."),
		source: () => Effect.succeed("configured")
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
