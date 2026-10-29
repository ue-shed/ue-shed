import { ErrorNextStep } from "@ue-shed/protocol/errors";
import { Option, Schema } from "effect";

/**
 * The CLI's exit codes. A command that could not do its work exits 2, or 3 when its error says
 * the same command may succeed later, so a script or a build can tell a change that failed a
 * check (1) from a run that could not check it, and a crash (4) from both. The error's code and
 * `nextStep` say more.
 */
export const CLI_EXIT_CODES = [
	{ exit: 0, name: "done", meaning: "The command finished; a check passed." },
	{ exit: 1, name: "failed", meaning: "A check ran, and the change failed it." },
	{
		exit: 2,
		name: "not_run",
		meaning:
			"It could not do its work. The error's code and recovery say why: usually the command, the project or the setup needs changing."
	},
	{
		exit: 3,
		name: "retry",
		meaning:
			"Something it reads, such as Perforce, was unavailable; the same command may succeed later."
	},
	{
		exit: 4,
		name: "crashed",
		meaning: "An internal error with no typed cause; report it with the output."
	},
	{ exit: 130, name: "interrupted", meaning: "Stopped by Ctrl+C or a termination signal." }
] as const;

/** An exit code's name in {@link CLI_EXIT_CODES}. */
export type CliExitName = (typeof CLI_EXIT_CODES)[number]["name"];

/** The exit code a name stands for. */
export function cliExit(name: CliExitName): number {
	return CLI_EXIT_CODES.find((row) => row.name === name)?.exit ?? 4;
}

/** The exit code of a typed failure with this next step. */
export function cliNextStepExit(nextStep: ErrorNextStep): number {
	return cliExit(nextStep === "retry" ? "retry" : "not_run");
}

/** What the CLI reads from a failure to report it and exit with it. */
export const CliFailure = Schema.Struct({
	_tag: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.String),
	recovery: Schema.optionalKey(Schema.String),
	nextStep: Schema.optionalKey(ErrorNextStep),
	code: Schema.optionalKey(Schema.String),
	kind: Schema.optionalKey(Schema.String)
});
export type CliFailure = typeof CliFailure.Type;

/** A failure, and the typed failure a generic CLI error wraps, both read at the CLI's edge. */
export interface CliFailureReport {
	readonly failure: CliFailure;
	readonly cause?: CliFailure | undefined;
}

const decodeFailure = Schema.decodeUnknownOption(CliFailure);

/** Reads a failure and its cause, when they carry what {@link CliFailure} names. */
export const readCliFailure = (failure: { readonly cause?: unknown }): CliFailureReport => {
	const cause = Option.getOrUndefined(decodeFailure(failure.cause));
	return {
		failure: Option.getOrElse(decodeFailure(failure), () => ({})),
		...(cause === undefined ? undefined : { cause })
	};
};

/** The CLI's generic advice says nothing a typed cause's recovery does not say better. */
const GENERIC_RECOVERY =
	"Inspect the command context and original cause before deciding whether to retry.";

/**
 * The exit code a failure ends the CLI with, from its next step, looking through a generic CLI
 * error to the typed cause it wraps; an interruption is 130, and anything untyped a crash.
 */
export function cliFailureExit(report: CliFailureReport): number {
	const { failure, cause } = report;
	if (failure._tag === "CliSignalError" || cause?._tag === "CliSignalError")
		return cliExit("interrupted");
	const nextStep =
		failure.nextStep === "escalate" && cause?.nextStep !== undefined
			? cause.nextStep
			: failure.nextStep;
	return nextStep === undefined ? cliExit("crashed") : cliNextStepExit(nextStep);
}

/** A failure's stable code: its `code`, or a Map History error's `kind`, never the generic one. */
export function cliFailureCode(report: CliFailureReport): string | undefined {
	for (const value of [report.failure, report.cause]) {
		const code = value?.code ?? value?.kind;
		if (code !== undefined && code !== "cli_command_failed") return code;
	}
	return undefined;
}

/** What to do about a failure: the typed cause's recovery when a generic CLI error wraps one. */
export function cliFailureRecovery(report: CliFailureReport): string | undefined {
	const own = report.failure.recovery;
	const recovery = own === undefined || own === GENERIC_RECOVERY ? report.cause?.recovery : own;
	return recovery === GENERIC_RECOVERY ? undefined : recovery;
}

/**
 * One failure a changelist check can end with: its code, what causes it, how to fix it, and the
 * next steps it carries, which give its exit code.
 */
export interface CliErrorRow {
	readonly code: string;
	readonly cause: string;
	readonly fix: string;
	readonly nextSteps: readonly ErrorNextStep[];
}

