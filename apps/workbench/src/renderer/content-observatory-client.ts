import {
	ContentObservatoryClient,
	ContentObservatoryClientError,
	ContentObservatoryHistoryRequest,
	decodeContentObservatoryState,
	type ContentObservatoryClientShape
} from "@ue-shed/extension-content-observatory/client";
import { Effect, Schema } from "effect";

const recovery = "Restart Workbench. If the problem persists, verify package versions.";
const encodeHistoryRequest = Schema.encodeUnknownEffect(ContentObservatoryHistoryRequest);

function request(
	operation: string,
	invoke: () => Promise<unknown>
): ReturnType<ContentObservatoryClientShape["status"]> {
	return Effect.tryPromise({
		try: invoke,
		catch: (cause) => new ContentObservatoryClientError({ cause, operation, recovery })
	}).pipe(
		Effect.flatMap(decodeContentObservatoryState),
		Effect.mapError(
			(cause) => new ContentObservatoryClientError({ cause, operation, recovery })
		)
	);
}

export const contentObservatoryClient: ContentObservatoryClientShape = ContentObservatoryClient.of({
	cancel: Effect.fn("ContentObservatoryClient.cancel")(() =>
		request("contentObservatory.cancel", () => window.ueShed.contentObservatory.cancel())
	),
	start: Effect.fn("ContentObservatoryClient.start")(
		(requestValue: ContentObservatoryHistoryRequest) =>
			encodeHistoryRequest(requestValue).pipe(
				Effect.mapError(
					(cause) =>
						new ContentObservatoryClientError({
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
	)
});
