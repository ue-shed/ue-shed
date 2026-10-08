import { LocalizationEvidence, LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { Effect, Metric, Result } from "effect";
import {
	GameTextLocalizationError,
	applyLocalizationKeyChanges,
	joinLocalizationTarget,
	localizationGateFailures,
	localizationGateResult,
	localizationGateTarget,
	localizationKeyChanges,
	textCorpusQuery,
	type LocalizationGateCheck,
	type LocalizationGateResult
} from "@ue-shed/game-text";
import { observeCliOperation } from "../cli-operation.js";
import { CliCommandError, CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import { readChangedFiles } from "./changed-files.js";
import { scanProjectText } from "./localization.js";

type LocalizationGateCommand = Extract<CliCommand, { readonly _tag: "LocalizationGate" }>;

const CHECK_LABELS = {
	key_changed: "Key changed",
	conflicting_source: "Same key, different text",
	translated_text_changed: "Translated text changed",
	text_changed: "Text changed",
	not_gathered: "Not gathered",
	unresolved_key: "No reliable key",
	removed: "Removed",
	gathered_source: "Gathered from source"
} satisfies Record<LocalizationGateCheck, string>;

/** The verdict as a few lines for a person reading a pre-submit dialog. */
export function localizationGateSummary(result: LocalizationGateResult): string {
	const lines: string[] = [];
	for (const target of result.targets) {
		const failing = target.items.filter((item) => item.severity === "fail").length;
		const scope = target.fileScope;
		lines.push(
			`${target.target}: ${target.status}. ${target.lines.toLocaleString("en-US")} lines` +
				(scope === undefined
					? ""
					: ` in ${scope.textFiles.toLocaleString("en-US")} of ${scope.files.toLocaleString("en-US")} files`) +
				`, ${failing.toLocaleString("en-US")} failing.`
		);
		for (const item of target.items) {
			const key = item.key === null ? "(no key)" : `${item.namespace ?? ""},${item.key}`;
			lines.push(
				`  ${item.severity === "fail" ? "FAIL" : "warn"}  ${CHECK_LABELS[item.check]}: ${key} "${item.source}" in ${item.file}`,
				`        ${item.guidance}`
			);
		}
		if (target.omitted > 0)
			lines.push(`  ${target.omitted.toLocaleString("en-US")} more lines not listed.`);
	}
	for (const skipped of result.skipped)
		lines.push(`${skipped.target}: skipped. ${skipped.reason}`);
	lines.push(result.status === "failed" ? "Text check failed." : "Text check passed.", "");
	return lines.join("\n");
}

const loadGate = Effect.fn("Cli.localization.gate")(function* (command: LocalizationGateCommand) {
	const both = command.failOn.filter((check) => command.warnOn.includes(check));
	if (both.length > 0)
		return yield* Effect.fail(
			new CliCommandError({
				message: `${both.join(", ")} cannot both fail and warn. Pass each check to --fail-on or --warn-on, not both.`
			})
		);
	const files = yield* readChangedFiles(command.changedFiles, command.projectRoot);
	const service = yield* LocalizationEvidence;
	const discovery = yield* service.discover({ projectRoot: command.projectRoot });
	const unknown = command.targets.filter(
		(name) => !discovery.targets.some((target) => target.name === name)
	);
	if (unknown.length > 0)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				code: "target_not_found",
				message: `The localization target ${unknown.join(", ")} was not found.`,
				recovery: "Run loc targets and choose a listed target."
			})
		);
	const targets =
		command.targets.length === 0
			? discovery.targets
			: discovery.targets.filter((target) => command.targets.includes(target.name));
	if (targets.length === 0)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				code: "target_not_found",
				message: "The project has no localization targets to check.",
				recovery: "Set up a localization target in Unreal, or check the project root."
			})
		);
	const evidence = yield* Effect.forEach(targets, (target) =>
		service.read({ projectRoot: command.projectRoot, target })
	);
	// A target Unreal has never gathered has no translations to lose. Checking every target skips
	// it; a target named on the command line must be readable.
	const missing = evidence.filter((item) => item.manifest.status === "failed");
	const named = command.targets.length > 0 ? missing[0] : undefined;
	if (named !== undefined || missing.length === evidence.length)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				code: "missing_manifest",
				message: `The manifest of ${(named ?? missing[0])?.target.name ?? "the target"} could not be read.`,
				recovery:
					"Run the target's Unreal gather configuration, or repair the manifest file."
			})
		);
	const skipped = missing.map((item) => ({
		target: item.target.name,
		reason: "Its manifest could not be read; Unreal may never have gathered it."
	}));
	const corpus = yield* scanProjectText(command.projectRoot, command.reader);
	const failOn = localizationGateFailures(command.failOn, command.warnOn);
	const readable = evidence.filter((item) => item.manifest.status !== "failed");
	const results = readable.map((item) => {
		const joined = joinLocalizationTarget(corpus, item);
		const join = applyLocalizationKeyChanges(
			joined,
			localizationKeyChanges(joined, corpus).pairs
		);
		return localizationGateTarget({
			corpus,
			query: textCorpusQuery(corpus, undefined, join),
			join,
			files,
			failOn
		});
	});
	return localizationGateResult(results, failOn, skipped);
});

/**
 * Checks the text in a change's files and exits 1 when the change fails: 0 passed, 1 failed,
 * 2 could not check. It only reads; what a failure means is up to whoever runs it.
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
					yield* printJson({
						schemaVersion: 1,
						status: "not_checked",
						error: result.failure
					});
					yield* runtime.setExitCode(2);
					return;
				}
				const verdict = result.success;
				if (verdict.status === "failed")
					yield* Metric.update(Metric.counter("cli.localization.gate.failed"), 1);
				if (command.summary) yield* runtime.print(localizationGateSummary(verdict));
				else yield* printJson(verdict);
				if (verdict.status === "failed") yield* runtime.setExitCode(1);
			})
		)
);
