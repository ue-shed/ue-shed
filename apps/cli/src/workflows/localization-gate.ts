import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { Effect, Metric, Result } from "effect";
import {
	localizationGateComparison,
	localizationGateFailures,
	localizationGateResult,
	indexedLocalizationGateTarget,
	localizationGateUnreadEvidence,
	localizationGatePartialPackages,
	localizationGateUnreadPackages,
	type LocalizationGateCheck,
	type LocalizationGateResult
} from "@ue-shed/game-text/checks";
import { GameTextLocalizationError, localizationManifestFailure } from "@ue-shed/game-text/schema";
import { cliFailureExit, readCliFailure } from "../cli-exit.js";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import {
	LocalizationGateError,
	changeSelection,
	readChange,
	selectTargets,
	unreadableFiles,
	usageError,
	type ChangeSelection
} from "./change-check.js";
import { readChangedFiles } from "./changed-files.js";
import { refreshCliGameTextIndex } from "./game-text-index.js";
import { localizationGateMarkdown, localizationGateSummary } from "./localization-gate-format.js";

export { localizationGateMarkdown, localizationGateSummary };

type LocalizationGateCommand = Extract<CliCommand, { readonly _tag: "LocalizationGate" }>;

/** A named target with no manifest fails; checking every target skips one. */
const ungatheredFailure = (target: string, reason: string) =>
	new GameTextLocalizationError({
		retrySafe: false,
		nextStep: "fix_input",
		code: "missing_manifest",
		message: `${target} has no manifest; ${reason}`,
		recovery: "Run the target's Unreal gather configuration first."
	});

/**
 * Checks listed files as they are on disk: every line whose text lives in one, through the
 * refreshed index, so a problem a touched file already had counts too.
 */
const loadFilesGate = Effect.fn("Cli.localization.gate")(function* (
	command: LocalizationGateCommand,
	list: string,
	failOn: readonly LocalizationGateCheck[]
) {
	const files = yield* readChangedFiles(list, command.projectRoot);
	const targets = yield* selectTargets(command.projectRoot, command.targets);
	const indexed = yield* Effect.forEach(targets, (target) =>
		refreshCliGameTextIndex(
			{ projectRoot: command.projectRoot, targetName: target.name, changedFiles: files },
			command.reader
		)
	);
	const evidence = indexed.map((item) => item.evidence);
	// A target whose manifest does not exist was never gathered and has no translations to lose.
	// Checking every target skips it; a target named on the command line must have one.
	const ungathered = evidence.filter(
		(item) => item.manifest.status === "failed" && item.manifest.error.code === "file_missing"
	);
	const named = command.targets.length > 0 ? ungathered[0] : undefined;
	if (named !== undefined || ungathered.length === evidence.length)
		return yield* Effect.fail(
			ungatheredFailure(
				(named ?? ungathered[0])?.target.name ?? "The target",
				"Unreal has not gathered it."
			)
		);
	const checked = evidence.filter((item) => !ungathered.includes(item));
	for (const item of checked) {
		if (item.manifest.status === "failed")
			return yield* Effect.fail(
				localizationManifestFailure(item.manifest.error, item.manifest.relativePath)
			);
	}
	// Files that exist but cannot be read make translations unknown, never absent.
	const unread = checked.flatMap(localizationGateUnreadEvidence);
	if (unread.length > 0) {
		const errors = checked.flatMap((item) =>
			item.cultures.flatMap((culture) =>
				[culture.archive, culture.po].flatMap((file) =>
					file.status === "failed" && file.error.code !== "file_missing"
						? [file.error]
						: []
				)
			)
		);
		return yield* Effect.fail(
			new LocalizationGateError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "unreadable_evidence",
				message: `Localization files could not be read: ${unread.join(", ")}. ${errors.map((error) => error.message).join(" ")}`,
				recovery: [...new Set(errors.map((error) => error.recovery))].join(" ")
			})
		);
	}
	const skipped = ungathered.map((item) => ({
		target: item.target.name,
		reason: "It has no manifest; Unreal has not gathered it."
	}));
	// The listed packages' coverage alone says which were read, selected natively.
	const header = yield* indexed[0]!.query.readFileCoverage(files);
	const unscanned = localizationGateUnreadPackages(header, files);
	if (unscanned.length > 0)
		return yield* Effect.fail(
			new LocalizationGateError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "unreadable_package",
				message: `Changed packages could not be read: ${unscanned.slice(0, 200).join(", ")}.${unscanned.length > 200 ? ` ${unscanned.length - 200} more packages omitted.` : ""}`,
				recovery:
					"Check that the packages are saved and not damaged, and that the reader supports their engine version, then check again."
			})
		);
	const partial = localizationGatePartialPackages(header, files);
	const results = yield* Effect.forEach(checked, (item) =>
		Effect.gen(function* () {
			const result = indexed.find((result) => result.evidence === item)!;
			// One projected line read answers every check, in Rust.
			return yield* indexedLocalizationGateTarget(result.query, {
				join: result.localization,
				files,
				failOn,
				partial
			});
		})
	);
	return localizationGateResult(results, failOn, skipped);
});

