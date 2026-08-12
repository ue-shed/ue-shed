import {
	MapCaptureRepository,
	inspectMapCapturePlan,
	runMapCapturePlan,
	type MapCapturePlan,
	type MapTilePyramidManifest
} from "@ue-shed/cameras";
import { EditorWorldControl } from "@ue-shed/engine-discovery";
import type {
	MapCaptureExecuteIntent,
	MapCaptureExecuteResult,
	MapCaptureOpenResult,
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
	readonly openMap: (plan: MapCapturePlan) => Effect.Effect<MapCaptureOpenResult>;
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

		const choosePlan = Effect.fn("Workbench.MapCapture.choosePlan")(function* () {
			return yield* Effect.gen(function* () {
				const choice = yield* dialog.chooseFile({
					filters: [{ extensions: ["json"], name: "Map Capture Plan" }],
					title: "Choose a UE Shed Map Capture Plan"
				});
				if (choice.status === "cancelled") return { status: "cancelled" as const };
				const selectedProject = yield* project.selectedProject();
				const plan = yield* repository.loadPlan(choice.path);
				const inspection = yield* inspectMapCapturePlan(plan);
				const runs = yield* repository.listRuns({
					planId: plan.id,
					projectRoot: selectedProject.projectRoot
				});
				return {
					grid: {
						levels: inspection.grid.levels,
						snappedBounds: inspection.grid.snappedBounds
					},
					plan,
					planPath: choice.path,
					projectRoot: selectedProject.projectRoot,
					runs,
					status: "ready" as const,
					tileCount: inspection.tileCount
				};
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

		return WorkbenchMapCapture.of({ capture, choosePlan, openMap });
	})
);

export function makeWorkbenchMapCaptureTestLayer(
	service: WorkbenchMapCaptureShape
): Layer.Layer<WorkbenchMapCapture> {
	return Layer.succeed(WorkbenchMapCapture, WorkbenchMapCapture.of(service));
}
