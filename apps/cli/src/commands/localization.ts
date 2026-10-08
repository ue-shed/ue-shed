import { Effect, Option } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
	LocalizationCheckId,
	LocalizationReviewLens,
	LocalizationState,
	TextOriginKind
} from "@ue-shed/game-text/browser";
import { runLocalizationCheck } from "../workflows/localization-check.js";
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
				operation: Argument.choice("operation", LocalizationOperation.literals),
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				engineRoot: Flag.string("engine-root").pipe(Flag.optional),
				carry: Flag.string("carry").pipe(Flag.optional),
				plan: Flag.boolean("plan"),
				json: Flag.boolean("json"),
				timeout: Flag.integer("timeout").pipe(Flag.withDefault(1800))
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
				projectRoot: Argument.string("project-root"),
				changes: Flag.string("changes"),
				skipStale: Flag.boolean("skip-stale"),
				review: Flag.boolean("review"),
				sync: Flag.boolean("sync"),
				engineRoot: Flag.string("engine-root").pipe(Flag.optional),
				json: Flag.boolean("json"),
				timeout: Flag.integer("timeout").pipe(Flag.withDefault(1800))
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
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				baseline: Flag.string("baseline").pipe(Flag.optional),
				saveBaseline: Flag.string("save-baseline").pipe(Flag.optional),
				reader: Flag.string("reader").pipe(Flag.optional)
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
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				culture: Flag.string("culture").pipe(Flag.optional),
				checks: Flag.choice("check", LocalizationCheckId.literals).pipe(Flag.atMost(64)),
				changes: Flag.string("changes").pipe(Flag.optional),
				reader: Flag.string("reader").pipe(Flag.optional)
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
				action: Argument.choice("action", ["set", "clear", "accept", "unaccept"] as const),
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				culture: Flag.string("culture"),
				lines: Flag.string("line").pipe(Flag.between(1, 500)),
				flags: Flag.choice("flag", LocalizationReviewFlag.literals).pipe(Flag.atMost(4)),
				check: Flag.string("check").pipe(Flag.optional),
				by: Flag.string("by").pipe(Flag.withDefault("ue-shed-cli")),
				reviewFile: Flag.string("review-file").pipe(Flag.optional)
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
			{ projectRoot: Argument.string("project-root") },
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
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				output: Flag.string("output"),
				reader: Flag.string("reader").pipe(Flag.optional),
				review: Flag.choice("review", LocalizationReviewLens.literals).pipe(Flag.optional),
				keyChanged: Flag.boolean("key-changed"),
				culture: Flag.string("culture").pipe(Flag.optional),
				state: Flag.choice("state", LocalizationState.literals).pipe(Flag.optional),
				kinds: Flag.choice("kind", TextOriginKind.literals).pipe(Flag.atMost(5)),
				path: Flag.string("path").pipe(Flag.optional),
				files: Flag.string("files").pipe(Flag.optional),
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
			"status",
			{
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				reader: Flag.string("reader").pipe(Flag.optional),
				review: Flag.choice("review", LocalizationReviewLens.literals).pipe(Flag.optional),
				keyChanged: Flag.boolean("key-changed"),
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
