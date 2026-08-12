import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	MapCapture,
	MapCaptureLive,
	mapTileCapturePortLayer,
	type MapTileCapturePortShape
} from "./map-tile-capture.js";
import {
	MapCaptureRepositoryLive,
	mapCaptureAttemptsRoot,
	mapCaptureRunsRoot
} from "./map-tile-repository.js";

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
	const planPath = join(projectRoot, "map-capture-plan.json");
	await writeFile(
		planPath,
		JSON.stringify({
			capture: {
				dataLayers: { mode: "unchanged" },
				orientation: { pitch: -90, roll: 0, yaw: 0 },
				render: { lodPolicy: "natural", profile: "full_fidelity" },
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
	port: MapTileCapturePortShape,
	levels?: ReadonlyArray<number>
) {
	return Effect.flatMap(MapCapture, (capture) =>
		capture.run({
			endpoint: "http://127.0.0.1:30010",
			...(levels === undefined ? {} : { levels }),
			planPath: project.planPath,
			projectRoot: project.projectRoot,
			runId: "test-run"
		})
	).pipe(
		Effect.provide(MapCaptureLive),
		Effect.provide(MapCaptureRepositoryLive),
		Effect.provide(mapTileCapturePortLayer(port))
	);
}

describe("map capture orchestration", () => {
	it("validates, hashes, and atomically publishes an exhaustive run", async () => {
		const project = await fixtureProject(1);
		const port: MapTileCapturePortShape = {
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
		const outcome = await Effect.runPromise(runWithPort(project, port));
		expect(outcome.published).toBe(true);
		expect(outcome.manifest.state).toBe("complete");
		expect(outcome.manifest.tiles[0]?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(outcome.manifestPath).toBe(
			join(mapCaptureRunsRoot(project.projectRoot, "test-plan"), "test-run", "manifest.json")
		);
		expect(JSON.parse(await readFile(outcome.manifestPath, "utf8"))).toEqual(outcome.manifest);
	});

	it("quarantines a bounded subset instead of publishing it as complete", async () => {
		const project = await fixtureProject(2);
		const port: MapTileCapturePortShape = {
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
});
