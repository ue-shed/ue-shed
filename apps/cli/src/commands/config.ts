import { Argument, Command, Flag } from "effect/unstable/cli";
import { runConfigCompare, runConfigExplain } from "../workflows/config.js";
import { optionalFlag, optionalValue } from "./options.js";

const common = {
	project: Argument.string("project"),
	section: Argument.string("section"),
	key: Argument.string("key"),
	engineRoot: optionalFlag("engine-root"),
	family: optionalFlag("family")
};

const explain = Command.make(
	"explain",
	{ ...common, platform: Flag.string("platform") },
	({ engineRoot, family, ...value }) => {
		const selectedEngine = optionalValue(engineRoot);
		const selectedFamily = optionalValue(family);
		return runConfigExplain({
			_tag: "ConfigExplain",
			...value,
			...(selectedEngine === undefined ? {} : { engineRoot: selectedEngine }),
			...(selectedFamily === undefined ? {} : { family: selectedFamily })
		});
	}
).pipe(
	Command.withDescription(
		"Explain the effective saved-source value and ordered provenance of one Unreal config key."
	)
);

const compare = Command.make(
	"compare",
	{
		...common,
		leftPlatform: Flag.string("left-platform"),
		rightPlatform: Flag.string("right-platform")
	},
	({ engineRoot, family, ...value }) => {
		const selectedEngine = optionalValue(engineRoot);
		const selectedFamily = optionalValue(family);
		return runConfigCompare({
			_tag: "ConfigCompare",
			...value,
			...(selectedEngine === undefined ? {} : { engineRoot: selectedEngine }),
			...(selectedFamily === undefined ? {} : { family: selectedFamily })
		});
	}
).pipe(
	Command.withDescription(
		"Compare the independently resolved saved-source value across two Unreal platforms."
	)
);

export const configCommand = Command.make("config").pipe(
	Command.withDescription("Explain saved Unreal configuration provenance."),
	Command.withSubcommands([explain, compare])
);
