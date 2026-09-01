import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { expect } from "vitest";
import {
	WorkbenchConfiguration,
	WorkbenchConfigurationLive,
	workbenchConfigurationFromUnknown
} from "./workbench-config.js";

it.effect("defaults the remote control endpoint when unset", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.remoteControlEndpoint).toBe("http://127.0.0.1:30001");
		expect(configuration.cameraPipeName).toBe("\\\\.\\pipe\\ue-shed-cameras-v1");
		expect(configuration.project).toEqual({ status: "not_configured" });
		expect(configuration.rememberProjects).toBe(true);
		expect(configuration.review).toEqual({ status: "not_configured" });
		expect(configuration.savedWorldMap).toEqual({ status: "not_configured" });
		expect(configuration.savedWorldMaps).toEqual({ status: "not_configured" });
		expect(configuration.textureAuditRules).toEqual({ status: "not_configured" });
		expect(configuration.authoringAsset).toEqual({ status: "not_configured" });
		expect(configuration.custodianRoot).toEqual({ status: "not_configured" });
		expect(configuration.sourceCheckout).toEqual({ status: "not_configured" });
		expect(configuration.expectedProject).toEqual({ status: "not_configured" });
		expect(configuration.unrealEngineRoot).toEqual({ status: "not_configured" });
	}).pipe(Effect.provide(workbenchConfigurationFromUnknown({})))
);

it.effect("makes Map Review ready for first-run authoring when a project root exists", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.project).toEqual({
			status: "configured",
			projectRoot: "C:/FixtureProject"
		});
		expect(configuration.review).toEqual({
			status: "project_configured",
			projectRoot: "C:/FixtureProject"
		});
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_PROJECT_ROOT: "C:/FixtureProject"
			})
		)
	)
);

it.effect("derives picker labels from a configured saved-map list", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.savedWorldMaps).toEqual({
			status: "configured",
			maps: [
				{ label: "Offline World", mapPath: "Content/Maps/L_OfflineWorld.umap" },
				{ label: "Camera Load", mapPath: "Content/Maps/L_CameraLoad.umap" }
			]
		});
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_SAVED_WORLD_MAPS:
					"Content/Maps/L_OfflineWorld.umap;Content/Maps/L_CameraLoad.umap"
			})
		)
	)
);

it.effect("honors an explicit Review Set override", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.review).toEqual({
			status: "configured",
			projectRoot: "C:/FixtureProject",
			reviewSetPath: "C:/custom/review-set.json"
		});
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_PROJECT_ROOT: "C:/FixtureProject",
				UE_SHED_REVIEW_SET: "C:/custom/review-set.json"
			})
		)
	)
);

it.effect("loads a complete configured Workbench session", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration).toEqual({
			authoringAsset: { status: "configured", path: "C:/table.uasset" },
			cameraPipeName: "\\\\.\\pipe\\ue-shed-cameras-recording",
			custodianRoot: { status: "configured", path: "C:/Unreal" },
			expectedProject: { status: "configured", projectName: "Fixture" },
			project: {
				status: "configured",
				projectRoot: "C:/FixtureProject",
				sessionStorageRoot: "C:/Temp/authoring-sessions"
			},
			rememberProjects: true,
			remoteControlEndpoint: "http://127.0.0.1:30010",
			review: {
				status: "configured",
				projectRoot: "C:/FixtureProject",
				reviewSetPath: "C:/custom/review-set.json"
			},
			savedWorldMap: { status: "configured", path: "Content/Maps/Fixture.umap" },
			savedWorldMaps: {
				status: "configured",
				maps: [{ label: "Fixture", mapPath: "Content/Maps/Fixture.umap" }]
			},
			sourceCheckout: { status: "configured", path: "C:/repo" },
			textureAuditRules: { status: "configured", path: "C:/rules.json" },
			unrealEngineRoot: { status: "configured", path: "C:/Unreal/UE_5.7" }
		});
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_AUTHORING_ASSET: "C:/table.uasset",
				UE_SHED_AUTHORING_SESSION_ROOT: "C:/Temp/authoring-sessions",
				UE_SHED_CAMERA_PIPE_NAME: "\\\\.\\pipe\\ue-shed-cameras-recording",
				UE_SHED_CUSTODIAN_ROOT: "C:/Unreal",
				UE_SHED_PROJECT_NAME: "Fixture",
				UE_SHED_PROJECT_ROOT: "C:/FixtureProject",
				UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://127.0.0.1:30010",
				UE_SHED_REPOSITORY_ROOT: "C:/repo",
				UE_SHED_REVIEW_SET: "C:/custom/review-set.json",
				UE_SHED_SAVED_WORLD_MAP: "Content/Maps/Fixture.umap",
				UE_SHED_TEXTURE_AUDIT_RULES: "C:/rules.json",
				UE_SHED_UNREAL_ENGINE_ROOT: "C:/Unreal/UE_5.7"
			})
		)
	)
);

it.effect("can disable project history for deterministic fixture runs", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.rememberProjects).toBe(false);
	}).pipe(
		Effect.provide(workbenchConfigurationFromUnknown({ UE_SHED_REMEMBER_PROJECTS: "false" }))
	)
);

it.effect("keeps Review not configured when only a Review Set is supplied", () =>
	Effect.gen(function* () {
		const configuration = yield* WorkbenchConfiguration;
		expect(configuration.project).toEqual({ status: "not_configured" });
		expect(configuration.review).toEqual({ status: "not_configured" });
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_REVIEW_SET: "C:/custom/review-set.json"
			})
		)
	)
);

it.effect("fails startup for malformed configured values", () =>
	Effect.gen(function* () {
		const exit = yield* Layer.build(
			WorkbenchConfigurationLive.pipe(
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							UE_SHED_REMOTE_CONTROL_ENDPOINT: "not-a-url"
						})
					)
				)
			)
		).pipe(Effect.scoped, Effect.exit);
		expect(Exit.isFailure(exit)).toBe(true);
	})
);

it.effect("rejects incomplete endpoints and empty configured paths", () =>
	Effect.gen(function* () {
		for (const values of [
			{ UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://" },
			{ UE_SHED_PROJECT_ROOT: " " }
		]) {
			const exit = yield* Layer.build(
				WorkbenchConfigurationLive.pipe(
					Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
				)
			).pipe(Effect.scoped, Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
		}
	})
);
