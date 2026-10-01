import type { SequenceReadResult } from "@ue-shed/extension-sequencer/contract";
import {
	adaptWasmAuthoringTable,
	type AuthoringReadResult
} from "@ue-shed/extension-data-authoring/wasm";
import { adaptWasmSequenceResult } from "@ue-shed/extension-sequencer/wasm";
import { MAX_ASSET_FILE_BYTES } from "@ue-shed/ui";
import type { BlueprintGraphReadResult } from "@ue-shed/extension-blueprint-graphs/contract";
import { adaptWasmBlueprintResult } from "@ue-shed/extension-blueprint-graphs/wasm";
import type { AssetInspectionReadResult } from "@ue-shed/extension-asset-inspector/contract";
import { adaptWasmInspectionResult } from "@ue-shed/extension-asset-inspector/wasm";
import { Effect, Schema } from "effect";
import { BlueprintBrowserError, BlueprintWorkerResponse } from "./worker-contract.js";

function browserError(operation: string, message: string): BlueprintBrowserError {
	return new BlueprintBrowserError({ operation, message });
}

const decodeBytes = Effect.fn("Website.Blueprints.decodeBytes")(function* (
	path: string,
	bytes: ArrayBuffer,
	operation: "blueprints" | "inspect" | "sequencer" | "authoring" = "blueprints"
) {
	if (bytes.byteLength > MAX_ASSET_FILE_BYTES) {
		return yield* Effect.fail(browserError("size", "Choose a .uasset of up to 64 MiB."));
	}
	const worker = yield* Effect.acquireRelease(
		Effect.try({
			try: () =>
				new Worker(new URL("./blueprint.worker.ts", import.meta.url), {
					type: "module"
				}),
			catch: () => browserError("worker", "The browser could not start the asset decoder.")
		}),
		(worker) =>
			Effect.sync(() => {
				worker.onmessage = null;
				worker.onerror = null;
				worker.onmessageerror = null;
				worker.terminate();
			})
	);
	const reply = yield* Effect.callback<MessageEvent<unknown>, BlueprintBrowserError>((resume) => {
		worker.onmessage = (event: MessageEvent<unknown>) => resume(Effect.succeed(event));
		worker.onerror = (event) => {
			event.preventDefault();
			resume(Effect.fail(browserError("worker", "The asset decoder stopped unexpectedly.")));
		};
		worker.onmessageerror = () =>
			resume(
				Effect.fail(
					browserError("transport", "The browser could not receive saved asset evidence.")
				)
			);
		try {
			worker.postMessage({ path, bytes, operation }, [bytes]);
		} catch {
			resume(
				Effect.fail(
					browserError("transport", "The browser could not send the file to its decoder.")
				)
			);
		}
		return Effect.sync(() => {
			worker.onmessage = null;
			worker.onerror = null;
			worker.onmessageerror = null;
		});
	}).pipe(
		Effect.timeout("30 seconds"),
		Effect.mapError((error) => browserError("transport", error.message))
	);
	const response = yield* Schema.decodeUnknownEffect(BlueprintWorkerResponse)(reply.data).pipe(
		Effect.mapError(() =>
			browserError("transport", "The decoder returned an invalid response.")
		)
	);
	if (response.status === "failed") {
		return yield* Effect.fail(browserError("decode", response.message));
	}
	if (
		(operation === "inspect") !== (response.status === "inspected") ||
		(operation === "sequencer") !== (response.status === "sequenced") ||
		(operation === "authoring") !== (response.status === "authored")
	) {
		return yield* Effect.fail(
			browserError("transport", "The decoder returned the wrong evidence.")
		);
	}
	return response;
}, Effect.scoped);

export const readBlueprintFile = Effect.fn("Website.Blueprints.readFile")(function* (
	file: File
): Effect.fn.Return<BlueprintGraphReadResult, BlueprintBrowserError> {
	if (file.size > MAX_ASSET_FILE_BYTES) {
		return yield* Effect.fail(
			browserError("size", "Choose a Blueprint .uasset of up to 64 MiB.")
		);
	}
	const bytes = yield* Effect.tryPromise({
		try: () => file.arrayBuffer(),
		catch: () => browserError("file", "The browser could not read the selected file.")
	});
	const response = yield* decodeBytes(file.name, bytes);
	return yield* adaptWasmBlueprintResult(file.name, response.output);
});

export const readBlueprintSample = Effect.fn("Website.Blueprints.readSample")(function* (
	url: string
): Effect.fn.Return<BlueprintGraphReadResult, BlueprintBrowserError> {
	// This is the only network read: a public fixture served with the site. User files stay local.
	const response = yield* Effect.tryPromise({
		try: (signal) => fetch(url, { signal }),
		catch: () => browserError("sample", "The sample Blueprint could not be downloaded.")
	});
	if (!response.ok) {
		return yield* Effect.fail(browserError("sample", "The sample Blueprint is unavailable."));
	}
	const bytes = yield* Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: () => browserError("sample", "The sample Blueprint download was interrupted.")
	});
	const decoded = yield* decodeBytes("BP_GraphFixture.uasset", bytes);
	return yield* adaptWasmBlueprintResult("BP_GraphFixture.uasset", decoded.output);
});

