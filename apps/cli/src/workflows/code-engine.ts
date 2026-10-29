import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { EngineInstallationDiscovery } from "@ue-shed/engine";
import { sourceGatherEngine, type SourceGatherEngine } from "@ue-shed/localization";
import { Effect } from "effect";
import { CliCommandError } from "../cli-runtime.js";

const failure = (message: string, recovery: string, cause?: unknown) =>
	new CliCommandError({
		cause,
		recovery,
		retrySafe: false,
		nextStep: "reconcile",
		code: "cli_command_failed",
		message
	});

const VERSION_RECOVERY =
	"Pass --engine-version 4.27, 5.7 or 5.8, or an --engine-root that holds Engine/Build/Build.version.";

const lineOf = (version: string) => {
	const match = /^(\d+)\.(\d+)/u.exec(version.trim());
	return match === null ? undefined : sourceGatherEngine(Number(match[1]), Number(match[2]));
};

const projectDescriptor = Effect.fn("Cli.code.project")(function* (projectRoot: string) {
	const names = yield* Effect.tryPromise({
		try: () => readdir(projectRoot),
		catch: (cause) =>
			failure(
				`Could not read ${projectRoot}.`,
				"Pass the folder that holds the .uproject.",
				cause
			)
	});
	const projects = names.filter((name) => extname(name).toLowerCase() === ".uproject");
	if (projects.length !== 1)
		return yield* failure(
			`${projectRoot} holds ${projects.length} .uproject files, not one.`,
			"Pass the folder that holds the project's only .uproject."
		);
	return join(projectRoot, projects[0]!);
});

export interface CodeEngine {
	readonly engine: SourceGatherEngine;
	/** The installation root, holding `Engine/`; without it engine wrappers are missing. */
	readonly engineRoot?: string | undefined;
}

/**
 * The source gather behaviour to reproduce and the engine root for engine wrappers.
 * `engineVersion` names the behaviour directly and reads without the engine unless `engineRoot`
 * is given; otherwise the engine comes from `engineRoot` or the project's association, as the
 * editor would open it.
 */
export const resolveCodeEngine = Effect.fn("Cli.code.engine")(function* (input: {
	readonly projectRoot: string;
	readonly engineRoot?: string | undefined;
	readonly engineVersion?: string | undefined;
}) {
	if (input.engineVersion !== undefined) {
		const engine = lineOf(input.engineVersion);
		if (engine === undefined)
			return yield* failure(
				`Unsupported engine version ${input.engineVersion}.`,
				VERSION_RECOVERY
			);
		return { engine, engineRoot: input.engineRoot } satisfies CodeEngine;
	}
	const discovery = yield* EngineInstallationDiscovery;
	const installation = yield* discovery
		.resolve({
			projectDescriptor: yield* projectDescriptor(input.projectRoot),
			...(input.engineRoot === undefined ? undefined : { explicitRoot: input.engineRoot })
		})
		.pipe(Effect.mapError((error) => failure(error.message, VERSION_RECOVERY, error)));
	const engine = sourceGatherEngine(installation.version.major, installation.version.minor);
	if (engine === undefined)
		return yield* failure(
			`Unreal ${installation.version.major}.${installation.version.minor} is older than 4.27.`,
			VERSION_RECOVERY
		);
	return { engine, engineRoot: installation.root } satisfies CodeEngine;
});
