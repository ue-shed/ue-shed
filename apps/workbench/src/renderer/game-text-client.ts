import {
	GameTextInvestigationPresetResult,
	LocalizationLinesFileResult
} from "@ue-shed/game-text/corpus";
import { InvestigationFileResult } from "@ue-shed/unreal-assets/investigation";
import {
	type WorkspaceQualityRequest,
	WorkspaceQualityResult,
	type WorkspaceQualityFocusRequest,
	WorkspaceQualityFocusResult,
	WorkspaceChangesResult,
	type LocalizationEditRequest,
	LocalizationEditResult,
	type LocalizationReviewRequest,
	LocalizationReviewResult,
	type WorkspaceReportRequest,
	WorkspaceReportResult,
	type WorkspaceReportFileRequest,
	WorkspaceReportFileResult,
	LocalizationTargetsResult,
	LocalizationTargetResult,
	LocalizationFocusResult,
	type LocalizationFocusRequest,
	parseTextQualityFocusResult,
	parseTextQualityQueryRunResult,
	parseTextQualityRuleUpdateResult,
	parseTextQualitySearchResult,
	type TextQualityFocusRequest,
	type TextQualityFocusResult,
	type TextQualityRuleUpdateResult,
	type TextQualitySearchRequest,
	type TextQualitySearchResult
} from "@ue-shed/game-text/corpus";
import {
	TextIdRepairResult,
	type LocalizationSelection,
	parseTextCorpusFocusResult,
	parseTextCorpusQueryRunResult,
	parseTextCorpusSearchResult,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/schema";
import { type GameTextRuleDocument } from "@ue-shed/game-text/rules";
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
	GameTextOperationState,
	GameTextOperationPlanResult,
	GameTextOperationResult,
	GameTextOperationFilesResult,
	GameTextOperationProgress
} from "@ue-shed/game-text/schema";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function invokeRequest<A, HostValue, DecodeError>(
	operation: string,
	invoke: () => Promise<HostValue>,
	decode: (value: HostValue) => Effect.Effect<A, DecodeError>
): Effect.Effect<A, GameTextClientError> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) =>
			new GameTextClientError({
				message: "Game Text could not complete the host operation.",
				retrySafe: false,
				nextStep: "reconcile",
				code: "game_text_client_failed",
				cause,
				operation,
				recovery
			})
	}).pipe(
		Effect.flatMap(decode),
		Effect.mapError(
			(cause) =>
				new GameTextClientError({
					message: "Game Text could not complete the host operation.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "game_text_client_failed",
					cause,
					operation,
					recovery
				})
		)
	);
}

