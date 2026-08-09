import {
	decodeTextCorpusFocusResult,
	decodeTextCorpusQueryRunResult,
	decodeTextCorpusSearchResult,
	type TextCorpusFocusRequest,
	type TextCorpusFocusResult,
	type TextCorpusSearchRequest,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/browser";
import { decodeEditorAssetLocateResult } from "@ue-shed/protocol";
import {
	GameTextClient,
	GameTextClientError,
	type GameTextClientShape
} from "@ue-shed/extension-game-text";
import { WorkbenchTaskProgress } from "../main/project-workspace-contract.js";
import { Effect, Schema } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function invokeRequest<A>(
	operation: string,
	invoke: () => Promise<unknown>,
	decode: (value: unknown) => Effect.Effect<A, unknown>
): Effect.Effect<A, GameTextClientError> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) => new GameTextClientError({ cause, operation, recovery })
	}).pipe(
		Effect.flatMap(decode),
		Effect.mapError((cause) => new GameTextClientError({ cause, operation, recovery }))
	);
}

export const gameTextClient: GameTextClientShape = GameTextClient.of({
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
	)
});
