import { Argument, Command, Flag } from "effect/cli";
import { optionalFlag, optionalValue, readerFields } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runSourceText = lazyWorkflow(
	() => import("../workflows/source-text.js"),
	(module) => module.runSourceText
);

const text = Command.make(
	"text",
	{
		projectRoot: Argument.String("project-root"),
		targets: Flag.String("target").pipe(Flag.atMost(Number.MAX_SAFE_INTEGER)),
		engineRoot: optionalFlag("engine-root"),
		engineVersion: optionalFlag("engine-version"),
		cacheRoot: optionalFlag("cache-root"),
		reader: optionalFlag("reader")
	},
	(value) => {
		const engineRoot = optionalValue(value.engineRoot);
		const engineVersion = optionalValue(value.engineVersion);
		const cacheRoot = optionalValue(value.cacheRoot);
		return runSourceText({
			_tag: "SourceText",
			projectRoot: value.projectRoot,
			targets: value.targets,
			...(engineRoot === undefined ? undefined : { engineRoot }),
			...(engineVersion === undefined ? undefined : { engineVersion }),
			...(cacheRoot === undefined ? undefined : { cacheRoot }),
			...readerFields(value.reader)
		});
	}
).pipe(
	Command.withDescription(
		"Find the text in the project's C++, config and String Table CSVs as each localization target's GatherTextFromSource steps would, and print it as JSON."
	)
);

export const sourceCommand = Command.make("source").pipe(
	Command.withDescription("Read an Unreal project's source the way Unreal's commandlets do."),
	Command.withSubcommands([text])
);
