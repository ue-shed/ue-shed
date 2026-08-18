import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import { runPluginsInstall, runPluginsList, runPluginsVerify } from "../workflows/plugins.js";
import { optionalFlag, optionalValue } from "./options.js";

const pluginManifestArgument = Argument.string("manifest").pipe(Argument.optional);
const pluginManifestFlag = optionalFlag("manifest");
const pluginArtifactFlag = optionalFlag("artifact");
const pluginProjectFlag = optionalFlag("project");

function resolvePluginPath(
	positional: Option.Option<string>,
	flag: Option.Option<string>,
	message: string
) {
	const positionalValue = optionalValue(positional);
	const flagValue = optionalValue(flag);
	if (positionalValue !== undefined && flagValue !== undefined) {
		return Effect.fail(new CliCommandError({ message }));
	}
	const value = positionalValue ?? flagValue;
	return value === undefined
		? Effect.fail(new CliCommandError({ message }))
		: Effect.succeed(value);
}

const pluginsListCommand = Command.make(
	"list",
	{
		manifest: pluginManifestArgument,
		manifestFlag: pluginManifestFlag,
		artifact: pluginArtifactFlag,
		project: pluginProjectFlag
	},
	({ manifest, manifestFlag, artifact, project }) =>
		Effect.gen(function* () {
			if (optionalValue(artifact) !== undefined || optionalValue(project) !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({ message: "plugins list only accepts a manifest path" })
				);
			}
			const manifestPath = yield* resolvePluginPath(
				manifest,
				manifestFlag,
				"plugins list requires a manifest path"
			);
			return yield* runPluginsList({ _tag: "PluginsList", manifestPath });
		})
).pipe(Command.withDescription("List plugins in a release manifest."));

const pluginsVerifyCommand = Command.make(
	"verify",
	{
		manifest: pluginManifestArgument,
		manifestFlag: pluginManifestFlag,
		artifact: pluginArtifactFlag,
		project: pluginProjectFlag
	},
	({ manifest, manifestFlag, artifact, project }) =>
		Effect.gen(function* () {
			const projectValue = optionalValue(project);
			const artifactValue = optionalValue(artifact);
			if (projectValue !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({ message: "plugins verify does not accept --project" })
				);
			}
			const manifestPath = yield* resolvePluginPath(
				manifest,
				manifestFlag,
				"plugins verify requires a manifest path"
			);
			return yield* runPluginsVerify({
				_tag: "PluginsVerify",
				manifestPath,
				...(artifactValue === undefined ? undefined : { artifactPath: artifactValue })
			});
		})
).pipe(Command.withDescription("Verify a plugin release manifest and artifact."));

const pluginsInstallCommand = Command.make(
	"install",
	{
		project: Argument.string("project").pipe(Argument.optional),
		projectFlag: pluginProjectFlag,
		manifest: Flag.string("manifest"),
		artifact: pluginArtifactFlag
	},
	({ project, projectFlag, manifest, artifact }) =>
		Effect.gen(function* () {
			const projectRoot = yield* resolvePluginPath(
				project,
				projectFlag,
				"plugins install requires --project <project-root-or-uproject>"
			);
			const artifactValue = optionalValue(artifact);
			return yield* runPluginsInstall({
				_tag: "PluginsInstall",
				manifestPath: manifest,
				projectRoot,
				...(artifactValue === undefined ? undefined : { artifactPath: artifactValue })
			});
		})
).pipe(Command.withDescription("Install a plugin bundle into a project."));

export const pluginsCommand = Command.make("plugins").pipe(
	Command.withDescription("Inspect, verify, and install plugin bundles."),
	Command.withSubcommands([pluginsListCommand, pluginsVerifyCommand, pluginsInstallCommand])
);
