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

export interface ShedHostConfigurationShape {
	readonly authoringAsset: () => Effect.Effect<ConfiguredAsset>;
	readonly project: () => Effect.Effect<ConfiguredProject>;
	readonly remoteControlEndpoint: () => Effect.Effect<string>;
}

export interface ShedHostConfigurationValues {
	readonly authoringAsset: ConfiguredAsset;
	readonly project: ConfiguredProject;
	readonly remoteControlEndpoint: string;
}

export class ShedHostConfiguration extends Context.Service<
	ShedHostConfiguration,
	ShedHostConfigurationShape
>()("@ue-shed/host/ShedHostConfiguration") {}

export function makeShedHostConfiguration(
	values: ShedHostConfigurationValues
): ShedHostConfigurationShape {
	return ShedHostConfiguration.of({
		authoringAsset: Effect.fn("ShedHostConfiguration.authoringAsset")(() =>
			Effect.succeed(values.authoringAsset)
		),
		project: Effect.fn("ShedHostConfiguration.project")(() => Effect.succeed(values.project)),
		remoteControlEndpoint: Effect.fn("ShedHostConfiguration.remoteControlEndpoint")(() =>
			Effect.succeed(values.remoteControlEndpoint)
		)
	});
}

export function shedHostConfigurationLayer(
	configuration: ShedHostConfigurationValues
): Layer.Layer<ShedHostConfiguration> {
	return Layer.succeed(ShedHostConfiguration, makeShedHostConfiguration(configuration));
}
