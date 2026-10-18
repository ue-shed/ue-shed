import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Layer, Option } from "effect";
import { LocalizationEvidenceNodeLive } from "@ue-shed/localization";
import {
	GameTextIndexRefresh,
	GameTextIndexSteps,
	GameTextIndexError,
	gameTextIndexRefreshLayer,
	gameTextIndexSourceNodeLayer,
	GameTextIndexBuilderLive,
	type GameTextIndexRefreshRequest
} from "@ue-shed/game-text/index";
import { readerLayer } from "../cli-operation.js";

export function cliGameTextIndexLayer(reader?: string) {
	return Layer.unwrap(
		Effect.gen(function* () {
			const cacheRoot = yield* Config.String("UE_SHED_PROJECT_INDEX_CACHE_ROOT").pipe(
				Config.withDefault(join(homedir(), ".cache", "ue-shed"))
			);
			return gameTextIndexRefreshLayer(cacheRoot).pipe(
				Layer.provide(gameTextIndexSourceNodeLayer(cacheRoot)),
				Layer.provide(GameTextIndexBuilderLive),
				Layer.provide(readerLayer(reader)),
				Layer.provide(LocalizationEvidenceNodeLive)
			);
		})
	);
}

export const refreshCliGameTextIndex = Effect.fn("Cli.game_text.refresh")(
	function* (request: GameTextIndexRefreshRequest, reader: string | undefined) {
		const compose = Effect.fn("Cli.game_text.prepare")(function* (
			steps: typeof GameTextIndexSteps.Service
		) {
			return yield* steps.openTarget(yield* steps.prepareTarget(request));
		});
		const steps = yield* Effect.serviceOption(GameTextIndexSteps);
		if (Option.isSome(steps)) return yield* compose(steps.value);
		const provided = yield* Effect.serviceOption(GameTextIndexRefresh);
		if (Option.isSome(provided)) return yield* provided.value.refresh(request);
		// The shared-reader map must remain alive while the command uses the returned model.
		const services = yield* Layer.buildWithScope(
			cliGameTextIndexLayer(reader),
			yield* Effect.scope
		);
		return yield* Effect.flatMap(GameTextIndexSteps, compose).pipe(Effect.provide(services));
	},
	(effect) =>
		effect.pipe(
			Effect.catchTag("ConfigError", (cause) =>
				Effect.fail(
					new GameTextIndexError({
						nextStep: "escalate",
						retrySafe: false,
						code: "index_failed",
						operation: "configuration",
						cause,
						message:
							"The game text index cache root or reader configuration is invalid.",
						recovery:
							"Check the project index cache root and reader configuration, then retry."
					})
				)
			)
		)
);

export const invalidateCliGameTextIndex = Effect.fn("Cli.game_text.invalidate")(function* (
	request: GameTextIndexRefreshRequest
) {
	const provided = yield* Effect.serviceOption(GameTextIndexRefresh);
	if (Option.isSome(provided)) return yield* provided.value.invalidate(request);
	return yield* Effect.flatMap(GameTextIndexRefresh, (service) =>
		service.invalidate(request)
	).pipe(
		Effect.provide(cliGameTextIndexLayer()),
		Effect.catchTag("ConfigError", (cause) =>
			Effect.fail(
				new GameTextIndexError({
					nextStep: "escalate",
					retrySafe: false,
					code: "index_failed",
					operation: "configuration",
					cause,
					message: "The game text index cache root or reader configuration is invalid.",
					recovery:
						"Check the project index cache root and reader configuration, then retry."
				})
			)
		)
	);
});
