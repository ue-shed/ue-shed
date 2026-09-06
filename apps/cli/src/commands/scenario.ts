import { Argument, Command, Flag } from "effect/unstable/cli";
import { runScenario } from "../workflows/scenario.js";
import { optionalValue, positiveIntegerFlag } from "./options.js";

const runCommand = Command.make(
	"run",
	{
		document: Flag.string("document").pipe(Flag.optional),
		endpoint: Argument.string("endpoint"),
		evidenceLimit: positiveIntegerFlag(
			"evidence-limit",
			"--evidence-limit requires a positive integer"
		).pipe(Flag.optional)
	},
	({ document, endpoint, evidenceLimit }) => {
		const limit = optionalValue(evidenceLimit);
		const path = optionalValue(document);
		return runScenario({
			...(path === undefined ? undefined : { document: path }),
			_tag: "ScenarioRun",
			endpoint,
			...(limit === undefined ? undefined : { evidenceLimit: limit })
		});
	}
).pipe(
	Command.withDescription(
		"Execute a saved scenario document, or the Movement Gym example, against a compatible PIE editor."
	)
);

export const scenarioCommand = Command.make("scenarios").pipe(
	Command.withDescription("Execute bounded gameplay scenarios through the public runner."),
	Command.withSubcommands([runCommand])
);
