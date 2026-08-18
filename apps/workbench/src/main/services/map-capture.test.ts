import {
	MapCaptureRepositoryLive,
	decodeMapTilePyramidManifest,
	makeCameraFeedTestLayer,
	mapCapturePlansRoot,
	mapCaptureRunsRoot
} from "@ue-shed/cameras";
import { it } from "@effect/vitest";
import { makeEditorWorldControlTestLayer } from "@ue-shed/engine";
import { Effect, Layer, Schema } from "effect";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { makeAssetReaderTestLayer } from "@ue-shed/unreal-assets";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect } from "vitest";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { makeWorkbenchWindowTestLayer } from "../adapters/electron-window.js";
import {
	makeWorkbenchConfigurationLayer,
	type WorkbenchConfigurationApi
} from "../workbench-config.js";
import { WorkbenchMapCapture, WorkbenchMapCaptureLive } from "./map-capture.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const configuration: WorkbenchConfigurationApi = {
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
		readonly assetReader?: ReturnType<typeof makeAssetReaderTestLayer>;
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
	const assetReader =
		options.assetReader ??
		makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("not used"),
			discoverTables: () => Effect.die("not used"),
			readAsset: () => Effect.die("not used"),
			readTable: () => Effect.die("not used"),
			source: () => Effect.succeed("path")
		});
	return WorkbenchMapCaptureLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				MapCaptureRepositoryLive,
				assetReader,
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

it.effect("does not inspect published runs while creating a plan", () =>
	Effect.gen(function* () {
		const projectRoot = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-map-author-legacy-run-"))
		);
		roots.push(projectRoot);
		const legacyRunRoot = join(mapCaptureRunsRoot(projectRoot, "map-overview"), "legacy-run");
		yield* Effect.promise(() => mkdir(legacyRunRoot, { recursive: true }));
		yield* Effect.promise(() =>
			writeFile(join(legacyRunRoot, "manifest.json"), "not valid JSON", "utf8")
		);

		const result = yield* Effect.gen(function* () {
			const service = yield* WorkbenchMapCapture;
			return yield* service.newPlan();
		}).pipe(Effect.provide(mapCaptureLayer(projectRoot)));

		expect(result.status).toBe("ready");
	})
);

it.effect("loads saved actors for the capture map through the shared asset reader", () =>
	Effect.gen(function* () {
		const projectRoot = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-map-actors-"))
		);
		roots.push(projectRoot);
		let readOptions: unknown;
		const world = {
			authority: { kind: "project_files" as const, mapPackage: "Content/Maps/L_City.umap" },
			completeness: "complete" as const,
			contract: {
				name: "unreal-saved-world" as const,
				version: { major: 1 as const, minor: 0 }
			},
			diagnostics: [],
			mapPath: "Content/Maps/L_City.umap",
			sourceKind: "level" as const,
			actors: [
				{
					actorPath: "/Game/Maps/L_City.L_City:PersistentLevel.Center",
					classPath: "/Script/Engine.StaticMeshActor",
					label: "Center",
					packageName: "/Game/Maps/L_City",
					position: { location: { x: 10, y: 20, z: 30 }, status: "resolved" as const }
				}
			],
			summary: {
				failedPackages: 0,
				partialPackages: 0,
				resolvedActors: 1,
				scannedPackages: 1
			}
		};
		const assetReader = makeAssetReaderTestLayer({
			discoverAssets: () => Effect.die("not used"),
			discoverTables: () => Effect.die("not used"),
			readAsset: () => Effect.die("not used"),
			readSavedWorld: (options) =>
				Effect.sync(() => {
					readOptions = options;
					return world;
				}),
			readTable: () => Effect.die("not used"),
			source: () => Effect.succeed("path")
		});
		const result = yield* Effect.gen(function* () {
			const service = yield* WorkbenchMapCapture;
			return yield* service.actors("/Game/Maps/L_City");
		}).pipe(Effect.provide(mapCaptureLayer(projectRoot, { assetReader })));

		expect(result).toEqual({ status: "ready", world });
		expect(readOptions).toEqual({
			concurrency: 8,
			mapPath: "Content/Maps/L_City.umap",
			projectRoot
		});
	})
);

it.effect("loads only manifest-owned capture proof tiles and verifies their hash", () =>
	Effect.gen(function* () {
		const projectRoot = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-map-proof-"))
		);
		roots.push(projectRoot);
		const fixture = yield* Effect.tryPromise({
			try: async () =>
				Schema.decodeUnknownSync(Schema.Json)(
					JSON.parse(
						await readFile(
							join(
								process.cwd(),
								"packages/protocol/contracts/cameras/map-tile/v1/fixtures/manifest-valid.json"
							),
							"utf8"
						)
					)
				),
			catch: (cause) => cause
		}).pipe(Effect.flatMap(decodeMapTilePyramidManifest));
		const fixtureArtifact = fixture.tiles[0]!;
		const tileBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const artifact = {
			...fixtureArtifact,
			bytes: tileBytes.byteLength,
			hash: `sha256:${createHash("sha256").update(tileBytes).digest("hex")}`
		};
		const manifest = { ...fixture, tiles: [artifact, ...fixture.tiles.slice(1)] };
		const runRoot = join(mapCaptureRunsRoot(projectRoot, manifest.planId), manifest.runId);
		const manifestPath = join(runRoot, "manifest.json");
		const tilePath = join(runRoot, ...artifact.relativePath.split("/"));
		yield* Effect.promise(() => mkdir(dirname(tilePath), { recursive: true }));
		yield* Effect.promise(() => writeFile(manifestPath, JSON.stringify(manifest), "utf8"));
		yield* Effect.promise(() => writeFile(tilePath, tileBytes));

		const result = yield* Effect.gen(function* () {
			const service = yield* WorkbenchMapCapture;
			return yield* service.tile({ manifestPath, relativePath: artifact.relativePath });
		}).pipe(Effect.provide(mapCaptureLayer(projectRoot)));

		expect(result).toEqual({ bytes: tileBytes, status: "ready" });

		yield* Effect.promise(() => writeFile(tilePath, new Uint8Array([0])));
		const tampered = yield* Effect.gen(function* () {
			const service = yield* WorkbenchMapCapture;
			return yield* service.tile({ manifestPath, relativePath: artifact.relativePath });
		}).pipe(Effect.provide(mapCaptureLayer(projectRoot)));
		expect(tampered.status).toBe("failed");
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
			// SAFETY: toMatchObject above verified the provision request's camera projection structure.
			(
				provisionRequest as {
					readonly cameras: ReadonlyArray<{
						readonly projection: { readonly orthoWidth: number };
					}>;
				}
			).cameras[0]?.projection.orthoWidth
		).toBeCloseTo((2048 * 16) / 9);
	})
);
