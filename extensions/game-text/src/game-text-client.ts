import type {
	TextCorpusFocusRequest,
	TextCorpusFocusResult,
	TextCorpusQueryRunResult,
	TextCorpusSearchRequest,
	TextCorpusSearchResult
} from "@ue-shed/game-text/browser";
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

export interface GameTextClientShape {
	readonly chooseProjectAndScan: () => Effect.Effect<
		TextCorpusQueryRunResult,
		GameTextClientError
	>;
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocusResult, GameTextClientError>;
	readonly loadConfiguredProject: () => Effect.Effect<
		TextCorpusQueryRunResult,
		GameTextClientError
	>;
	readonly progress: () => Effect.Effect<TaskProgress, GameTextClientError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchResult, GameTextClientError>;
}

export class GameTextClient extends Context.Service<GameTextClient, GameTextClientShape>()(
	"@ue-shed/extension-game-text/GameTextClient"
) {}
