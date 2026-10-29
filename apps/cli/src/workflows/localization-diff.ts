import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import type { LocalizationGateChange } from "@ue-shed/game-text/checks";
import type { GameTextContract } from "@ue-shed/protocol";
import { Effect } from "effect";
import { observeCliOperation } from "../cli-operation.js";
import { CliRuntime, printJson } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import {
	changeSelection,
	readChange,
	selectTargets,
	unreadableFiles,
	usageError
} from "./change-check.js";
import { CHECK_LABELS } from "./localization-gate-format.js";

type LocalizationDiffCommand = Extract<CliCommand, { readonly _tag: "LocalizationDiff" }>;

/** One target's differences and impact, without a verdict. */
export interface LocalizationDiffTarget {
	readonly target: string;
	/** Whether the base had the target's manifest; without it there is no impact. */
	readonly localized: boolean;
	readonly complete: boolean;
	readonly counts: GameTextContract.PointChangeCounts;
	/** Changed lines; `changes` lists the first `--limit` of them. */
	readonly total: number;
	readonly changes: readonly GameTextContract.PointChange[];
	readonly impact?: GameTextContract.PointFindings;
}

/** What `loc diff` prints as JSON. */
export interface LocalizationDiffResult {
	readonly schemaVersion: 1;
	readonly change: LocalizationGateChange;
	readonly targets: readonly LocalizationDiffTarget[];
}

const count = (value: number) => value.toLocaleString("en-US");

const KIND = { added: "+", removed: "-", rekeyed: "~", edited: "*" } as const;

/** Where a line lives: a code file's line, or a package's object and property. */
function where(change: GameTextContract.PointChange): string {
	const place = change.place;
	if (place.kind === "code") return `${change.path}:${place.line ?? 0}`;
	const inner = [place.object, place.entry, place.property].filter((part) => part.length > 0);
	return inner.length === 0 ? change.path : `${change.path} (${inner.join(" ")})`;
}

const identity = (text: GameTextContract.PointText | undefined) =>
	text === undefined || text.status === "missing_key"
		? "(no key)"
		: `${text.namespace},${text.key}`;

/** One change as a line: its kind, key (both for a rekey), text (both for an edit) and place. */
function changeLine(change: GameTextContract.PointChange): string {
	const before = change.before;
	const after = change.after;
	const key =
		change.kind === "rekeyed"
			? `${identity(before)} -> ${identity(after)}`
			: identity(after ?? before);
	const text =
		change.kind === "edited" && change.sourceChanged
			? `"${before?.source ?? ""}" -> "${after?.source ?? ""}"`
			: `"${(after ?? before)?.source ?? ""}"`;
	return `${KIND[change.kind]} ${change.kind.padEnd(7)} ${key} ${text}  ${where(change)}`;
}

function findingLine(finding: GameTextContract.PointFinding): string {
	const key =
		finding.key === undefined ? "(no key)" : `${finding.namespace ?? ""},${finding.key}`;
	const cultures = finding.cultures.length === 0 ? "" : ` [${finding.cultures.join(", ")}]`;
	const earlier =
		finding.earlier === undefined
			? ""
			: ` (was ${finding.earlier.namespace},${finding.earlier.key})`;
	return finding.check === "partial_read" || finding.check === "gathered_source"
		? `${CHECK_LABELS[finding.check]}: ${finding.path}`
		: `${CHECK_LABELS[finding.check]}: ${key}${earlier} "${finding.source}" in ${finding.path}${cultures}`;
}

const IMPACT = [
	["keyChanged", "key_changed"],
	["conflictingSource", "conflicting_source"],
	["translatedTextChanged", "translated_text_changed"],
	["textChanged", "text_changed"],
	["notGathered", "not_gathered"],
	["unresolvedKey", "unresolved_key"],
	["removed", "removed"],
	["gatheredSource", "gathered_source"],
	["partialRead", "partial_read"]
] as const;