export const gameTextClient: GameTextClientApi = GameTextClient.of({
	idRepairs: {
		prepare: (request) =>
			invokeRequest(
				"gameText.prepareIdRepair",
				() => window.ueShed.gameText.prepareIdRepair(request),
				Schema.decodeUnknownEffect(TextIdRepairResult)
			),
		apply: (id) =>
			invokeRequest(
				"gameText.applyIdRepair",
				() => window.ueShed.gameText.applyIdRepair(id),
				Schema.decodeUnknownEffect(TextIdRepairResult)
			)
	},
	operations: {
		state: (target) =>
			invokeRequest(
				"gameText.operationState",
				() => window.ueShed.gameText.operationState(target),
				Schema.decodeUnknownEffect(GameTextOperationState)
			),
		plan: (request) =>
			invokeRequest(
				"gameText.operationPlan",
				() => window.ueShed.gameText.operationPlan(request),
				Schema.decodeUnknownEffect(GameTextOperationPlanResult)
			),
		run: (id) =>
			invokeRequest(
				"gameText.operationRun",
				() => window.ueShed.gameText.operationRun(id),
				Schema.decodeUnknownEffect(GameTextOperationResult)
			),
		cancel: (id) =>
			invokeRequest(
				"gameText.operationCancel",
				() => window.ueShed.gameText.operationCancel(id),
				Schema.decodeUnknownEffect(GameTextOperationResult)
			),
		files: (request) =>
			invokeRequest(
				"gameText.operationFiles",
				() => window.ueShed.gameText.operationFiles(request),
				Schema.decodeUnknownEffect(GameTextOperationFilesResult)
			),
		progress: Stream.callback<GameTextOperationProgress>(
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
				Schema.decodeUnknownEffect(GameTextOperationProgress)(progress)
			),
			Stream.mapError(
				(cause) =>
					new GameTextClientError({
						message: "Game Text could not complete the host operation.",
						retrySafe: false,
						nextStep: "reconcile",
						code: "game_text_client_failed",
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
	localizationEdits: Effect.fn("GameTextClient.localizationEdits")(
		(request: LocalizationEditRequest) =>
			invokeRequest(
				"gameText.localizationEdits",
				() => window.ueShed.gameText.localizationEdits(request),
				Schema.decodeUnknownEffect(LocalizationEditResult)
			)
	),
	localizationReview: Effect.fn("GameTextClient.localizationReview")(
		(request: LocalizationReviewRequest) =>
			invokeRequest(
				"gameText.localizationReview",
				() => window.ueShed.gameText.localizationReview(request),
				Schema.decodeUnknownEffect(LocalizationReviewResult)
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
	localizationLinesFile: Effect.fn("GameTextClient.localizationLinesFile")(
		(request: TextCorpusSearchRequest) =>
			invokeRequest(
				"gameText.localizationLinesFile",
				() => window.ueShed.gameText.localizationLinesFile(request),
				Schema.decodeUnknownEffect(LocalizationLinesFileResult)
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
			parseTextQualityQueryRunResult
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
			parseTextQualityQueryRunResult
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
			parseTextCorpusQueryRunResult
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
				parseTextCorpusSearchResult
			)
	),
	focus: Effect.fn("GameTextClient.focus")(
		(
			input: TextCorpusFocusRequest
		): Effect.Effect<TextCorpusFocusResult, GameTextClientError> =>
			invokeRequest(
				"gameText.focus",
				() => window.ueShed.gameText.focus(input),
				parseTextCorpusFocusResult
			)
	),
	chooseQualityRules: Effect.fn("GameTextClient.chooseQualityRules")(() =>
		invokeRequest(
			"gameText.chooseQualityRules",
			() => window.ueShed.gameText.chooseQualityRules(),
			parseTextQualityQueryRunResult
		)
	),
	previewQualityRules: Effect.fn("GameTextClient.previewQualityRules")(
		(
			document: GameTextRuleDocument
		): Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError> =>
			invokeRequest(
				"gameText.previewQualityRules",
				() => window.ueShed.gameText.previewQualityRules(document),
				parseTextQualityRuleUpdateResult
			)
	),
	saveQualityRules: Effect.fn("GameTextClient.saveQualityRules")(
		(
			document: GameTextRuleDocument
		): Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError> =>
			invokeRequest(
				"gameText.saveQualityRules",
				() => window.ueShed.gameText.saveQualityRules(document),
				parseTextQualityRuleUpdateResult
			)
	),
	qualitySearch: Effect.fn("GameTextClient.qualitySearch")(
		(
			input: TextQualitySearchRequest
		): Effect.Effect<TextQualitySearchResult, GameTextClientError> =>
			invokeRequest(
				"gameText.qualitySearch",
				() => window.ueShed.gameText.qualitySearch(input),
				parseTextQualitySearchResult
			)
	),
	qualityFocus: Effect.fn("GameTextClient.qualityFocus")(
		(
			input: TextQualityFocusRequest
		): Effect.Effect<TextQualityFocusResult, GameTextClientError> =>
			invokeRequest(
				"gameText.qualityFocus",
				() => window.ueShed.gameText.qualityFocus(input),
				parseTextQualityFocusResult
			)
	)
});
