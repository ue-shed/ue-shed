import { Argument, Command, Flag } from "effect/unstable/cli";
import { Effect, Option } from "effect";
import {
	EngineBuildId,
	GitCommit,
	PluginVariantIdentity,
	ReleaseVersion,
	UnrealArchitecture,
	UnrealPlatform,
	UnrealVersion
} from "@ue-shed/plugin-distribution";
import { CliCommandError } from "../cli-runtime.js";
import {
	runPluginsCacheInstall,
	runPluginsCacheList,
	runPluginsCacheVerify,
	runPluginsBuild,
	runPluginsInstall,
	runPluginsList,
	runPluginsPrune,
	runPluginsVerify
} from "../workflows/plugins.js";
import { optionalFlag, optionalValue } from "./options.js";
import { positiveIntegerFlag } from "./options.js";

const pluginManifestArgument = Argument.string("manifest").pipe(Argument.optional);
const pluginManifestFlag = optionalFlag("manifest");
const pluginArtifactFlag = optionalFlag("artifact");
const pluginProjectFlag = optionalFlag("project");
const pluginReleaseFlag = Flag.string("release").pipe(Flag.withSchema(ReleaseVersion));
const pluginUnrealFlag = Flag.string("unreal").pipe(Flag.withSchema(UnrealVersion), Flag.optional);
const pluginBuildIdFlag = Flag.string("build-id").pipe(
	Flag.withSchema(EngineBuildId),
	Flag.optional
);
const pluginEngineSourceCommitFlag = Flag.string("engine-source-commit").pipe(
	Flag.withSchema(GitCommit),
	Flag.optional
);
const pluginVariantFlag = Flag.string("variant").pipe(
	Flag.withSchema(PluginVariantIdentity),
	Flag.optional
);

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

const pluginsBuildCommand = Command.make(
	"build",
	{
		architecture: Flag.string("architecture").pipe(Flag.withDefault("x64")),
		buildId: Flag.string("build-id"),
		compiler: Flag.string("compiler"),
		compilerVersion: Flag.string("compiler-version"),
		engineRoot: Flag.string("engine"),
		engineSourceCommit: pluginEngineSourceCommitFlag,
		maximumBuildSeconds: positiveIntegerFlag(
			"maximum-build-seconds",
			"maximum build seconds must be positive"
		).pipe(Flag.withDefault(7_200)),
		outputDirectory: Flag.string("output"),
		platform: Flag.string("platform").pipe(Flag.withDefault("Win64")),
		plugins: Flag.string("plugin").pipe(Flag.atLeast(1)),
		sourceArtifactDigest: Flag.string("source-artifact-digest"),
		sourceArtifactPath: Flag.string("source-artifact"),
		sourceManifestDigest: Flag.string("source-manifest-digest"),
		sourceManifestPath: Flag.string("source-manifest"),
		toolchain: Flag.string("toolchain"),
		toolchainVersion: Flag.string("toolchain-version"),
		targetTriple: optionalFlag("target-triple"),
		unrealVersion: Flag.string("unreal")
	},
	(options) => {
		const engineSourceCommit = optionalValue(options.engineSourceCommit);
		const targetTriple = optionalValue(options.targetTriple);
		return runPluginsBuild({
			_tag: "PluginsBuild",
			architecture: options.architecture,
			buildId: options.buildId,
			compiler: options.compiler,
			compilerVersion: options.compilerVersion,
			engineRoot: options.engineRoot,
			...(engineSourceCommit === undefined ? undefined : { engineSourceCommit }),
			maximumBuildSeconds: options.maximumBuildSeconds,
			outputDirectory: options.outputDirectory,
			platform: options.platform,
			pluginIds: options.plugins,
			sourceArtifactDigest: options.sourceArtifactDigest,
			sourceArtifactPath: options.sourceArtifactPath,
			sourceManifestDigest: options.sourceManifestDigest,
			sourceManifestPath: options.sourceManifestPath,
			toolchain: options.toolchain,
			toolchainVersion: options.toolchainVersion,
			...(targetTriple === undefined ? undefined : { targetTriple }),
			unrealVersion: options.unrealVersion
		});
	}
).pipe(Command.withDescription("Build an exact compiled UnrealEditor plugin graph."));

