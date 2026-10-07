import { Argument, Command, Flag } from "effect/unstable/cli";
import { Option } from "effect";
import { runLocalizationStatus, runLocalizationTargets } from "../workflows/localization.js";
import { localizationFlags, optionalLocalizationFlags } from "./localization-flags.js";

export const localizationCommand = Command.make("loc").pipe(
	Command.withDescription("Read saved Unreal localization targets."),
	Command.withSubcommands([
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
