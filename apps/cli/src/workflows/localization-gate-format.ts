import {
	LOCALIZATION_GATE_CHECK_LABELS,
	LocalizationGateCheck,
	type LocalizationGateItem,
	type LocalizationGateResult
} from "@ue-shed/game-text/checks";

/** Each check as a reviewer reads it. */
export const CHECK_LABELS = LOCALIZATION_GATE_CHECK_LABELS;

const count = (value: number) => value.toLocaleString("en-US");

/** What was checked: a changelist, a shelf, a range, or the listed files. */
function subject(result: LocalizationGateResult): string {
	const change = result.change;
	if (change === undefined || change.point === "local") return "the listed files";
	if (change.point.startsWith("shelved:"))
		return `shelved changelist ${change.point.slice("shelved:".length)}`;
	if (change.point.startsWith("range:"))
		return `changelists ${change.point.slice("range:".length).replace("..", " to ")}`;
	return `changelist ${change.point.replace(/^depot@/u, "")}`;
}

const itemKey = (item: LocalizationGateItem) =>
	item.key === null ? "(no key)" : `${item.namespace ?? ""},${item.key}`;

/** The verdict as a few lines for a person reading a pre-submit dialog or a build log. */
export function localizationGateSummary(result: LocalizationGateResult): string {
	const lines: string[] = [];
	for (const target of result.targets) {
		const failing = target.items.filter((item) => item.severity === "fail").length;
		const scope = target.fileScope;
		const checked =
			result.change === undefined
				? `${count(target.lines)} lines` +
					(scope === undefined
						? ""
						: ` in ${count(scope.textFiles)} of ${count(scope.files)} files`)
				: `${count(target.lines)} changed lines in ${subject(result)}`;
		lines.push(`${target.target}: ${target.status}. ${checked}, ${count(failing)} failing.`);
		for (const item of target.items) {
			// A partly read package is about the file, not a line of text.
			const what =
				item.check === "partial_read" || item.check === "gathered_source"
					? item.file
					: `${itemKey(item)} "${item.source}" in ${item.file}`;
			lines.push(
				`  ${item.severity === "fail" ? "FAIL" : "warn"}  ${CHECK_LABELS[item.check]}: ${what}`,
				`        ${item.guidance}`
			);
		}
		if (target.omitted > 0) lines.push(`  ${count(target.omitted)} more lines not listed.`);
	}
	for (const skipped of result.skipped)
		lines.push(`${skipped.target}: skipped. ${skipped.reason}`);
	lines.push(result.status === "failed" ? "Text check failed." : "Text check passed.", "");
	return lines.join("\n");
}

/** Text as Markdown shows it literally: inline code that its own backticks cannot end. */
function code(value: string): string {
	const text = value.replace(/\r?\n/gu, " ");
	const fence = "`".repeat(
		Math.max(0, ...[...text.matchAll(/`+/gu)].map((m) => m[0].length)) + 1
	);
	return fence === "`" ? `\`${text}\`` : `${fence} ${text} ${fence}`;
}

/** The most warnings the Markdown lists per target; the JSON output has them all. */
const MARKDOWN_WARNINGS = 20;

function markdownItem(item: LocalizationGateItem): string[] {
	const what =
		item.check === "partial_read" || item.check === "gathered_source"
			? code(item.file)
			: `${code(itemKey(item))} ${code(item.source)} in ${code(item.file)}`;
	return [`- **${CHECK_LABELS[item.check]}**: ${what}`, `  ${item.guidance}`];
}

/**
 * The verdict as Markdown for a build's summary or a review comment: the outcome, a count per
 * check that found something, the failing lines with a way forward, the first warnings, and what
 * the check read and did not.
 */
export function localizationGateMarkdown(result: LocalizationGateResult): string {
	const failing = new Set(result.failOn);
	const lines = [
		`### Text check ${result.status === "failed" ? "failed" : "passed"}: ${subject(result)}`,
		""
	];
	for (const target of result.targets) {
		const fails = target.items.filter((item) => item.severity === "fail");
		const warns = target.items.filter((item) => item.severity === "warn");
		const found = LocalizationGateCheck.literals.filter((check) => target.checks[check] > 0);
		lines.push(
			`**${target.target}**: ${target.status}, ${count(target.lines)} ${result.change === undefined ? "lines" : "changed lines"} checked.`,
			""
		);
		if (found.length > 0) {
			lines.push("| Check | Lines | Policy |", "| --- | ---: | --- |");
			for (const check of found)
				lines.push(
					`| ${CHECK_LABELS[check]} | ${count(target.checks[check])} | ${failing.has(check) ? "fails" : "warns"} |`
				);
			lines.push("");
		}
		if (fails.length > 0) lines.push("Failing:", "", ...fails.flatMap(markdownItem), "");
		if (warns.length > 0) {
			const shown = warns.slice(0, MARKDOWN_WARNINGS);
			lines.push("Warnings:", "", ...shown.flatMap(markdownItem));
			const more = warns.length - shown.length + target.omitted;
			if (more > 0)
				lines.push(`- ${count(more)} more, listed by \`--format json\` (up to 200).`);
			lines.push("");
		} else if (target.omitted > 0)
			lines.push(`${count(target.omitted)} more lines not listed.`, "");
	}
	for (const skipped of result.skipped)
		lines.push(`**${skipped.target}**: skipped. ${skipped.reason}`, "");
	lines.push(`Coverage: ${coverage(result)}`, "");
	return lines.join("\n");
}

/** What the check read and what it cannot see. */
function coverage(result: LocalizationGateResult): string {
	const change = result.change;
	const gap = "Reflected metadata (DisplayName, ToolTip) is not checked.";
	if (change === undefined) {
		const scope = result.targets.find((target) => target.fileScope !== undefined)?.fileScope;
		const read =
			scope === undefined
				? "the listed files"
				: `${count(scope.textFiles)} of ${count(scope.files)} listed files with text`;
		return `read ${read}, as they are on disk. ${gap}`;
	}
	const outside =
		change.outside > 0 ? `; ${count(change.outside)} outside the project were left out` : "";
	const engine = change.code
		? "Code and config files were read with the project's engine; String Table CSVs and wrapper macros come from the workspace."
		: "Code and config files were not read, since no engine was found, so their text is listed as gathered from source.";
	return (
		`read ${count(change.read)} of the ${count(change.files)} files the change touches in the project, ` +
		`before the change and at it${outside}. ${engine} ${gap}`
	);
}
