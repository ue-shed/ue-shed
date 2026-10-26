import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { LocalizationError } from "@ue-shed/localization";
import { SharedIndex, sharedIndexDirectory } from "./shared-index.js";
import { defaultLocalizationImportLimits } from "./localization-stream.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import type {
	LocalizationFileImportRequest,
	LocalizationFileSnapshotKey
} from "./localization-import.js";
import { nativeLocalizationStat, rememberNativeLocalizationStat } from "./localization-import.js";

/** The leased writer owns parsing, dictionary construction and atomic cold publication. */
export const importColdLocalizationTarget = Effect.fn("LocalizationSnapshot.importColdTarget")(
	function* (requests: readonly LocalizationFileImportRequest[], budgetOverride?: number) {
		const report = yield* GameTextIndexProgressReporter;
		const store = yield* SharedIndex;
		const writer = yield* store.writer();
		if (!writer.importLocalization) return undefined;
		const states = yield* Effect.forEach(requests, nativeLocalizationStat, {
			concurrency: "unbounded"
		});
		const maximumInFlightBytes = Math.max(
			1,
			Math.floor(Math.min(256 * 1024 ** 2, budgetOverride ?? Infinity))
		);
		const result = yield* writer.importLocalization(
			{
				files: requests.map((request) => ({
					projectRoot: request.projectRoot,
					file: resolve(request.projectRoot, request.relativePath),
					relativePath: request.relativePath,
					options: {
						format: request.format,
						...(request.poFormat ? { poFormat: request.poFormat } : undefined),
						...(request.collapseMode
							? { collapseMode: request.collapseMode }
							: undefined)
					},
					limits: request.limits ?? defaultLocalizationImportLimits
				})),
				maximumInFlightBytes,
				cold: true
			},
			(completed, total) => report({ phase: "localization", completed, total })
		);
		for (const file of result.files) {
			if (file.error)
				return yield* Effect.fail(
					Schema.decodeUnknownSync(LocalizationError)({
						_tag: "LocalizationError",
						...file.error
					})
				);
		}
		for (const [row, file] of result.files.entries()) {
			if (file.file)
				yield* rememberNativeLocalizationStat(
					states[row]!,
					file.file.contentHash,
					file.file.key
				);
		}
		report({ phase: "localization_publish", completed: 0, total: 0 });
		const metrics = writer.metrics();
		yield* Effect.annotateCurrentSpan({
			"localization.import.stage_ms.parse": result.parseMs,
			"localization.import.stage_ms.parse_cpu": result.parseCpuMs,
			"localization.import.stage_ms.publish": result.publishMs,
			"localization.import.workerCount": result.workerCount,
			"localization.import.maximumInFlightBytes": maximumInFlightBytes
		});
		const files: LocalizationFileSnapshotKey[] = result.files.map((entry, row) => {
			const file = entry.file!;
			return {
				...file,
				statHit: false,
				readBytes: file.inputBytes,
				directory: sharedIndexDirectory({
					cacheRoot: requests[row]!.cacheRoot,
					projectKey: requests[row]!.projectRoot,
					targetKey: requests[row]!.sharedTargetKey ?? "localization"
				}),
				sharedBytesAppended: row ? 0 : metrics.appendedBytes,
				sharedReadBytes: row ? 0 : metrics.readBytes,
				sharedIndexReadBytes: row ? 0 : metrics.indexReadBytes,
				lookupStrings: 0,
				reusedStrings: 0,
				probePasses: 0,
				profile: {
					sortMs: metrics.sortMs,
					probeMs: 0,
					appendMs: metrics.appendMs,
					segments: metrics.segments
				}
			};
		});
		return {
			files,
			profile: {
				workerCount: result.workerCount,
				memoryBudgetBytes: maximumInFlightBytes,
				parseMs: result.parseMs,
				publishMs: result.publishMs,
				...metrics
			}
		};
	}
);
