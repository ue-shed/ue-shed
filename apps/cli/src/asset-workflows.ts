import { readFile, stat } from "node:fs/promises";
import { EnhancedInputService, EnhancedInputServiceLive } from "@ue-shed/enhanced-input";
import {
	isFullScanEntry,
	resolveScanTarget,
	scanSavedProject,
	type SavedAssetScan
} from "@ue-shed/unreal-assets";
import { Effect, Result } from "effect";
import { CliCommandError, CliRuntime, messageOf, printJson } from "./cli-runtime.js";
import { observeCliOperation, readerLayer } from "./cli-operation.js";
import type { CliCommand } from "./command-model.js";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { loadLocalizationStatus } from "./workflows/localization.js";

function summarizeScan(scan: SavedAssetScan) {
	return {
		schemaVersion: 1,
		projectRoot: scan.summary.projectRoot,
		roots: scan.summary.roots,
		coverage: {
			scannedAssets: scan.summary.scannedAssets,
			emittedAssets: scan.summary.emittedAssets,
			skippedAssets: scan.summary.skippedAssets,
			partialAssets: scan.summary.partialAssets,
			failedAssets: scan.summary.failedAssets
		},
		assets: scan.assets.filter(isFullScanEntry).map((entry) => ({
			path: entry.inspection.path,
			packageName: entry.inspection.package.name,
			status: entry.inspection.status,
			fileBytes: entry.fileBytes,
			objects: entry.inspection.assets.map((asset) => ({
				kind: asset.kind,
				objectPath: asset.object_path,
				...(asset.kind === "UObject" ? { classPath: asset.class_path } : undefined)
			}))
		})),
		failures: scan.failures,
		diagnostics: scan.summary.diagnostics
	};
}

export type AssetsScanCommand = Extract<CliCommand, { readonly _tag: "AssetsScan" }>;
export type TextScanCommand = Extract<CliCommand, { readonly _tag: "TextScan" }>;
export type TextSearchCommand = Extract<CliCommand, { readonly _tag: "TextSearch" }>;
export type TextReviewCommand = Extract<CliCommand, { readonly _tag: "TextReview" }>;
export type TextRulesInitCommand = Extract<CliCommand, { readonly _tag: "TextRulesInit" }>;

export const runTextRulesInit = Effect.fn("Cli.workflow.text_rules_init")(
	(command: TextRulesInitCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { createStarterTextRules } = yield* Effect.promise(
					() => import("@ue-shed/game-text")
				);
				const path = yield* createStarterTextRules(
					command.projectRoot,
					command.output
				).pipe(
					Effect.mapError(
						(error) =>
							new CliCommandError({
								message: `${error.message} ${error.recovery}`
							})
					)
				);
				const runtime = yield* CliRuntime;
				yield* runtime.print(path + "\n");
			})
		)
);
export type InputInspectCommand = Extract<CliCommand, { readonly _tag: "InputInspect" }>;

export const runAssetsScan = Effect.fn("Cli.workflow.assets_scan")((command: AssetsScanCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const scan = yield* Effect.gen(function* () {
				const target = yield* resolveScanTarget(command.path);
				return yield* scanSavedProject({
					projectRoot: target.projectRoot,
					...(target.paths.length > 0 ? { paths: target.paths } : undefined),
					...(command.classes ? { classes: command.classes } : undefined),
					...(command.classPrefixes
						? { classPrefixes: command.classPrefixes }
						: undefined),
					...(command.names ? { names: command.names } : undefined),
					...(command.maximumAssets === undefined
						? undefined
						: { maximumAssets: command.maximumAssets })
				});
			}).pipe(
				Effect.provide(readerLayer(command.reader)),
				Effect.mapError((error) => new CliCommandError({ message: messageOf(error) }))
			);
			return yield* printJson(command.full ? scan : summarizeScan(scan));
		})
	)
);

export const runTextScan = Effect.fn("Cli.workflow.text_scan")((command: TextScanCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const { TextCorpusService, TextCorpusServiceLive } = yield* Effect.promise(
				() => import("@ue-shed/game-text")
			);
			const corpus = yield* Effect.gen(function* () {
				const service = yield* TextCorpusService;
				return yield* service.scan({ projectRoot: command.projectRoot });
			}).pipe(
				Effect.provide(TextCorpusServiceLive),
				Effect.provide(readerLayer(command.reader))
			);
			return yield* printJson(corpus);
		})
	)
);

