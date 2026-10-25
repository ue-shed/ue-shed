import { Effect } from "effect";
import { nativeGameTextEngineClientLayer } from "../packages/unreal-assets/dist/index.js";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import { openNativeTextQuery } from "../packages/game-text/src/native-query.ts";
import type { TextCorpusSearchRequest } from "../packages/game-text/src/schema.ts";
import type { joinStoreOptions } from "./columnar-join.test-support.ts";
import type { NativeLineFacts } from "./columnar-join-fuzz.test-support.ts";

/** Read the stored lines back through the production typed client and process boundary. */
export function nativeEngineLines(executable: string) {
	return (
		configuration: ReturnType<typeof joinStoreOptions>,
		request: TextCorpusSearchRequest
	): Promise<NativeLineFacts> =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* Effect.gen(function* () {
						return yield* (yield* SharedIndex).inspect();
					}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)));
					const query = yield* openNativeTextQuery({
						configuration: { ...configuration, sharedProject: false },
						generation: root.generation,
						joinedKey: root.active.joined ?? "missing-test-join"
					});
					return {
						lines: yield* query.readLocalizationLines(),
						exported: yield* query.selectLocalizationLines(request, [
							"identity",
							"source",
							"marks"
						]),
						page: yield* query.search(request)
					};
				})
			).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
		);
}
