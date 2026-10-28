import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { EngineInstallationDiscovery, EngineInstallationDiscoveryLive } from "@ue-shed/engine";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import { AssetReader, nativeGameTextEngineClientLayer } from "@ue-shed/unreal-assets";
import { engineLine, scanSourceText } from "@ue-shed/unreal-source";
import { Effect, Layer } from "effect";
import { CliCommandError, printJson } from "../cli-runtime.js";
import { observeCliOperation, readerLayer } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type SourceTextCommand = Extract<CliCommand, { readonly _tag: "SourceText" }>;

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
	return match === null ? undefined : engineLine(Number(match[1]), Number(match[2]));
};

const projectDescriptor = Effect.fn("Cli.source_text.project")(function* (projectRoot: string) {
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

/**
 * The commandlet behaviour to reproduce and the engine root for engine wrappers.
 * `--engine-version` names the behaviour directly and scans without the engine unless
 * `--engine-root` is given; otherwise the engine comes from `--engine-root` or the project's
 * association, as the editor would open it.
 */
const resolveEngine = Effect.fn("Cli.source_text.engine")(function* (command: SourceTextCommand) {
	if (command.engineVersion !== undefined) {
		const engine = lineOf(command.engineVersion);
		if (engine === undefined)
			return yield* failure(
				`Unsupported engine version ${command.engineVersion}.`,
				VERSION_RECOVERY
			);
		return { engine, engineRoot: command.engineRoot };
	}
	const discovery = yield* EngineInstallationDiscovery;
	const installation = yield* discovery
		.resolve({
			projectDescriptor: yield* projectDescriptor(command.projectRoot),
			...(command.engineRoot === undefined ? undefined : { explicitRoot: command.engineRoot })
		})
		.pipe(Effect.mapError((error) => failure(error.message, VERSION_RECOVERY, error)));
	const engine = engineLine(installation.version.major, installation.version.minor);
	if (engine === undefined)
		return yield* failure(
			`Unreal ${installation.version.major}.${installation.version.minor} is older than 4.27.`,
			VERSION_RECOVERY
		);
	return { engine, engineRoot: installation.root };
});

export const runSourceText = Effect.fn("Cli.workflow.source_text")((command: SourceTextCommand) =>
	observeCliOperation(
		command._tag,
		Effect.gen(function* () {
			const { engine, engineRoot } = yield* resolveEngine(command);
			const scanned = yield* scanSourceText({
				projectRoot: command.projectRoot,
				engine,
				engineRoot,
				targets: command.targets,
				cacheRoot: command.cacheRoot
			});
			yield* printJson(scanned);
		}).pipe(
			Effect.provide(
				Layer.mergeAll(
					EngineInstallationDiscoveryLive,
					LocalizationEvidenceNodeLive,
					Layer.unwrap(
						Effect.gen(function* () {
							const reader = yield* AssetReader;
							return nativeGameTextEngineClientLayer(yield* reader.configuration());
						})
					).pipe(Layer.provide(readerLayer(command.reader)))
				)
			)
		)
	)
);
