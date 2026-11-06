import { Effect } from "effect";
import { openNativeTextQuery } from "../../../../packages/game-text/src/native-query.ts";
import { nativeGameTextEngineClientLayer } from "../../../../packages/unreal-assets/dist/index.js";
import type { NativeTextQuery } from "../../../../packages/game-text/src/native-query-contract.ts";
import type { RetainedInput } from "./model.ts";

export async function withNative<A>(
	input: Pick<RetainedInput, "settings">,
	executable: string,
	use: (query: NativeTextQuery) => Promise<A>
): Promise<A> {
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const query = yield* openNativeTextQuery(input.settings);
				return yield* Effect.promise(() => use(query));
			})
		).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
	);
}
