import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import { CliCommandError } from "../cli-runtime.js";
import {
	runPluginsAcquire,
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

const pluginsAcquireCommand = Command.make(
	"acquire",
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
			return yield* runPluginsAcquire({
				_tag: "PluginsAcquire",
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
).pipe(Command.withDescription("Acquire and lease an exact plugin release in a host cache."));

const pluginsCacheListCommand = Command.make(
	"cache-list",
	{ cache: Flag.string("cache") },
	({ cache }) => runPluginsCacheList({ _tag: "PluginsCacheList", cacheRoot: cache })
).pipe(Command.withDescription("List verified releases in a plugin cache."));

const pluginsCacheVerifyCommand = Command.make(
	"cache-verify",
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

export const pluginsCommand = Command.make("plugins").pipe(
	Command.withDescription("Acquire, inspect, verify, install, and prune plugin bundles."),
	Command.withSubcommands([
		pluginsListCommand,
		pluginsVerifyCommand,
		pluginsInstallCommand,
		pluginsAcquireCommand,
		pluginsCacheListCommand,
		pluginsCacheVerifyCommand,
		pluginsPruneCommand
	])
);
