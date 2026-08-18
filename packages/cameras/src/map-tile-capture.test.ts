import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	MapCapture,
	MapCaptureLive,
	mapTileCapturePortLayer,
	type MapCaptureRunProgress,
	type MapTileCapturePortApi
} from "./map-tile-capture.js";
import {
	MapCaptureRepository,
	MapCaptureRepositoryLive,
	mapCaptureAttemptsRoot,
	mapCaptureRoot,
	mapCaptureRunsRoot,
	type MapCaptureRepositoryApi
} from "./map-tile-repository.js";
import { mapTileKeyId, mapTileRelativePath } from "./map-tile-pyramid.js";
import type { MapCaptureBackend } from "./map-tile-schema.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
	);
});

function fakePng(size: number): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, size);
	view.setUint32(20, size);
	return bytes;
}

async function fixtureProject(levelCount: number): Promise<{
	readonly planPath: string;
	readonly projectRoot: string;
}> {
	const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-capture-"));
	temporaryRoots.push(projectRoot);
	await writeFile(join(projectRoot, "Test.uproject"), "{}\n");
	const planPath = join(projectRoot, "map-capture-plan.json");
	await writeFile(
		planPath,
		JSON.stringify({
			capture: {
				dataLayers: { mode: "unchanged" },
				orientation: { pitch: -90, roll: 0, yaw: 0 },
				render: {
					effects: { fog: false, volumetricFog: false },
					lodDistanceScaleByZoom: Array.from({ length: levelCount }, (_value, zoom) =>
						Math.max(1, 4 / 2 ** zoom)
					),
					lodPolicy: "per_level_distance_scale",
					profile: "full_fidelity"
				},
				z: 1000
			},
			contract: {
				name: "ue-shed-map-capture-plan",
				version: { major: 1, minor: 0 }
			},
			gutterPixels: 2,
			id: "test-plan",
			levels: { coarsestUnitsPerPixel: 1, count: levelCount },
			output: { imageFormat: "png", publication: "local_immutable" },
			project: { id: "test-project", mapPath: "/Game/Test/Map" },
			requestedBounds: { minX: 0, minY: 0, maxX: 64, maxY: 64 },
			tilePixelSize: 64
		})
	);
	return { planPath, projectRoot };
}

function runWithPort(
	project: { readonly planPath: string; readonly projectRoot: string },
	port: MapTileCapturePortApi,
	levels?: ReadonlyArray<number>,
	onProgress?: (progress: MapCaptureRunProgress) => Effect.Effect<void>,
	repositoryLayer: Layer.Layer<MapCaptureRepository> = MapCaptureRepositoryLive,
	captureBackend?: MapCaptureBackend
) {
	return Effect.flatMap(MapCapture, (capture) =>
		capture.run({
			...(captureBackend === undefined ? undefined : { captureBackend }),
			endpoint: "http://127.0.0.1:30010",
			...(levels === undefined ? undefined : { levels }),
			...(onProgress === undefined ? undefined : { onProgress }),
			planPath: project.planPath,
			projectRoot: project.projectRoot,
			runId: "test-run"
		})
	).pipe(
		Effect.provide(MapCaptureLive),
		Effect.provide(repositoryLayer),
		Effect.provide(mapTileCapturePortLayer(port))
	);
}

