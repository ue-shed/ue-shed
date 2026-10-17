import { Effect, Option } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import { Argument, Command, Flag } from "effect/cli";
import { LocalizationGateCheck } from "@ue-shed/game-text/checks";
import {
	BuiltInCheckId,
	LocalizationReviewLens,
	LocalizationState,
	TextOriginKind
} from "@ue-shed/game-text/schema";
import { runLocalizationCheck } from "../workflows/localization-check.js";
import { runLocalizationGate } from "../workflows/localization-gate.js";
import { runLocalizationReport } from "../workflows/localization-report.js";
import {
	runLocalizationExport,
	runLocalizationStatus,
	runLocalizationTargets
} from "../workflows/localization.js";
import {
	localizationFlags,
	optionalLocalizationFlags,
	optionalWhereFlags,
	filterFlags,
	optionalFilterFlags
} from "./localization-flags.js";
import { LocalizationOperation, LocalizationReviewFlag } from "@ue-shed/localization/browser";
import { runLocalizationReview } from "../workflows/localization-review.js";
import { runLocalizationOperation } from "../workflows/localization-run.js";
import { applyLocalizationChanges } from "../workflows/localization-apply.js";

export const localizationCommand = Command.make("loc").pipe(
	Command.withDescription("Read saved Unreal localization targets."),
	Command.withSubcommands([
		Command.make(
			"run",
			{
				operation: Argument.Literals("operation", LocalizationOperation.literals),
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				engineRoot: Flag.String("engine-root").pipe(Flag.optional),
				carry: Flag.String("carry").pipe(Flag.optional),
				plan: Flag.Boolean("plan").pipe(Flag.withDefault(false)),
				json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
				timeout: Flag.Int("timeout").pipe(Flag.withDefault(1800))
			},
			({ operation, projectRoot, target, engineRoot, carry, plan, json, timeout }) => {
				const command = {
					_tag: "LocalizationRun",
					operation,
					projectRoot,
					target,
					plan,
					json,
					timeout
				} satisfies Extract<
					import("../command-model.js").CliCommand,
					{ readonly _tag: "LocalizationRun" }
				>;
				if (Option.isSome(engineRoot))
					Object.assign(command, { engineRoot: engineRoot.value });
				if (Option.isSome(carry)) {
					if (operation !== "gather" && operation !== "prepare")
						return Effect.fail(
							new CliCommandError({
								recovery:
									"Inspect the command context and original cause before deciding whether to retry.",
								retrySafe: false,
								nextStep: "escalate",
								code: "cli_command_failed",
								message:
									"--carry needs a run that gathers: use loc run gather or loc run prepare."
							})
						);
					Object.assign(command, { carry: carry.value });
				}
				return runLocalizationOperation(command);
			}
		).pipe(
			Command.withDescription(
				"Plan or run Unreal localization steps; sync imports then compiles."
			)
		),
		Command.make(
			"apply",
			{
				projectRoot: Argument.String("project-root"),
				changes: Flag.String("changes"),
				skipStale: Flag.Boolean("skip-stale").pipe(Flag.withDefault(false)),
				review: Flag.Boolean("review").pipe(Flag.withDefault(false)),
				sync: Flag.Boolean("sync").pipe(Flag.withDefault(false)),
				engineRoot: Flag.String("engine-root").pipe(Flag.optional),
				json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
				timeout: Flag.Int("timeout").pipe(Flag.withDefault(1800))
			},
			({ projectRoot, changes, skipStale, review, sync, engineRoot, json, timeout }) => {
				const command = {
					_tag: "LocalizationApply",
					projectRoot,
					changes,
					skipStale,
					review,
					sync,
					json,
					timeout
				} satisfies Extract<
					import("../command-model.js").CliCommand,
					{ readonly _tag: "LocalizationApply" }
				>;
				if (Option.isSome(engineRoot))
					Object.assign(command, { engineRoot: engineRoot.value });
				return applyLocalizationChanges(command);
			}
		).pipe(
			Command.withDescription(
				"Write a reviewed translation change set into the target's PO files; --sync then imports and compiles."
			)
		),
		Command.make(
			"report",
			{
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				baseline: Flag.String("baseline").pipe(Flag.optional),
				saveBaseline: Flag.String("save-baseline").pipe(Flag.optional),
				reader: Flag.String("reader").pipe(Flag.optional)
			},
			({ projectRoot, target, baseline, saveBaseline, reader }) =>
				runLocalizationReport({
					_tag: "LocalizationReport",
					projectRoot,
					target,
					...(Option.isSome(baseline) ? { baseline: baseline.value } : undefined),
					...(Option.isSome(saveBaseline)
						? { saveBaseline: saveBaseline.value }
						: undefined),
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				})
		).pipe(
			Command.withDescription("Report archive progress, coverage and manifest source deltas.")
		),
		Command.make(
			"check",
			{
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				culture: Flag.String("culture").pipe(Flag.optional),
				checks: Flag.Literals("check", BuiltInCheckId.literals).pipe(Flag.atMost(64)),
				changes: Flag.String("changes").pipe(Flag.optional),
				reader: Flag.String("reader").pipe(Flag.optional)
			},
			({ projectRoot, target, culture, checks, changes, reader }) =>
				runLocalizationCheck({
					_tag: "LocalizationCheck",
					projectRoot,
					target,
					checks,
					...(Option.isSome(culture) ? { culture: culture.value } : undefined),
					...(Option.isSome(changes) ? { changes: changes.value } : undefined),
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				})
		).pipe(
			Command.withDescription(
				"Check shipped translations and propose fixes without editing localization files."
			)
		),
		Command.make(
			"review",
			{
				action: Argument.Literals("action", [
					"set",
					"clear",
					"accept",
					"unaccept"
				] as const),
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				culture: Flag.String("culture"),
				lines: Flag.String("line").pipe(Flag.between(1, 500)),
				flags: Flag.Literals("flag", LocalizationReviewFlag.literals).pipe(Flag.atMost(4)),
				check: Flag.String("check").pipe(Flag.optional),
				by: Flag.String("by").pipe(Flag.withDefault("ue-shed-cli")),
				reviewFile: Flag.String("review-file").pipe(Flag.optional)
			},
			({ action, projectRoot, target, culture, lines, flags, check, by, reviewFile }) =>
				runLocalizationReview({
					_tag: "LocalizationReview",
					action,
					projectRoot,
					target,
					culture,
					lines,
					flags,
					by,
					...(Option.isSome(check) ? { check: check.value } : undefined),
					...(Option.isSome(reviewFile) ? { reviewFile: reviewFile.value } : undefined)
				})
		).pipe(
			Command.withDescription(
				"Set or clear review flags, or accept findings, in the target's review file."
			)
		),
		Command.make(
			"targets",
			{ projectRoot: Argument.String("project-root") },
			({ projectRoot }) =>
				runLocalizationTargets({ _tag: "LocalizationTargets", projectRoot })
		).pipe(
			Command.withDescription(
				"List target settings, recipes, outputs and culture file presence."
			)
		),
		Command.make(
			"export",
			{
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				output: Flag.String("output"),
				reader: Flag.String("reader").pipe(Flag.optional),
				review: Flag.Literals("review", LocalizationReviewLens.literals).pipe(
					Flag.optional
				),
				keyChanged: Flag.Boolean("key-changed").pipe(Flag.withDefault(false)),
				culture: Flag.String("culture").pipe(Flag.optional),
				state: Flag.Literals("state", LocalizationState.literals).pipe(Flag.optional),
				kinds: Flag.Literals("kind", TextOriginKind.literals).pipe(Flag.atMost(5)),
				path: Flag.String("path").pipe(Flag.optional),
				files: Flag.String("files").pipe(Flag.optional),
				...filterFlags()
			},
			({
				projectRoot,
				target,
				output,
				reader,
				review,
				keyChanged,
				culture,
				state,
				kinds,
				path,
				files,
				filters,
				group,
				cultures
			}) =>
				runLocalizationExport({
					_tag: "LocalizationExport",
					projectRoot,
					target,
					output,
					...optionalLocalizationFlags(culture, state),
					...optionalWhereFlags(kinds, path, files),
					...optionalFilterFlags(filters, cultures, group),
					...(Option.isSome(review) ? { review: review.value } : undefined),
					...(keyChanged ? { keyChanged } : undefined),
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				})
		).pipe(
			Command.withDescription(
				"Write every matching line, with a translation and state column per culture, to a new CSV."
			)
		),
		Command.make(
			"gate",
			{
				projectRoot: Argument.String("project-root"),
				files: Flag.String("files"),
				targets: Flag.String("target").pipe(Flag.atMost(50)),
				failOn: Flag.Literals("fail-on", LocalizationGateCheck.literals).pipe(
					Flag.atMost(LocalizationGateCheck.literals.length)
				),
				warnOn: Flag.Literals("warn-on", LocalizationGateCheck.literals).pipe(
					Flag.atMost(LocalizationGateCheck.literals.length)
				),
				summary: Flag.Boolean("summary").pipe(Flag.withDefault(false)),
				reader: Flag.String("reader").pipe(Flag.optional)
			},
			({ projectRoot, files, targets, failOn, warnOn, summary, reader }) =>
				runLocalizationGate({
					_tag: "LocalizationGate",
					projectRoot,
					changedFiles: files,
					targets,
					failOn,
					warnOn,
					summary,
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				})
		).pipe(
			Command.withDescription(
				"Check the text in a change's files; exits 1 when it fails, 2 when it could not check."
			)
		),
		Command.make(
			"status",
			{
				projectRoot: Argument.String("project-root"),
				target: Flag.String("target"),
				reader: Flag.String("reader").pipe(Flag.optional),
				review: Flag.Literals("review", LocalizationReviewLens.literals).pipe(
					Flag.optional
				),
				keyChanged: Flag.Boolean("key-changed").pipe(Flag.withDefault(false)),
				...localizationFlags()
			},
			({
				projectRoot,
				target,
				culture,
				state,
				review,
				keyChanged,
				limit,
				reader,
				kinds,
				path,
				files,
				filters,
				group,
				cultures
			}) => {
				return runLocalizationStatus({
					_tag: "LocalizationStatus",
					projectRoot,
					target,
					limit,
					...optionalLocalizationFlags(culture, state),
					...optionalWhereFlags(kinds, path, files),
					...optionalFilterFlags(filters, cultures, group),
					...(Option.isSome(review) ? { review: review.value } : undefined),
					...(keyChanged ? { keyChanged } : undefined),
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				});
			}
		).pipe(
			Command.withDescription("Report bounded localization states, counts and file evidence.")
		)
	])
);
