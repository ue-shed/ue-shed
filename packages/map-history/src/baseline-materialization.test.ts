import { materializePlannedRevision } from "./revision-materialization.js";
import { planScopedRevision } from "./revision-plan.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { materializeBaseline } from "./baseline-materialization.js";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";
import { makePerforceHistorySourceTestLayer, type PerforceHistorySourceApi } from "./perforce.js";

const scope = {
	externalActorDepotRoot: "//Project/Main/Content/__ExternalActors__/Maps/L_Example",
	externalActorProjectRoot: "Content/__ExternalActors__/Maps/L_Example",
	fileSpecs: [
		"//Project/Main/Content/Maps/L_Example.*",
		"//Project/Main/Content/__ExternalActors__/Maps/L_Example/..."
	],
	mapDepotPath: "//Project/Main/Content/Maps/L_Example.umap",
	mapPackageName: "/Game/Maps/L_Example",
	mapProjectRelativePath: "Content/Maps/L_Example.umap",
	sourceKind: "world_partition" as const
};

function source(materializedPath: string, hasMore = false): PerforceHistorySourceApi {
	return {
		describeChangelist: () => Effect.die("Baseline materialization must not describe changes."),
		listDepotFilesAtChange: (options) =>
			Effect.succeed({
				files: options.depotPath.endsWith("L_Example.*")
					? [
							{
								action: "edit",
								changelist: 90,
								depotPath: "//Project/Main/Content/Maps/L_Example.umap",
								revision: 3,
								type: "binary"
							}
						]
					: [
							{
								action: "edit",
								changelist: 89,
								depotPath:
									"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/Actor.uasset",
								revision: 4,
								type: "binary"
							},
							{
								action: "edit",
								changelist: 89,
								depotPath:
									"//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/Actor.uexp",
								revision: 4,
								type: "binary"
							}
						],
				hasMore
			}),
		listSubmittedChangelists: () =>
			Effect.die("Baseline materialization must not list changes."),
		materializeDepotFiles: (options) =>
			Effect.succeed({
				directory: options.directory,
				files: options.files.map((file) => ({ file, localPath: materializedPath })),
				totalCount: options.files.length
			}),
		resolveLocalPath: () => Effect.die("Baseline materialization must not resolve paths.")
	};
}

describe("materializeBaseline", () => {
	it.effect("builds a complete map and external-actor baseline in the owned tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const sourceRoot = yield* Effect.acquireRelease(
					Effect.promise(() =>
						mkdtemp(resolve(tmpdir(), "ue-shed-map-history-baseline-"))
					),
					(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
				);
				const materializedPath = resolve(sourceRoot, "asset.bin");
				yield* Effect.promise(() => writeFile(materializedPath, "baseline bytes"));
				const tree = yield* acquireHistoricalProjectTree;

				yield* materializeBaseline({
					change: 90,
					concurrency: 2,
					maxFiles: 10,
					scope,
					tree
				}).pipe(
					Effect.provide(makePerforceHistorySourceTestLayer(source(materializedPath)))
				);

				expect(
					yield* Effect.promise(() =>
						readFile(resolve(tree.projectRoot, "Content/Maps/L_Example.umap"), "utf8")
					)
				).toBe("baseline bytes");
				expect(
					yield* Effect.promise(() =>
						readFile(
							resolve(
								tree.projectRoot,
								"Content/__ExternalActors__/Maps/L_Example/A/Actor.uexp"
							),
							"utf8"
						)
					)
				).toBe("baseline bytes");
			})
		)
	);

	it.effect("refuses an incomplete Perforce baseline inventory", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const tree = yield* acquireHistoricalProjectTree;
				const error = yield* materializeBaseline({
					change: 90,
					concurrency: 2,
					maxFiles: 10,
					scope,
					tree
				}).pipe(
					Effect.provide(makePerforceHistorySourceTestLayer(source("unused", true))),
					Effect.flip
				);

				expect(error.kind).toBe("resource_limit");
			})
		)
	);
});

const mapFile = {
	action: "edit",
	changelist: 90,
	depotPath: "//Project/Main/Content/Maps/L_Example.umap",
	revision: 3,
	type: "binary"
} as const;

