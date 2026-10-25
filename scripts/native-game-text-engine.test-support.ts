import { Effect } from "effect";
import { nativeGameTextEngineClientLayer } from "../packages/unreal-assets/dist/index.js";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import { openNativeTextQuery } from "../packages/game-text/src/native-query.ts";
import { LocalizationLineId } from "../packages/game-text/src/localization-schema.ts";
import type {
	TextCorpusSearchRequest,
	TextCorpusFocusRequest
} from "../packages/game-text/src/schema.ts";
import type { joinStoreOptions } from "./columnar-join.test-support.ts";
import type { LocalizationFocusRequest } from "../packages/game-text/src/localization-view.ts";

/** Exercise the production typed client and process boundary against the independent oracle. */
export function nativeEngineResponses(executable: string) {
	return (
		configuration: ReturnType<typeof joinStoreOptions>,
		requests: readonly TextCorpusSearchRequest[],
		lines: readonly string[],
		focus: readonly TextCorpusFocusRequest[],
		exports: readonly TextCorpusSearchRequest[],
		details: readonly LocalizationFocusRequest[]
	) =>
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
					const searches = yield* Effect.forEach(requests, query.search);
					const localized = yield* Effect.forEach(lines, (id) =>
						query.localizationFocus(LocalizationLineId.make(id))
					);
					const focused = yield* Effect.forEach(focus, (request) =>
						query.focus(request).pipe(Effect.map((value) => value ?? null))
					);
					const summary = yield* query.summary();
					const exported = yield* Effect.forEach(exports, query.export);
					const detailed = yield* Effect.forEach(details, query.localizationDetail);
					const corpusLines = yield* query.readLocalizationLines();
					return {
						searches,
						lines: localized,
						focus: focused,
						summary,
						exports: exported,
						details: detailed,
						corpusLines
					};
				})
			).pipe(Effect.provide(nativeGameTextEngineClientLayer({ executable })))
		);
}
