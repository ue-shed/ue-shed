import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";
import { CAMERA_PIPE_NAME } from "@ue-shed/cameras";
import type { SavedWorldMap } from "@ue-shed/protocol";

export type ConfiguredPath =
	| { readonly status: "configured"; readonly path: string }
	| { readonly status: "not_configured" };

export type ProjectConfiguration =
	| {
			readonly status: "configured";
			readonly projectRoot: string;
			readonly sessionStorageRoot?: string;
	  }
	| { readonly status: "not_configured" };

export type ReviewConfiguration =
	| {
			readonly status: "configured";
			readonly projectRoot: string;
			readonly reviewSetPath: string;
	  }
	| { readonly status: "project_configured"; readonly projectRoot: string }
	| { readonly status: "not_configured" };

export type ExpectedProjectConfiguration =
	| { readonly status: "configured"; readonly projectName: string }
	| { readonly status: "not_configured" };

export type SavedWorldMapsConfiguration =
	| { readonly status: "configured"; readonly maps: readonly SavedWorldMap[] }
	| { readonly status: "not_configured" };

export interface WorkbenchConfigurationApi {
	readonly authoringAsset: ConfiguredPath;
	readonly cameraPipeName?: string;
	readonly custodianRoot?: ConfiguredPath;
	readonly expectedProject: ExpectedProjectConfiguration;
	readonly project: ProjectConfiguration;
	readonly remoteControlEndpoint: string;
	readonly review: ReviewConfiguration;
	/** Optional saved map to inspect without connecting to an Unreal Editor. */
	readonly savedWorldMap?: ConfiguredPath;
	/** Optional set of saved maps available to the offline map viewer. */
	readonly savedWorldMaps?: SavedWorldMapsConfiguration;
	readonly sourceCheckout: ConfiguredPath;
	readonly textureAuditRules: ConfiguredPath;
	/** Optional engine root used by headless saved-asset operations. */
	readonly unrealEngineRoot?: ConfiguredPath;
}

export class WorkbenchConfiguration extends Context.Service<
	WorkbenchConfiguration,
	WorkbenchConfigurationApi
>()("@ue-shed/workbench/WorkbenchConfiguration") {}

const NonEmptyConfigString = Schema.NonEmptyString.check(Schema.isPattern(/\S/));
const HttpEndpoint = Schema.NonEmptyString.check(
	Schema.makeFilter((value) => {
		try {
			const url = new URL(value);
			return url.protocol === "http:" || url.protocol === "https:"
				? undefined
				: "expected an HTTP or HTTPS URL";
		} catch {
			return "expected a valid HTTP or HTTPS URL";
		}
	})
);

const remoteControlEndpointConfig = Config.schema(
	HttpEndpoint,
	"UE_SHED_REMOTE_CONTROL_ENDPOINT"
).pipe(Config.withDefault("http://127.0.0.1:30001"));
const cameraPipeNameConfig = Config.schema(NonEmptyConfigString, "UE_SHED_CAMERA_PIPE_NAME").pipe(
	Config.withDefault(CAMERA_PIPE_NAME)
);
const projectRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_PROJECT_ROOT")
);
const authoringSessionRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_AUTHORING_SESSION_ROOT")
);
const reviewSetConfig = Config.option(Config.schema(NonEmptyConfigString, "UE_SHED_REVIEW_SET"));
const savedWorldMapConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_SAVED_WORLD_MAP")
);
const savedWorldMapsConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_SAVED_WORLD_MAPS")
);
const projectNameConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_PROJECT_NAME")
);
const repositoryRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_REPOSITORY_ROOT")
);
const textureAuditRulesConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_TEXTURE_AUDIT_RULES")
);
const authoringAssetConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_AUTHORING_ASSET")
);
const unrealEngineRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_UNREAL_ENGINE_ROOT")
);
const custodianRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_CUSTODIAN_ROOT")
);

function configuredPath(path: Option.Option<string>): ConfiguredPath {
	return Option.match(path, {
		onNone: () => ({ status: "not_configured" as const }),
		onSome: (value) => ({ status: "configured" as const, path: value })
	});
}

function configuredSavedWorldMaps(
	paths: Option.Option<string>,
	fallback: Option.Option<string>
): SavedWorldMapsConfiguration {
	const configured = Option.isSome(paths) ? paths.value : Option.getOrUndefined(fallback);
	if (configured === undefined) return { status: "not_configured" };
	const maps = configured
		.split(";")
		.map((path) => path.trim())
		.filter((path) => path.length > 0)
		.map((mapPath) => ({ label: savedMapLabel(mapPath), mapPath }));
	return maps.length === 0 ? { status: "not_configured" } : { status: "configured", maps };
}

