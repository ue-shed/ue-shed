import {
	NiagaraPreviewFailure,
	NiagaraPreviewArtifact,
	NiagaraPreviewRunManifest,
	NiagaraPreviewSettings,
	NiagaraSystemObjectPath
} from "@ue-shed/niagara/browser";
import { type Effect, Schema } from "effect";

export const NiagaraPreviewIntent = Schema.Struct({
	settings: NiagaraPreviewSettings,
	systemObjectPath: NiagaraSystemObjectPath
});
export interface NiagaraPreviewIntent extends Schema.Schema.Type<typeof NiagaraPreviewIntent> {}

export const NiagaraPreviewRunResult = Schema.Union([
	Schema.Struct({
		manifest: NiagaraPreviewRunManifest,
		manifestPath: Schema.NonEmptyString,
		status: Schema.Literal("completed")
	}),
	Schema.Struct({ error: NiagaraPreviewFailure, status: Schema.Literal("failed") })
]);
export type NiagaraPreviewRunResult = typeof NiagaraPreviewRunResult.Type;

export const NiagaraPreviewFrameIntent = Schema.Struct({
	manifestPath: Schema.NonEmptyString,
	relativePath: NiagaraPreviewArtifact.fields.relativePath
});
export interface NiagaraPreviewFrameIntent extends Schema.Schema.Type<
	typeof NiagaraPreviewFrameIntent
> {}

export const NiagaraPreviewFrameResult = Schema.Union([
	Schema.Struct({ bytes: Schema.Uint8Array, status: Schema.Literal("ready") }),
	Schema.Struct({ error: NiagaraPreviewFailure, status: Schema.Literal("failed") })
]);
export type NiagaraPreviewFrameResult = typeof NiagaraPreviewFrameResult.Type;

export const decodeNiagaraPreviewRunResult = Schema.decodeUnknownEffect(NiagaraPreviewRunResult);
export const decodeNiagaraPreviewFrameResult =
	Schema.decodeUnknownEffect(NiagaraPreviewFrameResult);

export class NiagaraPreviewClientError extends Schema.TaggedErrorClass<NiagaraPreviewClientError>()(
	"NiagaraPreview.ClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface NiagaraPreviewClientApi {
	readonly frame: (
		intent: NiagaraPreviewFrameIntent
	) => Effect.Effect<NiagaraPreviewFrameResult, NiagaraPreviewClientError>;
	readonly run: (
		intent: NiagaraPreviewIntent
	) => Effect.Effect<NiagaraPreviewRunResult, NiagaraPreviewClientError>;
}
