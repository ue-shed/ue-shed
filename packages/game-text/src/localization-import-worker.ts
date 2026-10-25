import { parentPort } from "node:worker_threads";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { prepareColdStringRuns, type PreparedColdStrings } from "./shared-string-sort.js";
import { Effect, Schema } from "effect";
import { LocalizationError } from "@ue-shed/localization";
import { SnapshotStoreError } from "./snapshot-store.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import {
	prepareLocalizationFile,
	type LocalizationFileImportRequest
} from "./localization-import.js";

if (!parentPort) throw new Error("Localization parser requires its owning worker pool.");
parentPort.on(
	"message",
	async (task: { request: LocalizationFileImportRequest; stagedFile: string }) => {
		try {
			let preparedStrings: PreparedColdStrings | undefined;
			const started = performance.now();
			const file = await Effect.runPromise(
				prepareLocalizationFile(task.request, task.stagedFile, async (source) => {
					const directory = `${task.stagedFile}.strings`;
					await mkdir(directory);
					preparedStrings = await prepareColdStringRuns(source, directory);
				})
			);
			parentPort!.postMessage({
				ok: true,
				file: { ...file, totalMs: performance.now() - started },
				preparedStrings
			});
		} catch (error) {
			// Structured clone strips custom Error properties; send the schema's wire value.
			const encoded = Schema.encodeUnknownSync(
				Schema.Union([LocalizationError, SnapshotStoreError, SnapshotFormatError])
			)(error);
			parentPort!.postMessage({ ok: false, error: encoded });
		}
	}
);
