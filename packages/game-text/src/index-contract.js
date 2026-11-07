import { Context, Schema } from "effect";
import {} from "@ue-shed/localization";
import { LocalizationKeyChangePair } from "./localization-key-changes.js";
export { GameTextIndexError, isGameTextIndexError } from "./index-error.js";
/** Inventory and verified reads are host adapters; gathering and caching stay in this library. */
export class GameTextIndexSource extends Context.Service()("@ue-shed/game-text/GameTextIndexSource") {
}
/**
 * How to read a target's code: the engine's source gather behaviour (`sourceGatherEngine`) and its
 * installation root, which holds `Engine/`. Without it a target's code is not read, and the index
 * keeps no code text for it. Without the root, the engine's wrappers and tables are left out.
 */
export const GameTextCodeSource = Schema.Struct({
    engine: Schema.Literals(["4.27", "5.7", "5.8"]),
    engineRoot: Schema.optionalKey(Schema.NonEmptyString),
    /** Read the engine's wrappers again, for a source-built engine edited without a version change. */
    refreshEngineWrappers: Schema.optionalKey(Schema.Boolean)
});
/**
 * A project and optional localization target to prepare. changedFiles absent means full
 * refresh, while an empty list permits reuse; review tolerance and key-change choices remain
 * explicit host policy.
 */
export const GameTextIndexRefreshRequest = Schema.Struct({
    projectRoot: Schema.NonEmptyString,
    targetName: Schema.optionalKey(Schema.NonEmptyString),
    changedFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    keyChangePairs: Schema.optionalKey(Schema.Array(LocalizationKeyChangePair)),
    tolerateReviewErrors: Schema.optionalKey(Schema.Boolean),
    requireManifest: Schema.optionalKey(Schema.Boolean),
    savedPackages: Schema.optionalKey(Schema.Boolean),
    code: Schema.optionalKey(GameTextCodeSource)
});
/**
 * Complete project/target refresh and invalidation port. A refresh returns a scoped pinned
 * model; invalidation affects disposable derived data, never the host's selected project or
 * authored files.
 */
export class GameTextIndexRefresh extends Context.Service()("@ue-shed/game-text/GameTextIndexRefresh") {
}
