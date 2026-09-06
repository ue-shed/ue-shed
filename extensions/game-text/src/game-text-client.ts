import type {
	GameTextInvestigationQuery,
	GameTextInvestigationPresetResult,
	InvestigationFileResult,
	InvestigationFormat
} from "@ue-shed/game-text/browser";
import type {
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult,
	TextQualityFocusRequest,
	TextQualityFocusResult,
	TextQualityQueryRunResult,
	TextQualityRuleDocument,
	TextQualityRuleUpdateResult,
	TextQualitySearchRequest,
	TextQualitySearchResult
} from "@ue-shed/game-text/browser";
import type { EditorAssetLocateResult } from "@ue-shed/protocol";
import type { TaskProgress } from "@ue-shed/ui/task-progress";
import { Context, type Effect, Schema } from "effect";

export class GameTextClientError extends Schema.TaggedErrorClass<GameTextClientError>()(
	"GameTextClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface GameTextClientApi {
	readonly investigations?: {
		readonly export: (
			query: GameTextInvestigationQuery,
			format: InvestigationFormat
		) => Effect.Effect<InvestigationFileResult, GameTextClientError>;
		readonly save: (
			query: GameTextInvestigationQuery
		) => Effect.Effect<InvestigationFileResult, GameTextClientError>;
		readonly open: () => Effect.Effect<GameTextInvestigationPresetResult, GameTextClientError>;
	};
	readonly chooseProjectAndScan: () => Effect.Effect<
		TextCorpusQueryRunResult,
		GameTextClientError
	>;
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocusResult, GameTextClientError>;
	readonly loadConfiguredProject: (
		refresh?: boolean
	) => Effect.Effect<TextCorpusQueryRunResult, GameTextClientError>;
	readonly locateAsset: (
		objectPath: string
	) => Effect.Effect<EditorAssetLocateResult, GameTextClientError>;
	readonly progress: () => Effect.Effect<TaskProgress, GameTextClientError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchResult, GameTextClientError>;
	readonly chooseQualityRules: () => Effect.Effect<
		TextQualityQueryRunResult,
		GameTextClientError
	>;
	readonly qualityFocus: (
		request: TextQualityFocusRequest
	) => Effect.Effect<TextQualityFocusResult, GameTextClientError>;
	readonly qualitySearch: (
		request: TextQualitySearchRequest
	) => Effect.Effect<TextQualitySearchResult, GameTextClientError>;
	readonly previewQualityRules: (
		document: TextQualityRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError>;
	readonly saveQualityRules: (
		document: TextQualityRuleDocument
	) => Effect.Effect<TextQualityRuleUpdateResult, GameTextClientError>;
}

export class GameTextClient extends Context.Service<GameTextClient, GameTextClientApi>()(
	"@ue-shed/extension-game-text/GameTextClient"
) {}
