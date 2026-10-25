/**
 * Measures GameTextIndexSource.inventory three ways against one project-index cache:
 * cold, warm with the default refresh, and warm with refreshProjectIndex disabled.
 * The game-text cache is never touched; only the inventory span is timed.
 *
 * node --import tsx scripts/game-text-warm-inventory-probe.ts --project <dir> --pi-cache <dir>
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import * as currentIndex from "../packages/game-text/dist/entry-index.js";
import * as currentAssets from "../packages/unreal-assets/dist/index.js";
import { withEngineBenchmarkLock } from "./game-text-engine-lock.ts";
import { makeStageRecorder } from "./game-text-stage-timings.ts";

const { values } = parseArgs({
	options: {
		project: { type: "string" },
		"pi-cache": { type: "string" }
	}
});
if (!values.project || !values["pi-cache"]) throw new Error("Provide --project and --pi-cache.");
const project = values.project;
const piCache = values["pi-cache"];

const { gameTextIndexSourceNodeLayer } = currentIndex;
const { AssetReaderLive } = currentAssets;
const { GameTextIndexSource } = await import("../packages/game-text/dist/index-refresh.js");

async function inventoryOnce(label: string, refreshProjectIndex?: boolean) {
	const recorder = makeStageRecorder();
	const scope = await Effect.runPromise(Scope.make());
	try {
		const layer = gameTextIndexSourceNodeLayer(
			piCache,
			refreshProjectIndex === undefined ? {} : { refreshProjectIndex }
		).pipe(Layer.provide(AssetReaderLive));
		const context = await Effect.runPromise(
			Effect.withTracer(Layer.buildWithScope(layer, scope), recorder.tracer)
		);
		const source = Context.get(context, GameTextIndexSource);
		const started = performance.now();
		const entries = await Effect.runPromise(
			Effect.withTracer(source.inventory({ projectRoot: project }), recorder.tracer)
		);
		const ms = performance.now() - started;
		const counts: Record<string, number> = recorder.counts();
		const pick = (suffix: string) =>
			Object.fromEntries(Object.entries(counts).filter(([key]) => key.endsWith(suffix)));
		return {
			label,
			ms: Math.round(ms),
			packages: entries.length,
			inventoryWallMs: counts["stage.GameTextIndexSource.inventory.wallMs"],
			refreshMs: pick("inventory.stage_ms.refresh")[
				"stage.GameTextIndexSource.inventory.inventory.stage_ms.refresh"
			],
			statusMs: pick("inventory.stage_ms.status")[
				"stage.GameTextIndexSource.inventory.inventory.stage_ms.status"
			],
			pagesMs: pick("inventory.stage_ms.pages")[
				"stage.GameTextIndexSource.inventory.inventory.stage_ms.pages"
			]
		};
	} finally {
		await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => undefined);
	}
}

await withEngineBenchmarkLock(async () => {
	for (const result of [
		await inventoryOnce("cold-project-index"),
		await inventoryOnce("warm-project-index"),
		await inventoryOnce("warm-project-index-no-refresh", false)
	])
		process.stdout.write(`${JSON.stringify(result)}\n`);
});
