import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
	callerOwnedMapCaptureDestination,
	mapCaptureAttemptsRoot,
	mapCaptureRoot,
	mapCaptureRunsRoot,
	projectLocalMapCaptureDestination,
	type MapCaptureDestination
} from "./map-tile-repository.js";
import { mapTileKeyId, mapTileRelativePath } from "./map-tile-pyramid.js";
import { MapCapturePlanId, MapCaptureRunId, type MapCaptureBackend } from "./map-tile-schema.js";

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
					lodPolicy: "natural",
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
	captureBackend?: MapCaptureBackend,
	destination?: MapCaptureDestination
) {
	return Effect.flatMap(MapCapture, (capture) =>
		capture.run({
			...(captureBackend === undefined ? undefined : { captureBackend }),
			...(destination === undefined ? undefined : { destination }),
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

function successfulPort(args: {
	readonly beforeCapture?: () => Effect.Effect<void>;
	readonly projectRoot: string;
}): MapTileCapturePortApi {
	return {
		capture: (request) =>
			Effect.gen(function* () {
				if (args.beforeCapture !== undefined) yield* args.beforeCapture();
				const results = yield* Effect.forEach(request.tiles, (tile) =>
					Effect.promise(async () => {
						const relativePath = mapTileRelativePath(tile.key);
						const stagedPath = resolve(
							args.projectRoot,
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
}

describe("map capture orchestration", () => {
	it("validates, hashes, and atomically publishes an exhaustive run", async () => {
		const project = await fixtureProject(1);
		const progress: MapCaptureRunProgress[] = [];
		const released: string[] = [];
		const port: MapTileCapturePortApi = {
			release: (runId) =>
				Effect.sync(() => {
					released.push(runId);
				}),
			capture: (request) =>
				Effect.tryPromise(async () => {
					expect(request.captureBackend).toBe("lit_camera_tiles");
					expect(request.overviewBounds).toEqual({
						minX: 0,
						minY: 0,
						maxX: 64,
						maxY: 64
					});
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
		expect(released).toEqual(["test-run"]);
		expect(outcome.manifest.provenance.producer).toBe("unreal-editor-lit-camera-tiles");
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

	it("publishes an exhaustive run beneath a caller-owned destination", async () => {
		const project = await fixtureProject(1);
		const destinationRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-caller-runs-"));
		temporaryRoots.push(destinationRoot);
		const destination = callerOwnedMapCaptureDestination(destinationRoot);

		const outcome = await Effect.runPromise(
			runWithPort(
				project,
				successfulPort({ projectRoot: project.projectRoot }),
				undefined,
				undefined,
				MapCaptureRepositoryLive,
				undefined,
				destination
			)
		);

		expect(outcome.published).toBe(true);
		expect(outcome.manifestPath).toBe(
			join(destinationRoot, "runs", "test-plan", "test-run", "manifest.json")
		);
		await expect(access(outcome.manifestPath)).resolves.toBeUndefined();
		await expect(
			access(join(mapCaptureRunsRoot(project.projectRoot, "test-plan"), "test-run"))
		).rejects.toThrow();
	});

	it("rejects an invalid caller-owned destination before invoking Unreal", async () => {
		const project = await fixtureProject(1);
		let captureCalls = 0;

		await expect(
			Effect.runPromise(
				runWithPort(
					project,
					successfulPort({
						beforeCapture: () => Effect.sync(() => void (captureCalls += 1)),
						projectRoot: project.projectRoot
					}),
					undefined,
					undefined,
					MapCaptureRepositoryLive,
					undefined,
					callerOwnedMapCaptureDestination("relative-map-runs")
				)
			)
		).rejects.toMatchObject({ operation: "prepare" });
		expect(captureCalls).toBe(0);
	});

	it("rejects a project-local destination that escapes through a junction before writing", async () => {
		const project = await fixtureProject(1);
		const outsideRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-root-escape-"));
		temporaryRoots.push(outsideRoot);
		await symlink(outsideRoot, join(project.projectRoot, ".ue-shed"), "junction");
		let captureCalls = 0;

		await expect(
			Effect.runPromise(
				runWithPort(
					project,
					successfulPort({
						beforeCapture: () => Effect.sync(() => void (captureCalls += 1)),
						projectRoot: project.projectRoot
					})
				)
			)
		).rejects.toMatchObject({ operation: "prepare" });
		expect(captureCalls).toBe(0);
		await expect(access(join(outsideRoot, "map-capture"))).rejects.toThrow();
	});

	it("rejects a caller-owned replay before a second Unreal capture", async () => {
		const project = await fixtureProject(1);
		const destinationRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-replay-"));
		temporaryRoots.push(destinationRoot);
		const destination = callerOwnedMapCaptureDestination(destinationRoot);
		let captureCalls = 0;
		const port = successfulPort({
			beforeCapture: () => Effect.sync(() => void (captureCalls += 1)),
			projectRoot: project.projectRoot
		});
		const run = () =>
			runWithPort(
				project,
				port,
				undefined,
				undefined,
				MapCaptureRepositoryLive,
				undefined,
				destination
			);
		await Effect.runPromise(run());
		await expect(Effect.runPromise(run())).rejects.toMatchObject({ operation: "prepare" });
		expect(captureCalls).toBe(1);
		await expect(access(join(destinationRoot, ".staging-test-run"))).rejects.toThrow();
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

	it("retains partial and cancelled manifests beneath a caller-owned attempts tree", async () => {
		const project = await fixtureProject(2);
		const destinationRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-caller-attempts-"));
		temporaryRoots.push(destinationRoot);
		const destination = callerOwnedMapCaptureDestination(destinationRoot);
		const partial = await Effect.runPromise(
			runWithPort(
				project,
				successfulPort({ projectRoot: project.projectRoot }),
				[0],
				undefined,
				MapCaptureRepositoryLive,
				undefined,
				destination
			)
		);
		expect(partial.manifest.state).toBe("partial");
		expect(partial.manifestPath).toBe(
			join(destinationRoot, "attempts", "test-plan", "test-run", "manifest.json")
		);

		const cancelledRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-caller-cancelled-"));
		temporaryRoots.push(cancelledRoot);
		const completedPort = successfulPort({ projectRoot: project.projectRoot });
		const cancelledPort: MapTileCapturePortApi = {
			capture: (request) =>
				completedPort.capture(request).pipe(
					Effect.map((response) => ({
						...response,
						failure: {
							code: "cancelled" as const,
							message: "Fixture cancellation",
							recovery: "Resume with a new run identity.",
							retrySafe: true
						},
						status: "cancelled" as const
					}))
				)
		};
		const cancelled = await Effect.runPromise(
			runWithPort(
				project,
				cancelledPort,
				undefined,
				undefined,
				MapCaptureRepositoryLive,
				undefined,
				callerOwnedMapCaptureDestination(cancelledRoot)
			)
		);
		expect(cancelled.manifest.state).toBe("cancelled");
		expect(cancelled.published).toBe(false);
		await expect(access(cancelled.manifestPath)).resolves.toBeUndefined();
	});

	it("prevents traversal and junction escape inside a caller-owned Map Capture attempt", async () => {
		const destinationRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-contained-"));
		const outsideRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-outside-"));
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-source-project-"));
		temporaryRoots.push(destinationRoot, outsideRoot, projectRoot);
		const destination = callerOwnedMapCaptureDestination(destinationRoot);
		const attempt = await Effect.runPromise(
			destination.prepare({
				planId: MapCapturePlanId.make("test-plan"),
				runId: MapCaptureRunId.make("test-run")
			})
		);
		const stagingRoot = join(destinationRoot, ".staging-test-run");
		await symlink(outsideRoot, join(stagingRoot, "Z00"), "junction");
		const sourceRoot = join(projectRoot, "Saved", "UEShed", "MapTileStaging");
		const sourcePath = join(sourceRoot, "pure.png");
		await mkdir(sourceRoot, { recursive: true });
		await writeFile(sourcePath, fakePng(64));
		await expect(
			Effect.runPromise(
				attempt.storeTile({
					relativePath: "../escape.png",
					sourceAuthorizationRoot: projectRoot,
					sourcePath,
					sourceRoot
				})
			)
		).rejects.toMatchObject({ operation: "store_tile" });
		await expect(
			Effect.runPromise(
				attempt.storeTile({
					relativePath: "Z00/new/R000_C000.png",
					sourceAuthorizationRoot: projectRoot,
					sourcePath,
					sourceRoot
				})
			)
		).rejects.toMatchObject({ operation: "store_tile" });
		await expect(access(join(outsideRoot, "new"))).rejects.toThrow();
		await Effect.runPromise(attempt.discard());
	});

	it("cleans a caller-owned attempt when host capture is interrupted", async () => {
		const project = await fixtureProject(1);
		const destinationRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-interrupted-"));
		temporaryRoots.push(destinationRoot);
		const captureStarted = await Effect.runPromise(Deferred.make<void>());
		const neverCapture = await Effect.runPromise(Deferred.make<void>());
		const released: string[] = [];
		const port = {
			...successfulPort({
				beforeCapture: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(captureStarted, undefined);
						yield* Deferred.await(neverCapture);
					}),
				projectRoot: project.projectRoot
			}),
			release: (runId: string) =>
				Effect.sync(() => {
					released.push(runId);
				})
		};
		const run = runWithPort(
			project,
			port,
			undefined,
			undefined,
			MapCaptureRepositoryLive,
			undefined,
			callerOwnedMapCaptureDestination(destinationRoot)
		);
		const fiber = Effect.runFork(run);
		await Effect.runPromise(Deferred.await(captureStarted));
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(released).toEqual(["test-run"]);
		await expect(access(join(destinationRoot, ".staging-test-run"))).rejects.toThrow();
		await expect(
			access(join(destinationRoot, "runs", "test-plan", "test-run"))
		).rejects.toThrow();
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
			const baseDestination = projectLocalMapCaptureDestination(project.projectRoot);
			const destination: MapCaptureDestination = {
				...baseDestination,
				prepare: (input) =>
					baseDestination.prepare(input).pipe(
						Effect.map((attempt) => ({
							...attempt,
							storeTile: (tile) => {
								if (!blockFirstStore) return attempt.storeTile(tile);
								blockFirstStore = false;
								return Deferred.succeed(firstStoreStarted, undefined).pipe(
									Effect.andThen(Deferred.await(releaseFirstStore)),
									Effect.andThen(attempt.storeTile(tile))
								);
							}
						}))
					)
			};
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
				MapCaptureRepositoryLive,
				undefined,
				destination
			).pipe(Effect.forkScoped);
			yield* Deferred.await(firstStoreStarted);
			yield* Deferred.await(secondCaptureStarted).pipe(
				Effect.timeout(Duration.seconds(1)),
				Effect.ensuring(Deferred.succeed(releaseFirstStore, undefined))
			);
			const outcome = yield* Fiber.join(runFiber);
			expect(captureCalls).toBe(22);
			expect(outcome.manifest.tiles).toHaveLength(85);
			expect(outcome.manifest.tiles.map(({ key }) => mapTileKeyId(key))).toEqual(
				requestedKeys
			);
		})
	);
});
