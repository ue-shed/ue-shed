import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	CompiledPluginBuilder,
	PluginDistribution,
	makeCompiledPluginBuilderTestLayer,
	makePluginDistributionTestLayer
} from "./index.js";

it.effect("hosts replace plugin distribution with their own complete implementation", () =>
	Effect.gen(function* () {
		const distribution = yield* PluginDistribution;
		expect(yield* distribution.listCached()).toEqual([]);
		yield* distribution.prune("ue-shed-plugins@0.1.0");
	}).pipe(
		Effect.provide(
			makePluginDistributionTestLayer({
				install: () => Effect.die("install is not used by this test"),
				listCached: () => Effect.succeed([]),
				prune: () => Effect.void,
				verifyCached: () => Effect.die("verifyCached is not used by this test")
			})
		)
	)
);

it.effect("hosts replace the compiled plugin builder without running a build tool", () =>
	Effect.gen(function* () {
		const builder = yield* CompiledPluginBuilder;
		const outcome = yield* builder.build({}).pipe(Effect.exit);
		expect(outcome._tag).toBe("Failure");
	}).pipe(
		Effect.provide(
			makeCompiledPluginBuilderTestLayer({
				build: () => Effect.die("this host refuses every build")
			})
		)
	)
);
