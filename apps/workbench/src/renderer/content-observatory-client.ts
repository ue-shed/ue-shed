import {
	ContentObservatoryClient,
	ContentObservatoryClientError,
	ContentObservatoryHistoryRequest,
	ContentObservatoryTargetCatalog,
	decodeContentObservatoryTargetCatalog,
	parseContentObservatoryState,
	type ContentObservatoryClientApi
} from "@ue-shed/extension-content-observatory/client";
import { Effect, Schema } from "effect";
import { ProjectRelativeMapPath } from "@ue-shed/map-history/contract";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";
const encodeHistoryRequest = Schema.encodeUnknownEffect(ContentObservatoryHistoryRequest);
const decodeTargetMapPath = Schema.decodeUnknownEffect(ProjectRelativeMapPath);

function request<HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): ReturnType<ContentObservatoryClientApi["status"]> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) =>
			new ContentObservatoryClientError({
				message: "Content Observatory could not complete the host operation.",
				retrySafe: false,
				nextStep: "reconcile",
				code: "content_observatory_client_failed",
				cause,
				operation,
				recovery
			})
	}).pipe(
		Effect.flatMap(parseContentObservatoryState),
		Effect.mapError(
			(cause) =>
				new ContentObservatoryClientError({
					message: "Content Observatory could not complete the host operation.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "content_observatory_client_failed",
					cause,
					operation,
					recovery
				})
		)
	);
}

function targetRequest<HostValue>(
	operation: string,
	invoke: () => Promise<HostValue>
): Effect.Effect<ContentObservatoryTargetCatalog, ContentObservatoryClientError> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) =>
			new ContentObservatoryClientError({
				message: "Content Observatory could not complete the host operation.",
				retrySafe: false,
				nextStep: "reconcile",
				code: "content_observatory_client_failed",
				cause,
				operation,
				recovery
			})
	}).pipe(
		Effect.flatMap(decodeContentObservatoryTargetCatalog),
		Effect.mapError(
			(cause) =>
				new ContentObservatoryClientError({
					message: "Content Observatory could not complete the host operation.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "content_observatory_client_failed",
					cause,
					operation,
					recovery
				})
		)
	);
}

export const contentObservatoryClient: ContentObservatoryClientApi = ContentObservatoryClient.of({
	cancel: Effect.fn("ContentObservatoryClient.cancel")(() =>
		request("contentObservatory.cancel", () => window.ueShed.contentObservatory.cancel())
	),
	start: Effect.fn("ContentObservatoryClient.start")(
		(requestValue: ContentObservatoryHistoryRequest) =>
			encodeHistoryRequest(requestValue).pipe(
				Effect.mapError(
					(cause) =>
						new ContentObservatoryClientError({
							message: "Content Observatory could not complete the host operation.",
							retrySafe: false,
							nextStep: "reconcile",
							code: "content_observatory_client_failed",
							cause,
							operation: "contentObservatory.start",
							recovery
						})
				),
				Effect.flatMap((wireRequest) =>
					request("contentObservatory.start", () =>
						window.ueShed.contentObservatory.start(wireRequest)
					)
				)
			)
	),
	status: Effect.fn("ContentObservatoryClient.status")(() =>
		request("contentObservatory.status", () => window.ueShed.contentObservatory.status())
	),
	targets: Effect.fn("ContentObservatoryClient.targets")((mapPath: string) =>
		decodeTargetMapPath(mapPath).pipe(
			Effect.mapError(
				(cause) =>
					new ContentObservatoryClientError({
						message: "Content Observatory could not complete the host operation.",
						retrySafe: false,
						nextStep: "reconcile",
						code: "content_observatory_client_failed",
						cause,
						operation: "contentObservatory.targets",
						recovery
					})
			),
			Effect.flatMap((decodedMapPath) =>
				targetRequest("contentObservatory.targets", () =>
					window.ueShed.contentObservatory.targets(decodedMapPath)
				)
			)
		)
	)
});