/** The failures `loc gate` and `loc diff` can end with. The docs' error table is generated from it. */
export const CHANGE_CHECK_ERRORS: readonly CliErrorRow[] = [
	{
		code: "cli_command_failed",
		cause: "The flags contradict each other, such as `--change` with `--files`, or a check passed to both `--fail-on` and `--warn-on`.",
		fix: "Pass one of `--files`, `--change` and `--shelved`, and each check to one policy flag.",
		nextSteps: ["fix_input"]
	},
	{
		code: "target_not_found",
		cause: "A `--target` the project does not have, or a project with no localization target.",
		fix: "Run `loc targets` and name a listed target.",
		nextSteps: ["fix_input"]
	},
	{
		code: "missing_manifest",
		cause: "A named target has no manifest: Unreal has not gathered it, or had not when the change was made.",
		fix: "Run the target's gather in Unreal, or leave the target out.",
		nextSteps: ["fix_input"]
	},
	{
		code: "unreadable_manifest",
		cause: "The target's manifest exists but cannot be read or parsed.",
		fix: "Get the manifest again from version control, or gather again.",
		nextSteps: ["fix_input"]
	},
	{
		code: "unreadable_evidence",
		cause: "An archive or PO file exists but cannot be read, so translations are unknown.",
		fix: "Get the file again from version control, then check again.",
		nextSteps: ["fix_input"]
	},
	{
		code: "unreadable_package",
		cause: "A changed package could not be read at all, so its text cannot be judged.",
		fix: "Check that the package is saved and not damaged, and that the reader supports its engine version.",
		nextSteps: ["fix_input"]
	},
	{
		code: "invalid_target",
		cause: "Perforce does not know the changelist, or `--change` names a pending change or `--shelved` a submitted one.",
		fix: "Check the number; pass `--change` for a submitted change and `--shelved` for a shelf.",
		nextSteps: ["fix_input"]
	},
	{
		code: "ambiguous_depot_mapping",
		cause: "No Perforce workspace maps the project folder.",
		fix: "Run it from a workspace that maps the project, or set `P4CLIENT` to one.",
		nextSteps: ["fix_input"]
	},
	{
		code: "perforce_authentication",
		cause: "Perforce refused the session or the depot path.",
		fix: "Log in with `p4 login`, or ask for access to the project's depot path.",
		nextSteps: ["fix_input"]
	},
	{
		code: "perforce_configuration",
		cause: "Perforce has no usable server or client settings.",
		fix: "Check `P4PORT`, `P4USER` and `P4CLIENT`, or the project's P4CONFIG file.",
		nextSteps: ["fix_input"]
	},
	{
		code: "perforce_command",
		cause: "A Perforce read failed: the connection dropped or timed out, or the server reported an error.",
		fix: "Run it again; if it keeps failing, report it with the Perforce message.",
		nextSteps: ["retry", "escalate"]
	},
	{
		code: "index_failed",
		cause: "The Game Text engine could not read the change's files or compare them, or its cache settings are wrong.",
		fix: "Follow the error's recovery; a busy or interrupted engine can be run again.",
		nextSteps: ["fix_input", "retry", "reconcile", "escalate"]
	},
	{
		code: "cli_signal_failed",
		cause: "Ctrl+C or a termination signal stopped the run.",
		fix: "Run it again.",
		nextSteps: []
	}
];

/** The error table's start marker in the docs: generated, never edited by hand. */
export const ERROR_TABLE_START =
	"<!-- error table: generated from CHANGE_CHECK_ERRORS in apps/cli/src/cli-exit.ts; do not edit -->";
/** The exit-code table's start marker in the docs. */
export const EXIT_TABLE_START =
	"<!-- exit table: generated from CLI_EXIT_CODES in apps/cli/src/cli-exit.ts; do not edit -->";
/** Where a generated table ends. */
export const TABLE_END = "<!-- end of generated table -->";

const table = (header: readonly string[], rows: readonly (readonly string[])[]) => {
	const all = [header, ...rows];
	const widths = header.map((_, column) =>
		Math.max(...all.map((row) => [...row[column]!].length))
	);
	const line = (cells: readonly string[]) =>
		`| ${cells.map((cell, column) => cell + " ".repeat(widths[column]! - [...cell].length)).join(" | ")} |`;
	return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
		"\n"
	);
};

/** The exit codes as a Markdown table. */
export function cliExitTable(): string {
	return table(
		["Exit", "Name", "Meaning"],
		CLI_EXIT_CODES.map((row) => [String(row.exit), `\`${row.name}\``, row.meaning])
	);
}

/** The changelist check's failures as a Markdown table. */
export function cliErrorTable(): string {
	return table(
		["Code", "Cause", "Fix", "Exit"],
		CHANGE_CHECK_ERRORS.map((row) => [
			`\`${row.code}\``,
			row.cause,
			row.fix,
			row.nextSteps.length === 0
				? String(cliExit("interrupted"))
				: [...new Set(row.nextSteps.map(cliNextStepExit))].join(" or ")
		])
	);
}

/** A document with each generated table, between its markers, replaced; undefined without one. */
export function withCliTables(document: string): string | undefined {
	let next = document;
	for (const [start, body] of [
		[EXIT_TABLE_START, cliExitTable()],
		[ERROR_TABLE_START, cliErrorTable()]
	] as const) {
		const from = next.indexOf(start);
		const to = next.indexOf(TABLE_END, from);
		if (from < 0 || to < from) return undefined;
		next = `${next.slice(0, from + start.length)}\n\n${body}\n\n${next.slice(to)}`;
	}
	return next;
}
