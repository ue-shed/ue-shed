import { refreshCliGameTextIndex } from "./game-text-index.js";
import { cultureList, parseTextFilter } from "./text-filter.js";
import { readChangedFiles } from "./changed-files.js";
import { textWhere } from "../commands/localization-flags.js";
import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { resolve } from "node:path";
import { Effect, Metric, Result, Schema } from "effect";
import { AssetReaderError } from "@ue-shed/unreal-assets";
import { indexedLocalizationStatusReport } from "@ue-shed/game-text/index";
import {
	GameTextLocalizationError,
	localizationManifestFailure,
	LocalizationSelection,
	type TextCorpus
} from "@ue-shed/game-text/schema";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type LocalizationStatusCommand = Extract<CliCommand, { readonly _tag: "LocalizationStatus" }>;
type LocalizationExportCommand = Extract<CliCommand, { readonly _tag: "LocalizationExport" }>;
type LocalizationSearchCommand = Extract<CliCommand, { readonly _tag: "TextSearch" }>;
type LocalizationCheckCommand = Extract<CliCommand, { readonly _tag: "LocalizationCheck" }>;
type LocalizationReportCommand = Extract<CliCommand, { readonly _tag: "LocalizationReport" }>;

/** Compatibility projection for explicit full-corpus reports and exports. */
export const scanProjectText = Effect.fn("Cli.localization.scan")(function* (
	projectRoot: string,
	reader: string | undefined
) {
	return yield* (yield* refreshCliGameTextIndex({ projectRoot }, reader)).corpus;
});

/** Decode CLI selections and read evidence before starting the saved-package reader. */
export const loadLocalizationContext = Effect.fn("Cli.localization.load_context")(function* (
	command:
		| LocalizationStatusCommand
		| LocalizationSearchCommand
		| LocalizationCheckCommand
		| LocalizationReportCommand
		| LocalizationExportCommand
) {
	const selection = yield* Schema.decodeUnknownEffect(LocalizationSelection)({
		target: command.target,
		...("culture" in command && command.culture !== undefined
			? { culture: command.culture }
			: undefined),
		...("state" in command && command.state !== undefined
			? { state: command.state }
			: undefined),
		...("review" in command && command.review !== undefined
			? { review: command.review }
			: undefined),
		...("keyChanged" in command && command.keyChanged ? { keyChanged: true } : undefined),
		...("cultures" in command && cultureList(command.cultures) !== undefined
			? { cultures: cultureList(command.cultures) }
			: undefined),
		...(command._tag === "TextSearch" && command.searchTranslations !== undefined
			? { searchTranslations: command.searchTranslations }
			: undefined)
	}).pipe(
		Effect.mapError(
			(cause) =>
				new GameTextLocalizationError({
					cause: cause,
					retrySafe: false,
					nextStep: "fix_input",
					code: "invalid_selection",
					message: "The localization selection is invalid.",
					recovery: "Use loc targets to list target names and cultures."
				})
		)
	);
	const service = yield* LocalizationEvidence;
	const discovery = yield* service.discover({ projectRoot: command.projectRoot });
	const target = discovery.targets.find((item) => item.name === selection.target);
	if (!target)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "target_not_found",
				message: "The selected localization target was not found.",
				recovery: "Run loc targets and choose a listed target."
			})
		);
	if (selection.culture !== undefined && !target.cultures.includes(selection.culture))
		return yield* Effect.fail(
			new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "invalid_selection",
				message: "The selected culture is not supported by the target.",
				recovery: "Choose a culture listed by loc targets."
			})
		);
	const indexed = yield* refreshCliGameTextIndex(
		{ projectRoot: command.projectRoot, targetName: target.name, requireManifest: true },
		command.reader
	).pipe(
		Effect.mapError((cause) =>
			"localizationError" in cause && cause.localizationError
				? localizationManifestFailure(cause.localizationError, target.outputPaths.manifest)
				: new GameTextLocalizationError({
						cause,
						retrySafe: cause.retrySafe,
						nextStep: cause.nextStep,
						code: "reader_failure",
						message: cause.message,
						recovery: cause.recovery
					})
		)
	);
	if (indexed.evidence.manifest.status === "failed")
		return yield* Effect.fail(
			localizationManifestFailure(
				indexed.evidence.manifest.error,
				indexed.evidence.manifest.relativePath
			)
		);
	return {
		joined: indexed.joined,
		check: indexed.prepareLocalizationCheck,
		/** Whole-corpus and join reads for evidence and export workflows. */
		corpus: indexed.corpus,
		join: indexed.localizationJoin,
		evidence: indexed.evidence,
		selection,
		localization: indexed.localization,
		query: indexed.query,
		review: indexed.review,
		keyChanges: { pairs: indexed.joined.meta.pairs, ambiguous: indexed.joined.meta.ambiguous }
	};
});

