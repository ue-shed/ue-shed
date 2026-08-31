import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AssetReader, assetReaderLayer, readSavedBlueprint } from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const sample = process.env.UASSET_BLUEPRINT_SAMPLE;
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

describe.skipIf(!executable || !sample)("saved Blueprint graph protocol", () => {
	it("validates a real UE 5.7 package through the TypeScript process boundary", async () => {
		const blueprint = await runReader(readSavedBlueprint({ assetPath: sample! }));
		const nodes = blueprint.graphs.flatMap((graph) => graph.nodes);

		expect(blueprint.schema_version).toBe(1);
		expect(blueprint.graphs.length).toBeGreaterThan(0);
		expect(nodes.length).toBeGreaterThan(0);
		expect(nodes.flatMap((node) => node.pins).length).toBeGreaterThan(0);
		expect(blueprint.graphs.flatMap((graph) => graph.links).length).toBeGreaterThan(0);
		expect(blueprint.coverage_gaps).toEqual([]);
	});
});
