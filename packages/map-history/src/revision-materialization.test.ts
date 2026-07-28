import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";
import { makePerforceHistorySourceTestLayer, type PerforceHistorySourceShape } from "./perforce.js";
import { materializePlannedRevision } from "./revision-materialization.js";
import { planScopedRevision } from "./revision-plan.js";

function source(materializedPath: string): PerforceHistorySourceShape {
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
				const tree = yield* acquireHistoricalProjectTree();
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
					Effect.provide(makePerforceHistorySourceTestLayer(source(materializedPath)))
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
