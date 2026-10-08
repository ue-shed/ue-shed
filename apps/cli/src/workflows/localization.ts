import { readChangedFiles } from "./changed-files.js";
import { textWhere } from "../commands/localization-flags.js";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	readLocalizationReview
} from "@ue-shed/localization";
import { Effect, Metric, Result, Schema } from "effect";
import {
	GameTextLocalizationError,
	LocalizationSelection,
	applyLocalizationReview,
	joinLocalizationTarget,
	localizationStatusReport,
	textCorpusQuery,
	TextCorpusService,
	TextCorpusServiceLive
} from "@ue-shed/game-text";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";

type LocalizationStatusCommand = Extract<CliCommand, { readonly _tag: "LocalizationStatus" }>;
type LocalizationSearchCommand = Extract<CliCommand, { readonly _tag: "TextSearch" }>;
type LocalizationCheckCommand = Extract<CliCommand, { readonly _tag: "LocalizationCheck" }>;
type LocalizationReportCommand = Extract<CliCommand, { readonly _tag: "LocalizationReport" }>;

/** Decode CLI selections and read evidence before starting the saved-package reader. */
export const loadLocalizationContext = Effect.fn("Cli.localization.load_context")(function* (
	command:
		| LocalizationStatusCommand
		| LocalizationSearchCommand
		| LocalizationCheckCommand
		| LocalizationReportCommand
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
	const corpus = yield* Effect.gen(function* () {
		const reader = yield* TextCorpusService;
		return yield* reader.scan({ projectRoot: command.projectRoot });
	}).pipe(
		Effect.provide(TextCorpusServiceLive),
		Effect.provide(readerLayer(command.reader)),
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
	// The review file is UE Shed's own project data; a missing file means nothing is reviewed yet.
	const review = yield* readLocalizationReview({
		projectRoot: command.projectRoot,
		target: target.name
	}).pipe(Effect.provide(LocalizationFileAccessLive));
	// Review is tracked once the target has a review file; until then reports say "not tracked".
	const join = applyLocalizationReview(
		joinLocalizationTarget(corpus, evidence, target),
		review.contentHash === null ? undefined : review.file
	);
	return { corpus, join, evidence, selection, review };
});

function whereField(command: Parameters<typeof textWhere>[0], files?: readonly string[]) {
	const where = textWhere(command, files);
	return where === undefined ? undefined : { where };
}

export const loadLocalizationStatus = Effect.fn("Cli.localization.load_status")(function* (
	command: LocalizationStatusCommand | LocalizationSearchCommand
) {
	const { corpus, join, evidence, selection } = yield* loadLocalizationContext(command);
	const files =
		command.changedFiles === undefined
			? undefined
			: yield* readChangedFiles(command.changedFiles, command.projectRoot);
	const page = textCorpusQuery(corpus, undefined, join).search({
		capability: "all",
		pageSize: command.limit ?? 50,
		query: command._tag === "TextSearch" ? command.query : "",
		localization: selection,
		...whereField(command, files)
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
