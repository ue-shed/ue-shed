import {
	AuthoringSessionPipeline,
	AuthoringSessionReview
} from "@ue-shed/authoring/review-contracts";
import { AuthoringTableSnapshot, AuthoringValue } from "@ue-shed/protocol";
import { Context, type Effect, Schema } from "effect";

export const AuthoringSessionView = Schema.Struct({
	canRedo: Schema.Boolean,
	canUndo: Schema.Boolean,
	commandCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	dirty: Schema.Boolean,
	lifecycle: Schema.Literals(["open", "closed"]),
	pipeline: AuthoringSessionPipeline,
	review: AuthoringSessionReview,
	sessionId: Schema.String,
	snapshot: AuthoringTableSnapshot,
	updatedAt: Schema.String
}).annotate({ identifier: "AuthoringSessionView" });
export type AuthoringSessionView = Schema.Schema.Type<typeof AuthoringSessionView>;

export const AuthoringSetCellsIntent = Schema.Struct({
	edits: Schema.Array(
		Schema.Struct({
			fieldName: Schema.String,
			rowId: Schema.String,
			value: AuthoringValue
		})
	),
	kind: Schema.Literal("set_cells"),
	sessionId: Schema.String,
	tableObjectPath: Schema.String
}).annotate({ identifier: "AuthoringSetCellsIntent" });
export type AuthoringSetCellsIntent = Schema.Schema.Type<typeof AuthoringSetCellsIntent>;

export const AuthoringRowIntent = Schema.Union([
	Schema.Struct({
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		kind: Schema.Literal("add_row"),
		rowName: Schema.String,
		sessionId: Schema.String,
		tableObjectPath: Schema.String
	}),
	Schema.Struct({
		atIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
		kind: Schema.Literal("duplicate_row"),
		rowName: Schema.String,
		sessionId: Schema.String,
		sourceRowId: Schema.String,
		tableObjectPath: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("remove_row"),
		rowId: Schema.String,
		sessionId: Schema.String,
		tableObjectPath: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("rename_row"),
		rowId: Schema.String,
		rowName: Schema.String,
		sessionId: Schema.String,
		tableObjectPath: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("reorder_rows"),
		rowIds: Schema.Array(Schema.String),
		sessionId: Schema.String,
		tableObjectPath: Schema.String
	})
]).annotate({ identifier: "AuthoringRowIntent" });
export type AuthoringRowIntent = Schema.Schema.Type<typeof AuthoringRowIntent>;

export const AuthoringSessionIntent = Schema.Union([
	AuthoringSetCellsIntent,
	AuthoringRowIntent
]).annotate({ identifier: "AuthoringSessionIntent" });
export type AuthoringSessionIntent = Schema.Schema.Type<typeof AuthoringSessionIntent>;

export const AuthoringSessionFailure = Schema.Struct({
	error: Schema.Struct({
		code: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean
	}),
	status: Schema.Literal("failed")
}).annotate({ identifier: "AuthoringSessionFailure" });
export type AuthoringSessionFailure = Schema.Schema.Type<typeof AuthoringSessionFailure>;

export const AuthoringSessionResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), view: AuthoringSessionView }),
	AuthoringSessionFailure
]).annotate({ identifier: "AuthoringSessionResult" });
export type AuthoringSessionResult = Schema.Schema.Type<typeof AuthoringSessionResult>;

export const AuthoringSessionReviewResult = Schema.Union([
	Schema.Struct({ review: AuthoringSessionReview, status: Schema.Literal("ready") }),
	AuthoringSessionFailure
]).annotate({ identifier: "AuthoringSessionReviewResult" });
export type AuthoringSessionReviewResult = Schema.Schema.Type<typeof AuthoringSessionReviewResult>;

export const AuthoringSessionSummary = Schema.Struct({
	commandCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	createdAt: Schema.String,
	id: Schema.String,
	lifecycle: Schema.Literals(["open", "closed"]),
	tableObjectPaths: Schema.Array(Schema.String),
	undoPointer: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	updatedAt: Schema.String
}).annotate({ identifier: "AuthoringSessionSummary" });
export type AuthoringSessionSummary = Schema.Schema.Type<typeof AuthoringSessionSummary>;

