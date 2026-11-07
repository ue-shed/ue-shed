import { Context, Effect, Layer, RcMap, Schema } from "effect";
import { GameTextIndexConfiguration } from "@ue-shed/protocol";
import { TEXT_AUDIENCE_POLICY } from "./text-audience.js";
import { answerJson, NativeGameTextEngineClient, nativeGameTextEngineClientLayer } from "@ue-shed/unreal-assets";
import { openNativeTextQuery } from "./native-query.js";
import { nativeIndexConfiguration } from "./native-index-configuration.js";
import { GameTextIndexError } from "./index-contract.js";
/** Native snapshot acquisition used by the headless indexing workflow. */
export class GameTextIndexQuery extends Context.Service()("@ue-shed/game-text/GameTextIndexQuery") {
}
const ReaderKeyJson = Schema.fromJsonString(Schema.Struct({
    configuration: GameTextIndexConfiguration,
    generation: Schema.String,
    joinedKey: Schema.String,
    audienceRules: Schema.Array(Schema.String)
}));
const decodeReaderKeyJson = Schema.decodeEffect(ReaderKeyJson);
const compareFailed = (cause) => new GameTextIndexError({
    code: "index_failed",
    operation: "compare_points",
    nextStep: "reconcile",
    retrySafe: false,
    message: "The native Game Text point comparison could not complete.",
    recovery: "Read both points again, then compare them.",
    cause
});
const fileCompareFailed = (cause) => new GameTextIndexError({
    code: "index_failed",
    operation: "compare_text_files",
    nextStep: "reconcile",
    retrySafe: true,
    message: "The localization files could not be compared.",
    recovery: "Check that both revisions are readable localization files, then compare again.",
    cause
});
/**
 * The host's engine: one process, started by the first read, holds every open snapshot's reader.
 * Each snapshot's reader lives in its callers' scope.
 */
export const nativeIndexQueryLayer = (configuration) => Layer.effect(GameTextIndexQuery, Effect.gen(function* () {
    const engine = yield* Layer.build(nativeGameTextEngineClientLayer(configuration));
    // Only live caller pins retain entries. No idle timeout retains unused snapshots.
    const readers = yield* RcMap.make({
        lookup: Effect.fn("GameTextIndexQuery.openReader")(function* (key) {
            let invalidated = false;
            const input = yield* decodeReaderKeyJson(key).pipe(Effect.orDie);
            return yield* openNativeTextQuery({
                ...input,
                onFailure: Effect.suspend(() => {
                    if (invalidated)
                        return Effect.void;
                    invalidated = true;
                    return RcMap.invalidate(readers, key);
                })
            }).pipe(Effect.provide(engine));
        })
    });
    const client = Context.get(engine, NativeGameTextEngineClient);
    return GameTextIndexQuery.of({
        comparePoints: Effect.fn("GameTextIndexQuery.comparePoints")(function* (input) {
            const answer = yield* client
                .execute({
                action: "compare_points",
                configuration: nativeIndexConfiguration(input.configuration),
                request: input.request
            })
                .pipe(Effect.mapError(compareFailed));
            const comparison = answerJson(answer);
            if (comparison === undefined)
                return yield* compareFailed("The engine sent no comparison.");
            return comparison;
        }),
        compareTextFiles: Effect.fn("GameTextIndexQuery.compareTextFiles")(function* (request) {
            const answer = yield* client
                .execute({ action: "compare_text_files", request })
                .pipe(Effect.mapError(fileCompareFailed));
            const comparison = answerJson(answer);
            if (comparison === undefined)
                return yield* fileCompareFailed("The engine sent no comparison.");
            yield* Effect.annotateCurrentSpan({
                "textFiles.total": comparison.total,
                "textFiles.kept": comparison.kept
            });
            return comparison;
        }),
        open: Effect.fn("GameTextIndexQuery.open")(function* (input) {
            return yield* RcMap.get(readers, JSON.stringify({
                configuration: nativeIndexConfiguration(input.configuration),
                generation: input.storeEpoch,
                joinedKey: input.joinedKey,
                audienceRules: TEXT_AUDIENCE_POLICY.map((rule) => rule.id)
            }));
        })
    });
}));
