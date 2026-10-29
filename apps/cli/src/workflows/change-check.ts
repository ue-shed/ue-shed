import { ErrorNextStep } from "@ue-shed/protocol/errors";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { LocalizationGateChange } from "@ue-shed/game-text/checks";
import { GameTextLocalizationError } from "@ue-shed/game-text/schema";
import { GameTextIndexError } from "@ue-shed/game-text/index";
import { Effect, Schema } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import { readChangedFiles } from "./changed-files.js";
import { readChangelistPoints, readLocalPoints, type TargetPoints } from "./changelist-points.js";
import { cliCacheRoot, cliGameTextIndexLayer, cliProjectCode } from "./game-text-index.js";

type ChangeCommand = Extract<
	CliCommand,
	{ readonly _tag: "LocalizationGate" | "LocalizationDiff" }
>;

/** The change a check reads: listed files on disk, or a submitted or shelved changelist. */
export type ChangeSelection =
	| { readonly kind: "files"; readonly list: string }
	| { readonly kind: "change"; readonly change: number; readonly shelved: boolean };

/** The flags were wrong; the message says how. */
export const usageError = (message: string) =>
	new CliCommandError({
		recovery: "Change the flags as the message says, then run it again.",
		retrySafe: false,
		nextStep: "fix_input",
		code: "cli_command_failed",
		message
	});

/** Exactly one of `--files`, `--change` and `--shelved`. */
export function changeSelection(command: ChangeCommand) {
	const named = [
		command.changedFiles === undefined ? [] : ["--files"],
		command.change === undefined ? [] : ["--change"],
		command.shelved === undefined ? [] : ["--shelved"]
	].flat();
	if (named.length !== 1)
		return Effect.fail(
			usageError(
				named.length === 0
					? "Name the change to check: --files <list>, --change <CL> or --shelved <CL>."
					: `${named.join(" and ")} name different changes. Pass one of them.`
			)
		);
	const number = command.change ?? command.shelved;
	if (number !== undefined && (!Number.isSafeInteger(number) || number < 1))
		return Effect.fail(usageError(`${number} is not a changelist number.`));
	const selection: ChangeSelection =
		command.changedFiles !== undefined || number === undefined
			? { kind: "files", list: command.changedFiles ?? "" }
			: { kind: "change", change: number, shelved: command.shelved !== undefined };
	return Effect.succeed(selection);
}

/**
 * The targets a check reads: the named ones, or every target the project has. A name the project
 * does not have, or a project with no target, fails.
 */
export const selectTargets = Effect.fn("Cli.localization.select_targets")(function* (
	projectRoot: string,
	names: readonly string[]
) {
	const discovery = yield* (yield* LocalizationEvidence).discover({ projectRoot });
	const unknown = names.filter(
		(name) => !discovery.targets.some((target) => target.name === name)
	);
	if (unknown.length > 0)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "target_not_found",
				message: `The localization target ${unknown.join(", ")} was not found.`,
				recovery: "Run loc targets and choose a listed target."
			})
		);
	const targets =
		names.length === 0
			? discovery.targets
			: discovery.targets.filter((target) => names.includes(target.name));
	if (targets.length === 0)
		return yield* Effect.fail(
			new GameTextLocalizationError({
				retrySafe: false,
				nextStep: "fix_input",
				code: "target_not_found",
				message: "The project has no localization targets to check.",
				recovery: "Set up a localization target in Unreal, or check the project root."
			})
		);
	return targets;
});

/** The change could not be judged: a verdict here could pass what it never saw. */
export class LocalizationGateError extends Schema.TaggedError<LocalizationGateError>()(
	"LocalizationGateError",
	{
		retrySafe: Schema.Boolean,
		nextStep: ErrorNextStep,
		cause: Schema.optionalKey(Schema.Defect()),
		code: Schema.Literals(["unreadable_evidence", "unreadable_package"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}

/** Changed packages, or code and config files, a point could not read at all. */
export function unreadableFiles(targets: readonly TargetPoints[]) {
	const failed = new Set(
		targets.flatMap((target) =>
			[...target.before.entries, ...target.after.entries].flatMap((entry) =>
				entry.status === "failed" ? [entry.path] : []
			)
		)
	);
	if (failed.size === 0) return Effect.void;
	const paths = [...failed];
	return Effect.fail(
		new LocalizationGateError({
			retrySafe: false,
			nextStep: "fix_input",
			code: "unreadable_package",
			message: `Changed files could not be read: ${paths.slice(0, 200).join(", ")}.${paths.length > 200 ? ` ${paths.length - 200} more files omitted.` : ""}`,
			recovery:
				"Check that the packages are saved and not damaged, and that the reader supports their engine version, then check again."
		})
	);
}

const configurationFailure = (cause: unknown) =>
	new GameTextIndexError({
		nextStep: "fix_input",
		retrySafe: false,
		code: "index_failed",
		operation: "configuration",
		cause,
		message: "The game text index cache root or engine configuration is invalid.",
		recovery: "Check UE_SHED_PROJECT_INDEX_CACHE_ROOT and the engine settings, then retry."
	});

/**
 * Reads a change's two points for each target and compares them: a changelist from Perforce, or
 * listed files on disk over the revisions the workspace has. Code is read with the project's
 * engine when one is found. `change` says what was read.
 */
export const readChange = Effect.fn("Cli.localization.read_change")(function* (input: {
	readonly projectRoot: string;
	readonly selection: ChangeSelection;
	readonly targetNames: readonly string[];
	readonly reader?: string;
	readonly changes?: { readonly offset: number; readonly limit: number };
}) {
	const cacheRoot = yield* cliCacheRoot.pipe(Effect.mapError(configurationFailure));
	const code = yield* cliProjectCode(input.projectRoot).pipe(
		Effect.catchTag("ConfigError", (cause) => Effect.fail(configurationFailure(cause)))
	);
	const common = {
		projectRoot: input.projectRoot,
		cacheRoot,
		targetNames: input.targetNames,
		...(code === undefined ? undefined : { code }),
		...(input.changes === undefined ? undefined : { changes: input.changes })
	};
	const read =
		input.selection.kind === "change"
			? Effect.map(
					readChangelistPoints({
						...common,
						change: input.selection.change,
						shelved: input.selection.shelved
					}),
					({ revisions, targets }) => ({
						targets,
						read: revisions.files.length,
						files: revisions.files.length + revisions.skipped.length,
						outside: revisions.outside
					})
				)
			: Effect.flatMap(readChangedFiles(input.selection.list, input.projectRoot), (files) =>
					Effect.map(readLocalPoints({ ...common, files }), ({ skipped, targets }) => ({
						targets,
						read: files.length - skipped.length,
						files: files.length,
						outside: 0
					}))
				);
	const result = yield* read.pipe(
		Effect.provide(cliGameTextIndexLayer(input.reader)),
		Effect.catchTag("ConfigError", (cause) => Effect.fail(configurationFailure(cause)))
	);
	const first = result.targets[0];
	const change: LocalizationGateChange = {
		point: first?.comparison.point ?? "",
		base: first?.comparison.base ?? "",
		files: result.files,
		read: result.read,
		outside: result.outside,
		code: code !== undefined
	};
	return { targets: result.targets, change };
});