const pluginsCacheInstallCommand = Command.make(
	"install",
	{
		architecture: Flag.string("architecture").pipe(
			Flag.withSchema(UnrealArchitecture),
			Flag.withDefault(UnrealArchitecture.make("x64"))
		),
		artifactDigest: optionalFlag("artifact-digest"),
		buildId: pluginBuildIdFlag,
		cache: Flag.string("cache"),
		cacheOnly: Flag.boolean("cache-only"),
		engineSourceCommit: pluginEngineSourceCommitFlag,
		kind: Flag.choice("kind", ["source", "compiled"]).pipe(Flag.withDefault("source")),
		manifestDigest: optionalFlag("manifest-digest"),
		platform: Flag.string("platform").pipe(
			Flag.withSchema(UnrealPlatform),
			Flag.withDefault(UnrealPlatform.make("Win64"))
		),
		plugins: Flag.string("plugin").pipe(Flag.atLeast(1)),
		release: pluginReleaseFlag,
		source: Flag.string("source").pipe(Flag.withDefault(".")),
		unreal: pluginUnrealFlag
	},
	({
		architecture,
		artifactDigest,
		buildId,
		cache,
		cacheOnly,
		engineSourceCommit,
		kind,
		manifestDigest,
		platform,
		plugins,
		release,
		source,
		unreal
	}) =>
		Effect.gen(function* () {
			const artifactDigestValue = optionalValue(artifactDigest);
			const buildIdValue = optionalValue(buildId);
			const engineSourceCommitValue = optionalValue(engineSourceCommit);
			const manifestDigestValue = optionalValue(manifestDigest);
			const unrealVersion = optionalValue(unreal);
			if (
				kind === "compiled" &&
				(buildIdValue === undefined || unrealVersion === undefined)
			) {
				return yield* Effect.fail(
					new CliCommandError({
						message:
							"compiled cache installs require exact --unreal and --build-id values"
					})
				);
			}
			if (kind === "source" && buildIdValue !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({
						message: "source cache installs do not accept --build-id"
					})
				);
			}
			if (kind === "source" && engineSourceCommitValue !== undefined) {
				return yield* Effect.fail(
					new CliCommandError({
						message: "source cache installs do not accept --engine-source-commit"
					})
				);
			}
			return yield* runPluginsCacheInstall({
				_tag: "PluginsCacheInstall",
				artifact:
					kind === "compiled"
						? {
								architecture,
								configuration: "Development",
								engineBuildId: buildIdValue!,
								...(engineSourceCommitValue === undefined
									? undefined
									: { engineSourceCommit: engineSourceCommitValue }),
								kind,
								platform,
								target: "UnrealEditor",
								unrealVersion: unrealVersion!
							}
						: {
								kind,
								...(unrealVersion === undefined ? undefined : { unrealVersion })
							},
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
					: { manifestDigest: manifestDigestValue })
			});
		})
).pipe(Command.withDescription("Install an exact plugin release into a host cache."));

const pluginsCacheListCommand = Command.make("list", { cache: Flag.string("cache") }, ({ cache }) =>
	runPluginsCacheList({ _tag: "PluginsCacheList", cacheRoot: cache })
).pipe(Command.withDescription("List verified releases in a plugin cache."));

const pluginsCacheVerifyCommand = Command.make(
	"verify",
	{ cache: Flag.string("cache"), release: pluginReleaseFlag, variant: pluginVariantFlag },
	({ cache, release, variant }) =>
		runPluginsCacheVerify({
			_tag: "PluginsCacheVerify",
			cacheRoot: cache,
			releaseVersion: release,
			...(optionalValue(variant) === undefined
				? undefined
				: { variantIdentity: optionalValue(variant)! })
		})
).pipe(Command.withDescription("Verify one immutable cached plugin release."));

const pluginsPruneCommand = Command.make(
	"prune",
	{ cache: Flag.string("cache"), release: pluginReleaseFlag, variant: pluginVariantFlag },
	({ cache, release, variant }) =>
		runPluginsPrune({
			_tag: "PluginsPrune",
			cacheRoot: cache,
			releaseVersion: release,
			...(optionalValue(variant) === undefined
				? undefined
				: { variantIdentity: optionalValue(variant)! })
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
		pluginsBuildCommand,
		pluginsListCommand,
		pluginsVerifyCommand,
		pluginsInstallCommand,
		pluginsCacheCommand
	])
);
