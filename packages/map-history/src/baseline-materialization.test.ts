import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { materializeBaseline } from "./baseline-materialization.js";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";
import { makePerforceHistorySourceTestLayer, type PerforceHistorySourceShape } from "./perforce.js";

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

function source(materializedPath: string, hasMore = false): PerforceHistorySourceShape {
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
				const tree = yield* acquireHistoricalProjectTree();

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
				const tree = yield* acquireHistoricalProjectTree();
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