export const AuthoringSessionListResult = Schema.Union([
	Schema.Struct({
		diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
		sessions: Schema.Array(AuthoringSessionSummary),
		status: Schema.Literal("ready")
	}),
	AuthoringSessionFailure
]).annotate({ identifier: "AuthoringSessionListResult" });
export type AuthoringSessionListResult = Schema.Schema.Type<typeof AuthoringSessionListResult>;

export const AuthoringLoadFailure = Schema.Struct({
	code: Schema.Literals(["reader_failure", "contract_failure"]),
	message: Schema.String,
	recovery: Schema.String,
	retrySafe: Schema.Boolean
});
export type AuthoringLoadFailure = Schema.Schema.Type<typeof AuthoringLoadFailure>;

export const AuthoringLoadResult = Schema.Union([
	Schema.Struct({ status: Schema.Literal("ready"), snapshot: AuthoringTableSnapshot }),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("cancelled") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: AuthoringLoadFailure })
]).annotate({ identifier: "AuthoringLoadResult" });
export type AuthoringLoadResult = Schema.Schema.Type<typeof AuthoringLoadResult>;

export const AuthoringTableCatalogEntry = Schema.Struct({
	authorities: Schema.Array(Schema.Literals(["saved", "live"])),
	completeness: Schema.Literals(["complete", "partial"]),
	divergence: Schema.Array(Schema.String),
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rowStruct: Schema.String
});
export type AuthoringTableCatalogEntry = Schema.Schema.Type<typeof AuthoringTableCatalogEntry>;

export const AuthoringCatalogResult = Schema.Union([
	Schema.Struct({
		diagnostics: Schema.Array(
			Schema.Struct({
				code: Schema.String,
				message: Schema.String,
				path: Schema.optional(Schema.String)
			})
		),
		status: Schema.Literal("ready"),
		tables: Schema.Array(AuthoringTableCatalogEntry)
	}),
	Schema.Struct({ status: Schema.Literal("not_configured") }),
	Schema.Struct({ status: Schema.Literal("failed"), error: AuthoringLoadFailure })
]).annotate({ identifier: "AuthoringCatalogResult" });
export type AuthoringCatalogResult = Schema.Schema.Type<typeof AuthoringCatalogResult>;

export const decodeAuthoringSessionResult = Schema.decodeUnknownEffect(AuthoringSessionResult);
export const decodeAuthoringSessionReviewResult = Schema.decodeUnknownEffect(
	AuthoringSessionReviewResult
);
export const decodeAuthoringSessionListResult = Schema.decodeUnknownEffect(
	AuthoringSessionListResult
);
export const decodeAuthoringSessionIntent = Schema.decodeUnknownEffect(AuthoringSessionIntent);
export const decodeAuthoringLoadResult = Schema.decodeUnknownEffect(AuthoringLoadResult);
export const decodeAuthoringCatalogResult = Schema.decodeUnknownEffect(AuthoringCatalogResult);

export class AuthoringClientError extends Schema.TaggedErrorClass<AuthoringClientError>()(
	"AuthoringClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		recovery: Schema.String
	}
) {}

export interface AuthoringClientShape {
	readonly loadConfiguredCatalog: () => Effect.Effect<
		AuthoringCatalogResult,
		AuthoringClientError
	>;
	readonly loadConfiguredTable: () => Effect.Effect<AuthoringLoadResult, AuthoringClientError>;
	readonly openCatalogTable: (
		objectPath: string
	) => Effect.Effect<AuthoringLoadResult, AuthoringClientError>;
	readonly chooseTable: () => Effect.Effect<AuthoringLoadResult, AuthoringClientError>;
	readonly beginSession: (
		objectPath: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly listSessions: () => Effect.Effect<AuthoringSessionListResult, AuthoringClientError>;
	readonly openSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly discardSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionListResult, AuthoringClientError>;
	readonly editSession: (
		intent: AuthoringSessionIntent
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly reviewSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionReviewResult, AuthoringClientError>;
	readonly undoSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly redoSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly applySession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly reconcileSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
	readonly saveSession: (
		sessionId: string
	) => Effect.Effect<AuthoringSessionResult, AuthoringClientError>;
}

export class AuthoringClient extends Context.Service<AuthoringClient, AuthoringClientShape>()(
	"@ue-shed/authoring-sdk/AuthoringClient"
) {}
