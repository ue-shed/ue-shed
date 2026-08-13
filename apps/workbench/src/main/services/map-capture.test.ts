import {
	MapCaptureRepositoryLive,
	makeCameraFeedTestLayer,
	mapCapturePlansRoot
} from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { makeEditorWorldControlTestLayer } from "@ue-shed/engine-discovery";
import { Effect, Layer } from "effect";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeWorkbenchWindowTestLayer } from "../adapters/electron-window.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationShape
} from "../workbench-config.js";
import { WorkbenchMapCapture, WorkbenchMapCaptureLive } from "./map-capture.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const configuration: WorkbenchConfigurationShape = {
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30010",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" },
	unrealEngineRoot: { status: "not_configured" }
};

function mapCaptureLayer(
	projectRoot: string,
	options: {
		readonly cameraFeed?: ReturnType<typeof makeCameraFeedTestLayer>;
		readonly remoteControl?: ReturnType<typeof makeRemoteControlClientTestLayer>;
	} = {}
) {
	const project = makeWorkbenchProjectTestLayer({
		choose: () => Effect.die("not used"),
		current: () => Effect.die("not used"),
		inputAtlas: () => Effect.die("not used"),
		savedProject: () =>
			Effect.succeed({
				maps: [{ label: "City", mapPath: "Content/Maps/L_City.umap" }],
				projectRoot
			}),
		savedTables: () => Effect.die("not used"),
		selectedProject: () => Effect.succeed({ projectName: "City Project", projectRoot })
	});
	const dialog = Layer.succeed(
		ElectronDialog,
		ElectronDialog.of({
			chooseDirectory: () => Effect.die("not used"),
			chooseFile: () => Effect.die("not used"),
			chooseFiles: () => Effect.die("not used"),
			chooseSaveFile: () => Effect.die("not used")
		})
	);
	const worldControl = makeEditorWorldControlTestLayer({ open: () => Effect.die("not used") });
	return WorkbenchMapCaptureLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				MapCaptureRepositoryLive,
				options.cameraFeed ?? makeCameraFeedTestLayer(),
				options.remoteControl ??
					makeRemoteControlClientTestLayer(() => Effect.die("not used")),
				project,
				dialog,
				makeWorkbenchWindowTestLayer(),
				worldControl,
				makeWorkbenchConfigurationLayer(configuration)
			)
		)
	);
}

it.effect(
	"authors a default plan from project maps and saves it through the public repository",
	() =>
		Effect.gen(function* () {
			const projectRoot = yield* Effect.promise(() =>
				mkdtemp(join(tmpdir(), "ue-shed-map-author-"))
			);
			roots.push(projectRoot);
			const result = yield* Effect.gen(function* () {
				const service = yield* WorkbenchMapCapture;
				const created = yield* service.newPlan();
				if (created.status !== "ready") return created;
				return yield* service.savePlan({ plan: created.plan, saveAs: false });
			}).pipe(Effect.provide(mapCaptureLayer(projectRoot)));

			expect(result.status).toBe("saved");
			if (result.status !== "saved") return;
			expect(result.plan.project).toEqual({
				id: "City-Project",
				mapPath: "/Game/Maps/L_City"
			});
			expect(result.planPath).toBe(
				join(mapCapturePlansRoot(projectRoot), "map-overview.json")
			);
			expect(
				JSON.parse(yield* Effect.promise(() => readFile(result.planPath, "utf8")))
			).toEqual(result.plan);
		})
);

it.effect("provisions the snapped bounds as one orthographic live camera", () =>
	Effect.gen(function* () {
		const projectRoot = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-map-preview-"))
		);
		roots.push(projectRoot);
		let provisionRequest: unknown;
		const remoteControl = makeRemoteControlClientTestLayer((request) => {
			if (request.functionName !== "EnsureProvisionedCameras") return Effect.die("not used");
			provisionRequest = JSON.parse(String(request.parameters.RequestJson));
			return Effect.succeed({
				cameras: [
					{
						cameraId: "map-camera",
						correlation: {
							mapCapturePlanId: "map-overview",
							type: "map_capture_plan"
						},
						displayName: "map-overview",
						height: 360,
						index: 0,
						width: 640
					}
				],
				schemaVersion: 3,
				worldContext: "editor"
			});
		});
		const cameraFeed = makeCameraFeedTestLayer({
			latestFrames: Effect.succeed(
				new Map([
					[
						0,
						{
							cameraId: "map-camera",
							cameraIndex: 0,
							captureMonotonicMs: 1,
							height: 360,
							pixels: new Uint8Array([1, 2, 3, 4]),
							producerId: "producer",
							readbackDrops: 0,
							readbackLatencyMs: 1,
							receivedMonotonicMs: 2,
							sequence: 1n,
							sessionId: "session",
							transportReplacements: 0,
							width: 640,
							worldSeconds: 1
						}
					]
				])
			)
		});
		const result = yield* Effect.gen(function* () {
			const service = yield* WorkbenchMapCapture;
			const created = yield* service.newPlan();
			if (created.status !== "ready") return created;
			return yield* service.preview(created.plan);
		}).pipe(Effect.provide(mapCaptureLayer(projectRoot, { cameraFeed, remoteControl })));

		expect(result.status).toBe("ready");
		expect(provisionRequest).toMatchObject({
			expectedMapPath: "/Game/Maps/L_City",
			schemaVersion: 3,
			cameras: [
				{
					correlation: { mapCapturePlanId: "map-overview", type: "map_capture_plan" },
					height: 360,
					location: { x: 0, y: 0, z: 5000 },
					projection: { type: "orthographic" },
					rotation: { pitch: -90, roll: 0, yaw: 0 },
					width: 640
				}
			]
		});
		expect(
			(
				provisionRequest as {
					readonly cameras: ReadonlyArray<{
						readonly projection: { readonly orthoWidth: number };
					}>;
				}
			).cameras[0]?.projection.orthoWidth
		).toBeCloseTo((4096 * 16) / 9);
	})
);
