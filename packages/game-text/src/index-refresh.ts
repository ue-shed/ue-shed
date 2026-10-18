import { performance } from "node:perf_hooks";
import { Context, Effect, Layer, Metric, Schema } from "effect";
import {
	GameTextIndexRefresh,
	GameTextIndexRefreshRequest,
	GameTextIndexError
} from "./index-contract.js";
import {
	GameTextIndexSteps,
	makeGameTextIndexSteps,
	type GameTextIndexStepsOptions
} from "./index-steps.js";
export * from "./index-contract.js";

const refreshes = Metric.counter("game_text.index.refreshes");
const refreshDuration = Metric.histogram("game_text.index.refresh_duration_ms", {
	boundaries: [1, 10, 100, 1000, 10000, 60000, 900000]
});

/** Compatibility workflow, composed entirely from the independently usable project/target steps. */
export const gameTextIndexRefreshLayer = (
	cacheRoot: string,
	options: GameTextIndexStepsOptions = {}
) =>
	Layer.effectContext(
		Effect.gen(function* () {
			const steps = yield* makeGameTextIndexSteps(cacheRoot, options);
			const refresh = Effect.fn("GameTextIndex.refresh")(function* (
				input: GameTextIndexRefreshRequest
			) {
				const request = yield* Schema.decodeUnknownEffect(GameTextIndexRefreshRequest)(
					input
				).pipe(
					Effect.mapError(
						(cause) =>
							new GameTextIndexError({
								nextStep: "escalate",
								retrySafe: false,
								code: "index_failed",
								operation: "request",
								message:
									"The Game Text index refresh request does not match its schema.",
								recovery: "Choose a project and localization target.",
								cause
							})
					)
				);
				const started = performance.now();
				const target = yield* steps.prepareTarget(request);
				const result = yield* steps.openTarget(target);
				yield* Metric.update(refreshes, 1);
				yield* Metric.update(refreshDuration, performance.now() - started);
				return result;
			});
			return Context.make(GameTextIndexSteps, steps).pipe(
				Context.add(
					GameTextIndexRefresh,
					GameTextIndexRefresh.of({ refresh, invalidate: steps.invalidate })
				)
			);
		})
	);
