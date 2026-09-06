import { makeWorkbenchTestConfigurationLayer as makeWorkbenchConfigurationLayer } from "../test-configuration.js";
import { it } from "@effect/vitest";
import { ConfigExplorerNodeLive } from "@ue-shed/config-explorer";
import { Effect, Layer } from "effect";
import { resolve } from "node:path";
import { expect } from "vitest";
import { makeWorkbenchProjectTestLayer } from "./project-workspace.js";
import { WorkbenchConfigExplorer, WorkbenchConfigExplorerLive } from "./config-explorer.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../../..");
const fixtureRoot = resolve(repositoryRoot, "packages/config-explorer/fixtures/config-source");

const unusedProjectOperations = {
	choose: () => Effect.die("not used"),
	current: () => Effect.die("not used"),
	inputAtlas: () => Effect.die("not used"),
	savedProject: () => Effect.die("not used"),
	savedTables: () => Effect.die("not used")
};

function configuration(options?: {
	readonly sourceCheckout?: "configured" | "not_configured";
	readonly unrealEngineRoot?: "configured" | "not_configured";
}) {
	return makeWorkbenchConfigurationLayer({
		authoringAsset: { status: "not_configured" },
		expectedProject: { status: "not_configured" },
		project: { status: "not_configured" },
		remoteControlEndpoint: "http://127.0.0.1:30001",
		review: { status: "not_configured" },
		sourceCheckout:
			options?.sourceCheckout === "not_configured"
				? { status: "not_configured" }
				: { path: repositoryRoot, status: "configured" },
		textureAuditRules: { status: "not_configured" },
		unrealEngineRoot:
			options?.unrealEngineRoot === "configured"
				? { path: fixtureRoot, status: "configured" }
				: { status: "not_configured" }
	});
}

function layer(options?: {
	readonly sourceCheckout?: "configured" | "not_configured";
	readonly unrealEngineRoot?: "configured" | "not_configured";
}) {
	const project = makeWorkbenchProjectTestLayer({
		...unusedProjectOperations,
		selectedProject: () =>
			Effect.succeed({ projectName: "FixtureProject", projectRoot: fixtureRoot })
	});
	return WorkbenchConfigExplorerLive.pipe(
		Layer.provide(Layer.mergeAll(ConfigExplorerNodeLive, configuration(options), project))
	);
}

it.effect("runs an editable sample comparison through the generic fixture", () =>
	Effect.gen(function* () {
		const explorer = yield* WorkbenchConfigExplorer;
		const result = yield* explorer.query({
			family: "Game",
			key: "Entries",
			leftPlatform: "PlatformA",
			mode: "compare",
			rightPlatform: "PlatformB",
			section: "Fixture.Settings",
			source: "sample_fixture"
		});
		expect(result.status).toBe("ready");
		if (result.status !== "ready" || result.mode !== "compare") return;

		expect(result.projectName).toBe("UE Shed config fixture");
		expect(result.evidence.left.effectiveValue).toEqual({
			kind: "array",
			values: ["PlatformA"]
		});
		expect(result.evidence.right.effectiveValue).toEqual({
			kind: "array",
			values: ["PlatformB", "PlatformB"]
		});
	}).pipe(Effect.provide(layer()))
);

it.effect("uses the selected Workbench project and explicit engine configuration", () =>
	Effect.gen(function* () {
		const explorer = yield* WorkbenchConfigExplorer;
		const result = yield* explorer.query({
			family: "Game",
			key: "Mode",
			mode: "explain",
			platform: "PlatformA",
			section: "Fixture.Settings",
			source: "selected_project"
		});
		expect(result.status).toBe("ready");
		if (result.status !== "ready" || result.mode !== "explain") return;
		expect(result.projectName).toBe("FixtureProject");
		expect(result.evidence.effectiveValue).toEqual({
			kind: "scalar",
			value: "PlatformA"
		});
	}).pipe(Effect.provide(layer({ unrealEngineRoot: "configured" })))
);

it.effect("reports a typed unavailable sample outside a source checkout", () =>
	Effect.gen(function* () {
		const explorer = yield* WorkbenchConfigExplorer;
		const result = yield* explorer.query({
			family: "Game",
			key: "Mode",
			mode: "explain",
			platform: "PlatformA",
			section: "Fixture.Settings",
			source: "sample_fixture"
		});
		expect(result).toEqual({
			error: {
				code: "sample_unavailable",
				message: "The committed Config Explorer sample is unavailable.",
				recovery: "Launch Workbench through pnpm showcase from a source checkout.",
				retrySafe: false
			},
			status: "failed"
		});
	}).pipe(Effect.provide(layer({ sourceCheckout: "not_configured" })))
);