/**
 * Checks a submitted or shelved changelist, or a range of submitted ones, from Perforce: its files
 * before the change and at it, judged against the target's localization as the change found it,
 * so only what the change introduces counts. It needs no workspace synced to the change.
 */
const loadChangeGate = Effect.fn("Cli.localization.gate_change")(function* (
	command: LocalizationGateCommand,
	selection: Extract<ChangeSelection, { readonly kind: "change" }>,
	failOn: readonly LocalizationGateCheck[]
) {
	const targets = yield* selectTargets(command.projectRoot, command.targets);
	const read = yield* readChange({
		projectRoot: command.projectRoot,
		selection,
		targetNames: targets.map((target) => target.name),
		...(command.reader === undefined ? undefined : { reader: command.reader })
	});
	yield* unreadableFiles(read.targets);
	const ungathered = read.targets.filter((target) => !target.localized);
	const named = command.targets.length > 0 ? ungathered[0] : undefined;
	if (named !== undefined || ungathered.length === read.targets.length)
		return yield* Effect.fail(
			ungatheredFailure(
				(named ?? ungathered[0])?.target ?? "The target",
				"it had none when the change was made, so Unreal had not gathered it."
			)
		);
	const results = read.targets.flatMap((target) =>
		target.localized && target.target !== undefined
			? [
					localizationGateComparison({
						target: target.target,
						comparison: target.comparison,
						failOn
					})
				]
			: []
	);
	const skipped = ungathered.map((target) => ({
		target: target.target ?? "",
		reason: "It had no manifest when the change was made; Unreal had not gathered it."
	}));
	return { ...localizationGateResult(results, failOn, skipped), change: read.change };
});

const loadGate = Effect.fn("Cli.localization.load_gate")(function* (
	command: LocalizationGateCommand
) {
	const both = command.failOn.filter((check) => command.warnOn.includes(check));
	if (both.length > 0)
		return yield* Effect.fail(
			usageError(
				`${both.join(", ")} cannot both fail and warn. Pass each check to --fail-on or --warn-on, not both.`
			)
		);
	const selection = yield* changeSelection(command);
	const failOn = localizationGateFailures(command.failOn, command.warnOn);
	return selection.kind === "files"
		? yield* loadFilesGate(command, selection.list, failOn)
		: yield* loadChangeGate(command, selection, failOn);
});

/** The way forward the CLI adds: the commands that carry translations, and the stricter policy. */
function withCliGuidance(result: LocalizationGateResult): LocalizationGateResult {
	return {
		...result,
		targets: result.targets.map((target) => ({
			...target,
			items: target.items.map((item) =>
				item.check === "key_changed"
					? {
							...item,
							guidance: `${item.guidance} Use loc run prepare --carry and loc apply --sync.`
						}
					: item.check === "partial_read" && item.severity === "warn"
						? {
								...item,
								guidance: `${item.guidance} To stop such a change instead, pass --fail-on partial_read.`
							}
						: item
			)
		}))
	};
}

/**
 * Checks the text a change touches and exits 1 when the change fails, 0 when it passes, and 2 or
 * more when it could not check (see `CLI_EXIT_CODES`). It only reads; what a failure means is up
 * to whoever runs it.
 */
export const runLocalizationGate = Effect.fn("Cli.workflow.localization_gate")(
	(command: LocalizationGateCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				const result = yield* loadGate(command).pipe(
					Effect.provide(LocalizationEvidenceNodeLive),
					Effect.result
				);
				// "not_checked", not "failed", so a script never mistakes a broken run for a verdict.
				if (Result.isFailure(result)) {
					if (command.format === "json")
						yield* printJson({
							schemaVersion: 1,
							status: "not_checked",
							error: result.failure
						});
					else
						yield* runtime.print(
							`${command.format === "markdown" ? "### Text not checked\n\n" : ""}${result.failure.message}\n${result.failure.recovery}\n`
						);
					yield* runtime.setExitCode(cliFailureExit(readCliFailure(result.failure)));
					return;
				}
				const verdict = withCliGuidance(result.success);
				if (verdict.status === "failed")
					yield* Metric.update(Metric.counter("cli.localization.gate.failed"), 1);
				if (command.format === "text")
					yield* runtime.print(localizationGateSummary(verdict));
				else if (command.format === "markdown")
					yield* runtime.print(localizationGateMarkdown(verdict));
				else yield* printJson(verdict);
				if (verdict.status === "failed") yield* runtime.setExitCode(1);
			})
		)
);
