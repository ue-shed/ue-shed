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
		expect(configuration.project).toEqual({ status: "not_configured" });
		expect(configuration.review).toEqual({ status: "not_configured" });
		expect(configuration.textureAuditRules).toEqual({ status: "not_configured" });
		expect(configuration.authoringAsset).toEqual({ status: "not_configured" });
		expect(configuration.sourceCheckout).toEqual({ status: "not_configured" });
		expect(configuration.expectedProject).toEqual({ status: "not_configured" });
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
			expectedProject: { status: "configured", projectName: "Fixture" },
			project: {
				status: "configured",
				projectRoot: "C:/FixtureProject",
				sessionStorageRoot: "C:/Temp/authoring-sessions"
			},
			remoteControlEndpoint: "http://127.0.0.1:30010",
			review: {
				status: "configured",
				projectRoot: "C:/FixtureProject",
				reviewSetPath: "C:/custom/review-set.json"
			},
			sourceCheckout: { status: "configured", path: "C:/repo" },
			textureAuditRules: { status: "configured", path: "C:/rules.json" }
		});
	}).pipe(
		Effect.provide(
			workbenchConfigurationFromUnknown({
				UE_SHED_AUTHORING_ASSET: "C:/table.uasset",
				UE_SHED_AUTHORING_SESSION_ROOT: "C:/Temp/authoring-sessions",
				UE_SHED_PROJECT_NAME: "Fixture",
				UE_SHED_PROJECT_ROOT: "C:/FixtureProject",
				UE_SHED_REMOTE_CONTROL_ENDPOINT: "http://127.0.0.1:30010",
				UE_SHED_REPOSITORY_ROOT: "C:/repo",
				UE_SHED_REVIEW_SET: "C:/custom/review-set.json",
				UE_SHED_TEXTURE_AUDIT_RULES: "C:/rules.json"
			})
		)
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
