import type { ScenarioDocument, ScenarioRun } from "@ue-shed/scenarios";
import { Effect, Schema } from "effect";

export class ScenarioStudioClientError extends Schema.TaggedErrorClass<ScenarioStudioClientError>()(
	"ScenarioStudioClientError",
	{
		cause: Schema.Defect(),
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface ScenarioStudioClient {
	readonly run: (
		document: ScenarioDocument
	) => Effect.Effect<ScenarioRun, ScenarioStudioClientError>;
}