function countsLine(counts: GameTextContract.PointChangeCounts): string {
	return `${count(counts.added)} added, ${count(counts.removed)} removed, ${count(counts.rekeyed)} rekeyed, ${count(counts.edited)} edited, ${count(counts.unchanged)} unchanged`;
}

function impactLine(impact: GameTextContract.PointFindings): string {
	const found = IMPACT.filter(([field]) => impact.counts[field] > 0).map(
		([field, check]) => `${count(impact.counts[field])} ${CHECK_LABELS[check].toLowerCase()}`
	);
	return found.length === 0 ? "nothing" : found.join(", ");
}

/** The differences as lines for a terminal or a build log. */
export function localizationDiffText(result: LocalizationDiffResult): string {
	const lines: string[] = [];
	for (const target of result.targets) {
		lines.push(
			`${target.target}: ${result.change.point} over ${result.change.base}: ${countsLine(target.counts)}.`
		);
		for (const change of target.changes) lines.push(`  ${changeLine(change)}`);
		if (target.total > target.changes.length)
			lines.push(
				`  ${count(target.total - target.changes.length)} more changes not listed; raise --limit.`
			);
		if (target.impact === undefined) {
			lines.push("  Impact: not judged; the base had no manifest for this target.");
			continue;
		}
		lines.push(`  Impact: ${impactLine(target.impact)}.`);
		for (const finding of target.impact.rows) lines.push(`    ${findingLine(finding)}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** The differences as Markdown for a build summary or a review comment. */
export function localizationDiffMarkdown(result: LocalizationDiffResult): string {
	const lines = [`### Text changes: ${result.change.point}`, ""];
	for (const target of result.targets) {
		lines.push(`**${target.target}**: ${countsLine(target.counts)}.`, "");
		if (target.changes.length > 0) {
			lines.push("```text", ...target.changes.map(changeLine), "```");
			if (target.total > target.changes.length)
				lines.push(
					`${count(target.total - target.changes.length)} more changes not listed.`
				);
			lines.push("");
		}
		if (target.impact === undefined) {
			lines.push("Impact: not judged; the base had no manifest for this target.", "");
			continue;
		}
		lines.push(`Impact: ${impactLine(target.impact)}.`, "");
		for (const finding of target.impact.rows) lines.push(`- ${findingLine(finding)}`);
		if (target.impact.rows.length > 0) lines.push("");
	}
	return lines.join("\n");
}

/**
 * Lists the text a change adds, removes, rekeys or edits per target, and what it does to the
 * target's translations as the change found them, without a verdict: it exits 0 whenever it
 * could read the change.
 */
export const runLocalizationDiff = Effect.fn("Cli.workflow.localization_diff")(
	(command: LocalizationDiffCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const runtime = yield* CliRuntime;
				if (
					!Number.isSafeInteger(command.limit) ||
					command.limit < 1 ||
					command.limit > 1000
				)
					return yield* Effect.fail(
						usageError("--limit takes a number of lines from 1 to 1,000.")
					);
				const selection = yield* changeSelection(command);
				const targets = yield* selectTargets(command.projectRoot, command.targets);
				const read = yield* readChange({
					projectRoot: command.projectRoot,
					selection,
					targetNames: targets.map((target) => target.name),
					changes: { offset: 0, limit: command.limit },
					...(command.reader === undefined ? undefined : { reader: command.reader })
				});
				yield* unreadableFiles(read.targets);
				const result: LocalizationDiffResult = {
					schemaVersion: 1,
					change: read.change,
					targets: read.targets.map((target) => ({
						target: target.target ?? "",
						localized: target.localized,
						complete: target.comparison.complete,
						counts: target.comparison.counts,
						total: target.comparison.total,
						changes: target.comparison.changes,
						...(target.comparison.findings === undefined
							? undefined
							: {
									impact: {
										...target.comparison.findings,
										rows: target.comparison.findings.rows.slice(
											0,
											command.limit
										)
									}
								})
					}))
				};
				if (command.format === "text") yield* runtime.print(localizationDiffText(result));
				else if (command.format === "markdown")
					yield* runtime.print(localizationDiffMarkdown(result));
				else yield* printJson(result);
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		)
);
