import { userInfo } from "node:os";
import {
	GameTextWorkspaceHostFailure,
	makeGameTextWorkspace,
	type GameTextWorkspaceApi
} from "@ue-shed/game-text/workspace";
import { EngineInstallationDiscoveryLive } from "@ue-shed/engine";
import { LocalizationFileAccessLive, projectSourceGatherEngine } from "@ue-shed/localization";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFiles, type LocalFilesApi } from "../adapters/local-files.js";
import type { GameTextWorkspaceFileHooks } from "@ue-shed/game-text/workspace";
import { WorkbenchConfiguration } from "../workbench-config.js";
import { WorkbenchProject } from "./project-workspace.js";

/**
 * The Game Text workspace from `@ue-shed/game-text/workspace`, with Workbench's selected project,
 * dialogs and local files as its host hooks.
 */
export type WorkbenchGameTextApi = GameTextWorkspaceApi;

export class WorkbenchGameText extends Context.Service<WorkbenchGameText, WorkbenchGameTextApi>()(
	"@ue-shed/workbench/WorkbenchGameText"
) {}

// Review records name who set them; the OS account is the honest default for a desktop host.
function reviewer() {
	try {
		return userInfo().username || "workbench";
	} catch {
		return "workbench";
	}
}

/** Adapts a host-owned failure while retaining its identity and recovery guidance. */
export function gameTextHostFailure(cause: {
	readonly code?: string;
	readonly message: string;
	readonly recovery: string;
	readonly retrySafe: boolean;
	readonly nextStep: GameTextWorkspaceHostFailure["nextStep"];
}): GameTextWorkspaceHostFailure {
	return new GameTextWorkspaceHostFailure({
		cause,
		...(cause.code === undefined ? undefined : { code: cause.code }),
		message: cause.message,
		recovery: cause.recovery,
		retrySafe: cause.retrySafe,
		nextStep: cause.nextStep
	});
}

/** Local file capabilities adapted to the shared workspace's typed host boundary. */
export function gameTextFileHooks(
	files: LocalFilesApi
): Pick<GameTextWorkspaceFileHooks, "readFile" | "readFileWithin" | "writeFile"> {
	return {
		readFile: (path, options) =>
			files.readFile(path, options).pipe(Effect.mapError(gameTextHostFailure)),
		readFileWithin: (directory, path, options) =>
			files
				.readFileWithin(directory, path, options)
				.pipe(Effect.mapError(gameTextHostFailure)),
		writeFile: (path, bytes, options) =>
			files.writeFile(path, bytes, options).pipe(Effect.mapError(gameTextHostFailure))
	};
}

export const WorkbenchGameTextLive = Layer.effect(
	WorkbenchGameText,
	Effect.gen(function* () {
		const project = yield* WorkbenchProject;
		const dialog = yield* ElectronDialog;
		const files = yield* LocalFiles;
		// Optional: hosts without Workbench's settings read code with the project's association.
		const configuration = yield* Effect.serviceOption(WorkbenchConfiguration);
		const engineRoot = Option.match(configuration, {
			onNone: () => undefined,
			onSome: (value) =>
				value.unrealEngineRoot?.status === "configured"
					? value.unrealEngineRoot.path
					: undefined
		});
		const workspace = yield* makeGameTextWorkspace({
			project: {
				current: project.current,
				refresh: Effect.suspend(() => project.refresh()),
				candidates: Effect.suspend(() => project.candidates("game_text")).pipe(
					Effect.mapError(gameTextHostFailure)
				),
				progress: project.progress,
				progressChanges: project.progressChanges
			},
			files: {
				...gameTextFileHooks(files),
				chooseFile: (options) =>
					dialog.chooseFile(options).pipe(Effect.mapError(gameTextHostFailure)),
				chooseSaveFile: (options) =>
					dialog.chooseSaveFile(options).pipe(Effect.mapError(gameTextHostFailure))
			},
			reviewer,
			changeAuthor: "workbench",
			localizationFiles: LocalizationFileAccessLive,
			// Code is read with Workbench's engine setting, else the project's association.
			codeSource: (projectRoot) =>
				projectSourceGatherEngine(projectRoot, engineRoot).pipe(
					Effect.provide(EngineInstallationDiscoveryLive),
					// Unreadable engine discovery settings leave the code unread, as no engine does.
					Effect.catchTag("ConfigError", (error) =>
						Effect.annotateCurrentSpan({ "code.unavailable": error.message }).pipe(
							Effect.as(undefined)
						)
					)
				)
		});
		return WorkbenchGameText.of(workspace);
	})
);

