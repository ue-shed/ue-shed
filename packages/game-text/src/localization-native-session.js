import { Layer, Effect } from "effect";
import { AssetReaderLive } from "@ue-shed/unreal-assets";
import { GameTextIndexBuilder } from "./index-builder.js";
import { snapshotStoreFailure } from "./snapshot-store.js";
/** Standalone imports own the same native lease as imports within an indexing operation. */
export const withNativeLocalizationSession = Effect.fn("LocalizationImport.nativeSession")(function* (configuration, effect) {
    const { GameTextIndexBuilderLive } = yield* Effect.promise(() => import("./native-index-builder.js"));
    return yield* Effect.scoped(Effect.gen(function* () {
        const builder = yield* GameTextIndexBuilder;
        return yield* builder.withSession({ configuration }, effect);
    })).pipe(Effect.provide(Layer.provideMerge(GameTextIndexBuilderLive, AssetReaderLive)), Effect.catchTag("ConfigError", (cause) => Effect.fail(snapshotStoreFailure("native-localization-configuration", cause, "Check the native reader configuration and retry the import."))));
});
