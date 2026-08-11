import { it } from "@effect/vitest";
import { ConfigExplorerNodeLive } from "@ue-shed/config-explorer";
import { Effect, Layer } from "effect";
import { resolve } from "node:path";
import { expect } from "vitest";
import { makeWorkbenchConfigurationLayer } from "../workbench-config.js";
import { WorkbenchConfigExplorer, WorkbenchConfigExplorerLive } from "./config-explorer.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../../..");

const configuration = makeWorkbenchConfigurationLayer({
	authoringAsset: { status: "not_configured" },
	expectedProject: { status: "not_configured" },
	project: { status: "not_configured" },
	remoteControlEndpoint: "http://127.0.0.1:30001",
	review: { status: "not_configured" },
	sourceCheckout: { path: repositoryRoot, status: "configured" },
	textureAuditRules: { status: "not_configured" }
});

const layer = WorkbenchConfigExplorerLive.pipe(
	Layer.provide(Layer.mergeAll(ConfigExplorerNodeLive, configuration))
);

it.effect("resolves every Workbench showcase preset through the real generic fixture", () =>
	Effect.gen(function* () {
		const explorer = yield* WorkbenchConfigExplorer;
		const result = yield* explorer.showcase();
		expect(result.status).toBe("ready");
		if (result.status !== "ready") return;

		expect(result.comparison.valueChanged).toBe(true);
		expect(result.comparison.left.effectiveValue).toEqual({
			kind: "array",
			values: ["PlatformA"]
		});
		expect(result.comparison.right.effectiveValue).toEqual({
			kind: "array",
			values: ["PlatformB", "PlatformB"]
		});
		expect(result.scalarReplacement.effectiveValue).toEqual({
			kind: "scalar",
			value: "PlatformA"
		});
		expect(result.explicitEmpty.effectiveValue).toEqual({ kind: "empty_array" });
		expect(result.unsupportedSyntax.status).toBe("partial");
		expect(result.redirectInvolvement.status).toBe("partial");
	}).pipe(Effect.provide(layer))
);

it.effect("reports a typed unavailable state outside a configured source checkout", () =>
	Effect.gen(function* () {
		const explorer = yield* WorkbenchConfigExplorer;
		const result = yield* explorer.showcase();
		expect(result).toEqual({
			error: {
				code: "showcase_unavailable",
				message: "The committed Config Explorer fixture is unavailable.",
				recovery: "Launch Workbench through pnpm showcase from a source checkout.",
				retrySafe: false
			},
			status: "failed"
		});
	}).pipe(
		Effect.provide(
			WorkbenchConfigExplorerLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						ConfigExplorerNodeLive,
						makeWorkbenchConfigurationLayer({
							authoringAsset: { status: "not_configured" },
							expectedProject: { status: "not_configured" },
							project: { status: "not_configured" },
							remoteControlEndpoint: "http://127.0.0.1:30001",
							review: { status: "not_configured" },
							sourceCheckout: { status: "not_configured" },
							textureAuditRules: { status: "not_configured" }
						})
					)
				)
			)
		)
	)
);
