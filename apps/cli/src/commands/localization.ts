import { Argument, Command, Flag } from "effect/unstable/cli";
import { Option } from "effect";
import { LocalizationCheckId } from "@ue-shed/game-text/browser";
import { runLocalizationCheck } from "../workflows/localization-check.js";
import { runLocalizationStatus, runLocalizationTargets } from "../workflows/localization.js";
import { localizationFlags, optionalLocalizationFlags } from "./localization-flags.js";

export const localizationCommand = Command.make("loc").pipe(
	Command.withDescription("Read saved Unreal localization targets."),
	Command.withSubcommands([
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
			"status",
			{
				projectRoot: Argument.string("project-root"),
				target: Flag.string("target"),
				reader: Flag.string("reader").pipe(Flag.optional),
				...localizationFlags()
			},
			({ projectRoot, target, culture, state, limit, reader }) => {
				return runLocalizationStatus({
					_tag: "LocalizationStatus",
					projectRoot,
					target,
					limit,
					...optionalLocalizationFlags(culture, state),
					...(Option.isSome(reader) ? { reader: reader.value } : undefined)
				});
			}
		).pipe(
			Command.withDescription("Report bounded localization states, counts and file evidence.")
		)
	])
);
