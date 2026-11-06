import {
	AuthoringClient,
	AuthoringClientError,
	decodeAuthoringCatalogResult,
	decodeAuthoringLoadResult,
	decodeAuthoringSessionListResult,
	decodeAuthoringSessionReviewResult,
	decodeAuthoringSessionResult,
	type AuthoringCatalogResult,
	type AuthoringClientApi,
	type AuthoringLoadResult,
	type AuthoringSessionListResult,
	type AuthoringSessionReviewResult,
	type AuthoringSessionResult
} from "@ue-shed/authoring-sdk";
import { Effect, Schema } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";

/** The renderer cannot tell whether the main process applied a session change; a person decides. */
function clientError(operation: string, message: string, cause: unknown): AuthoringClientError {
	return new AuthoringClientError({
		cause,
		message,
		operation,
		recovery,
		retrySafe: false,
		nextStep: "escalate"
	});
}

function request<A, HostValue, DecodeError>(args: {
	readonly decode: (value: HostValue) => Effect.Effect<A, DecodeError>;
	readonly invoke: () => Promise<HostValue>;
	readonly operation: string;
}): Effect.Effect<A, AuthoringClientError> {
	return Effect.tryPromise({
		try: args.invoke,
		catch: (cause) =>
			clientError(args.operation, `Workbench could not complete ${args.operation}.`, cause)
	}).pipe(
		Effect.flatMap((value) =>
			args
				.decode(value)
				.pipe(
					Effect.mapError((cause) =>
						clientError(
							args.operation,
							`Workbench returned an invalid ${args.operation} result.`,
							cause
						)
					)
				)
		)
	);
}

export const decodeAuthoringLoadResultFromHost = (
	value: Schema.Json
): Effect.Effect<AuthoringLoadResult, AuthoringClientError> =>
	decodeAuthoringLoadResult(value).pipe(
		Effect.mapError((cause) =>
			clientError(
				"authoring.decodeLoad",
				"Workbench returned an invalid authoring load result.",
				cause
			)
		)
	);

export const decodeAuthoringCatalogResultFromHost = (
	value: Schema.Json
): Effect.Effect<AuthoringCatalogResult, AuthoringClientError> =>
	decodeAuthoringCatalogResult(value).pipe(
		Effect.mapError((cause) =>
			clientError(
				"authoring.decodeCatalog",
				"Workbench returned an invalid authoring catalog result.",
				cause
			)
		)
	);

const loadRequest = <HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): Effect.Effect<AuthoringLoadResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringLoadResult, invoke, operation });

const sessionRequest = <HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): Effect.Effect<AuthoringSessionResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionResult, invoke, operation });

const reviewRequest = <HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): Effect.Effect<AuthoringSessionReviewResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionReviewResult, invoke, operation });

const sessionListRequest = <HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): Effect.Effect<AuthoringSessionListResult, AuthoringClientError> =>
	request({ decode: decodeAuthoringSessionListResult, invoke, operation });

export const authoringClient: AuthoringClientApi = AuthoringClient.of({
	getCatalogProgress: Effect.sync(() => ({
		cacheHits: 0,
		phase: "idle" as const,
		processedAssets: 0,
		tablesFound: 0,
		totalAssets: 0
	})).pipe(Effect.withSpan("AuthoringClient.getCatalogProgress")),
	beginSession: Effect.fn("AuthoringClient.beginSession")((objectPath) =>
		sessionRequest("authoring.beginSession", () =>
			window.ueShed.authoring.beginSession(objectPath)
		)
	),
	listSessions: Effect.suspend(() =>
		sessionListRequest("authoring.listSessions", () => window.ueShed.authoring.listSessions())
	).pipe(Effect.withSpan("AuthoringClient.listSessions")),
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
	loadConfiguredCatalog: Effect.suspend(() =>
		request({
			decode: decodeAuthoringCatalogResult,
			invoke: () => window.ueShed.authoring.loadConfiguredCatalog(),
			operation: "authoring.loadConfiguredCatalog"
		})
	).pipe(Effect.withSpan("AuthoringClient.loadConfiguredCatalog")),
	loadConfiguredTable: Effect.suspend(() =>
		loadRequest("authoring.loadConfiguredTable", () =>
			window.ueShed.authoring.loadConfiguredTable()
		)
	).pipe(Effect.withSpan("AuthoringClient.loadConfiguredTable")),
	openCatalogTable: Effect.fn("AuthoringClient.openCatalogTable")((objectPath, authority) =>
		loadRequest("authoring.openCatalogTable", () =>
			window.ueShed.authoring.openCatalogTable(objectPath, authority)
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
	chooseTable: Effect.suspend(() =>
		loadRequest("authoring.chooseTable", () => window.ueShed.authoring.chooseTable())
	).pipe(Effect.withSpan("AuthoringClient.chooseTable"))
});
