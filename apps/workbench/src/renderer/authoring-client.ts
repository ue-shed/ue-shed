import {
	AuthoringClient,
	AuthoringClientError,
	decodeAuthoringCatalogResult,
	decodeAuthoringLoadResult,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionReviewResult,
	decodeAuthoringSessionResult,
	type AuthoringCatalogResult,
	type AuthoringClientShape,
	type AuthoringLoadResult,
	type AuthoringSessionListResult,
	type AuthoringSessionReviewResult,
	type AuthoringSessionResult
} from "@ue-shed/authoring-sdk";
import { Effect } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

function request<A>(args: {
	readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
	readonly invoke: () => Promise<unknown>;
	readonly operation: string;
}): Effect.Effect<A, AuthoringClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) => new AuthoringClientError({ cause, operation: args.operation, recovery })
	}).pipe(
		Effect.flatMap(args.decode),
		Effect.mapError(
			(cause) => new AuthoringClientError({ cause, operation: args.operation, recovery })
		)
	);
}

export const decodeAuthoringLoadResultFromHost = (
	value: unknown
): Effect.Effect<AuthoringLoadResult, AuthoringClientError> =>
	decodeAuthoringLoadResult(value).pipe(
		Effect.mapError(
			(cause) =>
				new AuthoringClientError({ cause, operation: "authoring.decodeLoad", recovery })
		)
	);

export const decodeAuthoringCatalogResultFromHost = (
	value: unknown
): Effect.Effect<AuthoringCatalogResult, AuthoringClientError> =>
	decodeAuthoringCatalogResult(value).pipe(
		Effect.mapError(
			(cause) =>
				new AuthoringClientError({ cause, operation: "authoring.decodeCatalog", recovery })
		)
	);

const loadRequest = (
	operation: string,
	invoke: () => Promise<unknown>
): Effect.Effect<AuthoringLoadResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringLoadResult, invoke, operation });

const sessionRequest = (
	operation: string,
	invoke: () => Promise<unknown>
): Effect.Effect<AuthoringSessionResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionResult, invoke, operation });

const reviewRequest = (
	operation: string,
	invoke: () => Promise<unknown>
): Effect.Effect<AuthoringSessionReviewResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionReviewResult, invoke, operation });

const sessionListRequest = (
	operation: string,
	invoke: () => Promise<unknown>
): Effect.Effect<AuthoringSessionListResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionListResult, invoke, operation });

export const authoringClient: AuthoringClientShape = AuthoringClient.of({
	getCatalogProgress: Effect.fn("AuthoringClient.getCatalogProgress")(() =>
		Effect.succeed({
			cacheHits: 0,
			phase: "idle" as const,
			processedAssets: 0,
			tablesFound: 0,
			totalAssets: 0
		})
	),
	beginSession: Effect.fn("AuthoringClient.beginSession")((objectPath) =>
		sessionRequest("authoring.beginSession", () =>
			window.ueShed.authoring.beginSession(objectPath)
		)
	),
	listSessions: Effect.fn("AuthoringClient.listSessions")(() =>
		sessionListRequest("authoring.listSessions", () => window.ueShed.authoring.listSessions())
	),
	openSession: Effect.fn("AuthoringClient.openSession")((sessionId) =>
		sessionRequest("authoring.openSession", () =>
			window.ueShed.authoring.openSession(sessionId)
		)
	),
	discardSession: Effect.fn("AuthoringClient.discardSession")((sessionId) =>
		sessionListRequest("authoring.discardSession", () =>
			window.ueShed.authoring.discardSession(sessionId)
		)
	),
	applySession: Effect.fn("AuthoringClient.applySession")((sessionId) =>
		sessionRequest("authoring.applySession", () =>
			window.ueShed.authoring.applySession(sessionId)
		)
	),
	editSession: Effect.fn("AuthoringClient.editSession")((intent) =>
		sessionRequest("authoring.editSession", () => window.ueShed.authoring.editSession(intent))
	),
	loadConfiguredCatalog: Effect.fn("AuthoringClient.loadConfiguredCatalog")(() =>
		request({
			decode: decodeAuthoringCatalogResult,
			invoke: () => window.ueShed.authoring.loadConfiguredCatalog(),
			operation: "authoring.loadConfiguredCatalog"
		})
	),
	loadConfiguredTable: Effect.fn("AuthoringClient.loadConfiguredTable")(() =>
		loadRequest("authoring.loadConfiguredTable", () =>
			window.ueShed.authoring.loadConfiguredTable()
		)
	),
	openCatalogTable: Effect.fn("AuthoringClient.openCatalogTable")((objectPath) =>
		loadRequest("authoring.openCatalogTable", () =>
			window.ueShed.authoring.openCatalogTable(objectPath)
		)
	),
	redoSession: Effect.fn("AuthoringClient.redoSession")((sessionId) =>
		sessionRequest("authoring.redoSession", () =>
			window.ueShed.authoring.redoSession(sessionId)
		)
	),
	reviewSession: Effect.fn("AuthoringClient.reviewSession")((sessionId) =>
		reviewRequest("authoring.reviewSession", () =>
			window.ueShed.authoring.reviewSession(sessionId)
		)
	),
	reconcileSession: Effect.fn("AuthoringClient.reconcileSession")((sessionId) =>
		sessionRequest("authoring.reconcileSession", () =>
			window.ueShed.authoring.reconcileSession(sessionId)
		)
	),
	saveSession: Effect.fn("AuthoringClient.saveSession")((sessionId) =>
		sessionRequest("authoring.saveSession", () =>
			window.ueShed.authoring.saveSession(sessionId)
		)
	),
	undoSession: Effect.fn("AuthoringClient.undoSession")((sessionId) =>
		sessionRequest("authoring.undoSession", () =>
			window.ueShed.authoring.undoSession(sessionId)
		)
	),
	chooseTable: Effect.fn("AuthoringClient.chooseTable")(() =>
		loadRequest("authoring.chooseTable", () => window.ueShed.authoring.chooseTable())
	)
});
