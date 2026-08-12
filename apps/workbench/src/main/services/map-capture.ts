import {
	MapCaptureRepository,
	inspectMapCapturePlan,
	makeDefaultMapCapturePlan,
	mapCapturePlansRoot,
	runMapCapturePlan,
	savedMapPathToGameMapPath,
	type MapCapturePlan,
	type MapTilePyramidManifest
} from "@ue-shed/cameras";
import { EditorWorldControl } from "@ue-shed/engine-discovery";
import type {
	MapCaptureExecuteIntent,
	MapCaptureExecuteResult,
	MapCaptureOpenResult,
	MapCaptureSaveIntent,
	MapCaptureSaveResult,
	MapCaptureSelectionResult
} from "@ue-shed/extension-camera-review/map-capture-client";
import { Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

const previewTileLimit = 128;
const previewByteLimit = 16 * 1024 * 1024;

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function failure(cause: unknown, recovery: string) {
	return { message: messageOf(cause), recovery, status: "failed" as const };
}

function previewTiles(args: {
	readonly manifest: MapTilePyramidManifest;
	readonly manifestPath: string;
}) {
	return Effect.tryPromise({
		try: async () => {
			const result: Array<{ readonly dataUrl: string; readonly relativePath: string }> = [];
			let bytesRead = 0;
			for (const tile of args.manifest.tiles) {
				if (
					result.length >= previewTileLimit ||
					bytesRead + tile.bytes > previewByteLimit
				) {
					break;
				}
				const bytes = await readFile(
					join(dirname(args.manifestPath), ...tile.relativePath.split("/"))
				);
				bytesRead += bytes.byteLength;
				result.push({
					dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
					relativePath: tile.relativePath
				});
			}
			return {
				previewTiles: result,
				previewTruncated: result.length < args.manifest.tiles.length
			};
		},
		catch: (cause) => cause
	});
}

export interface WorkbenchMapCaptureShape {
	readonly capture: (intent: MapCaptureExecuteIntent) => Effect.Effect<MapCaptureExecuteResult>;
	readonly choosePlan: () => Effect.Effect<MapCaptureSelectionResult>;
	readonly newPlan: () => Effect.Effect<MapCaptureSelectionResult>;
	readonly openMap: (plan: MapCapturePlan) => Effect.Effect<MapCaptureOpenResult>;
	readonly savePlan: (intent: MapCaptureSaveIntent) => Effect.Effect<MapCaptureSaveResult>;
}

export class WorkbenchMapCapture extends Context.Service<
	WorkbenchMapCapture,
	WorkbenchMapCaptureShape
>()("@ue-shed/workbench/WorkbenchMapCapture") {}

export const WorkbenchMapCaptureLive = Layer.effect(
	WorkbenchMapCapture,
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		const dialog = yield* ElectronDialog;
		const project = yield* WorkbenchProject;
		const repository = yield* MapCaptureRepository;
		const worldControl = yield* EditorWorldControl;

		const openMap = Effect.fn("Workbench.MapCapture.openMap")(function* (plan: MapCapturePlan) {
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

		const readySelection = Effect.fn("Workbench.MapCapture.readySelection")(function* (args: {
			readonly plan: MapCapturePlan;
			readonly planPath?: string;
			readonly source: "new" | "opened";
		}) {
			const selectedProject = yield* project.savedProject();
			const inspection = yield* inspectMapCapturePlan(args.plan);
			const runs = yield* repository.listRuns({
				planId: args.plan.id,
				projectRoot: selectedProject.projectRoot
			});
			return {
				grid: {
					levels: inspection.grid.levels,
					snappedBounds: inspection.grid.snappedBounds
				},
				maps: selectedProject.maps,
				plan: args.plan,
				...(args.planPath === undefined ? {} : { planPath: args.planPath }),
				projectRoot: selectedProject.projectRoot,
				runs,
				source: args.source,
				status: "ready" as const,
				tileCount: inspection.tileCount
			};
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
					...(mapPath === undefined ? {} : { mapPath }),
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

		const capture = Effect.fn("Workbench.MapCapture.capture")(function* (
			intent: MapCaptureExecuteIntent
		) {
			return yield* Effect.gen(function* () {
				const selectedProject = yield* project.selectedProject();
				if (intent.openMap) {
					const opened = yield* openMap(intent.plan);
					if (opened.status === "failed") return opened;
					if (opened.response.outcome === "rejected") {
						return failure(opened.response.message, opened.response.recovery);
					}
				}
				const outcome = yield* runMapCapturePlan({
					endpoint: configuration.remoteControlEndpoint,
					plan: intent.plan,
					projectRoot: selectedProject.projectRoot
				});
				const preview = yield* previewTiles({
					manifest: outcome.manifest,
					manifestPath: outcome.manifestPath
				});
				return {
					...outcome,
					...preview,
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

		return WorkbenchMapCapture.of({ capture, choosePlan, newPlan, openMap, savePlan });
	})
);

export function makeWorkbenchMapCaptureTestLayer(
	service: WorkbenchMapCaptureShape
): Layer.Layer<WorkbenchMapCapture> {
	return Layer.succeed(WorkbenchMapCapture, WorkbenchMapCapture.of(service));
}