export interface SiteAssetRead {
	readonly read: AssetInspectionReadResult;
	readonly blueprint: BlueprintGraphReadResult;
	readonly sequence: SequenceReadResult;
	readonly authoring: AuthoringReadResult;
}

const inspectBytes = Effect.fn("Website.Inspector.decodeBytes")(function* (
	path: string,
	bytes: ArrayBuffer
): Effect.fn.Return<SiteAssetRead, BlueprintBrowserError> {
	const fileBytes = bytes.byteLength;
	const response = yield* decodeBytes(path, bytes, "inspect");
	if (response.status !== "inspected") {
		return yield* Effect.fail(browserError("transport", "The decoder returned no inspection."));
	}
	const read = yield* adaptWasmInspectionResult(path, fileBytes, response.inspection);
	const blueprint = yield* adaptWasmBlueprintResult(path, response.output);
	const sequence = yield* adaptWasmSequenceResult(path, response.sequenceOutput);
	const authoring = yield* adaptWasmAuthoringTable(path, response.authoringOutput);
	return { read, blueprint, sequence, authoring };
});

export const readAssetFile = Effect.fn("Website.Inspector.readFile")(function* (
	file: File
): Effect.fn.Return<SiteAssetRead, BlueprintBrowserError> {
	if (file.size > MAX_ASSET_FILE_BYTES) {
		return yield* Effect.fail(browserError("size", "Choose a .uasset of up to 64 MiB."));
	}
	const bytes = yield* Effect.tryPromise({
		try: () => file.arrayBuffer(),
		catch: () => browserError("file", "The browser could not read the selected file.")
	});
	return yield* inspectBytes(file.name, bytes);
});

export const readAssetSample = Effect.fn("Website.Inspector.readSample")(function* (
	url: string,
	fileName: string
): Effect.fn.Return<SiteAssetRead, BlueprintBrowserError> {
	const response = yield* Effect.tryPromise({
		try: (signal) => fetch(url, { signal }),
		catch: () => browserError("sample", "The sample asset could not be downloaded.")
	});
	if (!response.ok)
		return yield* Effect.fail(browserError("sample", "The sample asset is unavailable."));
	const bytes = yield* Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: () => browserError("sample", "The sample asset download was interrupted.")
	});
	return yield* inspectBytes(fileName, bytes);
});

export const readSequenceFile = Effect.fn("Website.Sequencer.readFile")(function* (
	file: File
): Effect.fn.Return<SequenceReadResult, BlueprintBrowserError> {
	if (file.size > MAX_ASSET_FILE_BYTES) {
		return yield* Effect.fail(browserError("size", "Choose a .uasset of up to 64 MiB."));
	}
	const bytes = yield* Effect.tryPromise({
		try: () => file.arrayBuffer(),
		catch: () => browserError("file", "The browser could not read the selected file.")
	});
	const response = yield* decodeBytes(file.name, bytes, "sequencer");
	return yield* adaptWasmSequenceResult(file.name, response.output);
});

export const readSequenceSample = Effect.fn("Website.Sequencer.readSample")(function* (
	url: string
): Effect.fn.Return<SequenceReadResult, BlueprintBrowserError> {
	const response = yield* Effect.tryPromise({
		try: (signal) => fetch(url, { signal }),
		catch: () => browserError("sample", "The sample Level Sequence could not be downloaded.")
	});
	if (!response.ok) {
		return yield* Effect.fail(
			browserError("sample", "The sample Level Sequence is unavailable.")
		);
	}
	const bytes = yield* Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: () => browserError("sample", "The sample download was interrupted.")
	});
	const decoded = yield* decodeBytes("LS_SavedDetails.uasset", bytes, "sequencer");
	return yield* adaptWasmSequenceResult("LS_SavedDetails.uasset", decoded.output);
});

export const readAuthoringFile = Effect.fn("Website.DataTables.readFile")(function* (
	file: File
): Effect.fn.Return<AuthoringReadResult, BlueprintBrowserError> {
	if (file.size > MAX_ASSET_FILE_BYTES) {
		return yield* Effect.fail(browserError("size", "Choose a .uasset of up to 64 MiB."));
	}
	const bytes = yield* Effect.tryPromise({
		try: () => file.arrayBuffer(),
		catch: () => browserError("file", "The browser could not read the selected file.")
	});
	const response = yield* decodeBytes(file.name, bytes, "authoring");
	return yield* adaptWasmAuthoringTable(file.name, response.output);
});

export const readAuthoringSample = Effect.fn("Website.DataTables.readSample")(function* (
	url: string
): Effect.fn.Return<AuthoringReadResult, BlueprintBrowserError> {
	const response = yield* Effect.tryPromise({
		try: (signal) => fetch(url, { signal }),
		catch: () => browserError("sample", "The sample DataTable could not be downloaded.")
	});
	if (!response.ok) {
		return yield* Effect.fail(browserError("sample", "The sample DataTable is unavailable."));
	}
	const bytes = yield* Effect.tryPromise({
		try: () => response.arrayBuffer(),
		catch: () => browserError("sample", "The sample download was interrupted.")
	});
	const decoded = yield* decodeBytes("DT_Scalars.uasset", bytes, "authoring");
	return yield* adaptWasmAuthoringTable("DT_Scalars.uasset", decoded.output);
});