export const runTextSearch = Effect.fn("Cli.workflow.text_search")((command: TextSearchCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			if (command.query.length === 0) {
				return yield* Effect.fail(
					new CliCommandError({ message: "text search requires a non-empty query" })
				);
			}
			if (command.target !== undefined) {
				const result = yield* loadLocalizationStatus(command).pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.result
				);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				return yield* printJson(result.success);
			}
			if (
				command.culture !== undefined ||
				command.state !== undefined ||
				command.searchTranslations
			) {
				return yield* Effect.fail(
					new CliCommandError({
						message: "Localization search options require --target."
					})
				);
			}
			const { searchTextCorpus, TextCorpusService, TextCorpusServiceLive } =
				yield* Effect.promise(() => import("@ue-shed/game-text"));
			const corpus = yield* Effect.gen(function* () {
				const service = yield* TextCorpusService;
				return yield* service.scan({ projectRoot: command.projectRoot });
			}).pipe(
				Effect.provide(TextCorpusServiceLive),
				Effect.provide(readerLayer(command.reader))
			);
			return yield* printJson({
				schemaVersion: corpus.schemaVersion,
				status: corpus.status,
				query: command.query,
				coverage: corpus.coverage,
				matches: searchTextCorpus(corpus, command.query),
				diagnostics: corpus.diagnostics
			});
		})
	)
);

export const runTextReview = Effect.fn("Cli.workflow.text_review")((command: TextReviewCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const {
				decodeTextQualityRuleDocumentJson,
				evaluateTextQuality,
				TextCorpusScanError,
				TextCorpusService,
				TextCorpusServiceLive
			} = yield* Effect.promise(() => import("@ue-shed/game-text"));
			const ruleJson = yield* Effect.tryPromise({
				try: () => readFile(command.ruleFile, "utf8"),
				catch: () =>
					new CliCommandError({
						message:
							"Could not read the Game Text quality rule file. Confirm it exists and is readable, then retry."
					})
			});
			const document = yield* decodeTextQualityRuleDocumentJson(ruleJson).pipe(
				Effect.mapError(
					(error) =>
						new CliCommandError({
							message: `${error.message} ${error.recovery}`
						})
				)
			);
			const corpus = yield* Effect.gen(function* () {
				const service = yield* TextCorpusService;
				return yield* service.scan({ projectRoot: command.projectRoot });
			}).pipe(
				Effect.provide(TextCorpusServiceLive),
				Effect.provide(readerLayer(command.reader)),
				Effect.mapError(
					(error) =>
						new CliCommandError({
							message:
								error instanceof TextCorpusScanError
									? `Game Text corpus scan failed (${error.code}). ${error.recovery}`
									: "Game Text corpus scan configuration failed. Confirm the saved-asset reader configuration and retry."
						})
				)
			);
			return yield* printJson(evaluateTextQuality(corpus, document));
		})
	)
);

export const runInputInspect = Effect.fn("Cli.workflow.input_inspect")(
	(command: InputInspectCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const report = yield* Effect.gen(function* () {
					const service = yield* EnhancedInputService;
					const info = yield* Effect.tryPromise({
						try: () => stat(command.path),
						catch: (cause) =>
							new CliCommandError({
								message: `Could not read path ${command.path}: ${String(cause)}`
							})
					});
					if (info.isDirectory()) {
						const target = yield* resolveScanTarget(command.path);
						return yield* service.scan({
							projectRoot: target.projectRoot,
							...(target.paths.length > 0 ? { paths: target.paths } : undefined)
						});
					}
					return yield* service.inspectPath(command.path);
				}).pipe(
					Effect.provide(EnhancedInputServiceLive),
					Effect.provide(readerLayer(command.reader)),
					Effect.mapError((error) =>
						error instanceof CliCommandError
							? error
							: new CliCommandError({ message: messageOf(error) })
					)
				);
				return yield* printJson(report);
			})
		)
);
