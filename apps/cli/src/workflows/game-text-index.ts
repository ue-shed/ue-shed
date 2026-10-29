import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Layer, Option } from "effect";
import { EngineInstallationDiscoveryLive } from "@ue-shed/engine";
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
import { resolveCodeEngine } from "./code-engine.js";

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

/**
 * A target's code is read with the engine `UE_SHED_ENGINE_VERSION` and `UE_SHED_ENGINE_ROOT` name,
 * as `code text`'s flags do, else with the one the project's association names. A setting that
 * names no usable engine fails; a project whose associated engine is not installed is indexed
 * without its code, as before code was read.
 */
const withProjectCode = Effect.fn("Cli.game_text.code")(function* (
	request: GameTextIndexRefreshRequest
) {
	if (request.targetName === undefined || request.code !== undefined) return request;
	const engineVersion = Option.getOrUndefined(
		yield* Config.option(Config.String("UE_SHED_ENGINE_VERSION"))
	);
	const engineRoot = Option.getOrUndefined(
		yield* Config.option(Config.String("UE_SHED_ENGINE_ROOT"))
	);
	const resolve = resolveCodeEngine({
		projectRoot: request.projectRoot,
		engineVersion,
		engineRoot
	}).pipe(
		Effect.provide(EngineInstallationDiscoveryLive),
		Effect.map((found) => ({
			engine: found.engine,
			...(found.engineRoot === undefined ? undefined : { engineRoot: found.engineRoot })
		}))
	);
	const resolved =
		engineVersion !== undefined || engineRoot !== undefined
			? yield* resolve.pipe(
					Effect.catchTag("CliCommandError", (cause) =>
						Effect.fail(
							new GameTextIndexError({
								nextStep: "fix_input",
								retrySafe: false,
								code: "index_failed",
								operation: "configuration",
								cause,
								message: cause.message,
								recovery: cause.recovery
							})
						)
					)
				)
			: yield* resolve.pipe(
					Effect.catchTag("CliCommandError", (error) =>
						Effect.annotateCurrentSpan({ "code.unavailable": error.message }).pipe(
							Effect.as(undefined)
						)
					)
				);
	return resolved === undefined ? request : { ...request, code: resolved };
});

export const refreshCliGameTextIndex = Effect.fn("Cli.game_text.refresh")(
	function* (input: GameTextIndexRefreshRequest, reader: string | undefined) {
		const request = yield* withProjectCode(input);
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
