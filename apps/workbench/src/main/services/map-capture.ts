import {
	CameraFeed,
	MapCaptureRepository,
	awaitProvisionedCameraFrame,
	clearProvisionedCameras,
	decodeMapTilePyramidManifest,
	ensureProvisionedCameras,
	inspectMapCapturePlan,
	makeDefaultMapCapturePlan,
	mapCapturePlansRoot,
	mapCaptureRoot,
	runMapCapturePlan,
	savedMapPathToGameMapPath,
	type MapCapturePlan
} from "@ue-shed/cameras";
import { EditorWorldControl } from "@ue-shed/engine-discovery";
import type {
	MapCaptureExecuteIntent,
	MapCaptureExecuteResult,
	MapCaptureActorCatalogResult,
	MapCaptureLivePreviewResult,
	MapCaptureOpenResult,
	MapCaptureProgressEvent,
	MapCaptureSaveIntent,
	MapCaptureSaveResult,
	MapCaptureSelectionResult,
	MapCaptureTileIntent,
	MapCaptureTileResult
} from "@ue-shed/extension-camera-review/map-capture-client";
import { AssetReader } from "@ue-shed/unreal-assets";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { Context, Effect, Layer, Schema } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { WorkbenchWindow } from "../adapters/electron-window.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

const progressEventChannel = "map-capture:progress";
const livePreviewMaximumDimension = 640;
const livePreviewHeight = 360;
const livePreviewFps = 5;

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function failure(cause: unknown, recovery: string) {
	return { message: messageOf(cause), recovery, status: "failed" as const };
}

function isContainedPath(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath !== "" &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	);
}

function previewCameraFrame(bounds: {
	readonly maxX: number;
	readonly maxY: number;
	readonly minX: number;
	readonly minY: number;
}) {
	const xSpan = bounds.maxX - bounds.minX;
	const ySpan = bounds.maxY - bounds.minY;
	const width = livePreviewMaximumDimension;
	const height = livePreviewHeight;
	const renderAspect = width / height;
	return {
		height,
		location: {
			x: (bounds.minX + bounds.maxX) * 0.5,
			y: (bounds.minY + bounds.maxY) * 0.5
		},
		// A -90°/0° top-down camera maps world Y across the image and world X vertically.
		orthoWidth: Math.max(ySpan, xSpan * renderAspect),
		width
	};
}

export interface WorkbenchMapCaptureApi {
	readonly actors: (mapPath: string) => Effect.Effect<MapCaptureActorCatalogResult>;
	readonly capture: (intent: MapCaptureExecuteIntent) => Effect.Effect<MapCaptureExecuteResult>;
	readonly choosePlan: () => Effect.Effect<MapCaptureSelectionResult>;
	readonly newPlan: () => Effect.Effect<MapCaptureSelectionResult>;
	readonly openMap: (plan: MapCapturePlan) => Effect.Effect<MapCaptureOpenResult>;
	readonly preview: (plan: MapCapturePlan) => Effect.Effect<MapCaptureLivePreviewResult>;
	readonly savePlan: (intent: MapCaptureSaveIntent) => Effect.Effect<MapCaptureSaveResult>;
	readonly tile: (intent: MapCaptureTileIntent) => Effect.Effect<MapCaptureTileResult>;
}

export class WorkbenchMapCapture extends Context.Service<
	WorkbenchMapCapture,
	WorkbenchMapCaptureApi
>()("@ue-shed/workbench/WorkbenchMapCapture") {}

