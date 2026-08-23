import { Effect, Layer } from "effect";
import {
	CompiledPluginBuilder,
	PluginDistribution,
	compiledPluginBuilderLayer,
	httpPluginReleaseSourceLayer,
	localPluginReleaseSourceLayer,
	pluginDistributionLayer,
	pluginStoreLayer
} from "@ue-shed/plugin-distribution";
import { OwnedProcessTreeLive } from "@ue-shed/engine";
import { printJson } from "../cli-runtime.js";
import { observeCliOperation } from "../cli-operation.js";
import type { CliCommand } from "../command-model.js";

type PluginsListCommand = Extract<CliCommand, { readonly _tag: "PluginsList" }>;
type PluginsVerifyCommand = Extract<CliCommand, { readonly _tag: "PluginsVerify" }>;
type PluginsInstallCommand = Extract<CliCommand, { readonly _tag: "PluginsInstall" }>;
type PluginsCacheInstallCommand = Extract<CliCommand, { readonly _tag: "PluginsCacheInstall" }>;
type PluginsCacheListCommand = Extract<CliCommand, { readonly _tag: "PluginsCacheList" }>;
type PluginsCacheVerifyCommand = Extract<CliCommand, { readonly _tag: "PluginsCacheVerify" }>;
type PluginsPruneCommand = Extract<CliCommand, { readonly _tag: "PluginsPrune" }>;
type PluginsBuildCommand = Extract<CliCommand, { readonly _tag: "PluginsBuild" }>;

function distributionLayer(cacheRoot: string, source: string) {
	const sourceLayer = /^https?:\/\//u.test(source)
		? httpPluginReleaseSourceLayer({ baseUrl: source })
		: localPluginReleaseSourceLayer({ directory: source });
	return pluginDistributionLayer().pipe(
		Layer.provide(Layer.merge(sourceLayer, pluginStoreLayer({ cacheRoot })))
	);
}

const builderLayer = compiledPluginBuilderLayer().pipe(Layer.provide(OwnedProcessTreeLive));

export const runPluginsBuild = Effect.fn("Cli.workflow.plugins_build")(
	(command: PluginsBuildCommand) =>
		observeCliOperation(
			command._tag,
			Effect.flatMap(CompiledPluginBuilder, (builder) =>
				builder.build({
					artifact: {
						architecture: command.architecture,
						configuration: "Development",
						engineBuildId: command.buildId,
						...(command.engineSourceCommit === undefined
							? undefined
							: { engineSourceCommit: command.engineSourceCommit }),
						kind: "compiled",
						platform: command.platform,
						target: "UnrealEditor",
						unrealVersion: command.unrealVersion
					},
					compiler: {
						compiler: command.compiler,
						compilerVersion: command.compilerVersion,
						toolchain: command.toolchain,
						toolchainVersion: command.toolchainVersion,
						...(command.targetTriple === undefined
							? undefined
							: { targetTriple: command.targetTriple })
					},
					engineRoot: command.engineRoot,
					expectedSourceArtifactSha256: command.sourceArtifactDigest,
					expectedSourceManifestSha256: command.sourceManifestDigest,
					maximumBuildSeconds: command.maximumBuildSeconds,
					outputDirectory: command.outputDirectory,
					pluginIds: command.pluginIds,
					sourceArtifactPath: command.sourceArtifactPath,
					sourceManifestPath: command.sourceManifestPath
				})
			).pipe(Effect.flatMap(printJson), Effect.provide(builderLayer))
		)
);

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

export const runPluginsCacheInstall = Effect.fn("Cli.workflow.plugins_cache_install")(
	(command: PluginsCacheInstallCommand) =>
		observeCliOperation(
			command._tag,
			Effect.scoped(
				Effect.gen(function* () {
					const distribution = yield* PluginDistribution;
					const result = yield* distribution.install({
						artifact: command.artifact,
						releaseVersion: command.releaseVersion,
						pluginIds: command.pluginIds,
						networkPolicy: command.cacheOnly ? "cache-only" : "online",
						...(command.artifactDigest === undefined
							? undefined
							: { expectedArtifactSha256: command.artifactDigest }),
						...(command.manifestDigest === undefined
							? undefined
							: { expectedManifestSha256: command.manifestDigest })
					});
					return yield* printJson(result);
				})
			).pipe(Effect.provide(distributionLayer(command.cacheRoot, command.source)))
		)
);

export const runPluginsCacheList = Effect.fn("Cli.workflow.plugins_cache_list")(
	(command: PluginsCacheListCommand) =>
		observeCliOperation(
			command._tag,
			Effect.flatMap(PluginDistribution, (distribution) => distribution.listCached()).pipe(
				Effect.flatMap(printJson),
				Effect.provide(distributionLayer(command.cacheRoot, "."))
			)
		)
);

export const runPluginsCacheVerify = Effect.fn("Cli.workflow.plugins_cache_verify")(
	(command: PluginsCacheVerifyCommand) =>
		observeCliOperation(
			command._tag,
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.verifyCached(
					command.variantIdentity === undefined
						? command.releaseVersion
						: {
								releaseVersion: command.releaseVersion,
								variantIdentity: command.variantIdentity
							}
				)
			).pipe(
				Effect.flatMap(printJson),
				Effect.provide(distributionLayer(command.cacheRoot, "."))
			)
		)
);

export const runPluginsPrune = Effect.fn("Cli.workflow.plugins_prune")(
	(command: PluginsPruneCommand) =>
		observeCliOperation(
			command._tag,
			Effect.flatMap(PluginDistribution, (distribution) =>
				distribution.prune(
					command.variantIdentity === undefined
						? command.releaseVersion
						: {
								releaseVersion: command.releaseVersion,
								variantIdentity: command.variantIdentity
							}
				)
			).pipe(
				Effect.andThen(
					printJson({ releaseVersion: command.releaseVersion, status: "pruned" })
				),
				Effect.provide(distributionLayer(command.cacheRoot, "."))
			)
		)
);
