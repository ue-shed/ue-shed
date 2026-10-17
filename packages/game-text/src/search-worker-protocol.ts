import { snapshotStoreGuidance } from "./snapshot-store.js";
import { Schema, Struct } from "effect";
import {
	TextCorpus,
	TextCorpusFocus,
	TextCorpusFocusRequest,
	TextCorpusQuerySummary,
	TextCorpusSearchRequest,
	TextCorpusSearchPage
} from "./schema.js";
import {
	GameTextLocalizationError,
	LocalizationLine,
	LocalizationLineId
} from "./localization-schema.js";
import { SnapshotStoreError } from "./snapshot-store.js";
import { SnapshotFormatError } from "./snapshot-format.js";

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SearchWorkerInput = Schema.Struct({
	configuration: Schema.Struct({
		cacheRoot: Schema.NonEmptyString,
		projectKey: Schema.NonEmptyString,
		targetKey: Schema.NonEmptyString,
		projectView: Schema.optionalKey(
			Schema.Union([
				Schema.Struct({ kind: Schema.Literal("source") }),
				Schema.Struct({
					kind: Schema.Literal("localization"),
					target: Schema.NonEmptyString
				})
			])
		)
	}),
	generation: Schema.NonEmptyString,
	joinedKey: Schema.NonEmptyString
});
export type SearchWorkerInput = typeof SearchWorkerInput.Type;
export const SearchWorkerTask = Schema.Struct({
	id: Id,
	request: TextCorpusSearchRequest,
	cancelled: Schema.instanceOf(SharedArrayBuffer)
});
export const SearchWorkerReply = Schema.Union([
	/** The worker prepared its query; the summary it computed while preparing comes along. */
	Schema.Struct({ kind: Schema.Literal("ready"), summary: TextCorpusQuerySummary }),
	Schema.Struct({ kind: Schema.Literal("result"), id: Id, page: TextCorpusSearchPage }),
	Schema.Struct({ kind: Schema.Literal("cancelled"), id: Id }),
	Schema.Struct({
		kind: Schema.Literal("failed"),
		id: Schema.optionalKey(Id),
		error: Schema.Union([SnapshotStoreError, SnapshotFormatError])
	})
]);
export type SearchWorkerReply = typeof SearchWorkerReply.Type;

/** Requests over the whole matching set: a search request without its page. */
export const SearchWorkerUnpagedRequest = Schema.Struct(
	Struct.omit(TextCorpusSearchRequest.fields, ["cursor", "pageSize"])
);
/**
 * The synchronous query calls a host makes on the worker's prepared model. The host blocks on a
 * shared flag until the worker answers; the worker serves them between searches.
 */
export const SearchWorkerCall = Schema.Union([
	Schema.Struct({ id: Id, method: Schema.Literal("search"), request: TextCorpusSearchRequest }),
	Schema.Struct({ id: Id, method: Schema.Literal("focus"), request: TextCorpusFocusRequest }),
	Schema.Struct({
		id: Id,
		method: Schema.Literal("localizationFocus"),
		lineId: LocalizationLineId
	}),
	Schema.Struct({
		id: Id,
		method: Schema.Literals(["localizationLines", "localizationRows", "export"]),
		request: SearchWorkerUnpagedRequest
	})
]);
export type SearchWorkerCall = typeof SearchWorkerCall.Type;
export const SearchWorkerCallFailure = Schema.Union([
	SnapshotStoreError,
	SnapshotFormatError,
	GameTextLocalizationError
]);
export type SearchWorkerCallFailure = typeof SearchWorkerCallFailure.Type;
/** Each value is encoded by its method's schema; the host decodes it with the same schema. */
export const SearchWorkerCallReply = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("value"), id: Id, value: Schema.Unknown }),
	Schema.Struct({ kind: Schema.Literal("failed"), id: Id, error: SearchWorkerCallFailure })
]);
export type SearchWorkerCallReply = typeof SearchWorkerCallReply.Type;
/** The schema of each call's value. */
export const searchWorkerCallValues = {
	search: TextCorpusSearchPage,
	focus: Schema.UndefinedOr(TextCorpusFocus),
	localizationFocus: Schema.UndefinedOr(LocalizationLine),
	localizationLines: Schema.Array(LocalizationLine),
	localizationRows: Schema.instanceOf(Uint32Array),
	export: TextCorpus
} as const;

export function searchWorkerFailure(operation: string, cause: unknown) {
	return Schema.is(SnapshotStoreError)(cause) || Schema.is(SnapshotFormatError)(cause)
		? cause
		: new SnapshotStoreError({
				retrySafe: snapshotStoreGuidance("unavailable").retrySafe,
				nextStep: snapshotStoreGuidance("unavailable").nextStep,
				operation,
				code: "unavailable",
				message: `The Game Text search worker could not complete ${operation}.`,
				cause,
				recovery: "Refresh the Game Text index and retry the search."
			});
}
