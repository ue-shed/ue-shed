import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ConfigExplorer, ConfigFamily, type ConfigExplainRequest } from "@ue-shed/config-explorer";
import {
	makeInputObjectPath,
	type EnhancedInputReport,
	type EnhancedInputRunResult
} from "@ue-shed/enhanced-input";
import { AssetReader } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, expect } from "vitest";
import { makeWorkbenchTestConfigurationLayer } from "../test-configuration.js";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import {
	WorkbenchInputAtlas,
	WorkbenchInputAtlasLive,
	workbenchHostPlatform
} from "./input-atlas.js";

let projectRoot: string;
beforeAll(async () => {
	// No Config/<Platform>/<Platform>Input.ini, so no platform view needs the reader.
	projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-input-atlas-"));
});
afterAll(async () => {
	await rm(projectRoot, { recursive: true, force: true });
});

const available = <A>(value: A) => ({ status: "available", source: "serialized", value }) as const;

const report: EnhancedInputReport = {
	schemaVersion: 2,
	status: "complete",
	coverage: {
		discoveredPackages: 1,
		inspectedPackages: 1,
		partialPackages: 0,
		failedPackages: 0,
		inputActions: 0,
		mappingContexts: 0,
		playerMappableConfigs: 1
	},
	actions: [],
	mappingContexts: [],
	playerMappableConfigs: [
		{
			objectPath: makeInputObjectPath("/Game/Input/PMI_Default.PMI_Default"),
			classPath: "/Script/EnhancedInput.PlayerMappableInputConfig",
			packageFile: "Content/Input/PMI_Default.uasset",
			configName: available("Default"),
			displayName: { status: "unavailable", reason: "not_serialized" },
			deprecated: { status: "unavailable", reason: "not_serialized" },
			contexts: available([{ context: "/Game/Input/IMC_Gameplay.IMC_Gameplay", priority: 1 }])
		}
	],
	diagnostics: []
};

function layer(result: () => EnhancedInputRunResult) {
	const project = makeWorkbenchProjectTestLayer({
		choose: () => Effect.die("not used"),
		current: () =>
			Effect.succeed({
				status: "ready",
				project: {
					inputAtlas: "ready",
					mapCount: 0,
					packageCount: 1,
					projectName: "Demo",
					projectRoot
				}
			}),
		inputAtlas: () => Effect.succeed(result()),
		savedProject: () => Effect.die("not used"),
		savedTables: () => Effect.die("not used")
	});
	const requests: ConfigExplainRequest[] = [];
	const explorer = Layer.succeed(
		ConfigExplorer,
		ConfigExplorer.of({
			explain: (request) => {
				requests.push(request);
				return Effect.succeed({
					schemaVersion: 1,
					status: "complete",
					project: { descriptor: join(projectRoot, "Demo.uproject") },
					platform: request.platform,
					family: request.family ?? ConfigFamily.make("Input"),
					section: request.section,
					key: request.key,
					effectiveValue: {
						kind: "array",
						values: ['(InputMappingContext="/Game/Input/IMC_Menu.IMC_Menu",Priority=5)']
					},
					contributions: [],
					layers: [],
					authorities: [],
					diagnostics: []
				});
			},
			compare: () => Effect.die("not used")
		})
	);
	// SAFETY: the temporary project has no platform Input config, so no platform data class is
	// listed and the platform resolver never calls the reader.
	const reader = Layer.succeed(AssetReader, AssetReader.of({} as never));
	return {
		requests,
		layer: WorkbenchInputAtlasLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					project,
					explorer,
					reader,
					makeWorkbenchTestConfigurationLayer({
						authoringAsset: { status: "not_configured" },
						expectedProject: { status: "not_configured" },
						project: { status: "not_configured" },
						remoteControlEndpoint: "http://127.0.0.1:30001",
						review: { status: "not_configured" },
						sourceCheckout: { status: "not_configured" },
						textureAuditRules: { status: "not_configured" },
						unrealEngineRoot: { status: "not_configured" }
					})
				)
			)
		)
	};
}

it.effect("adds config asset and project default co-activation sets to a completed scan", () => {
	const { layer: live, requests } = layer(() => ({ status: "completed", report, projectRoot }));
	return Effect.gen(function* () {
		const atlas = yield* WorkbenchInputAtlas;
		const result = yield* atlas.configuredScan();
		expect(result.status).toBe("completed");
		if (result.status !== "completed") return;
		expect(result.analysis?.coActivation.sets.map((set) => set.source)).toEqual([
			"config_asset",
			"project_default_contexts"
		]);
		expect(result.analysis?.coActivation.sources.map((source) => source.status)).toEqual([
			"resolved",
			"resolved",
			"absent"
		]);
		expect(result.analysis?.platforms).toEqual([]);
		expect(requests[0]?.platform).toBe(workbenchHostPlatform(process.platform));
	}).pipe(Effect.provide(live));
});

it.effect("passes failed scans through without resolving analysis", () =>
	Effect.gen(function* () {
		const atlas = yield* WorkbenchInputAtlas;
		const result = yield* atlas.configuredScan();
		expect(result).toEqual({
			status: "failed",
			error: {
				code: "invalid_project",
				message: "No project.",
				recovery: "Choose one.",
				retrySafe: true
			}
		});
	}).pipe(
		Effect.provide(
			layer(() => ({
				status: "failed",
				error: {
					code: "invalid_project",
					message: "No project.",
					recovery: "Choose one.",
					retrySafe: true
				}
			})).layer
		)
	)
);

it("maps host operating systems onto Unreal platform names", () => {
	expect(workbenchHostPlatform("win32")).toBe("Windows");
	expect(workbenchHostPlatform("darwin")).toBe("Mac");
	expect(workbenchHostPlatform("linux")).toBe("Linux");
});
