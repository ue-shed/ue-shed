import { Argument, Command, Flag } from "effect/cli";
import { optionalFlag, optionalValue, readerFields } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runCodeText = lazyWorkflow(
	() => import("../workflows/code-text.js"),
	(module) => module.runCodeText
);

const text = Command.make(
	"text",
	{
		projectRoot: Argument.String("project-root"),
		targets: Flag.String("target").pipe(Flag.atMost(Number.MAX_SAFE_INTEGER)),
		engineRoot: optionalFlag("engine-root"),
		engineVersion: optionalFlag("engine-version"),
		cacheRoot: optionalFlag("cache-root"),
		refreshEngineWrappers: Flag.Boolean("refresh-engine-wrappers").pipe(
			Flag.withDefault(false)
		),
		reader: optionalFlag("reader")
	},
	(value) => {
		const engineRoot = optionalValue(value.engineRoot);
		const engineVersion = optionalValue(value.engineVersion);
		const cacheRoot = optionalValue(value.cacheRoot);
		return runCodeText({
			_tag: "CodeText",
			projectRoot: value.projectRoot,
			targets: value.targets,
			refreshEngineWrappers: value.refreshEngineWrappers,
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

export const codeCommand = Command.make("code").pipe(
	Command.withDescription(
		"Read an Unreal project's code (C++, config and String Table CSVs) the way Unreal's tools do."
	),
	Command.withSubcommands([text])
);
