import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";

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

export interface WorkbenchConfigurationShape {
	readonly authoringAsset: ConfiguredPath;
	readonly expectedProject: ExpectedProjectConfiguration;
	readonly project: ProjectConfiguration;
	readonly remoteControlEndpoint: string;
	readonly review: ReviewConfiguration;
	readonly sourceCheckout: ConfiguredPath;
	readonly textureAuditRules: ConfiguredPath;
}

export class WorkbenchConfiguration extends Context.Service<
	WorkbenchConfiguration,
	WorkbenchConfigurationShape
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
const projectRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_PROJECT_ROOT")
);
const authoringSessionRootConfig = Config.option(
	Config.schema(NonEmptyConfigString, "UE_SHED_AUTHORING_SESSION_ROOT")
);
const reviewSetConfig = Config.option(Config.schema(NonEmptyConfigString, "UE_SHED_REVIEW_SET"));
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

function configuredPath(path: Option.Option<string>): ConfiguredPath {
	return Option.match(path, {
		onNone: () => ({ status: "not_configured" as const }),
		onSome: (value) => ({ status: "configured" as const, path: value })
	});
}

export function makeWorkbenchConfiguration(input: {
	readonly authoringAsset: Option.Option<string>;
	readonly authoringSessionRoot: Option.Option<string>;
	readonly expectedProjectName: Option.Option<string>;
	readonly projectRoot: Option.Option<string>;
	readonly remoteControlEndpoint: string;
	readonly repositoryRoot: Option.Option<string>;
	readonly reviewSet: Option.Option<string>;
	readonly textureAuditRules: Option.Option<string>;
}): WorkbenchConfigurationShape {
	const project: ProjectConfiguration = Option.match(input.projectRoot, {
		onNone: () => ({ status: "not_configured" as const }),
		onSome: (projectRoot) => ({
			projectRoot,
			...(Option.isSome(input.authoringSessionRoot)
				? { sessionStorageRoot: input.authoringSessionRoot.value }
				: {}),
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
		expectedProject,
		project,
		remoteControlEndpoint: input.remoteControlEndpoint,
		review,
		sourceCheckout: configuredPath(input.repositoryRoot),
		textureAuditRules: configuredPath(input.textureAuditRules)
	};
}

export const WorkbenchConfigurationLive = Layer.effect(
	WorkbenchConfiguration,
	Effect.gen(function* () {
		return WorkbenchConfiguration.of(
			makeWorkbenchConfiguration({
				authoringAsset: yield* authoringAssetConfig,
				authoringSessionRoot: yield* authoringSessionRootConfig,
				expectedProjectName: yield* projectNameConfig,
				projectRoot: yield* projectRootConfig,
				remoteControlEndpoint: yield* remoteControlEndpointConfig,
				repositoryRoot: yield* repositoryRootConfig,
				reviewSet: yield* reviewSetConfig,
				textureAuditRules: yield* textureAuditRulesConfig
			})
		);
	})
);

export const makeWorkbenchConfigurationLayer = (
	configuration: WorkbenchConfigurationShape
): Layer.Layer<WorkbenchConfiguration> =>
	Layer.succeed(WorkbenchConfiguration, WorkbenchConfiguration.of(configuration));

export const workbenchConfigurationFromUnknown = (
	values: Readonly<Record<string, string>>
): Layer.Layer<WorkbenchConfiguration, Config.ConfigError> =>
	WorkbenchConfigurationLive.pipe(
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
	);
