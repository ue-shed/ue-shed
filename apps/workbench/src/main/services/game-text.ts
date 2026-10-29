import { userInfo } from "node:os";
import { makeGameTextWorkspace, type GameTextWorkspaceApi } from "@ue-shed/game-text/workspace";
import { EngineInstallationDiscoveryLive } from "@ue-shed/engine";
import { LocalizationFileAccessLive, projectSourceGatherEngine } from "@ue-shed/localization";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFiles } from "../adapters/local-files.js";
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
				refresh: () => project.refresh(),
				candidates: () => project.candidates("game_text"),
				progress: project.progress,
				progressChanges: project.progressChanges
			},
			files: {
				chooseFile: dialog.chooseFile,
				chooseSaveFile: dialog.chooseSaveFile,
				readFile: files.readFile,
				readFileWithin: files.readFileWithin,
				writeFile: files.writeFile
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
			operationStateTarget: () => Effect.succeed(undefined),
			operationTarget: () => Effect.succeed(undefined),
			operationBusyReason: () => Effect.succeed(undefined),
			beginOperation: () => Effect.succeed(true),
			endOperation: () => Effect.void,
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
			localizationTargets: () => Effect.succeed({ status: "ready", targets: [] }),
			localizationTarget: () => Effect.succeed({ status: "not_ready" }),
			localizationFocus: () => Effect.succeed({ status: "not_ready" }),
			related: () => Effect.succeed({ status: "not_ready" }),
			investigationExport: () => Effect.succeed({ status: "cancelled" }),
			investigationSave: () => Effect.succeed({ status: "cancelled" }),
			investigationOpen: () => Effect.succeed({ status: "cancelled" }),
			configuredRefresh: () => Effect.succeed({ status: "not_configured" }),
			focus: () => Effect.succeed({ status: "not_ready" }),
			chooseQualityRules: () => Effect.succeed({ status: "not_ready" }),
			reloadQualityRules: () => Effect.succeed({ status: "not_ready" }),
			createStarterRules: () => Effect.succeed({ status: "not_ready" }),
			progress: () => Effect.succeed({ completed: 0, phase: "idle", total: 0 }),
			progressChanges: () => Stream.empty,
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