export function makeWorkbenchGameTextTestLayer(
	service: Pick<WorkbenchGameTextApi, "configuredScan"> &
		Partial<Omit<WorkbenchGameTextApi, "configuredScan">>
): Layer.Layer<WorkbenchGameText> {
	return Layer.succeed(
		WorkbenchGameText,
		WorkbenchGameText.of({
			operationStateTarget: () => Effect.undefined,
			operationTarget: () => Effect.undefined,
			operationBusyReason: Effect.undefined,
			beginOperation: Effect.succeed(true),
			endOperation: Effect.void,
			refreshAfterOperation: () => Effect.succeed(true),
			localizationBeforeGather: () => Effect.void,
			localizationQualitySearch: () => Effect.succeed({ status: "not_ready" }),
			localizationQualityFocus: () => Effect.succeed({ status: "not_ready" }),
			localizationChanges: () => Effect.succeed({ status: "not_ready" }),
			localizationEdits: () => Effect.succeed({ status: "not_ready" }),
			localizationReview: () => Effect.succeed({ status: "not_ready" }),
			localizationReport: () => Effect.succeed({ status: "not_ready" }),
			localizationReportFile: () => Effect.succeed({ status: "not_ready" }),
			localizationLinesFile: () => Effect.succeed({ status: "not_ready" }),
			compareChange: () => Effect.succeed({ status: "not_ready" }),
			chooseLocalizationFile: () => Effect.succeed({ status: "cancelled" }),
			compareLocalizationFiles: () =>
				Effect.succeed({
					status: "failed",
					code: "file_not_chosen",
					message: "No files were chosen.",
					recovery: "Choose two files."
				}),
			localizationTargets: Effect.sync(() => ({ status: "ready", targets: [] })),
			localizationTarget: () => Effect.succeed({ status: "not_ready" }),
			localizationFocus: () => Effect.succeed({ status: "not_ready" }),
			related: () => Effect.succeed({ status: "not_ready" }),
			investigationExport: () => Effect.succeed({ status: "cancelled" }),
			investigationSave: () => Effect.succeed({ status: "cancelled" }),
			investigationOpen: Effect.sync(() => ({ status: "cancelled" })),
			configuredRefresh: () => Effect.succeed({ status: "not_configured" }),
			focus: () => Effect.succeed({ status: "not_ready" }),
			chooseQualityRules: Effect.sync(() => ({ status: "not_ready" })),
			reloadQualityRules: Effect.sync(() => ({ status: "not_ready" })),
			createStarterRules: () => Effect.succeed({ status: "not_ready" }),
			progress: Effect.sync(() => ({ completed: 0, phase: "idle", total: 0 })),
			progressChanges: Stream.empty,
			search: () => Effect.succeed({ status: "not_ready" }),
			searchRows: () => Effect.succeed({ status: "not_ready" }),
			qualityFocus: () => Effect.succeed({ status: "not_ready" }),
			qualitySearch: () => Effect.succeed({ status: "not_ready" }),
			previewQualityRules: () => Effect.succeed({ status: "not_ready" }),
			saveQualityRules: () => Effect.succeed({ status: "not_ready" }),
			...service
		})
	);
}
