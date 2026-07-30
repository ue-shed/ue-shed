import type {
	TextureAuditQueryRunResult,
	TextureAuditRecordResult,
	TextureAuditSearchRequest,
	TextureAuditSearchResult,
	TexturePreviewResult
} from "@ue-shed/asset-audits/browser";
import type { TaskProgress } from "@ue-shed/ui/task-progress";
import { Context, type Effect, Schema } from "effect";

export const TextureAuditLaunchResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready") }),
	Schema.Struct({
		message: Schema.String,
		recovery: Schema.String,
		status: Schema.Literal("failed")
	})
]);
export type TextureAuditLaunchResult = Schema.Schema.Type<typeof TextureAuditLaunchResult>;

export class TextureAuditClientError extends Schema.TaggedErrorClass<TextureAuditClientError>()(
	"TextureAuditClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface TextureAuditClientShape {
	readonly loadConfiguredProject: () => Effect.Effect<
		TextureAuditQueryRunResult,
		TextureAuditClientError
	>;
	readonly progress: () => Effect.Effect<TaskProgress, TextureAuditClientError>;
	readonly chooseProjectAndScan: () => Effect.Effect<
		TextureAuditQueryRunResult,
		TextureAuditClientError
	>;
	readonly search: (
		request: TextureAuditSearchRequest
	) => Effect.Effect<TextureAuditSearchResult, TextureAuditClientError>;
	readonly record: (
		objectPath: string
	) => Effect.Effect<TextureAuditRecordResult, TextureAuditClientError>;
	readonly loadPreview: (
		objectPath: string
	) => Effect.Effect<TexturePreviewResult, TextureAuditClientError>;
	readonly launchUnreal: () => Effect.Effect<TextureAuditLaunchResult, TextureAuditClientError>;
}

export class TextureAuditClient extends Context.Service<
	TextureAuditClient,
	TextureAuditClientShape
>()("@ue-shed/extension-asset-audits/TextureAuditClient") {}

export const decodeTextureAuditLaunchResult = Schema.decodeUnknownEffect(TextureAuditLaunchResult);
