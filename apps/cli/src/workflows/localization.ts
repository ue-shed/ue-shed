import { cultureList, parseTextFilter } from "./text-filter.js";
import { readChangedFiles } from "./changed-files.js";
import { textWhere } from "../commands/localization-flags.js";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	readLocalizationReview
} from "@ue-shed/localization";
import { Effect, FileSystem, Metric, Result, Schema } from "effect";
import {
	GameTextLocalizationError,
	LocalizationSelection,
	applyLocalizationKeyChanges,
	applyLocalizationReview,
	joinLocalizationTarget,
	localizationKeyChanges,
	localizationLinesCsv,
	pickedLocalizationCultures,
	localizationStatusReport,
	textCorpusQuery,
	TextCorpusService,
	TextCorpusServiceLive
} from "@ue-shed/game-text";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type LocalizationStatusCommand = Extract<CliCommand, { readonly _tag: "LocalizationStatus" }>;
type LocalizationExportCommand = Extract<CliCommand, { readonly _tag: "LocalizationExport" }>;
type LocalizationSearchCommand = Extract<CliCommand, { readonly _tag: "TextSearch" }>;
type LocalizationCheckCommand = Extract<CliCommand, { readonly _tag: "LocalizationCheck" }>;
type LocalizationReportCommand = Extract<CliCommand, { readonly _tag: "LocalizationReport" }>;

/** Scans the project's saved text once; every target a command reads joins the same corpus. */
export const scanProjectText = Effect.fn("Cli.localization.scan")(function* (
	projectRoot: string,
	reader: string | undefined
) {
	return yield* Effect.gen(function* () {
		const service = yield* TextCorpusService;
		return yield* service.scan({ projectRoot });
	}).pipe(
		Effect.provide(TextCorpusServiceLive),
		Effect.provide(readerLayer(reader)),
		Effect.mapError(
			() =>
				new GameTextLocalizationError({
					code: "reader_failure",
					message: "The saved-package text reader could not complete the scan.",
					recovery:
						"Verify that the project root is readable and configure UE_SHED_UASSET_EXECUTABLE or --reader with a supported saved-asset reader, then retry."
				})
		)
	);
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
			() =>
				new GameTextLocalizationError({
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
				code: "target_not_found",
				message: "The selected localization target was not found.",
				recovery: "Run loc targets and choose a listed target."
			})
		);
	if (selection.culture !== undefined && !target.cultures.includes(selection.culture))
		return yield* Effect.fail(
			new GameTextLocalizationError({
				code: "invalid_selection",
				message: "The selected culture is not supported by the target.",
				recovery: "Choose a culture listed by loc targets."
			})
		);
	const evidence = yield* service.read({ projectRoot: command.projectRoot, target });
	if (evidence.manifest.status === "failed")
		return yield* Effect.fail(
			new GameTextLocalizationError({
				code: "missing_manifest",
				message: "The target manifest could not be read.",
				recovery:
					"Run the target's Unreal gather configuration, or repair the manifest file."
			})
		);
	const corpus = yield* scanProjectText(command.projectRoot, command.reader);
	// The review file is UE Shed's own project data; a missing file means nothing is reviewed yet.
	const review = yield* readLocalizationReview({
		projectRoot: command.projectRoot,
		target: target.name
	}).pipe(Effect.provide(LocalizationFileAccessLive));
	// Review is tracked once the target has a review file; until then reports say "not tracked".
	const joined = applyLocalizationReview(
		joinLocalizationTarget(corpus, evidence, target),
		review.contentHash === null ? undefined : review.file
	);
	// Saved text whose key changed since the last gather pairs with the key Unreal still lists.
	const keyChanges = localizationKeyChanges(joined, corpus);
	const join = applyLocalizationKeyChanges(joined, keyChanges.pairs);
	return { corpus, join, evidence, selection, review, keyChanges };
});

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
	const { corpus, join, evidence, selection } = yield* loadLocalizationContext(command);
	const files =
		command.changedFiles === undefined
			? undefined
			: yield* readChangedFiles(command.changedFiles, command.projectRoot);
	const filter = yield* filterField(command);
	const page = textCorpusQuery(corpus, undefined, join).search({
		capability: "all",
		pageSize: command.limit ?? 50,
		query: command._tag === "TextSearch" ? command.query : "",
		localization: selection,
		...whereField(command, files),
		...filter,
		...(command.group === undefined ? undefined : { group: command.group })
	});
	yield* Metric.update(Metric.counter("cli.localization.status.lines"), page.total);
	return localizationStatusReport(corpus, evidence, page);
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

class LocalizationExportError extends Schema.TaggedErrorClass<LocalizationExportError>()(
	"LocalizationExportError",
	{
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
								code: "invalid_destination",
								message: "The export destination must be a CSV file.",
								recovery: "Choose a new .csv file."
							})
						);
					const { corpus, join, selection } = yield* loadLocalizationContext(command);
					const files =
						command.changedFiles === undefined
							? undefined
							: yield* readChangedFiles(command.changedFiles, command.projectRoot);
					const filter = yield* filterField(command);
					const lines = textCorpusQuery(corpus, undefined, join).localizationLines({
						capability: "all",
						query: "",
						localization: selection,
						...whereField(command, files),
						...filter
					});
					const { csv, rows } = localizationLinesCsv({
						join,
						lines,
						corpus,
						cultures: pickedLocalizationCultures(selection)
					});
					const fs = yield* FileSystem.FileSystem;
					yield* fs.writeFileString(command.output, csv, { flag: "wx" }).pipe(
						Effect.mapError(
							(error) =>
								new LocalizationExportError(
									error.reason._tag === "AlreadyExists"
										? {
												code: "destination_exists",
												message: "The export destination already exists.",
												recovery:
													"Choose a new file; existing files are never overwritten."
											}
										: {
												code: "unwritable",
												message: "The export file could not be created.",
												recovery:
													"Choose a writable directory and a new file name."
											}
								)
						)
					);
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
