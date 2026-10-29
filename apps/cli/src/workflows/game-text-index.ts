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
	type GameTextCodeSource,
	type GameTextIndexRefreshRequest
} from "@ue-shed/game-text/index";
import { readerLayer } from "../cli-operation.js";
import { resolveCodeEngine } from "./code-engine.js";

/** The cache root the CLI's Game Text index, records and revisions live under. */
export const cliCacheRoot = Config.String("UE_SHED_PROJECT_INDEX_CACHE_ROOT").pipe(
	Config.withDefault(join(homedir(), ".cache", "ue-shed"))
);

export function cliGameTextIndexLayer(reader?: string) {
	return Layer.unwrap(
		Effect.gen(function* () {
			const cacheRoot = yield* cliCacheRoot;
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
 * The engine a project's code is read with: the one `UE_SHED_ENGINE_VERSION` and
 * `UE_SHED_ENGINE_ROOT` name, as `code text`'s flags do, else the one the project's association
 * names. A setting that names no usable engine fails; undefined when the project's associated
 * engine is not installed, so its code is not read.
 */
export const cliProjectCode = Effect.fn("Cli.game_text.code")(function* (projectRoot: string) {
	const engineVersion = Option.getOrUndefined(
		yield* Config.option(Config.String("UE_SHED_ENGINE_VERSION"))
	);
	const engineRoot = Option.getOrUndefined(
		yield* Config.option(Config.String("UE_SHED_ENGINE_ROOT"))
	);
	const resolve = resolveCodeEngine({
		projectRoot,
		engineVersion,
		engineRoot
	}).pipe(
		Effect.provide(EngineInstallationDiscoveryLive),
		Effect.map((found) => ({
			engine: found.engine,
			...(found.engineRoot === undefined ? undefined : { engineRoot: found.engineRoot })
		}))
	);
	return engineVersion !== undefined || engineRoot !== undefined
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
						Effect.as<GameTextCodeSource | undefined>(undefined)
					)
				)
			);
});

/** A target's code is read with the engine {@link cliProjectCode} finds, when it finds one. */
const withProjectCode = Effect.fnUntraced(function* (request: GameTextIndexRefreshRequest) {
	if (request.targetName === undefined || request.code !== undefined) return request;
	const code = yield* cliProjectCode(request.projectRoot);
	return code === undefined ? request : { ...request, code };
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
