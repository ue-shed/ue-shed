import { Argument, Command, Flag } from "effect/unstable/cli";
import { runScenario } from "../workflows/scenario.js";
import { optionalValue, positiveIntegerFlag } from "./options.js";

const runCommand = Command.make(
	"run",
	{
		endpoint: Argument.string("endpoint"),
		evidenceLimit: positiveIntegerFlag(
			"evidence-limit",
			"--evidence-limit requires a positive integer"
		).pipe(Flag.optional)
	},
	({ endpoint, evidenceLimit }) => {
		const limit = optionalValue(evidenceLimit);
		return runScenario({
			_tag: "ScenarioRun",
			endpoint,
			...(limit === undefined ? {} : { evidenceLimit: limit })
		});
	}
).pipe(
	Command.withDescription(
		"Execute the portable Movement Gym scenario against one compatible UE 5.7 PIE editor."
	)
);

export const scenarioCommand = Command.make("scenarios").pipe(
	Command.withDescription("Execute bounded gameplay scenarios through the public runner."),
	Command.withSubcommands([runCommand])
);
