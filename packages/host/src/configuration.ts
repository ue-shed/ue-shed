import { Context, Effect, Layer } from "effect";

export type ConfiguredAsset =
	| { readonly status: "configured"; readonly path: string }
	| { readonly status: "not_configured" };

export type ConfiguredProject =
	| {
			readonly catalogCachePath?: string;
			readonly status: "configured";
			readonly projectRoot: string;
			readonly sessionStorageRoot?: string;
	  }
	| { readonly status: "not_configured" };

export interface ShedHostConfigurationApi {
	readonly authoringAsset: Effect.Effect<ConfiguredAsset>;
	readonly project: Effect.Effect<ConfiguredProject>;
	readonly remoteControlEndpoint: Effect.Effect<string>;
}

export interface ShedHostConfigurationValues {
	readonly authoringAsset: ConfiguredAsset;
	readonly project: ConfiguredProject;
	readonly remoteControlEndpoint: string;
}

/**
 * Host-owned selection and connection configuration. Reading this service neither selects a
 * project nor launches an editor; features consume the shell's existing selection.
 */
export class ShedHostConfiguration extends Context.Service<
	ShedHostConfiguration,
	ShedHostConfigurationApi
>()("@ue-shed/host/ShedHostConfiguration") {}

export function makeShedHostConfiguration(
	values: ShedHostConfigurationValues
): ShedHostConfigurationApi {
	return ShedHostConfiguration.of({
		authoringAsset: Effect.sync(() => values.authoringAsset).pipe(
			Effect.withSpan("ShedHostConfiguration.authoringAsset")
		),
		project: Effect.sync(() => values.project).pipe(
			Effect.withSpan("ShedHostConfiguration.project")
		),
		remoteControlEndpoint: Effect.sync(() => values.remoteControlEndpoint).pipe(
			Effect.withSpan("ShedHostConfiguration.remoteControlEndpoint")
		)
	});
}

/**
 * Provides fixed host configuration values. Hosts with a changing selection can supply their
 * own ShedHostConfiguration implementation instead of mutating these captured values.
 */
export function shedHostConfigurationLayer(
	configuration: ShedHostConfigurationValues
): Layer.Layer<ShedHostConfiguration> {
	return Layer.succeed(ShedHostConfiguration, makeShedHostConfiguration(configuration));
}
