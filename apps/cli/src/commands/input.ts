import { Argument, Command, Flag } from "effect/cli";
import { lazyWorkflow } from "../lazy-workflows.js";
import { optionalFlag, optionalValue, positiveIntegerFlag, readerFields } from "./options.js";

const runInputInspect = lazyWorkflow(
	() => import("../asset-workflows.js"),
	(module) => module.runInputInspect
);
const runInputAtlas = lazyWorkflow(
	() => import("../workflows/input.js"),
	(module) => module.runInputAtlas
);
const runInputConflicts = lazyWorkflow(
	() => import("../workflows/input.js"),
	(module) => module.runInputConflicts
);
const runInputUnused = lazyWorkflow(
	() => import("../workflows/input.js"),
	(module) => module.runInputUnused
);
const runInputPlatforms = lazyWorkflow(
	() => import("../workflows/input.js"),
	(module) => module.runInputPlatforms
);
const runInputExport = lazyWorkflow(
	() => import("../workflows/input.js"),
	(module) => module.runInputExport
);

const readerFlag = optionalFlag("reader");
const projectArgument = Argument.String("project");

/** Optional co-activation sources shared by `conflicts` and `export`. */
const coActivationFlags = {
	coActivation: optionalFlag("co-activation"),
	platform: optionalFlag("platform"),
	engineRoot: optionalFlag("engine-root")
};

function coActivationFields(flags: {
	readonly coActivation: Parameters<typeof optionalValue<string>>[0];
	readonly platform: Parameters<typeof optionalValue<string>>[0];
	readonly engineRoot: Parameters<typeof optionalValue<string>>[0];
}) {
	const coActivation = optionalValue(flags.coActivation);
	const platform = optionalValue(flags.platform);
	const engineRoot = optionalValue(flags.engineRoot);
	return {
		...(coActivation === undefined ? undefined : { coActivation }),
		...(platform === undefined ? undefined : { platform }),
		...(engineRoot === undefined ? undefined : { engineRoot })
	};
}

const inspect = Command.make(
	"inspect",
	{ path: Argument.String("asset-or-project"), reader: readerFlag },
	({ path, reader }) => runInputInspect({ _tag: "InputInspect", path, ...readerFields(reader) })
).pipe(Command.withDescription("Print the raw Enhanced Input scan report."));

const atlas = Command.make(
	"atlas",
	{ projectRoot: projectArgument, reader: readerFlag },
	({ projectRoot, reader }) =>
		runInputAtlas({ _tag: "InputAtlas", projectRoot, ...readerFields(reader) })
).pipe(
	Command.withDescription(
		"Print every claimed key with its contexts, trigger parameters and action-to-action edges."
	)
);

const conflicts = Command.make(
	"conflicts",
	{ projectRoot: projectArgument, reader: readerFlag, ...coActivationFlags },
	({ projectRoot, reader, ...flags }) =>
		runInputConflicts({
			_tag: "InputConflicts",
			projectRoot,
			...readerFields(reader),
			...coActivationFields(flags)
		})
).pipe(
	Command.withDescription(
		"Classify contested keys as shadowed, ambiguous, qualified or cross-context against co-activation sets."
	)
);

const unused = Command.make(
	"unused",
	{
		projectRoot: projectArgument,
		reader: readerFlag,
		noBlueprints: Flag.Boolean("no-blueprints").pipe(Flag.withDefault(false)),
		maximumBlueprints: positiveIntegerFlag(
			"maximum-blueprints",
			"--maximum-blueprints requires a positive integer"
		).pipe(Flag.withDefault(500))
	},
	({ projectRoot, reader, noBlueprints, maximumBlueprints }) =>
		runInputUnused({
			_tag: "InputUnused",
			projectRoot,
			blueprints: !noBlueprints,
			maximumBlueprints,
			...readerFields(reader)
		})
).pipe(
	Command.withDescription(
		"List actions with no known use, unbound mappings and Blueprint uses. C++ bindings are not visible."
	)
);

const platforms = Command.make(
	"platforms",
	{
		projectRoot: projectArgument,
		reader: readerFlag,
		platforms: Flag.String("platform").pipe(Flag.atMost(Number.MAX_SAFE_INTEGER)),
		engineRoot: optionalFlag("engine-root"),
		deviceSets: optionalFlag("device-sets")
	},
	({ projectRoot, reader, platforms, engineRoot, deviceSets }) => {
		const engine = optionalValue(engineRoot);
		const devices = optionalValue(deviceSets);
		return runInputPlatforms({
			_tag: "InputPlatforms",
			projectRoot,
			platforms,
			...(engine === undefined ? undefined : { engineRoot: engine }),
			...(devices === undefined ? undefined : { deviceSets: devices }),
			...readerFields(reader)
		});
	}
).pipe(
	Command.withDescription(
		"Show platform context redirects, key profiles and device coverage. Without --platform, uses platforms with a project Input config."
	)
);

const exportCommand = Command.make(
	"export",
	{
		projectRoot: projectArgument,
		reader: readerFlag,
		format: Flag.Literals("format", ["csv", "markdown", "json"]).pipe(
			Flag.withDefault("markdown")
		),
		output: optionalFlag("output"),
		...coActivationFlags
	},
	({ projectRoot, reader, format, output, ...flags }) => {
		const outputPath = optionalValue(output);
		return runInputExport({
			_tag: "InputExport",
			projectRoot,
			format,
			...(outputPath === undefined ? undefined : { output: outputPath }),
			...readerFields(reader),
			...coActivationFields(flags)
		});
	}
).pipe(Command.withDescription("Export a control sheet as Markdown, CSV or JSON."));

export const inputCommand = Command.make("input").pipe(
	Command.withDescription("Inspect and analyse saved Enhanced Input assets."),
	Command.withSubcommands([inspect, atlas, conflicts, unused, platforms, exportCommand])
);
