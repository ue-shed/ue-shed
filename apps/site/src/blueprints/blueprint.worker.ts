import { createBrowserRuntime } from "@ue-shed/uasset-inspection-wasm/browser";
import { Effect, Schema } from "effect";
import {
	BlueprintBrowserError,
	BlueprintWorkerRequest,
	type BlueprintWorkerResponse
} from "./worker-contract.js";

const decode = Effect.fn("Website.Blueprints.workerDecode")(function* (
	event: MessageEvent<unknown>
) {
	const request = yield* Schema.decodeUnknownEffect(BlueprintWorkerRequest)(event.data).pipe(
		Effect.mapError(
			() =>
				new BlueprintBrowserError({
					operation: "request",
					message: "The browser sent an invalid file request."
				})
		)
	);
	const runtime = yield* Effect.tryPromise({
		try: () => createBrowserRuntime(),
		catch: () =>
			new BlueprintBrowserError({
				operation: "initialize",
				message: "The browser could not initialize the asset decoder."
			})
	});
	return yield* Effect.try({
		try: (): BlueprintWorkerResponse => {
			const bytes = new Uint8Array(request.bytes);
			if (request.operation === "authoring") {
				return {
					status: "authored",
					output: runtime.extractAuthoringTable(request.path, bytes)
				};
			}
			if (request.operation === "sequencer") {
				return {
					status: "sequenced",
					output: runtime.extractLevelSequences(request.path, bytes)
				};
			}
			if (request.operation === "inspect") {
				const inspection = runtime.inspect(request.path, bytes);
				// Inspection already tells us the class. Avoid a third package parse for other assets.
				const isSequence =
					inspection.status !== "error" &&
					inspection.assets.some((asset) => asset.class_path?.endsWith(".LevelSequence"));
				return {
					status: "inspected",
					inspection,
					authoringOutput:
						inspection.status !== "error" &&
						inspection.assets.some(
							(asset) =>
								asset.kind === "DataTable" || asset.kind === "CompositeDataTable"
						)
							? runtime.extractAuthoringTable(request.path, bytes)
							: {
									schema_version: 1,
									status: "error",
									path: request.path,
									kind: "unsupported_capability",
									message: "package contains no supported DataTable export"
								},
					sequenceOutput: isSequence
						? runtime.extractLevelSequences(request.path, bytes)
						: {
								schema_version: 1,
								status: "complete",
								path: request.path,
								sequences: [],
								diagnostics: []
							},
					output: runtime.extractBlueprints(request.path, bytes)
				};
			}
			return { status: "ok", output: runtime.extractBlueprints(request.path, bytes) };
		},
		catch: () =>
			new BlueprintBrowserError({
				operation: "decode",
				message: "The browser decoder could not read this file."
			})
	});
});

self.onmessage = (event: MessageEvent<unknown>) => {
	// The worker is a foreign runtime entrypoint. Its owner terminates it on read completion
	// or cancellation; no runtime or file bytes survive the read's resource scope.
	Effect.runFork(
		decode(event).pipe(
			Effect.match({
				onFailure: (error) =>
					self.postMessage({
						status: "failed",
						message: error.message
					} satisfies BlueprintWorkerResponse),
				onSuccess: (response) => self.postMessage(response)
			})
		)
	);
};
