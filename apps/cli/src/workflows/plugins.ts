import { Effect, Layer } from "effect";
import {
	PluginDistribution,
	httpPluginReleaseSourceLayer,
	localPluginReleaseSourceLayer,
	pluginDistributionLayer,
	pluginStoreLayer
} from "@ue-shed/plugin-distribution";
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

function distributionLayer(cacheRoot: string, source: string) {
	const sourceLayer = /^https?:\/\//u.test(source)
		? httpPluginReleaseSourceLayer({ baseUrl: source })
		: localPluginReleaseSourceLayer({ directory: source });
	return pluginDistributionLayer().pipe(
		Layer.provide(Layer.merge(sourceLayer, pluginStoreLayer({ cacheRoot })))
	);
}

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
						releaseVersion: command.releaseVersion,
						pluginIds: command.pluginIds,
						networkPolicy: command.cacheOnly ? "cache-only" : "online",
						...(command.artifactDigest === undefined
							? undefined
							: { expectedArtifactSha256: command.artifactDigest }),
						...(command.manifestDigest === undefined
							? undefined
							: { expectedManifestSha256: command.manifestDigest }),
						...(command.unrealVersion === undefined
							? undefined
							: { unrealVersion: command.unrealVersion })
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
				distribution.verifyCached(command.releaseVersion)
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
				distribution.prune(command.releaseVersion)
			).pipe(
				Effect.andThen(
					printJson({ releaseVersion: command.releaseVersion, status: "pruned" })
				),
				Effect.provide(distributionLayer(command.cacheRoot, "."))
			)
		)
);
