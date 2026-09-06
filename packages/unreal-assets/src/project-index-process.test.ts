import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Stream } from "effect";
import { describe, expect } from "vitest";
import {
	countProjectIndex,
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
			const queryWorkerPids: number[] = [];
			let observeQueryWorkers = false;
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => rm(cacheRoot, { recursive: true, force: true }))
			);

			const layer = projectIndexProcessLayerWithConfig({
				cacheRoot,
				executable: executable!,
				protocolObserver: (event) => {
					if (observeQueryWorkers && event.kind === "worker_started") {
						queryWorkerPids.push(event.pid);
					}
				},
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
				observeQueryWorkers = true;
				const queryMaps = (limit: number) =>
					queryProjectIndex(
						ProjectIndexQuery.cases.Maps.make({
							expectedGeneration: warm.generation,
							limit,
							projectId: warm.projectId
						})
					);

				const [maps, repeatedMaps] = yield* Effect.all([queryMaps(16), queryMaps(8)], {
					concurrency: "unbounded"
				});
				expect(maps.items.length).toBeLessThanOrEqual(16);
				expect(maps.generation).toBe(warm.generation);
				expect(repeatedMaps.generation).toBe(warm.generation);
				const counted = yield* countProjectIndex({
					projectId: warm.projectId,
					expectedGeneration: warm.generation,
					filters: [
						{ _tag: "ExactClasses", values: ["/Script/Engine.DataTable"] },
						{ _tag: "ClassNameSuffixes", values: ["Table"] }
					]
				});
				expect(counted.count).toBeGreaterThan(0);
				expect(counted.generation).toBe(warm.generation);
				const count = yield* countProjectIndex({
					projectId: warm.projectId,
					expectedGeneration: warm.generation,
					filters: [{ _tag: "Maps" }, { _tag: "Maps" }]
				});
				expect(count.count).toBe(warm.mapCount);
				const staleCount = yield* Effect.exit(
					countProjectIndex({
						projectId: warm.projectId,
						expectedGeneration: ProjectIndexGeneration.make(99999),
						filters: [{ _tag: "Maps" }]
					})
				);
				expect(Exit.isFailure(staleCount)).toBe(true);

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

				const recovered = yield* queryProjectIndex(
					ProjectIndexQuery.cases.Maps.make({
						expectedGeneration: warm.generation,
						limit: 4,
						projectId: warm.projectId
					})
				);
				expect(recovered.generation).toBe(warm.generation);
			}).pipe(Effect.provide(layer));

			expect(new Set(queryWorkerPids).size).toBe(1);
			expect(queryWorkerPids.length).toBe(7);
			const sessionPid = queryWorkerPids[0];
			if (sessionPid !== undefined) {
				expect(() => process.kill(sessionPid, 0)).toThrow();
			}
		}).pipe(Effect.scoped)
	);
});
