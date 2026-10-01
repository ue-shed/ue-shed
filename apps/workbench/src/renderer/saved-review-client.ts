import { Effect, Schema } from "effect";
import { SavedReviewInventory, SequenceReadResult } from "../shared/saved-review-contract.js";
import { WorkbenchRendererError } from "./workbench-client.js";

function request<A, HostValue, E>(
	operation: string,
	invoke: () => Promise<HostValue>,
	decode: (value: HostValue) => Effect.Effect<A, E>
): Effect.Effect<A, WorkbenchRendererError> {
	const failure = (cause: unknown) =>
		new WorkbenchRendererError({
			cause,
			operation,
			recovery:
				"Retry the read. If it persists, restart Workbench and verify the UAsset reader."
		});
	return Effect.tryPromise({ try: invoke, catch: failure }).pipe(
		Effect.flatMap(decode),
		Effect.mapError(failure),
		Effect.withSpan(operation)
	);
}
export interface SavedReviewClient {
	readonly readSequence: (
		path: string
	) => Effect.Effect<SequenceReadResult, WorkbenchRendererError>;
	readonly inventory: () => Effect.Effect<SavedReviewInventory, WorkbenchRendererError>;
}
export const savedReviewClient: SavedReviewClient = {
	readSequence: (path) =>
		request(
			"savedReview.readSequence",
			() => window.ueShed.savedReview.sequence(path),
			Schema.decodeUnknownEffect(SequenceReadResult)
		),
	inventory: () =>
		request(
			"savedReview.inventory",
			() => window.ueShed.savedReview.inventory(),
			Schema.decodeUnknownEffect(SavedReviewInventory)
		)
};