/** A target's query over a scan already made, for saved investigations that filter by target. */
export const loadTargetQuery = Effect.fn("Cli.localization.target_query")(function* (
	projectRoot: string,
	targetName: string,
	_corpus: TextCorpus
) {
	const service = yield* LocalizationEvidence;
	const discovery = yield* service.discover({ projectRoot });
	const target = discovery.targets.find((item) => item.name === targetName);
	if (!target)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "target_not_found",
				message: `The localization target ${targetName} was not found.`,
				recovery: "Run loc targets and choose a listed target, or edit the preset."
			})
		);
	const indexed = yield* refreshCliGameTextIndex(
		{ projectRoot, targetName: target.name, requireManifest: true },
		undefined
	);
	if (indexed.evidence.manifest.status === "failed")
		return yield* Effect.fail(
			localizationManifestFailure(
				indexed.evidence.manifest.error,
				indexed.evidence.manifest.relativePath
			)
		);
	return indexed.query;
}, Effect.provide(LocalizationEvidenceNodeLive));

function whereField(command: Parameters<typeof textWhere>[0], files?: readonly string[]) {
	const where = textWhere(command, files);
	return where === undefined ? undefined : { where };
}

/** The request's `filter` for the command's `--filter` clauses; absent when none was given. */
const filterField = Effect.fn("Cli.localization.filter")(function* (command: {
	readonly filter?: readonly string[];
}) {
	if (command.filter === undefined) return undefined;
	return { filter: yield* parseTextFilter(command.filter) };
});

export const loadLocalizationStatus = Effect.fn("Cli.localization.load_status")(function* (
	command: LocalizationStatusCommand | LocalizationSearchCommand
) {
	const { query, evidence, selection } = yield* loadLocalizationContext(command);
	const files =
		command.changedFiles === undefined
			? undefined
			: yield* readChangedFiles(command.changedFiles, command.projectRoot);
	const filter = yield* filterField(command);
	const page = yield* query.search({
		capability: "all",
		pageSize: command.limit ?? 50,
		query: command._tag === "TextSearch" ? command.query : "",
		localization: selection,
		...whereField(command, files),
		...filter,
		...(command.group === undefined ? undefined : { group: command.group })
	});
	yield* Metric.update(Metric.counter("cli.localization.status.lines"), page.total);
	return yield* indexedLocalizationStatusReport(query, evidence, page);
});

export const runLocalizationStatus = Effect.fn("Cli.workflow.localization_status")(
	(command: LocalizationStatusCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
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
				yield* printJson(result.success);
			})
		)
);

class LocalizationExportError extends Schema.TaggedError<LocalizationExportError>()(
	"LocalizationExportError",
	{
		retrySafe: Schema.Boolean,
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literals(["invalid_destination", "destination_exists", "unwritable"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

/** Writes every matching line, with a column per culture, to a new CSV file. */
export const runLocalizationExport = Effect.fn("Cli.workflow.localization_export")(
	(command: LocalizationExportCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const work = Effect.gen(function* () {
					if (!command.output.toLowerCase().endsWith(".csv"))
						return yield* Effect.fail(
							new LocalizationExportError({
								retrySafe: false,
								nextStep: "fix_input",
								code: "invalid_destination",
								message: "The export destination must be a CSV file.",
								recovery: "Choose a new .csv file."
							})
						);
					const { query, selection } = yield* loadLocalizationContext(command);
					const files =
						command.changedFiles === undefined
							? undefined
							: yield* readChangedFiles(command.changedFiles, command.projectRoot);
					const filter = yield* filterField(command);
					// The engine encodes the spreadsheet and writes the file; no line reaches the CLI.
					const unwritable = new LocalizationExportError({
						retrySafe: false,
						nextStep: "fix_input",
						code: "unwritable",
						message: "The export file could not be created.",
						recovery: "Choose a writable directory and a new file name."
					});
					const written = yield* query
						.writeLocalizationLinesCsv(
							{
								capability: "all",
								query: "",
								localization: selection,
								...whereField(command, files),
								...filter
							},
							{ path: resolve(command.output), exclusive: true }
						)
						.pipe(
							Effect.mapError((error) =>
								Schema.is(AssetReaderError)(error.cause) &&
								error.cause.code === "io_error"
									? unwritable
									: error
							)
						);
					if (written.status === "exists")
						return yield* new LocalizationExportError({
							retrySafe: false,
							nextStep: "fix_input",
							code: "destination_exists",
							message: "The export destination already exists.",
							recovery: "Choose a new file; existing files are never overwritten."
						});
					const rows = written.rows;
					yield* Metric.update(Metric.counter("cli.localization.export.rows"), rows);
					return { schemaVersion: 1, status: "written", path: command.output, rows };
				});
				const result = yield* work.pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.result
				);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				yield* printJson(result.success);
			})
		)
);

export const runLocalizationTargets = Effect.fn("Cli.workflow.localization_targets")(
	(command: Extract<CliCommand, { readonly _tag: "LocalizationTargets" }>) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const service = yield* LocalizationEvidence;
				const result = yield* service
					.targets({ projectRoot: command.projectRoot })
					.pipe(Effect.result);
				if (Result.isFailure(result)) {
					yield* printJson({ schemaVersion: 1, status: "failed", error: result.failure });
					const runtime = yield* CliRuntime;
					yield* runtime.setExitCode(2);
					return;
				}
				yield* printJson(result.success);
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		)
);