export function savedMapLabel(mapPath: string): string {
	const filename = mapPath.replaceAll("\\", "/").split("/").at(-1) ?? mapPath;
	return filename
		.replace(/\.umap$/i, "")
		.replace(/^L_/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replaceAll("_", " ");
}

export function makeWorkbenchConfiguration(input: {
	readonly authoringAsset: Option.Option<string>;
	readonly authoringSessionRoot: Option.Option<string>;
	readonly cameraPipeName?: string;
	readonly custodianRoot?: Option.Option<string>;
	readonly expectedProjectName: Option.Option<string>;
	readonly projectRoot: Option.Option<string>;
	readonly remoteControlEndpoint: string;
	readonly repositoryRoot: Option.Option<string>;
	readonly reviewSet: Option.Option<string>;
	readonly savedWorldMap?: Option.Option<string>;
	readonly savedWorldMaps?: Option.Option<string>;
	readonly textureAuditRules: Option.Option<string>;
	readonly unrealEngineRoot?: Option.Option<string>;
}): WorkbenchConfigurationApi {
	const project: ProjectConfiguration = Option.match(input.projectRoot, {
		onNone: () => ({ status: "not_configured" as const }),
		onSome: (projectRoot) => ({
			projectRoot,
			...(Option.isSome(input.authoringSessionRoot)
				? { sessionStorageRoot: input.authoringSessionRoot.value }
				: undefined),
			status: "configured" as const
		})
	});

	const review: ReviewConfiguration =
		project.status === "configured"
			? Option.match(input.reviewSet, {
					onNone: () => ({
						projectRoot: project.projectRoot,
						status: "project_configured" as const
					}),
					onSome: (reviewSetPath) => ({
						projectRoot: project.projectRoot,
						reviewSetPath,
						status: "configured" as const
					})
				})
			: { status: "not_configured" };

	const expectedProject: ExpectedProjectConfiguration = Option.match(input.expectedProjectName, {
		onNone: () => ({ status: "not_configured" as const }),
		onSome: (projectName) => ({ status: "configured" as const, projectName })
	});

	return {
		authoringAsset: configuredPath(input.authoringAsset),
		cameraPipeName: input.cameraPipeName ?? CAMERA_PIPE_NAME,
		custodianRoot: configuredPath(input.custodianRoot ?? Option.none()),
		expectedProject,
		project,
		remoteControlEndpoint: input.remoteControlEndpoint,
		review,
		savedWorldMap: configuredPath(input.savedWorldMap ?? Option.none()),
		savedWorldMaps: configuredSavedWorldMaps(
			input.savedWorldMaps ?? Option.none(),
			input.savedWorldMap ?? Option.none()
		),
		sourceCheckout: configuredPath(input.repositoryRoot),
		textureAuditRules: configuredPath(input.textureAuditRules),
		unrealEngineRoot: configuredPath(input.unrealEngineRoot ?? Option.none())
	};
}

export const WorkbenchConfigurationLive = Layer.effect(
	WorkbenchConfiguration,
	Effect.gen(function* () {
		return WorkbenchConfiguration.of(
			makeWorkbenchConfiguration({
				authoringAsset: yield* authoringAssetConfig,
				authoringSessionRoot: yield* authoringSessionRootConfig,
				cameraPipeName: yield* cameraPipeNameConfig,
				custodianRoot: yield* custodianRootConfig,
				expectedProjectName: yield* projectNameConfig,
				projectRoot: yield* projectRootConfig,
				remoteControlEndpoint: yield* remoteControlEndpointConfig,
				repositoryRoot: yield* repositoryRootConfig,
				reviewSet: yield* reviewSetConfig,
				savedWorldMap: yield* savedWorldMapConfig,
				savedWorldMaps: yield* savedWorldMapsConfig,
				textureAuditRules: yield* textureAuditRulesConfig,
				unrealEngineRoot: yield* unrealEngineRootConfig
			})
		);
	})
);

export const makeWorkbenchConfigurationLayer = (
	configuration: WorkbenchConfigurationApi
): Layer.Layer<WorkbenchConfiguration> =>
	Layer.succeed(WorkbenchConfiguration, WorkbenchConfiguration.of(configuration));

export const workbenchConfigurationFromUnknown = (
	values: Readonly<Record<string, string>>
): Layer.Layer<WorkbenchConfiguration, Config.ConfigError> =>
	WorkbenchConfigurationLive.pipe(
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
	);
