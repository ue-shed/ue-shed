import {
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
	type TextQualityRuleDocument,
	type TextQualityRuleUpdateResult,
	type TextQualitySearchRequest,
	type TextQualitySearchResult
} from "@ue-shed/game-text/browser";
import { decodeEditorAssetLocateResult } from "@ue-shed/protocol";
import {
	GameTextClient,
	GameTextClientError,
	type GameTextClientApi
} from "@ue-shed/extension-game-text";
import { WorkbenchTaskProgress } from "../main/project-workspace-contract.js";
import { Effect, Schema } from "effect";

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
	loadConfiguredProject: Effect.fn("GameTextClient.loadConfiguredProject")(() =>
		invokeRequest(
			"gameText.loadConfiguredProject",
			() => window.ueShed.gameText.refreshConfiguredProject(),
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
			document: TextQualityRuleDocument
		): Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError> =>
			invokeRequest(
				"gameText.previewQualityRules",
				() => window.ueShed.gameText.previewQualityRules(document),
				decodeTextQualityRuleUpdateResult
			)
	),
	saveQualityRules: Effect.fn("GameTextClient.saveQualityRules")(
		(
			document: TextQualityRuleDocument
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
