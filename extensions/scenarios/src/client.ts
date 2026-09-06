import type {
	ScenarioDocument,
	ScenarioDocumentFileResult,
	ScenarioRun,
	ScenarioRunHandle,
	ScenarioRunnerStatus
} from "@ue-shed/scenarios/browser";
import { Effect, Schema, Stream } from "effect";

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
	readonly openDocument?: () => Effect.Effect<
		ScenarioDocumentFileResult,
		ScenarioStudioClientError
	>;
	readonly saveDocument?: (
		document: ScenarioDocument
	) => Effect.Effect<ScenarioDocumentFileResult, ScenarioStudioClientError>;
	readonly cancel: (
		handle: ScenarioRunHandle
	) => Effect.Effect<ScenarioRun, ScenarioStudioClientError>;
	readonly settings: () => Effect.Effect<
		{ readonly endpoint: string },
		ScenarioStudioClientError
	>;
	readonly start: (options: {
		readonly document: ScenarioDocument;
		readonly endpoint: string;
	}) => Effect.Effect<ScenarioRunHandle, ScenarioStudioClientError>;
	readonly watch: (
		handle: ScenarioRunHandle
	) => Stream.Stream<ScenarioRunnerStatus, ScenarioStudioClientError>;
}
