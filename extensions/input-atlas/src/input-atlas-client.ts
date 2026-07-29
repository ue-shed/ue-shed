import type { EnhancedInputRunResult } from "@ue-shed/enhanced-input/browser";
import { Context, type Effect, Schema } from "effect";

export class InputAtlasClientError extends Schema.TaggedErrorClass<InputAtlasClientError>()(
	"InputAtlasClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface InputAtlasClientShape {
	readonly loadConfiguredProject: () => Effect.Effect<
		EnhancedInputRunResult,
		InputAtlasClientError
	>;
	readonly chooseProjectAndScan: () => Effect.Effect<
		EnhancedInputRunResult,
		InputAtlasClientError
	>;
}

export class InputAtlasClient extends Context.Service<InputAtlasClient, InputAtlasClientShape>()(
	"@ue-shed/extension-input-atlas/InputAtlasClient"
) {}
