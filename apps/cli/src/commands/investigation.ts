import { Argument, Command, Flag } from "effect/cli";
import { optionalFlag, optionalValue, readerFields } from "./options.js";
import { lazyWorkflow } from "../lazy-workflows.js";

const runInvestigation = lazyWorkflow(
	() => import("../workflows/investigation.js"),
	(module) => module.runInvestigation
);

const run = Command.make(
	"run",
	{
		projectRoot: Argument.String("project-root"),
		preset: Flag.String("preset"),
		format: Flag.Literals("format", ["json", "csv"]).pipe(Flag.withDefault("json")),
		output: optionalFlag("output"),
		reader: optionalFlag("reader")
	},
	({ projectRoot, preset, format, output, reader }) => {
		const outputPath = optionalValue(output);
		return runInvestigation({
			_tag: "InvestigationRun",
			projectRoot,
			preset,
			format,
			...(outputPath === undefined ? undefined : { output: outputPath }),
			...readerFields(reader)
		});
	}
).pipe(Command.withDescription("Rescan an explicit project using an investigation preset."));

export const investigationsCommand = Command.make("investigations").pipe(
	Command.withDescription("Replay Game Text and Texture Audit investigations."),
	Command.withSubcommands([run])
);
