import {
	MapHistoryLimits,
	MapHistoryProgress,
	MapHistoryRange,
	PerforceMapHistory,
	ProjectRelativeMapPath
} from "@ue-shed/map-history/contract";
import { Context, type Effect, Schema } from "effect";

export const ContentObservatoryHistoryRequest = Schema.Struct({
	limits: MapHistoryLimits,
	mapPath: ProjectRelativeMapPath,
	range: MapHistoryRange
});
export type ContentObservatoryHistoryRequest = Schema.Schema.Type<
	typeof ContentObservatoryHistoryRequest
>;
/** Browser-to-main payload with timestamps represented as ISO strings. */
export type ContentObservatoryHistoryRequestWire = Schema.Codec.Encoded<
	typeof ContentObservatoryHistoryRequest
>;

export const ContentObservatoryError = Schema.Struct({
	kind: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	recovery: Schema.NonEmptyString,
	retrySafe: Schema.Boolean
});
export type ContentObservatoryError = Schema.Schema.Type<typeof ContentObservatoryError>;

export const ContentObservatoryMap = Schema.Struct({
	label: Schema.NonEmptyString,
	mapPath: Schema.NonEmptyString
});
export type ContentObservatoryMap = Schema.Schema.Type<typeof ContentObservatoryMap>;

const RequestState = Schema.Struct({
	jobId: Schema.NonEmptyString,
	request: ContentObservatoryHistoryRequest
});

export const ContentObservatoryState = Schema.Union([
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({
		maps: Schema.Array(ContentObservatoryMap),
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("ready")
	}),
	Schema.Struct({
		...RequestState.fields,
		maps: Schema.Array(ContentObservatoryMap),
		progress: MapHistoryProgress,
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("running")
	}),
	Schema.Struct({
		...RequestState.fields,
		history: PerforceMapHistory,
		maps: Schema.Array(ContentObservatoryMap),
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("complete")
	}),
	Schema.Struct({
		...RequestState.fields,
		error: ContentObservatoryError,
		maps: Schema.Array(ContentObservatoryMap),
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("failed")
	}),
	Schema.Struct({
		...RequestState.fields,
		maps: Schema.Array(ContentObservatoryMap),
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("cancelled")
	})
]);
export type ContentObservatoryState = Schema.Schema.Type<typeof ContentObservatoryState>;

export const decodeContentObservatoryState = Schema.decodeUnknownEffect(ContentObservatoryState);

export class ContentObservatoryClientError extends Schema.TaggedErrorClass<ContentObservatoryClientError>()(
	"ContentObservatoryClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface ContentObservatoryClientShape {
	readonly cancel: () => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
	readonly start: (
		request: ContentObservatoryHistoryRequest
	) => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
	readonly status: () => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
}

export class ContentObservatoryClient extends Context.Service<
	ContentObservatoryClient,
	ContentObservatoryClientShape
>()("@ue-shed/extension-content-observatory/ContentObservatoryClient") {}
