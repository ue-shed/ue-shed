import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { describe, expect } from "vitest";
import {
	foldProjectIndexRefresh,
	getProjectIndexStatus,
	ProjectIndexGeneration,
	ProjectIndexQuery,
	queryProjectIndex,
	refreshProjectIndex
} from "./project-index.js";
import { projectIndexProcessLayerWithConfig } from "./project-index-process.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));

describe.skipIf(!executable)("Project Index process adapter", () => {
	effectIt.effect("refreshes and queries the fixture without inventory frames", () =>
		Effect.gen(function* () {
			const cacheRoot = yield* Effect.promise(() =>
				mkdtemp(join(tmpdir(), "ue-shed-project-index-ts-"))
			);
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => rm(cacheRoot, { recursive: true, force: true }))
			);

			const layer = projectIndexProcessLayerWithConfig({
				cacheRoot,
				executable: executable!,
				timeoutMs: 120_000
			});

			yield* Effect.gen(function* () {
				expect(yield* getProjectIndexStatus({ projectRoot: fixtureRoot })).toEqual({
					status: "absent"
				});

				const cold = yield* foldProjectIndexRefresh(
					yield* Stream.runCollect(refreshProjectIndex({ projectRoot: fixtureRoot }))
				);
				expect(cold.generation).toBeGreaterThanOrEqual(1);
				expect(cold.packageCount).toBeGreaterThan(0);

				const warm = yield* foldProjectIndexRefresh(
					yield* Stream.runCollect(refreshProjectIndex({ projectRoot: fixtureRoot }))
				);
				expect(warm.changedPackages).toBe(0);
				expect(warm.packageCount).toBe(cold.packageCount);

				const maps = yield* queryProjectIndex(
					ProjectIndexQuery.cases.Maps.make({
						expectedGeneration: warm.generation,
						limit: 16,
						projectId: warm.projectId
					})
				);
				expect(maps.items.length).toBeLessThanOrEqual(16);
				expect(maps.generation).toBe(warm.generation);

				const stale = yield* Effect.exit(
					queryProjectIndex(
						ProjectIndexQuery.cases.Maps.make({
							expectedGeneration: ProjectIndexGeneration.make(1),
							limit: 8,
							projectId: warm.projectId
						})
					)
				);
				expect(Exit.isFailure(stale)).toBe(true);
			}).pipe(Effect.provide(layer));
		}).pipe(Effect.scoped)
	);
});