describe("map capture orchestration", () => {
	it("validates, hashes, and atomically publishes an exhaustive run", async () => {
		const project = await fixtureProject(1);
		const progress: MapCaptureRunProgress[] = [];
		const port: MapTileCapturePortApi = {
			capture: (request) =>
				Effect.tryPromise(async () => {
					const tile = request.tiles[0]!;
					const stagedPath = resolve(
						project.projectRoot,
						"Saved/UEShed/MapTileStaging/test-run/Z00/R000_C000.png"
					);
					await mkdir(dirname(stagedPath), { recursive: true });
					await writeFile(stagedPath, fakePng(64));
					return {
						actualMapPath: "/Game/Test/Map",
						contract: {
							name: "ue-shed-map-tile-capture" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						correlationId: request.correlationId,
						dirtyState: { after: false, before: false },
						durationMs: 2,
						operationId: request.operationId,
						results: [
							{
								bytes: 24,
								captureDurationMs: 1,
								height: 64,
								key: tile.key,
								stagedPath,
								status: "captured" as const,
								width: 64
							}
						],
						status: "completed" as const,
						tileCounts: { failed: 0, requested: 1, succeeded: 1 }
					};
				})
		};
		const outcome = await Effect.runPromise(
			runWithPort(project, port, undefined, (update) =>
				Effect.sync(() => progress.push(update))
			)
		);
		expect(outcome.published).toBe(true);
		expect(outcome.manifest.state).toBe("complete");
		expect(outcome.manifest.tiles[0]?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(outcome.manifestPath).toBe(
			join(mapCaptureRunsRoot(project.projectRoot, "test-plan"), "test-run", "manifest.json")
		);
		expect(JSON.parse(await readFile(outcome.manifestPath, "utf8"))).toEqual(outcome.manifest);
		expect(progress).toEqual([
			{ failedTiles: 0, phase: "capturing", processedTiles: 0, totalTiles: 1 },
			{ failedTiles: 0, phase: "capturing", processedTiles: 1, totalTiles: 1 },
			{ failedTiles: 0, phase: "publishing", processedTiles: 1, totalTiles: 1 }
		]);
	});

	it("sends complete zoom levels to the experimental viewport backend", async () => {
		const project = await fixtureProject(2);
		const requestedBatches: Array<ReadonlyArray<string>> = [];
		const port: MapTileCapturePortApi = {
			capture: (request) =>
				Effect.tryPromise(async () => {
					requestedBatches.push(request.tiles.map(({ key }) => mapTileKeyId(key)));
					const results = [];
					for (const tile of request.tiles) {
						const relativePath = mapTileRelativePath(tile.key);
						const stagedPath = resolve(
							project.projectRoot,
							"Saved/UEShed/MapTileStaging/test-run",
							...relativePath.split("/")
						);
						await mkdir(dirname(stagedPath), { recursive: true });
						await writeFile(stagedPath, fakePng(64));
						results.push({
							bytes: 24,
							captureDurationMs: 1,
							height: 64,
							key: tile.key,
							stagedPath,
							status: "captured" as const,
							width: 64
						});
					}
					expect(request.captureBackend).toBe("viewport_high_resolution");
					return {
						actualMapPath: "/Game/Test/Map",
						contract: {
							name: "ue-shed-map-tile-capture" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						correlationId: request.correlationId,
						dirtyState: { after: false, before: false },
						durationMs: results.length,
						operationId: request.operationId,
						results,
						status: "completed" as const,
						tileCounts: {
							failed: 0,
							requested: results.length,
							succeeded: results.length
						}
					};
				})
		};

		const outcome = await Effect.runPromise(
			runWithPort(
				project,
				port,
				undefined,
				undefined,
				MapCaptureRepositoryLive,
				"viewport_high_resolution"
			)
		);

		expect(outcome.published).toBe(true);
		expect(outcome.manifest.provenance.producer).toBe(
			"unreal-editor-viewport-high-resolution-experimental"
		);
		expect(requestedBatches).toEqual([["0/0/0"], ["1/0/0", "1/0/1", "1/1/0", "1/1/1"]]);
	});

	it("quarantines a bounded subset instead of publishing it as complete", async () => {
		const project = await fixtureProject(2);
		const port: MapTileCapturePortApi = {
			capture: (request) =>
				Effect.tryPromise(async () => {
					const tile = request.tiles[0]!;
					const stagedPath = resolve(
						project.projectRoot,
						"Saved/UEShed/MapTileStaging/test-run/Z00/R000_C000.png"
					);
					await mkdir(dirname(stagedPath), { recursive: true });
					await writeFile(stagedPath, fakePng(64));
					return {
						actualMapPath: "/Game/Test/Map",
						contract: {
							name: "ue-shed-map-tile-capture" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						correlationId: request.correlationId,
						dirtyState: { after: false, before: false },
						durationMs: 2,
						operationId: request.operationId,
						results: [
							{
								bytes: 24,
								captureDurationMs: 1,
								height: 64,
								key: tile.key,
								stagedPath,
								status: "captured" as const,
								width: 64
							}
						],
						status: "completed" as const,
						tileCounts: { failed: 0, requested: 1, succeeded: 1 }
					};
				})
		};
		const outcome = await Effect.runPromise(runWithPort(project, port, [0]));
		expect(outcome.published).toBe(false);
		expect(outcome.manifest.state).toBe("partial");
		expect(outcome.manifestPath).toBe(
			join(
				mapCaptureAttemptsRoot(project.projectRoot, "test-plan"),
				"test-run",
				"manifest.json"
			)
		);
	});

	it("rejects an editor artifact outside the contained staging root", async () => {
		const project = await fixtureProject(1);
		const port: MapTileCapturePortApi = {
			capture: (request) =>
				Effect.tryPromise(async () => {
					const tile = request.tiles[0]!;
					const stagedPath = resolve(project.projectRoot, "escaped.png");
					await writeFile(stagedPath, fakePng(64));
					return {
						actualMapPath: "/Game/Test/Map",
						contract: {
							name: "ue-shed-map-tile-capture" as const,
							version: { major: 1 as const, minor: 0 as const }
						},
						correlationId: request.correlationId,
						dirtyState: { after: false, before: false },
						durationMs: 1,
						operationId: request.operationId,
						results: [
							{
								bytes: 24,
								captureDurationMs: 1,
								height: 64,
								key: tile.key,
								stagedPath,
								status: "captured" as const,
								width: 64
							}
						],
						status: "completed" as const,
						tileCounts: { failed: 0, requested: 1, succeeded: 1 }
					};
				})
		};
		const outcome = await Effect.runPromise(runWithPort(project, port));
		expect(outcome.published).toBe(false);
		expect(outcome.manifest.failures[0]?.failure.code).toBe("write_failed");
	});

	it("cleans project-local host staging when transport fails", async () => {
		const project = await fixtureProject(1);
		const port: MapTileCapturePortApi = {
			capture: () => Effect.fail(new Error("endpoint unavailable"))
		};
		await expect(Effect.runPromise(runWithPort(project, port))).rejects.toThrow(
			"endpoint unavailable"
		);
		await expect(
			stat(join(mapCaptureRoot(project.projectRoot), ".staging-test-run"))
		).rejects.toThrow();
	});

	effectIt.effect("captures the next batch while the host ingests the previous batch", () =>
		Effect.gen(function* () {
			const project = yield* Effect.promise(() => fixtureProject(4));
			const firstStoreStarted = yield* Deferred.make<void>();
			const releaseFirstStore = yield* Deferred.make<void>();
			const secondCaptureStarted = yield* Deferred.make<void>();
			const requestedKeys: string[] = [];
			let captureCalls = 0;
			let blockFirstStore = true;
			const repositoryLayer = Layer.effect(
				MapCaptureRepository,
				Effect.gen(function* () {
					const delegate = yield* MapCaptureRepository;
					const service: MapCaptureRepositoryApi = {
						...delegate,
						storeTile: (input) => {
							if (!blockFirstStore) return delegate.storeTile(input);
							blockFirstStore = false;
							return Deferred.succeed(firstStoreStarted, undefined).pipe(
								Effect.andThen(Deferred.await(releaseFirstStore)),
								Effect.andThen(delegate.storeTile(input))
							);
						}
					};
					return MapCaptureRepository.of(service);
				})
			).pipe(Layer.provide(MapCaptureRepositoryLive));
			const port: MapTileCapturePortApi = {
				capture: (request) =>
					Effect.gen(function* () {
						captureCalls += 1;
						requestedKeys.push(...request.tiles.map(({ key }) => mapTileKeyId(key)));
						if (captureCalls === 2) {
							yield* Deferred.succeed(secondCaptureStarted, undefined);
						}
						const results = yield* Effect.forEach(request.tiles, (tile) =>
							Effect.tryPromise(async () => {
								const relativePath = mapTileRelativePath(tile.key);
								const stagedPath = resolve(
									project.projectRoot,
									"Saved/UEShed/MapTileStaging/test-run",
									...relativePath.split("/")
								);
								await mkdir(dirname(stagedPath), { recursive: true });
								await writeFile(stagedPath, fakePng(64));
								return {
									bytes: 24,
									captureDurationMs: 1,
									height: 64,
									key: tile.key,
									stagedPath,
									status: "captured" as const,
									width: 64
								};
							})
						);
						return {
							actualMapPath: "/Game/Test/Map",
							contract: {
								name: "ue-shed-map-tile-capture" as const,
								version: { major: 1 as const, minor: 0 as const }
							},
							correlationId: request.correlationId,
							dirtyState: { after: false, before: false },
							durationMs: results.length,
							operationId: request.operationId,
							results,
							status: "completed" as const,
							tileCounts: {
								failed: 0,
								requested: results.length,
								succeeded: results.length
							}
						};
					})
			};
			const runFiber = yield* runWithPort(
				project,
				port,
				undefined,
				undefined,
				repositoryLayer
			).pipe(Effect.forkScoped);
			yield* Deferred.await(firstStoreStarted);
			yield* Deferred.await(secondCaptureStarted).pipe(
				Effect.timeout(Duration.seconds(1)),
				Effect.ensuring(Deferred.succeed(releaseFirstStore, undefined))
			);
			const outcome = yield* Fiber.join(runFiber);
			expect(captureCalls).toBe(2);
			expect(outcome.manifest.tiles).toHaveLength(85);
			expect(outcome.manifest.tiles.map(({ key }) => mapTileKeyId(key))).toEqual(
				requestedKeys
			);
		})
	);
});
