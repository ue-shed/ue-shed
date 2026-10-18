import { Context, Effect, Layer, type Scope } from "effect";
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

/** Each snapshot owns its native process in the caller's scope, including cancellation. */
export const nativeIndexQueryLayer = (configuration: AssetReaderConfiguration) =>
	Layer.succeed(
		GameTextIndexQuery,
		GameTextIndexQuery.of({
			open: Effect.fn("GameTextIndexQuery.open")(function* (input) {
				const services = yield* Layer.build(nativeGameTextEngineClientLayer(configuration));
				return yield* openNativeTextQuery({
					...input,
					configuration: nativeIndexConfiguration(input.configuration)
				}).pipe(Effect.provide(services));
			})
		})
	);