/** A source whose listings honour the requested bound, like Perforce's `-m`. */
function boundedSource(
	materializedPath: string,
	external: ReadonlyArray<typeof mapFile>
): PerforceHistorySourceApi {
	const base = source(materializedPath);
	return {
		...base,
		listDepotFilesAtChange: (options) => {
			const all = options.depotPath.endsWith("L_Example.*") ? [mapFile] : [...external];
			return Effect.succeed({
				files: all.slice(0, options.maxFiles),
				hasMore: all.length > options.maxFiles
			});
		}
	};
}

describe("C2 materializeBaseline counts the distinct union against its budget", () => {
	const materialize = (external: ReadonlyArray<typeof mapFile>, maxFiles: number) =>
		Effect.scoped(
			Effect.gen(function* () {
				const sourceRoot = yield* Effect.acquireRelease(
					Effect.promise(() => mkdtemp(resolve(tmpdir(), "ue-shed-map-history-budget-"))),
					(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
				);
				const materializedPath = resolve(sourceRoot, "asset.bin");
				yield* Effect.promise(() => writeFile(materializedPath, "baseline bytes"));
				const tree = yield* acquireHistoricalProjectTree;
				return yield* materializeBaseline({
					change: 90,
					concurrency: 2,
					maxFiles,
					scope,
					tree
				}).pipe(
					Effect.provide(makePerforceHistorySourceTestLayer(boundedSource(materializedPath, external)))
				);
			})
		);

	it.effect("accepts an empty scope after an earlier scope filled the budget", () =>
		Effect.gen(function* () {
			const result = yield* materialize([], 1).pipe(Effect.result);
			expect(result._tag).toBe("Success");
		})
	);

	it.effect("accepts a scope that only repeats files already counted", () =>
		Effect.gen(function* () {
			const result = yield* materialize([mapFile], 1).pipe(Effect.result);
			expect(result._tag).toBe("Success");
		})
	);

	it.effect("still refuses a union with more distinct files than the budget", () =>
		Effect.gen(function* () {
			const error = yield* materialize(
				[{ ...mapFile, depotPath: "//Project/Main/Content/__ExternalActors__/Maps/L_Example/A/B.uasset" }],
				1
			).pipe(Effect.flip);
			expect(error.kind).toBe("resource_limit");
		})
	);
});

function revisionSource(materializedPath: string): PerforceHistorySourceApi {
	return {
		describeChangelist: () =>
			Effect.die("Revision materialization must not describe changelists."),
		listDepotFilesAtChange: () =>
			Effect.die("Revision materialization must not inventory files."),
		listSubmittedChangelists: () =>
			Effect.die("Revision materialization must not list changes."),
		materializeDepotFiles: (options) =>
			Effect.succeed({
				directory: options.directory,
				files: options.files.map((file) => ({ file, localPath: materializedPath })),
				totalCount: options.files.length
			}),
		resolveLocalPath: () => Effect.die("Revision materialization must not resolve paths.")
	};
}

describe("materializePlannedRevision", () => {
	it.effect("applies only the exact materialized map revision to the historical tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const sourceRoot = yield* Effect.acquireRelease(
					Effect.promise(() =>
						mkdtemp(resolve(tmpdir(), "ue-shed-map-history-materialized-"))
					),
					(root) => Effect.promise(() => rm(root, { force: true, recursive: true }))
				);
				const materializedPath = resolve(sourceRoot, "L_Example.umap");
				yield* Effect.promise(() => writeFile(materializedPath, "historical bytes"));
				const tree = yield* acquireHistoricalProjectTree;
				const plan = planScopedRevision({
					files: [
						{
							action: "edit",
							depotPath: "//Project/Main/Content/Maps/L_Example.umap",
							revision: 7,
							type: "binary"
						}
					],
					scope: [
						{
							depotPath: "//Project/Main/Content/Maps/L_Example.umap",
							packageName: "/Game/Maps/L_Example",
							projectRelativePath: "Content/Maps/L_Example.umap"
						}
					]
				});

				yield* materializePlannedRevision({
					change: 120,
					concurrency: 2,
					maxFiles: 5,
					plan,
					tree
				}).pipe(
					Effect.provide(
						makePerforceHistorySourceTestLayer(revisionSource(materializedPath))
					)
				);

				expect(
					yield* Effect.promise(() =>
						readFile(resolve(tree.projectRoot, "Content/Maps/L_Example.umap"), "utf8")
					)
				).toBe("historical bytes");
			})
		)
	);
});
