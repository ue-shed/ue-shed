import { Context, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Progress of any Game Text operation: an index refresh, a corpus scan or a quality scan.
 * Counts describe the current phase, not a percentage of the whole operation.
 */
export const GameTextIndexProgress = Schema.Struct({
	phase: Schema.Literals([
		"inventory",
		"localization",
		/** Publishing the parsed localization files; no count. */
		"localization_publish",
		"packages",
		/** Preparing the package text layer: packages prepared of the packages in the inventory. */
		"package_text",
		/** Publishing the package text layer; no count. */
		"package_publish",
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
	]),
	completed: Count,
	total: Count,
	/** Findings so far, during a quality scan; the last event has the scan's count. */
	findings: Schema.optionalKey(Count)
});
export type GameTextIndexProgress = typeof GameTextIndexProgress.Type;

/**
 * The one way Game Text reports progress: an operation-scoped observer the host provides with
 * `Effect.provideService` around the operation. Each operation reports its own events, so
 * concurrent operations never share state, and no caller polls. It runs inside the operation,
 * so it must be cheap and must not throw. Hosts own presentation and transport.
 */
export const GameTextIndexProgressReporter = Context.Reference<
	(progress: GameTextIndexProgress) => void
>("@ue-shed/game-text/GameTextIndexProgressReporter", {
	defaultValue: () => () => {}
});
