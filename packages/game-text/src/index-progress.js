import { Context, Schema } from "effect";
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** The phase a Game Text operation reports, as a raw code; `GAME_TEXT_INDEX_PHASE_LABELS` words it. */
export const GameTextIndexPhase = Schema.Literals([
    "inventory",
    "localization",
    /** Publishing the parsed localization files; no count. */
    "localization_publish",
    /**
     * Reading the saved packages a refresh needs: packages read of packages to read, with
     * `unchanged`, the packages kept from the existing index without reading them.
     */
    "package_read",
    /** Preparing the package text layer: packages prepared of the packages in the inventory. */
    "package_text",
    /** Publishing a package text layer written again; no count. */
    "package_publish",
    /** Updating the existing package text layer with the packages read; no count. */
    "package_update",
    /** Joining source text with translations; no count. */
    "joining",
    /** Opening the joined index: the engine's preparation stages done, of three. */
    "opening",
    "ready",
    "failed",
    /** A corpus scan reading packages: assets read of assets selected. */
    "corpus",
    /** A localization quality scan: the rule document's rules evaluated, of its rules. */
    "localization_quality",
    /** A source quality scan: the rule document's rules evaluated, of its rules. */
    "source_quality"
]);
/** Each index phase in words, for hosts that show progress. */
export const GAME_TEXT_INDEX_PHASE_LABELS = {
    inventory: "Reading project asset inventory",
    localization: "Reading localization files",
    localization_publish: "Saving localization text",
    package_read: "Reading changed packages",
    package_text: "Preparing package text",
    package_publish: "Saving package text",
    package_update: "Updating package text",
    joining: "Joining source text and translations",
    opening: "Opening text index",
    ready: "Text index ready",
    failed: "Text index failed",
    corpus: "Reading saved packages",
    localization_quality: "Checking localization quality",
    source_quality: "Checking source text"
};
/**
 * Progress of any Game Text operation: an index refresh, a corpus scan or a quality scan.
 * Counts describe the current phase, not a percentage of the whole operation.
 */
export const GameTextIndexProgress = Schema.Struct({
    phase: GameTextIndexPhase,
    completed: Count,
    total: Count,
    /** Findings so far, during a quality scan; the last event has the scan's count. */
    findings: Schema.optionalKey(Count),
    /** Packages kept from the existing index without reading them, while reading packages. */
    unchanged: Schema.optionalKey(Count)
});
/**
 * The one way Game Text reports progress: an operation-scoped observer the host provides with
 * `Effect.provideService` around the operation. Each operation reports its own events, so
 * concurrent operations never share state, and no caller polls. It runs inside the operation,
 * so it must be cheap and must not throw. Hosts own presentation and transport.
 */
export const GameTextIndexProgressReporter = Context.Reference("@ue-shed/game-text/GameTextIndexProgressReporter", {
    defaultValue: () => () => { }
});
const forwardedTo = new WeakMap();
/**
 * Records that `reporter` forwards its events to `host` while `live` holds, so both reach one
 * host and a reporter that stopped forwarding can be told apart.
 */
export const forwardsProgressTo = (reporter, host, live = () => true) => {
    forwardedTo.set(reporter, { host, live });
    return reporter;
};
/** The reporter that receives a reporter's events at the end of its forwarding: its host. */
export const progressHost = (reporter) => {
    let host = reporter;
    for (let next = forwardedTo.get(host); next; next = forwardedTo.get(host))
        host = next.host;
    return host;
};
/** Whether a reporter's events still reach its host: every forwarding step is live. */
export const reachesProgressHost = (reporter) => {
    for (let next = forwardedTo.get(reporter); next; next = forwardedTo.get(reporter)) {
        if (!next.live())
            return false;
        reporter = next.host;
    }
    return true;
};
