import { contractParser } from "@ue-shed/protocol";
import {
	AuthoringSessionPipeline,
	AuthoringSessionReview,
	AuthoringOperationError,
	AuthoringTableSnapshot,
	AuthoringValue,
	ErrorGuidanceFields,
	type ErrorNextStep
} from "@ue-shed/protocol";
import { Context, Effect, Schema } from "effect";

export const AuthoringAuthority = Schema.Literals(["saved", "live"]);
export type AuthoringAuthority = Schema.Schema.Type<typeof AuthoringAuthority>;

export const AuthoringSessionView = Schema.Struct({
	canRedo: Schema.Boolean,
	canUndo: Schema.Boolean,
	commandCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	dirty: Schema.Boolean,
	lifecycle: Schema.Literals(["open", "closed"]),
	lastApply: Schema.optionalKey(
		Schema.Struct({
			errors: Schema.Array(AuthoringOperationError),
			operationId: Schema.String,
			status: Schema.Literals(["committed", "rolled_back", "rejected", "indeterminate"])
		})
	),
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
	needsSave: Schema.optionalKey(Schema.Boolean),
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

export const AuthoringCatalogProgress = Schema.Struct({
	cacheHits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	phase: Schema.Literals(["idle", "enumerating", "scanning", "writing_cache", "ready", "failed"]),
	processedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tablesFound: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	totalAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
}).annotate({ identifier: "AuthoringCatalogProgress" });
export type AuthoringCatalogProgress = Schema.Schema.Type<typeof AuthoringCatalogProgress>;

export const decodeAuthoringSessionResult = contractParser(
	AuthoringSessionResult,
	"AuthoringSessionResult"
);
export const decodeAuthoringSessionReviewResult = contractParser(
	AuthoringSessionReviewResult,
	"AuthoringSessionReviewResult"
);
export const decodeAuthoringSessionListResult = contractParser(
	AuthoringSessionListResult,
	"AuthoringSessionListResult"
);
export const decodeAuthoringSessionIntent = contractParser(
	AuthoringSessionIntent,
	"AuthoringSessionIntent"
);
export const decodeAuthoringLoadResult = contractParser(AuthoringLoadResult, "AuthoringLoadResult");
export const decodeAuthoringCatalogResult = contractParser(
	AuthoringCatalogResult,
	"AuthoringCatalogResult"
);
export const decodeAuthoringCatalogProgress = contractParser(
	AuthoringCatalogProgress,
	"AuthoringCatalogProgress"
);

export class AuthoringClientError extends Schema.TaggedError<AuthoringClientError>()(
	"AuthoringClientError",
	{
		cause: Schema.Defect(),
		operation: Schema.String,
		...ErrorGuidanceFields
	}
) {}

export interface AuthoringClientApi {
	readonly getCatalogProgress: () => Effect.Effect<
		AuthoringCatalogProgress,
		AuthoringClientError
	>;
	readonly loadConfiguredCatalog: () => Effect.Effect<
		AuthoringCatalogResult,
		AuthoringClientError
	>;
	readonly loadConfiguredTable: () => Effect.Effect<AuthoringLoadResult, AuthoringClientError>;
	readonly openCatalogTable: (
		objectPath: string,
		authority: AuthoringAuthority
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

export class AuthoringClient extends Context.Service<AuthoringClient, AuthoringClientApi>()(
	"@ue-shed/authoring-sdk/AuthoringClient"
) {}

export const AuthoringTransportRequest = Schema.Union([
	Schema.Struct({ operation: Schema.Literal("get_catalog_progress") }),
	Schema.Struct({ operation: Schema.Literal("load_configured_catalog") }),
	Schema.Struct({ operation: Schema.Literal("load_configured_table") }),
	Schema.Struct({
		authority: AuthoringAuthority,
		objectPath: Schema.String,
		operation: Schema.Literal("open_catalog_table")
	}),
	Schema.Struct({ operation: Schema.Literal("choose_table") }),
	Schema.Struct({ objectPath: Schema.String, operation: Schema.Literal("begin_session") }),
	Schema.Struct({ operation: Schema.Literal("list_sessions") }),
	Schema.Struct({ operation: Schema.Literal("open_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("discard_session"), sessionId: Schema.String }),
	Schema.Struct({ intent: AuthoringSessionIntent, operation: Schema.Literal("edit_session") }),
	Schema.Struct({ operation: Schema.Literal("review_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("undo_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("redo_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("apply_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("reconcile_session"), sessionId: Schema.String }),
	Schema.Struct({ operation: Schema.Literal("save_session"), sessionId: Schema.String })
]).annotate({ identifier: "AuthoringTransportRequest" });
export type AuthoringTransportRequest = Schema.Schema.Type<typeof AuthoringTransportRequest>;

export const AuthoringTransportResponse = Schema.Union([
	Schema.Struct({ status: Schema.Literal("success"), value: Schema.Json }),
	Schema.Struct({
		error: Schema.Struct({ message: Schema.String, recovery: Schema.String }),
		status: Schema.Literal("transport_error")
	})
]).annotate({ identifier: "AuthoringTransportResponse" });
export type AuthoringTransportResponse = Schema.Schema.Type<typeof AuthoringTransportResponse>;

export const decodeAuthoringTransportRequest = contractParser(
	AuthoringTransportRequest,
	"AuthoringTransportRequest"
);
export const decodeAuthoringTransportResponse = contractParser(
	AuthoringTransportResponse,
	"AuthoringTransportResponse"
);

export function dispatchAuthoringTransportRequest(
	client: AuthoringClientApi,
	request: AuthoringTransportRequest
) {
	const operation = (() => {
		switch (request.operation) {
			case "get_catalog_progress":
				return client.getCatalogProgress();
			case "load_configured_catalog":
				return client.loadConfiguredCatalog();
			case "load_configured_table":
				return client.loadConfiguredTable();
			case "open_catalog_table":
				return client.openCatalogTable(request.objectPath, request.authority);
			case "choose_table":
				return client.chooseTable();
			case "begin_session":
				return client.beginSession(request.objectPath);
			case "list_sessions":
				return client.listSessions();
			case "open_session":
				return client.openSession(request.sessionId);
			case "discard_session":
				return client.discardSession(request.sessionId);
			case "edit_session":
				return client.editSession(request.intent);
			case "review_session":
				return client.reviewSession(request.sessionId);
			case "undo_session":
				return client.undoSession(request.sessionId);
			case "redo_session":
				return client.redoSession(request.sessionId);
			case "apply_session":
				return client.applySession(request.sessionId);
			case "reconcile_session":
				return client.reconcileSession(request.sessionId);
			case "save_session":
				return client.saveSession(request.sessionId);
		}
	})();

	return operation.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
		Effect.withSpan("authoring.transport.dispatch", {
			attributes: { "authoring.transport.operation": request.operation }
		})
	);
}

/**
 * HTTP client settings. `headers` are sent with every request after `content-type`, for example
 * an authorization or CSRF header a host requires. `fetch` replaces the global fetch, for a
 * proxy, an Electron net module or a test double. Omit both to keep the defaults.
 */
export interface AuthoringHttpClientOptions {
	readonly endpoint: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly fetch?: typeof globalThis.fetch;
}

/** Transport requests that only read host state; every other request changes a session. */
const authoringReadRequests: ReadonlySet<AuthoringTransportRequest["operation"]> = new Set([
	"get_catalog_progress",
	"load_configured_catalog",
	"load_configured_table",
	"open_catalog_table",
	"choose_table",
	"list_sessions",
	"open_session",
	"review_session"
]);

interface AuthoringRequestGuidance {
	readonly retrySafe: boolean;
	readonly nextStep: ErrorNextStep;
}

/**
 * A read whose outcome is unknown may be repeated. A session change may already have applied,
 * so the caller reopens the session before sending it again.
 */
function unknownOutcomeGuidance(read: boolean): AuthoringRequestGuidance {
	return read
		? { retrySafe: true, nextStep: "retry" }
		: { retrySafe: false, nextStep: "reconcile" };
}

export function makeAuthoringHttpClient(options: AuthoringHttpClientOptions): AuthoringClientApi {
	const request = <A, DecodeError>(args: {
		readonly decode: (input: Schema.Json) => Effect.Effect<A, DecodeError>;
		readonly operation: string;
		readonly payload: AuthoringTransportRequest;
	}) =>
		Effect.gen(function* () {
			const read = authoringReadRequests.has(args.payload.operation);
			const contractMismatch: AuthoringRequestGuidance = {
				retrySafe: read,
				nextStep: read ? "escalate" : "reconcile"
			};
			const protocolRecovery = read
				? "Run the adopted host and client from the same UE Shed version, or report the protocol failure."
				: "Reopen the session and reconcile its state before sending this change again; the host may have applied it.";
			const response = yield* Effect.tryPromise({
				try: (signal) =>
					(options.fetch ?? fetch)(options.endpoint, {
						body: JSON.stringify(args.payload),
						headers: { "content-type": "application/json", ...options.headers },
						method: "POST",
						signal
					}),
				catch: (cause) =>
					new AuthoringClientError({
						cause,
						message: `The adopted UE Shed host did not answer ${args.operation}.`,
						operation: args.operation,
						recovery: read
							? "Verify the adopted UE Shed host is running, then retry."
							: protocolRecovery,
						...unknownOutcomeGuidance(read)
					})
			});
			if (!response.ok)
				return yield* new AuthoringClientError({
					cause: { status: response.status },
					message: `The adopted host rejected ${args.operation} with HTTP ${response.status}.`,
					operation: args.operation,
					recovery:
						response.status >= 500 && !read
							? protocolRecovery
							: `Inspect the adopted host failure for HTTP ${response.status}.`,
					...(response.status >= 500
						? unknownOutcomeGuidance(read)
						: { retrySafe: read, nextStep: "fix_input" as const })
				});
			const input = yield* Effect.tryPromise({
				try: () => response.json(),
				catch: (cause) =>
					new AuthoringClientError({
						cause,
						message: `The adopted host returned invalid JSON for ${args.operation}.`,
						operation: args.operation,
						recovery: protocolRecovery,
						...contractMismatch
					})
			});
			const transport = yield* decodeAuthoringTransportResponse(input).pipe(
				Effect.mapError(
					(cause) =>
						new AuthoringClientError({
							cause,
							message: `The adopted host returned an invalid transport response for ${args.operation}.`,
							operation: args.operation,
							recovery: protocolRecovery,
							...contractMismatch
						})
				)
			);
			if (transport.status === "transport_error")
				return yield* new AuthoringClientError({
					cause: transport.error.message,
					message: transport.error.message,
					operation: args.operation,
					recovery: transport.error.recovery,
					retrySafe: false,
					nextStep: "fix_input"
				});
			return yield* args.decode(transport.value).pipe(
				Effect.mapError(
					(cause) =>
						new AuthoringClientError({
							cause,
							message: `The adopted host response for ${args.operation} does not match the authoring contract.`,
							operation: args.operation,
							recovery: protocolRecovery,
							...contractMismatch
						})
				)
			);
		}).pipe(Effect.withSpan(args.operation));

	return AuthoringClient.of({
		getCatalogProgress: () =>
			request({
				decode: decodeAuthoringCatalogProgress,
				operation: "authoring.http.get_catalog_progress",
				payload: { operation: "get_catalog_progress" }
			}),
		applySession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.apply_session",
				payload: { operation: "apply_session", sessionId }
			}),
		beginSession: (objectPath) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.begin_session",
				payload: { objectPath, operation: "begin_session" }
			}),
		chooseTable: () =>
			request({
				decode: decodeAuthoringLoadResult,
				operation: "authoring.http.choose_table",
				payload: { operation: "choose_table" }
			}),
		discardSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionListResult,
				operation: "authoring.http.discard_session",
				payload: { operation: "discard_session", sessionId }
			}),
		editSession: (intent) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.edit_session",
				payload: { intent, operation: "edit_session" }
			}),
		listSessions: () =>
			request({
				decode: decodeAuthoringSessionListResult,
				operation: "authoring.http.list_sessions",
				payload: { operation: "list_sessions" }
			}),
		loadConfiguredCatalog: () =>
			request({
				decode: decodeAuthoringCatalogResult,
				operation: "authoring.http.load_configured_catalog",
				payload: { operation: "load_configured_catalog" }
			}),
		loadConfiguredTable: () =>
			request({
				decode: decodeAuthoringLoadResult,
				operation: "authoring.http.load_configured_table",
				payload: { operation: "load_configured_table" }
			}),
		openCatalogTable: (objectPath, authority) =>
			request({
				decode: decodeAuthoringLoadResult,
				operation: "authoring.http.open_catalog_table",
				payload: { authority, objectPath, operation: "open_catalog_table" }
			}),
		openSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.open_session",
				payload: { operation: "open_session", sessionId }
			}),
		reconcileSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.reconcile_session",
				payload: { operation: "reconcile_session", sessionId }
			}),
		redoSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.redo_session",
				payload: { operation: "redo_session", sessionId }
			}),
		reviewSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionReviewResult,
				operation: "authoring.http.review_session",
				payload: { operation: "review_session", sessionId }
			}),
		saveSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.save_session",
				payload: { operation: "save_session", sessionId }
			}),
		undoSession: (sessionId) =>
			request({
				decode: decodeAuthoringSessionResult,
				operation: "authoring.http.undo_session",
				payload: { operation: "undo_session", sessionId }
			})
	});
}
