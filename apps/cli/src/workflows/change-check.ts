import { join } from "node:path";
import { ErrorNextStep } from "@ue-shed/protocol/errors";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { LocalizationGateChange } from "@ue-shed/game-text/checks";
import { GameTextLocalizationError } from "@ue-shed/game-text/schema";
import {
	GameTextIndexError,
	readGameTextChangePoints,
	unreadableChangePaths,
	type GameTextTargetPoints
} from "@ue-shed/game-text/index";
import type { GameTextChange } from "@ue-shed/game-text/schema";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { perforceChangeRevisions } from "@ue-shed/map-history";
import { Effect, Schema } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import type { CliCommand } from "../command-model.js";
import { readChangedFiles } from "./changed-files.js";
import { cliCacheRoot, cliGameTextIndexLayer, cliProjectCode } from "./game-text-index.js";

type ChangeCommand = Extract<
	CliCommand,
	{ readonly _tag: "LocalizationGate" | "LocalizationDiff" }
>;

/** The change a check reads: listed files on disk, or a changelist, a shelf or a range. */
export type ChangeSelection =
	| { readonly kind: "files"; readonly list: string }
	| { readonly kind: "change"; readonly change: Exclude<GameTextChange, { kind: "local" }> };

/** The flags were wrong; the message says how. */
export const usageError = (message: string) =>
	new CliCommandError({
		recovery: "Change the flags as the message says, then run it again.",
		retrySafe: false,
		nextStep: "fix_input",
		code: "cli_command_failed",
		message
	});

/** Exactly one of `--files`, `--change`, `--shelved`, and `--from` with `--to`. */
export function changeSelection(command: ChangeCommand) {
	const range = command.from !== undefined || command.to !== undefined;
	const named = [
		command.changedFiles === undefined ? [] : ["--files"],
		command.change === undefined ? [] : ["--change"],
		command.shelved === undefined ? [] : ["--shelved"],
		range ? ["--from and --to"] : []
	].flat();
	if (named.length !== 1)
		return Effect.fail(
			usageError(
				named.length === 0
					? "Name the change to check: --files <list>, --change <CL>, --shelved <CL>, or --from <CL> --to <CL>."
					: `${named.slice(0, -1).join(", ")} and ${named.at(-1)} name different changes. Pass one of them.`
			)
		);
	const numbers = [command.change, command.shelved, command.from, command.to].flatMap((value) =>
		value === undefined ? [] : [value]
	);
	const bad = numbers.find((number) => !Number.isSafeInteger(number) || number < 1);
	if (bad !== undefined) return Effect.fail(usageError(`${bad} is not a changelist number.`));
	if (range && (command.from === undefined || command.to === undefined))
		return Effect.fail(usageError("A range takes both --from <CL> and --to <CL>."));
	if (command.from !== undefined && command.to !== undefined && command.to <= command.from)
		return Effect.fail(
			usageError(
				`--to ${command.to} is not after --from ${command.from}. Name the later changelist as --to.`
			)
		);
	const selection: ChangeSelection =
		command.from !== undefined && command.to !== undefined
			? { kind: "change", change: { kind: "range", from: command.from, to: command.to } }
			: command.change !== undefined
				? { kind: "change", change: { kind: "submitted", change: command.change } }
				: command.shelved !== undefined
					? { kind: "change", change: { kind: "shelved", change: command.shelved } }
					: { kind: "files", list: command.changedFiles ?? "" };
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
export function unreadableFiles(targets: readonly GameTextTargetPoints[]) {
	const paths = unreadableChangePaths(targets);
	if (paths.length === 0) return Effect.void;
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
	const change: GameTextChange =
		input.selection.kind === "change"
			? input.selection.change
			: {
					kind: "local",
					files: yield* readChangedFiles(input.selection.list, input.projectRoot)
				};
	const result = yield* readGameTextChangePoints({
		projectRoot: input.projectRoot,
		change,
		revisions: perforceChangeRevisions({ directory: join(cacheRoot, "revisions") }),
		targetNames: input.targetNames,
		...(code === undefined ? undefined : { code }),
		...(input.changes === undefined ? undefined : { changes: input.changes })
	}).pipe(
		Effect.provide(cliGameTextIndexLayer(input.reader)),
		Effect.provide(LocalizationEvidenceNodeLive),
		Effect.catchTag("ConfigError", (cause) => Effect.fail(configurationFailure(cause)))
	);
	return { targets: result.targets, change: result.change };
});
