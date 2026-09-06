import { makeWorkbenchTestConfigurationLayer as makeWorkbenchConfigurationLayer } from "../test-configuration.js";
import { it } from "@effect/vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";
import { WorkbenchAssetNavigation, WorkbenchAssetNavigationLive } from "./asset-navigation.js";
import {
	WorkbenchUnrealConnection,
	makeWorkbenchUnrealConnectionLayer
} from "./unreal-connection.js";

it.effect("keeps negotiation and navigation on one target during a port change", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>();
		const resume = yield* Deferred.make<void>();
		const requests: string[] = [];
		const remote = makeRemoteControlClientTestLayer((request) =>
			Effect.gen(function* () {
				requests.push(request.endpoint);
				if (requests.length === 1) {
					yield* Deferred.succeed(started, undefined);
					yield* Deferred.await(resume);
				}
				return request.functionName === "GetCapabilityManifest"
					? {
							assetNavigationObjectPath:
								"/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary",
							capabilities: ["editor.asset-navigation.v1"],
							producerKind: "unreal_editor",
							projectName: "Fixture",
							schemaVersion: 1
						}
					: {
							contract: {
								name: "unreal-editor-asset-navigation",
								version: { major: 1, minor: 0 }
							},
							objectPath: "/Game/Textures/T_Rock.T_Rock",
							status: "located"
						};
			})
		);
		const dependencies = Layer.merge(
			remote,
			makeWorkbenchUnrealConnectionLayer("http://editor:30001/")
		);
		yield* Effect.gen(function* () {
			const connection = yield* WorkbenchUnrealConnection;
			const navigation = yield* WorkbenchAssetNavigation;
			const first = yield* connection
				.withCurrent(navigation.locate("/Game/Textures/T_Rock.T_Rock"))
				.pipe(Effect.forkChild);
			yield* Deferred.await(started);
			yield* connection.setPort(31001);
			yield* Deferred.succeed(resume, undefined);
			expect((yield* Fiber.join(first)).status).toBe("located");
			expect((yield* navigation.locate("/Game/Textures/T_Rock.T_Rock")).status).toBe(
				"located"
			);
			expect(requests).toEqual([
				"http://editor:30001",
				"http://editor:30001",
				"http://editor:31001",
				"http://editor:31001"
			]);
		}).pipe(
			Effect.provide(WorkbenchAssetNavigationLive.pipe(Layer.provideMerge(dependencies)))
		);
	})
);

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { status: "not_configured" },
	textureAuditRules: { status: "not_configured" }
});

function navigationLayer(
	handle: Parameters<typeof makeRemoteControlClientTestLayer>[0]
): Layer.Layer<WorkbenchAssetNavigation> {
	const dependencies = Layer.mergeAll(configuration, makeRemoteControlClientTestLayer(handle));
	return WorkbenchAssetNavigationLive.pipe(Layer.provide(dependencies));
}

it.effect("locates any advertised Unreal asset through the generic capability", () =>
	Effect.gen(function* () {
		const navigation = yield* WorkbenchAssetNavigation;
		const result = yield* navigation.locate("/Game/Textures/T_Rock.T_Rock");
		expect(result).toEqual({
			contract: {
				name: "unreal-editor-asset-navigation",
				version: { major: 1, minor: 0 }
			},
			objectPath: "/Game/Textures/T_Rock.T_Rock",
			status: "located"
		});
	}).pipe(
		Effect.provide(
			navigationLayer((request) =>
				request.functionName === "GetCapabilityManifest"
					? Effect.succeed({
							assetNavigationObjectPath:
								"/Script/UEShedCoreEditor.Default__UEShedEditorAssetNavigationLibrary",
							capabilities: ["editor.asset-navigation.v1"],
							producerKind: "unreal_editor",
							projectName: "Fixture",
							schemaVersion: 1
						})
					: Effect.succeed({
							contract: {
								name: "unreal-editor-asset-navigation",
								version: { major: 1, minor: 0 }
							},
							objectPath: "/Game/Textures/T_Rock.T_Rock",
							status: "located"
						})
			)
		)
	)
);

it.effect("reports a missing editor capability without throwing into the route", () =>
	Effect.gen(function* () {
		const navigation = yield* WorkbenchAssetNavigation;
		const result = yield* navigation.locate("/Game/Textures/T_Rock.T_Rock");
		expect(result.status).toBe("unavailable");
		if (result.status === "unavailable") {
			expect(result.reason).toBe("capability_missing");
			expect(result.recovery).toContain("plugins enabled");
		}
	}).pipe(
		Effect.provide(
			navigationLayer(() =>
				Effect.succeed({
					capabilities: [],
					producerKind: "unreal_editor",
					projectName: "Fixture",
					schemaVersion: 1
				})
			)
		)
	)
);
