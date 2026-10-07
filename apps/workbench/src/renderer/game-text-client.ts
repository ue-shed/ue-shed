import { GameTextInvestigationPresetResult } from "@ue-shed/game-text/browser";
import { InvestigationFileResult } from "@ue-shed/unreal-assets/investigation";
import {
	type WorkspaceQualityRequest,
	WorkspaceQualityResult,
	type WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	type WorkspaceReportRequest,
	WorkspaceReportResult,
	type WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	LocalizationTargetsResult,
	LocalizationTargetResult,
	LocalizationFocusResult,
	type LocalizationFocusRequest,
	type LocalizationSelection,
	decodeTextCorpusFocusResult,
	decodeTextCorpusQueryRunResult,
	decodeTextCorpusSearchResult,
	decodeTextQualityFocusResult,
	decodeTextQualityQueryRunResult,
	decodeTextQualityRuleUpdateResult,
	decodeTextQualitySearchResult,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult,
	type TextQualityFocusRequest,
	type TextQualityFocusResult,
	type GameTextRuleDocument,
	type TextQualityRuleUpdateResult,
	type TextQualitySearchRequest,
	type TextQualitySearchResult
} from "@ue-shed/game-text/browser";
import { decodeEditorAssetLocateResult } from "@ue-shed/protocol";
import {
	GameTextClient,
	GameTextClientError,
	type GameTextClientApi
} from "@ue-shed/extension-game-text/client";
import {
	WorkbenchTaskProgress,
	WorkbenchProjectState
} from "../shared/project-workspace-contract.js";
import { Effect, Queue, Schema, Stream } from "effect";
import {
	WorkbenchOperationState,
	WorkbenchOperationPlanResult,
	WorkbenchOperationResult,
	WorkbenchOperationFilesResult,
	WorkbenchOperationProgress
} from "@ue-shed/game-text/browser";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function invokeRequest<A, HostValue, DecodeError>(
	operation: string,
	invoke: () => Promise<HostValue>,
	decode: (value: HostValue) => Effect.Effect<A, DecodeError>
): Effect.Effect<A, GameTextClientError> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) => new GameTextClientError({ cause, operation, recovery })
	}).pipe(
		Effect.flatMap(decode),
		Effect.mapError((cause) => new GameTextClientError({ cause, operation, recovery }))
	);
}

