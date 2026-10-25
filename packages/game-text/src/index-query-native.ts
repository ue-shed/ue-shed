import { Context, Effect, Layer, RcMap, Schema, type Scope } from "effect";
import { GameTextIndexConfiguration } from "@ue-shed/protocol";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import {
	nativeGameTextEngineClientLayer,
	type AssetReaderConfiguration
} from "@ue-shed/unreal-assets";
import { openNativeTextQuery } from "./native-query.js";
import { nativeIndexConfiguration } from "./native-index-configuration.js";
import type { SharedIndexOptions } from "./shared-index.js";
import type { GameTextIndexError } from "./index-contract.js";

/** Native snapshot acquisition used by the headless indexing workflow. */
export class GameTextIndexQuery extends Context.Service<
	GameTextIndexQuery,
	{
		readonly open: (input: {
			readonly configuration: SharedIndexOptions;
			readonly generation: string;
			readonly joinedKey: string;
		}) => Effect.Effect<
			Effect.Success<ReturnType<typeof openNativeTextQuery>>,
			GameTextIndexError,
			Scope.Scope
		>;
	}
>()("@ue-shed/game-text/GameTextIndexQuery") {}

/**
 * The host's engine: one process, started by the first read, holds every open snapshot's reader.
 * Each snapshot's reader lives in its callers' scope.
 */
export const nativeIndexQueryLayer = (configuration: AssetReaderConfiguration) =>
	Layer.effect(
		GameTextIndexQuery,
		Effect.gen(function* () {
			const engine = yield* Layer.build(nativeGameTextEngineClientLayer(configuration));
			const Request = Schema.Struct({
				configuration: GameTextIndexConfiguration,
				generation: Schema.String,
				joinedKey: Schema.String,
				audienceRules: Schema.Array(Schema.String)
			});
			// Only live caller pins retain entries. No idle timeout retains unused snapshots.
			const readers: RcMap.RcMap<
				string,
				Effect.Success<ReturnType<typeof openNativeTextQuery>>,
				GameTextIndexError
			> = yield* RcMap.make({
				lookup: (key: string) =>
					Effect.gen(function* () {
						let invalidated = false;
						const input = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Request)
						)(key).pipe(Effect.orDie);
						return yield* openNativeTextQuery({
							...input,
							onFailure: Effect.suspend(() => {
								if (invalidated) return Effect.void;
								invalidated = true;
								return RcMap.invalidate(readers, key);
							})
						}).pipe(Effect.provide(engine));
					})
			});
			return GameTextIndexQuery.of({
				open: Effect.fn("GameTextIndexQuery.open")(function* (input) {
					return yield* RcMap.get(
						readers,
						JSON.stringify({
							configuration: nativeIndexConfiguration(input.configuration),
							generation: input.generation,
							joinedKey: input.joinedKey,
							audienceRules: TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
						})
					);
				})
			});
		})
	);
