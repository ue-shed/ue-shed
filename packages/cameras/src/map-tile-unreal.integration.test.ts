import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { runMapCapture } from "./map-tile-capture.js";
import { mapCaptureAttemptsRoot, mapCaptureRunsRoot } from "./map-tile-repository.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = join(repositoryRoot, "fixtures", "unreal-project");
const cleanupPaths: string[] = [];

afterEach(async () => {
	await Promise.all(
		cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

describe.skipIf(endpoint === undefined)("map tile capture against Unreal", () => {
	it("captures three aligned orthographic levels without publishing partial evidence", async () => {
		const runId = randomUUID();
		const planId = `fixture-map-${runId}`;
		const planRoot = await mkdtemp(join(tmpdir(), "ue-shed-map-plan-"));
		const planPath = join(planRoot, "plan.json");
		cleanupPaths.push(planRoot);
		cleanupPaths.push(join(mapCaptureRunsRoot(projectRoot, planId), runId));
		cleanupPaths.push(join(mapCaptureAttemptsRoot(projectRoot, planId), runId));
		cleanupPaths.push(join(projectRoot, "Saved", "UEShed", "MapTileStaging", runId));
		await writeFile(
			planPath,
			JSON.stringify({
				capture: {
					dataLayers: { mode: "unchanged" },
					orientation: { pitch: -90, roll: 0, yaw: 0 },
					render: { lodPolicy: "natural", profile: "full_fidelity" },
					z: 5000
				},
				contract: {
					name: "ue-shed-map-capture-plan",
					version: { major: 1, minor: 0 }
				},
				gutterPixels: 2,
				id: planId,
				levels: { coarsestUnitsPerPixel: 16, count: 3 },
				output: { imageFormat: "png", publication: "local_immutable" },
				project: {
					id: "ue-shed-fixture",
					mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
				},
				requestedBounds: { minX: -512, minY: -512, maxX: 512, maxY: 512 },
				tilePixelSize: 64
			})
		);

		const outcome = await Effect.runPromise(
			runMapCapture({ endpoint: endpoint!, planPath, projectRoot, runId })
		);
		expect(outcome.published).toBe(true);
		expect(outcome.manifest.state).toBe("complete");
		expect(outcome.manifest.levels).toHaveLength(3);
		expect(outcome.manifest.tiles).toHaveLength(21);
		expect(outcome.manifest.failures).toEqual([]);
		expect(
			outcome.manifest.tiles.every((tile) => tile.width === 64 && tile.height === 64)
		).toBe(true);
	}, 120_000);
});
