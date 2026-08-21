import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import {
	runPluginsCacheInstall,
	runPluginsCacheList,
	runPluginsCacheVerify,
	runPluginsInstall,
	runPluginsList,
	runPluginsPrune,
	runPluginsVerify
} from "../workflows/plugins.js";
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

const pluginsCacheInstallCommand = Command.make(
	"install",
	{
		artifactDigest: optionalFlag("artifact-digest"),
		cache: Flag.string("cache"),
		cacheOnly: Flag.boolean("cache-only"),
		manifestDigest: optionalFlag("manifest-digest"),
		plugins: Flag.string("plugin").pipe(Flag.atLeast(1)),
		release: Flag.string("release"),
		source: Flag.string("source").pipe(Flag.withDefault(".")),
		unreal: optionalFlag("unreal")
	},
	({ artifactDigest, cache, cacheOnly, manifestDigest, plugins, release, source, unreal }) =>
		Effect.gen(function* () {
			const artifactDigestValue = optionalValue(artifactDigest);
			const manifestDigestValue = optionalValue(manifestDigest);
			const unrealVersion = optionalValue(unreal);
			return yield* runPluginsCacheInstall({
				_tag: "PluginsCacheInstall",
				cacheOnly,
				cacheRoot: cache,
				pluginIds: plugins,
				releaseVersion: release,
				source,
				...(artifactDigestValue === undefined
					? undefined
					: { artifactDigest: artifactDigestValue }),
				...(manifestDigestValue === undefined
					? undefined
					: { manifestDigest: manifestDigestValue }),
				...(unrealVersion === undefined ? undefined : { unrealVersion })
			});
		})
).pipe(Command.withDescription("Install an exact plugin release into a host cache."));

const pluginsCacheListCommand = Command.make("list", { cache: Flag.string("cache") }, ({ cache }) =>
	runPluginsCacheList({ _tag: "PluginsCacheList", cacheRoot: cache })
).pipe(Command.withDescription("List verified releases in a plugin cache."));

const pluginsCacheVerifyCommand = Command.make(
	"verify",
	{ cache: Flag.string("cache"), release: Flag.string("release") },
	({ cache, release }) =>
		runPluginsCacheVerify({
			_tag: "PluginsCacheVerify",
			cacheRoot: cache,
			releaseVersion: release
		})
).pipe(Command.withDescription("Verify one immutable cached plugin release."));

const pluginsPruneCommand = Command.make(
	"prune",
	{ cache: Flag.string("cache"), release: Flag.string("release") },
	({ cache, release }) =>
		runPluginsPrune({
			_tag: "PluginsPrune",
			cacheRoot: cache,
			releaseVersion: release
		})
).pipe(Command.withDescription("Prune one unleased cached plugin release."));

const pluginsCacheCommand = Command.make("cache").pipe(
	Command.withDescription("Install, inspect, verify, and prune host-cached plugin releases."),
	Command.withSubcommands([
		pluginsCacheInstallCommand,
		pluginsCacheListCommand,
		pluginsCacheVerifyCommand,
		pluginsPruneCommand
	])
);

export const pluginsCommand = Command.make("plugins").pipe(
	Command.withDescription("Inspect and install plugin bundles for projects or host caches."),
	Command.withSubcommands([
		pluginsListCommand,
		pluginsVerifyCommand,
		pluginsInstallCommand,
		pluginsCacheCommand
	])
);
