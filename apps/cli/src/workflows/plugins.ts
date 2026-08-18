import { Effect } from "effect";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type PluginsListCommand = Extract<CliCommand, { readonly _tag: "PluginsList" }>;
type PluginsVerifyCommand = Extract<CliCommand, { readonly _tag: "PluginsVerify" }>;
type PluginsInstallCommand = Extract<CliCommand, { readonly _tag: "PluginsInstall" }>;

export const runPluginsList = Effect.fn("Cli.workflow.plugins_list")(
	(command: PluginsListCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { listPluginManifest } = yield* Effect.promise(
					() => import("../plugin-installer.js")
				);
				return yield* listPluginManifest(command.manifestPath).pipe(
					Effect.flatMap(printJson)
				);
			})
		)
);

export const runPluginsVerify = Effect.fn("Cli.workflow.plugins_verify")(
	(command: PluginsVerifyCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { verifyPluginManifest } = yield* Effect.promise(
					() => import("../plugin-installer.js")
				);
				return yield* verifyPluginManifest(command).pipe(Effect.flatMap(printJson));
			})
		)
);

export const runPluginsInstall = Effect.fn("Cli.workflow.plugins_install")(
	(command: PluginsInstallCommand) =>
		observeCliOperation(
			command._tag,
			Effect.gen(function* () {
				const { installPluginBundle } = yield* Effect.promise(
					() => import("../plugin-installer.js")
				);
				return yield* installPluginBundle({
					...(command.artifactPath === undefined
						? undefined
						: { artifactPath: command.artifactPath }),
					manifestPath: command.manifestPath,
					projectPath: command.projectRoot
				}).pipe(Effect.flatMap(printJson));
			})
		)
);
