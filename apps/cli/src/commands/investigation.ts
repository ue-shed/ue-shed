import { Argument, Command, Flag } from "effect/unstable/cli";
import { runInvestigation } from "../workflows/investigation.js";
import { optionalFlag, optionalValue, readerFields } from "./options.js";

const run = Command.make(
	"run",
	{
		projectRoot: Argument.string("project-root"),
		preset: Flag.string("preset"),
		format: Flag.choice("format", ["json", "csv"]).pipe(Flag.withDefault("json")),
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
