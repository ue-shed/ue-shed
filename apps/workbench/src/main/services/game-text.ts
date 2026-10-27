import { userInfo } from "node:os";
import { makeGameTextWorkspace, type GameTextWorkspaceApi } from "@ue-shed/game-text/workspace";
import { LocalizationFileAccessLive } from "@ue-shed/localization";
import { Context, Effect, Layer, Stream } from "effect";
import type { WorkbenchTaskProgress } from "../project-workspace-contract.js";
import { ElectronDialog } from "../adapters/electron-dialog.js";
import { LocalFiles } from "../adapters/local-files.js";
import { WorkbenchProject } from "./project-workspace.js";

/**
 * The Game Text workspace from `@ue-shed/game-text/workspace`, with Workbench's selected project,
 * dialogs and local files as its host hooks.
 */
export interface WorkbenchGameTextApi extends Omit<
	GameTextWorkspaceApi,
	"progress" | "progressChanges"
> {
	readonly progress: () => Effect.Effect<WorkbenchTaskProgress>;
	readonly progressChanges: () => Stream.Stream<WorkbenchTaskProgress>;
}

/** The workspace reports Game Text's own stage; Workbench's progress contract names it. */
const workbenchProgress = (
	value: Effect.Success<ReturnType<GameTextWorkspaceApi["progress"]>>
): WorkbenchTaskProgress => ({
	...value,
	stage:
		value.stage === "project_index" || value.stage === "texture_audit"
			? value.stage
			: "game_text"
});

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
			localizationFiles: LocalizationFileAccessLive
		});
		return WorkbenchGameText.of({
			...workspace,
			progress: Effect.fn("Workbench.WorkbenchGameText.progress")(function* () {
				return workbenchProgress(yield* workspace.progress());
			}),
			progressChanges: () => workspace.progressChanges().pipe(Stream.map(workbenchProgress))
		});
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
			progress: () =>
				Effect.succeed({
					completed: 0,
					phase: "idle",
					stage: "game_text",
					total: 0
				}),
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
