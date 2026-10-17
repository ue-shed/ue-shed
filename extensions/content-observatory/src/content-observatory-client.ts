import {
	MapHistoryLimits,
	MapHistoryProgress,
	MapHistoryRange,
	FastHistoryInvestigationTarget,
	PerforceMapHistory,
	PerforceFastMapHistory,
	ProjectRelativeMapPath
} from "@ue-shed/map-history/contract";
import { SavedWorld, SavedWorldProgress, decodeSavedWorld } from "@ue-shed/protocol";
import { Context, Effect, Schema } from "effect";

const historyRequestFields = {
	limits: MapHistoryLimits,
	mapPath: ProjectRelativeMapPath,
	range: MapHistoryRange
};

/** The browser must choose the acquisition depth explicitly; Deep is the route default. */
export const ContentObservatoryHistoryRequest = Schema.Union([
	Schema.Struct({ ...historyRequestFields, mode: Schema.Literal("deep") }),
	Schema.Struct({
		...historyRequestFields,
		mode: Schema.Literal("fast"),
		target: FastHistoryInvestigationTarget
	})
]);
export type ContentObservatoryHistoryRequest = Schema.Schema.Type<
	typeof ContentObservatoryHistoryRequest
>;
/** Browser-to-main payload with timestamps represented as ISO strings. */
export type ContentObservatoryHistoryRequestWire = Schema.Codec.Encoded<
	typeof ContentObservatoryHistoryRequest
>;

/** Current saved-world actors used to choose a Fast History Investigation Target. */
export const ContentObservatoryTargetCatalog = SavedWorld;
export type ContentObservatoryTargetCatalog = Schema.Schema.Type<
	typeof ContentObservatoryTargetCatalog
>;

export const decodeContentObservatoryTargetCatalog = decodeSavedWorld;

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

export const ContentObservatoryProgress = Schema.Struct({
	...MapHistoryProgress.fields,
	savedWorld: Schema.optionalKey(SavedWorldProgress)
});
export type ContentObservatoryProgress = Schema.Schema.Type<typeof ContentObservatoryProgress>;

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
		progress: ContentObservatoryProgress,
		projectRoot: Schema.NonEmptyString,
		status: Schema.Literal("running")
	}),
	Schema.Struct({
		...RequestState.fields,
		// Fast first: its `mode` discriminator must not be decoded as the legacy deep document.
		history: Schema.Union([PerforceFastMapHistory, PerforceMapHistory]),
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

/**
 * A value that does not match the Content Observatory contract: the two sides disagree about the contract, so
 * repeating the same call returns the same mismatch.
 */
export class ContentObservatoryContractError extends Schema.TaggedError<ContentObservatoryContractError>()(
	"ContentObservatoryContractError",
	{
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("invalid_contract"),
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/**
 * A unary parser for one Content Observatory contract value: it decodes the encoded value and fails with
 * `ContentObservatoryContractError` naming `subject`, keeping the schema issue as its cause.
 */
function contentObservatoryContractParser<S extends Schema.Codec<unknown, unknown>>(
	schema: S,
	subject: string
) {
	const decode = Schema.decodeUnknownEffect(schema);
	return (
		// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This parser is the boundary: it decodes its input here.
		encoded: unknown
	): Effect.Effect<S["Type"], ContentObservatoryContractError> =>
		decode(encoded).pipe(
			Effect.mapError(
				(cause) =>
					new ContentObservatoryContractError({
						nextStep: "escalate",
						code: "invalid_contract",
						message: `The ${subject} does not match the Content Observatory contract.`,
						recovery:
							"Run Workbench and its extensions from the same UE Shed version, then retry.",
						retrySafe: false,
						cause
					})
			)
		);
}

export const parseContentObservatoryState = contentObservatoryContractParser(
	ContentObservatoryState,
	"content observatory state"
);

export class ContentObservatoryClientError extends Schema.TaggedError<ContentObservatoryClientError>()(
	"ContentObservatoryClientError",
	{
		message: Schema.String,
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("content_observatory_client_failed"),
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface ContentObservatoryClientApi {
	readonly cancel: () => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
	readonly start: (
		request: ContentObservatoryHistoryRequest
	) => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
	readonly status: () => Effect.Effect<ContentObservatoryState, ContentObservatoryClientError>;
	readonly targets?: (
		mapPath: string
	) => Effect.Effect<ContentObservatoryTargetCatalog, ContentObservatoryClientError>;
}

export class ContentObservatoryClient extends Context.Service<
	ContentObservatoryClient,
	ContentObservatoryClientApi
>()("@ue-shed/extension-content-observatory/ContentObservatoryClient") {}
