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

export const NiagaraCatalogueEntry = Schema.Struct({
	objectPath: NiagaraSystemObjectPath
});
export interface NiagaraCatalogueEntry extends Schema.Schema.Type<typeof NiagaraCatalogueEntry> {}

export const NiagaraCatalogueResult = Schema.Union([
	Schema.Struct({
		entries: Schema.Array(NiagaraCatalogueEntry),
		status: Schema.Literal("ready")
	}),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		error: Schema.Struct({ message: Schema.String, recovery: Schema.String }),
		status: Schema.Literal("failed")
	})
]);
export type NiagaraCatalogueResult = typeof NiagaraCatalogueResult.Type;

export const decodeNiagaraPreviewRunResult = Schema.decodeUnknownEffect(NiagaraPreviewRunResult);
export const decodeNiagaraPreviewFrameResult =
	Schema.decodeUnknownEffect(NiagaraPreviewFrameResult);
export const decodeNiagaraCatalogueResult = Schema.decodeUnknownEffect(NiagaraCatalogueResult);

export class NiagaraPreviewClientError extends Schema.TaggedErrorClass<NiagaraPreviewClientError>()(
	"NiagaraPreview.ClientError",
	{
		cause: Schema.Defect(),
		message: Schema.String,
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface NiagaraPreviewClientApi {
	readonly catalogue: () => Effect.Effect<NiagaraCatalogueResult, NiagaraPreviewClientError>;
	readonly frame: (
		intent: NiagaraPreviewFrameIntent
	) => Effect.Effect<NiagaraPreviewFrameResult, NiagaraPreviewClientError>;
	readonly run: (
		intent: NiagaraPreviewIntent
	) => Effect.Effect<NiagaraPreviewRunResult, NiagaraPreviewClientError>;
}