export const WorkbenchMapCaptureLive = Layer.effect(
	WorkbenchMapCapture,
	Effect.gen(function* () {
		const assetReader = yield* AssetReader;
		const cameraFeed = yield* CameraFeed;
		const configuration = yield* WorkbenchConfiguration;
		const dialog = yield* ElectronDialog;
		const project = yield* WorkbenchProject;
		const repository = yield* MapCaptureRepository;
		const remoteControl = yield* RemoteControlClient;
		const window = yield* WorkbenchWindow;
		const worldControl = yield* EditorWorldControl;
		const reportProgress = (progress: MapCaptureProgressEvent): Effect.Effect<void> =>
			window.send(progressEventChannel, progress).pipe(Effect.ignore);
		const clearLivePreview = () =>
			clearProvisionedCameras(configuration.remoteControlEndpoint).pipe(
				Effect.provideService(RemoteControlClient, remoteControl),
				Effect.ignore
			);

		const openMap = Effect.fn("Workbench.MapCapture.openMap")(function* (plan: MapCapturePlan) {
			yield* clearLivePreview();
			return yield* worldControl
				.open({
					endpoint: configuration.remoteControlEndpoint,
					operationId: randomUUID(),
					targetMapPath: plan.project.mapPath
				})
				.pipe(
					Effect.map((response) => ({ response, status: "completed" as const })),
					Effect.catch((cause) =>
						Effect.succeed(
							failure(
								cause,
								"Reconnect to an editor with UEShedCoreEditor world control enabled."
							)
						)
					)
				);
		});

		const preview = Effect.fn("Workbench.MapCapture.preview")(function* (plan: MapCapturePlan) {
			return yield* Effect.gen(function* () {
				const inspection = yield* inspectMapCapturePlan(plan);
				const frame = previewCameraFrame(inspection.grid.snappedBounds);
				const bindings = yield* ensureProvisionedCameras(
					configuration.remoteControlEndpoint,
					[
						{
							correlation: {
								mapCapturePlanId: plan.id,
								type: "map_capture_plan" as const
							},
							height: frame.height,
							location: { ...frame.location, z: plan.capture.z },
							projection: {
								orthoWidth: frame.orthoWidth,
								type: "orthographic" as const
							},
							rotation: plan.capture.orientation,
							width: frame.width
						}
					],
					{ expectedMapPath: plan.project.mapPath, previewFps: livePreviewFps }
				).pipe(Effect.provideService(RemoteControlClient, remoteControl));
				const binding = bindings[0];
				if (binding === undefined) {
					return yield* Effect.fail(
						new Error("Unreal did not register the map preview camera.")
					);
				}
				const firstFrame = yield* awaitProvisionedCameraFrame({
					cameraIndex: binding.index,
					expectedCameraId: binding.cameraId,
					latestFrames: cameraFeed.latestFrames,
					timeout: "3 seconds"
				});
				return {
					bytes: firstFrame.pixels,
					cameraId: binding.cameraId,
					cameraIndex: binding.index,
					height: firstFrame.height,
					previewContext: binding.previewContext,
					status: "ready" as const,
					width: firstFrame.width
				};
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Open the target map in an editor launched With UE Shed, then retry the live preview."
						)
					)
				)
			);
		});

		const readySelection = Effect.fn("Workbench.MapCapture.readySelection")(function* (args: {
			readonly plan: MapCapturePlan;
			readonly planPath?: string;
			readonly source: "new" | "opened";
		}) {
			const selectedProject = yield* project.savedProject();
			const inspection = yield* inspectMapCapturePlan(args.plan);
			return {
				grid: {
					levels: inspection.grid.levels,
					snappedBounds: inspection.grid.snappedBounds
				},
				maps: selectedProject.maps,
				plan: args.plan,
				...(args.planPath === undefined ? undefined : { planPath: args.planPath }),
				projectRoot: selectedProject.projectRoot,
				source: args.source,
				status: "ready" as const,
				tileCount: inspection.tileCount
			};
		});

		const actors = Effect.fn("Workbench.MapCapture.actors")(function* (mapPath: string) {
			return yield* Effect.gen(function* () {
				const selectedProject = yield* project.savedProject();
				const savedMap = selectedProject.maps.find(
					(candidate) => savedMapPathToGameMapPath(candidate.mapPath) === mapPath
				);
				if (savedMap === undefined) {
					return failure(
						`Saved map ${mapPath} is not part of the selected project inventory.`,
						"Choose a saved map from this project, then capture it again."
					);
				}
				const world = yield* assetReader.readSavedWorld({
					concurrency: 8,
					mapPath: savedMap.mapPath,
					projectRoot: selectedProject.projectRoot
				});
				return { status: "ready" as const, world };
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Verify the saved map packages and selected project, then retry the actor overlay."
						)
					)
				)
			);
		});

		const choosePlan = Effect.fn("Workbench.MapCapture.choosePlan")(function* () {
			return yield* Effect.gen(function* () {
				const choice = yield* dialog.chooseFile({
					filters: [{ extensions: ["json"], name: "Map Capture Plan" }],
					title: "Choose a UE Shed Map Capture Plan"
				});
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				const plan = yield* repository.loadPlan(choice.path);
				return yield* readySelection({ plan, planPath: choice.path, source: "opened" });
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Choose a valid plan and a Workbench project containing one .uproject file."
						)
					)
				)
			);
		});

		const newPlan = Effect.fn("Workbench.MapCapture.newPlan")(function* () {
			return yield* Effect.gen(function* () {
				const [selectedProject, savedProject] = yield* Effect.all([
					project.selectedProject(),
					project.savedProject()
				]);
				const mapPath = savedProject.maps
					.map((map) => savedMapPathToGameMapPath(map.mapPath))
					.find((candidate) => candidate !== undefined);
				const plan = makeDefaultMapCapturePlan({
					...(mapPath === undefined ? undefined : { mapPath }),
					projectId: selectedProject.projectName
				});
				return yield* readySelection({ plan, source: "new" });
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Choose a Workbench project and let its saved-map inventory finish."
						)
					)
				)
			);
		});

		const savePlan = Effect.fn("Workbench.MapCapture.savePlan")(function* (
			intent: MapCaptureSaveIntent
		) {
			return yield* Effect.gen(function* () {
				const selectedProject = yield* project.selectedProject();
				const defaultPath = join(
					mapCapturePlansRoot(selectedProject.projectRoot),
					`${intent.plan.id}.json`
				);
				let planPath = intent.planPath ?? defaultPath;
				if (intent.saveAs) {
					const choice = yield* dialog.chooseSaveFile({
						defaultPath: intent.planPath ?? defaultPath,
						filters: [{ extensions: ["json"], name: "Map Capture Plan" }],
						title: "Save UE Shed Map Capture Plan"
					});
					if (choice.status === "cancelled") return { status: "cancelled" as const };
					planPath = choice.path.toLocaleLowerCase().endsWith(".json")
						? choice.path
						: `${choice.path}.json`;
				}
				yield* repository.savePlan(planPath, intent.plan);
				return { plan: intent.plan, planPath, status: "saved" as const };
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(cause, "Choose a writable plan location and retry Save or Save As.")
					)
				)
			);
		});

		const tile = Effect.fn("Workbench.MapCapture.tile")(function* (
			intent: MapCaptureTileIntent
		) {
			return yield* Effect.gen(function* () {
				const selectedProject = yield* project.selectedProject();
				const captureRoot = mapCaptureRoot(selectedProject.projectRoot);
				const manifestPath = resolve(intent.manifestPath);
				if (
					basename(manifestPath) !== "manifest.json" ||
					!isContainedPath(captureRoot, manifestPath)
				) {
					return yield* Effect.fail(
						new Error("Capture proof manifest is outside the selected project.")
					);
				}
				const manifest = yield* Effect.tryPromise({
					try: async () =>
						Schema.decodeUnknownSync(Schema.Json)(
							JSON.parse(await readFile(manifestPath, "utf8"))
						),
					catch: (cause) => cause
				}).pipe(Effect.flatMap(decodeMapTilePyramidManifest));
				const artifact = manifest.tiles.find(
					(candidate) => candidate.relativePath === intent.relativePath
				);
				if (artifact === undefined) {
					return yield* Effect.fail(
						new Error("Capture proof tile is not listed by this manifest.")
					);
				}
				const runRoot = dirname(manifestPath);
				const tilePath = resolve(runRoot, ...artifact.relativePath.split("/"));
				if (!isContainedPath(runRoot, tilePath)) {
					return yield* Effect.fail(
						new Error("Capture proof tile resolves outside its immutable run.")
					);
				}
				const bytes = yield* Effect.tryPromise({
					try: () => readFile(tilePath),
					catch: (cause) => cause
				});
				const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
				if (bytes.byteLength !== artifact.bytes || hash !== artifact.hash) {
					return yield* Effect.fail(
						new Error("Capture proof tile no longer matches its immutable manifest.")
					);
				}
				return { bytes: new Uint8Array(bytes), status: "ready" as const };
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Inspect or recapture this run; Workbench only loads manifest-owned PNG tiles."
						)
					)
				)
			);
		});

		const capture = Effect.fn("Workbench.MapCapture.capture")(function* (
			intent: MapCaptureExecuteIntent
		) {
			return yield* Effect.gen(function* () {
				yield* clearLivePreview();
				const selectedProject = yield* project.selectedProject();
				if (intent.openMap) {
					const inspection = yield* inspectMapCapturePlan(intent.plan);
					yield* reportProgress({
						failedTiles: 0,
						operationId: intent.operationId,
						phase: "opening_map",
						processedTiles: 0,
						totalTiles: inspection.tileCount
					});
					const opened = yield* openMap(intent.plan);
					if (opened.status === "failed") return opened;
					if (opened.response.outcome === "rejected") {
						return failure(opened.response.message, opened.response.recovery);
					}
				}
				const outcome = yield* runMapCapturePlan({
					captureBackend: intent.captureBackend,
					endpoint: configuration.remoteControlEndpoint,
					onProgress: (progress) =>
						reportProgress({ ...progress, operationId: intent.operationId }),
					plan: intent.plan,
					projectRoot: selectedProject.projectRoot
				});
				return {
					...outcome,
					status: "completed" as const
				};
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							cause,
							"Inspect the selected plan, editor map, capture attempt, and Remote Control session."
						)
					)
				)
			);
		});

		return WorkbenchMapCapture.of({
			actors,
			capture,
			choosePlan,
			newPlan,
			openMap,
			preview,
			savePlan,
			tile
		});
	})
);

export function makeWorkbenchMapCaptureTestLayer(
	service: WorkbenchMapCaptureApi
): Layer.Layer<WorkbenchMapCapture> {
	return Layer.succeed(WorkbenchMapCapture, WorkbenchMapCapture.of(service));
}