export const gameTextClient: GameTextClientApi = GameTextClient.of({
	operations: {
		state: (target) =>
			invokeRequest(
				"gameText.operationState",
				() => window.ueShed.gameText.operationState(target),
				Schema.decodeUnknownEffect(WorkbenchOperationState)
			),
		plan: (request) =>
			invokeRequest(
				"gameText.operationPlan",
				() => window.ueShed.gameText.operationPlan(request),
				Schema.decodeUnknownEffect(WorkbenchOperationPlanResult)
			),
		run: (id) =>
			invokeRequest(
				"gameText.operationRun",
				() => window.ueShed.gameText.operationRun(id),
				Schema.decodeUnknownEffect(WorkbenchOperationResult)
			),
		cancel: (id) =>
			invokeRequest(
				"gameText.operationCancel",
				() => window.ueShed.gameText.operationCancel(id),
				Schema.decodeUnknownEffect(WorkbenchOperationResult)
			),
		files: (request) =>
			invokeRequest(
				"gameText.operationFiles",
				() => window.ueShed.gameText.operationFiles(request),
				Schema.decodeUnknownEffect(WorkbenchOperationFilesResult)
			),
		progress: Stream.callback<WorkbenchOperationProgress>(
			(queue) =>
				Effect.acquireRelease(
					Effect.sync(() =>
						window.ueShed.gameText.onOperationProgress((progress) =>
							Queue.offerUnsafe(queue, progress)
						)
					),
					(unsubscribe) => Effect.sync(unsubscribe)
				),
			{ bufferSize: 1, strategy: "sliding" }
		).pipe(
			Stream.mapEffect((progress) =>
				Schema.decodeUnknownEffect(WorkbenchOperationProgress)(progress)
			),
			Stream.mapError(
				(cause) =>
					new GameTextClientError({
						cause,
						operation: "gameText.operationProgress",
						recovery
					})
			)
		)
	},
	localizationQualitySearch: Effect.fn("GameTextClient.localizationQualitySearch")(
		(request: WorkspaceQualityRequest) =>
			invokeRequest(
				"gameText.localizationQualitySearch",
				() => window.ueShed.gameText.localizationQualitySearch(request),
				Schema.decodeUnknownEffect(WorkspaceQualityResult)
			)
	),
	localizationQualityFocus: Effect.fn("GameTextClient.localizationQualityFocus")(
		(request: WorkspaceQualityFocusRequest) =>
			invokeRequest(
				"gameText.localizationQualityFocus",
				() => window.ueShed.gameText.localizationQualityFocus(request),
				Schema.decodeUnknownEffect(WorkspaceQualityFocusResult)
			)
	),
	localizationChanges: Effect.fn("GameTextClient.localizationChanges")(
		(request: WorkspaceQualityRequest) =>
			invokeRequest(
				"gameText.localizationChanges",
				() => window.ueShed.gameText.localizationChanges(request),
				Schema.decodeUnknownEffect(WorkspaceChangesResult)
			)
	),
	localizationReport: Effect.fn("GameTextClient.localizationReport")(
		(request: WorkspaceReportRequest) =>
			invokeRequest(
				"gameText.localizationReport",
				() => window.ueShed.gameText.localizationReport(request),
				Schema.decodeUnknownEffect(WorkspaceReportResult)
			)
	),
	localizationReportFile: Effect.fn("GameTextClient.localizationReportFile")(
		(request: WorkspaceReportFileRequest) =>
			invokeRequest(
				"gameText.localizationReportFile",
				() => window.ueShed.gameText.localizationReportFile(request),
				Schema.decodeUnknownEffect(WorkspaceReportFileResult)
			)
	),
	localizationTargets: Effect.fn("GameTextClient.localizationTargets")(() =>
		invokeRequest(
			"gameText.localizationTargets",
			() => window.ueShed.gameText.localizationTargets(),
			Schema.decodeUnknownEffect(LocalizationTargetsResult)
		)
	),
	localizationTarget: Effect.fn("GameTextClient.localizationTarget")(
		(target: LocalizationSelection["target"]) =>
			invokeRequest(
				"gameText.localizationTarget",
				() => window.ueShed.gameText.localizationTarget(target),
				Schema.decodeUnknownEffect(LocalizationTargetResult)
			)
	),
	localizationFocus: Effect.fn("GameTextClient.localizationFocus")(
		(request: LocalizationFocusRequest) =>
			invokeRequest(
				"gameText.localizationFocus",
				() => window.ueShed.gameText.localizationFocus(request),
				Schema.decodeUnknownEffect(LocalizationFocusResult)
			)
	),
	reloadQualityRules: Effect.fn("GameTextClient.reloadQualityRules")(() =>
		invokeRequest(
			"gameText.reloadQualityRules",
			() => window.ueShed.gameText.reloadQualityRules(),
			decodeTextQualityQueryRunResult
		)
	),
	projectKey: Effect.fn("GameTextClient.projectKey")(() =>
		invokeRequest(
			"gameText.projectKey",
			() => window.ueShed.project.current(),
			Schema.decodeUnknownEffect(WorkbenchProjectState)
		).pipe(
			Effect.map((result) =>
				result.status === "ready" ? result.project.projectRoot : undefined
			)
		)
	),
	createStarterRules: Effect.fn("GameTextClient.createStarterRules")((loadExisting: boolean) =>
		invokeRequest(
			"gameText.createStarterRules",
			() => window.ueShed.gameText.createStarterRules(loadExisting),
			decodeTextQualityQueryRunResult
		)
	),
	investigations: {
		export: (query, format) =>
			invokeRequest(
				"gameText.investigationExport",
				() => window.ueShed.gameText.investigationExport(query, format),
				Schema.decodeUnknownEffect(InvestigationFileResult)
			),
		save: (query) =>
			invokeRequest(
				"gameText.investigationSave",
				() => window.ueShed.gameText.investigationSave(query),
				Schema.decodeUnknownEffect(InvestigationFileResult)
			),
		open: () =>
			invokeRequest(
				"gameText.investigationOpen",
				() => window.ueShed.gameText.investigationOpen(),
				Schema.decodeUnknownEffect(GameTextInvestigationPresetResult)
			)
	},
	loadConfiguredProject: Effect.fn("GameTextClient.loadConfiguredProject")((refresh = true) =>
		invokeRequest(
			"gameText.loadConfiguredProject",
			() => window.ueShed.gameText.refreshConfiguredProject(refresh),
			decodeTextCorpusQueryRunResult
		)
	),
	chooseProjectAndScan: Effect.fn("GameTextClient.chooseProjectAndScan")(() =>
		invokeRequest(
			"gameText.chooseProjectAndScan",
			() => window.ueShed.gameText.chooseProjectAndRefresh(),
			decodeTextCorpusQueryRunResult
		)
	),
	progress: Effect.fn("GameTextClient.progress")(() =>
		invokeRequest(
			"gameText.progress",
			() => window.ueShed.gameText.progress(),
			Schema.decodeUnknownEffect(WorkbenchTaskProgress)
		)
	),
	locateAsset: Effect.fn("GameTextClient.locateAsset")((objectPath: string) =>
		invokeRequest(
			"gameText.locateAsset",
			() => window.ueShed.assetNavigation.locate(objectPath),
			decodeEditorAssetLocateResult
		)
	),
	search: Effect.fn("GameTextClient.search")(
		(
			input: TextCorpusSearchRequest
		): Effect.Effect<TextCorpusSearchResult, GameTextClientError> =>
			invokeRequest(
				"gameText.search",
				() => window.ueShed.gameText.search(input),
				decodeTextCorpusSearchResult
			)
	),
	focus: Effect.fn("GameTextClient.focus")(
		(
			input: TextCorpusFocusRequest
		): Effect.Effect<TextCorpusFocusResult, GameTextClientError> =>
			invokeRequest(
				"gameText.focus",
				() => window.ueShed.gameText.focus(input),
				decodeTextCorpusFocusResult
			)
	),
	chooseQualityRules: Effect.fn("GameTextClient.chooseQualityRules")(() =>
		invokeRequest(
			"gameText.chooseQualityRules",
			() => window.ueShed.gameText.chooseQualityRules(),
			decodeTextQualityQueryRunResult
		)
	),
	previewQualityRules: Effect.fn("GameTextClient.previewQualityRules")(
		(
			document: GameTextRuleDocument
		): Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError> =>
			invokeRequest(
				"gameText.previewQualityRules",
				() => window.ueShed.gameText.previewQualityRules(document),
				decodeTextQualityRuleUpdateResult
			)
	),
	saveQualityRules: Effect.fn("GameTextClient.saveQualityRules")(
		(
			document: GameTextRuleDocument
		): Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError> =>
			invokeRequest(
				"gameText.saveQualityRules",
				() => window.ueShed.gameText.saveQualityRules(document),
				decodeTextQualityRuleUpdateResult
			)
	),
	qualitySearch: Effect.fn("GameTextClient.qualitySearch")(
		(
			input: TextQualitySearchRequest
		): Effect.Effect<TextQualitySearchResult, GameTextClientError> =>
			invokeRequest(
				"gameText.qualitySearch",
				() => window.ueShed.gameText.qualitySearch(input),
				decodeTextQualitySearchResult
			)
	),
	qualityFocus: Effect.fn("GameTextClient.qualityFocus")(
		(
			input: TextQualityFocusRequest
		): Effect.Effect<TextQualityFocusResult, GameTextClientError> =>
			invokeRequest(
				"gameText.qualityFocus",
				() => window.ueShed.gameText.qualityFocus(input),
				decodeTextQualityFocusResult
			)
	)
});
