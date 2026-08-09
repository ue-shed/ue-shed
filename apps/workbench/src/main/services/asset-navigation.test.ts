import { it } from "@effect/vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { WorkbenchAssetNavigation, WorkbenchAssetNavigationLive } from "./asset-navigation.js";

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
