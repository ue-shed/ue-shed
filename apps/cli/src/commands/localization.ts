import { Argument, Command } from "effect/unstable/cli";
import { runLocalizationTargets } from "../workflows/localization.js";

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
		)
	])
);
