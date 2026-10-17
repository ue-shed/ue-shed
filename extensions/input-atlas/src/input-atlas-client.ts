import type { EnhancedInputRunResult } from "@ue-shed/enhanced-input/browser";
import { Context, type Effect, Schema } from "effect";

export class InputAtlasClientError extends Schema.TaggedError<InputAtlasClientError>()(
	"InputAtlasClientError",
	{
		message: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("input_atlas_client_failed"),
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface InputAtlasClientApi {
	readonly loadConfiguredProject: () => Effect.Effect<
		EnhancedInputRunResult,
		InputAtlasClientError
	>;
}

export class InputAtlasClient extends Context.Service<InputAtlasClient, InputAtlasClientApi>()(
	"@ue-shed/extension-input-atlas/InputAtlasClient"
) {}
