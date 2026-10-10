import { parentPort } from "node:worker_threads";
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
		let peakRss = process.memoryUsage().rss;
		const sample = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 25);
		try {
			const file = await Effect.runPromise(
				prepareLocalizationFile(task.request, task.stagedFile)
			);
			parentPort!.postMessage({
				ok: true,
				file,
				rss: Math.max(peakRss, process.memoryUsage().rss)
			});
		} catch (error) {
			// Structured clone strips custom Error properties; send the schema's wire value.
			const encoded = Schema.encodeUnknownSync(
				Schema.Union([LocalizationError, SnapshotStoreError, SnapshotFormatError])
			)(error);
			parentPort!.postMessage({ ok: false, error: encoded });
		} finally {
			clearInterval(sample);
		}
	}
);
