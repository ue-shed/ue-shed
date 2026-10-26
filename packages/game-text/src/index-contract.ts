import { Context, Schema, type Effect, type Scope, type Stream } from "effect";
import {
	type LocalizationTargetEvidence,
	type LocalizationReviewSnapshot
} from "@ue-shed/localization";
import type { SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import type { PackageTextInventoryEntry, refreshPackageTextLayer } from "./package-text-layer.js";
import type { importLocalizationTarget } from "./localization-import.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import type { NativeTextQuery } from "./native-query.js";
import type {
	TextCorpus,
	TextCorpusRowsPage,
	TextCorpusSearchRequest,
	TextCorpusSearchPage
} from "./schema.js";
import type { LocalizationJoin } from "./localization-schema.js";
import type { LocalizationCheckOptions } from "./localization-quality-schema.js";
import type { QueriedLocalizationQuality } from "./localization-workspace.js";
import type { AsyncTextQualityQuery } from "./quality-query.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import { LocalizationKeyChangePair } from "./localization-key-changes.js";
import type { RefreshJoinedTarget } from "./joined-target.js";
import type { GameTextProjectIndex } from "./index-steps.js";
export { GameTextIndexError, isGameTextIndexError } from "./index-error.js";
import type { GameTextIndexError } from "./index-error.js";

/**
 * Inventory request for one selected project. changedFiles is a reuse hint: omitted means full
 * discovery, and an empty array means no saved input was reported changed.
 */
export interface GameTextIndexSourceRequest {
	readonly projectRoot: string;
	/** Absent means a complete refresh; an empty list means reuse every saved input. */
	readonly changedFiles?: readonly string[];
}

/** Inventory and verified reads are host adapters; gathering and caching stay in this library. */
export class GameTextIndexSource extends Context.Service<
	GameTextIndexSource,
	{
		readonly inventory: (
			request: GameTextIndexSourceRequest
		) => Effect.Effect<readonly PackageTextInventoryEntry[], GameTextIndexError>;
		/** Reads must verify the complete package-and-sidecar signature around extraction. */
		readonly read: (
			projectRoot: string,
			entries: readonly PackageTextInventoryEntry[]
		) => Stream.Stream<typeof SavedAssetPackageTextEvent.Type, GameTextIndexError>;
		/**
		 * Verified native preparation. With `snapshots`, each complete shard stays in one
		 * request and the reader writes `<directory>/<group>.snapshot`. Completion events name
		 * selected packages; excluded inventory entries are encoded without reading packages.
		 * Authored records stay in the reader throughout conversion and shard ordering.
		 */
		readonly stage?: (
			projectRoot: string,
			entries: readonly PackageTextInventoryEntry[],
			staging: {
				readonly directory: string;
				readonly groups: readonly number[];
				readonly snapshots?: import("./package-text-native.js").PackageTextSnapshots;
			}
		) => Stream.Stream<{ readonly path: string; readonly file: string }, GameTextIndexError>;
	}
>()("@ue-shed/game-text/GameTextIndexSource") {}

/**
 * Check options of an indexed quality read. Progress goes to `GameTextIndexProgressReporter`: a
 * `localization_quality` event before the engine checks, with no lines checked, and one after,
 * with every line checked and the findings the checks found.
 */
export type IndexedLocalizationQualityOptions = LocalizationCheckOptions;

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
	savedPackages: Schema.optionalKey(Schema.Boolean)
});
export type GameTextIndexRefreshRequest = typeof GameTextIndexRefreshRequest.Type;

type ImportedTarget = Effect.Success<ReturnType<typeof importLocalizationTarget>>;
/**
 * Pinned corpus, localization and query views from one validated revision. Keep its scope open
 * while executing asynchronous reads; sourceQuality and localizationQuality are required, interruptible
 * operations with the rule document first.
 */
export interface GameTextIndexRefreshResult {
	/** Present on the steps implementation; optional for existing host-provided refresh adapters. */
	readonly project?: GameTextProjectIndex | undefined;
	/** Opaque immutable query identity. Compare only within the same project, cache and backend;
	 * never parse, construct or persist it as a durable identifier. Absent on legacy adapters.
	 */
	readonly queryRevision?: string | undefined;
	/**
	 * This opened model's revision, unique within the process: equal values are the same model
	 * and pinned snapshot. Compare it to tell whether the model changed, instead of keeping
	 * `corpus` or other lazy reads as identity tokens. Absent on legacy adapters; a retained
	 * model always has one.
	 */
	readonly revision?: string | undefined;
	readonly joined: JoinedTargetReader;
	readonly query: NativeTextQuery;
	readonly summary: import("./schema.js").TextCorpusQuerySummary;
	/** Asynchronous search through the pinned native snapshot. */
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchPage, IndexFailure>;
	/** The request's rows, or its open groups' first rows, without the aggregates. */
	readonly searchRows: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusRowsPage, IndexFailure>;
	readonly imported: ImportedTarget;
	readonly packages: Effect.Success<ReturnType<typeof refreshPackageTextLayer>>;
	readonly join: Effect.Success<ReturnType<RefreshJoinedTarget>>;
	/**
	 * Explicit bulk read of the whole corpus, for hosts that write it out. Facts about it come
	 * from `query`: `aggregate`, `selectLocalizationLines`, `readCorpusHeader`, `corpusFingerprint`.
	 */
	readonly corpus: Effect.Effect<TextCorpus, IndexFailure>;
	/** Explicit bulk read of every visible joined line with full evidence; see `corpus`. */
	readonly localizationJoin: Effect.Effect<LocalizationJoin, IndexFailure>;
	readonly localization: Omit<LocalizationJoin, "lines">;
	readonly evidence: LocalizationTargetEvidence;
	readonly review: LocalizationReviewSnapshot;
	/**
	 * Localization quality over the index: the engine checks the rule document once per document,
	 * and the workspace reads its findings a page at a time. It can be interrupted, and reports
	 * `localization_quality` progress through `GameTextIndexProgressReporter`. Arguments are in
	 * the same order as `sourceQuality`: the rule document first.
	 */
	readonly localizationQuality: (
		ruleDocument?: GameTextRuleDocument,
		options?: IndexedLocalizationQualityOptions
	) => Effect.Effect<QueriedLocalizationQuality, IndexFailure>;
	/**
	 * The CLI quality report, ready to write: its proposals, collected before acceptance
	 * filtering, and its findings' count are read, and the engine writes the findings as the
	 * report is written. A complete rule the engine can't run fails it with the rules file's
	 * error.
	 */
	readonly prepareLocalizationCheck: (
		document?: GameTextRuleDocument,
		options?: IndexedLocalizationQualityOptions
	) => Effect.Effect<
		import("./localization-check-report.js").PreparedLocalizationCheck,
		IndexFailure | import("./game-text-rules.js").GameTextRuleDocumentError
	>;
	/** `prepareLocalizationCheck`'s report as a value, for hosts that keep it. */
	readonly localizationCheck: (
		document?: GameTextRuleDocument,
		options?: IndexedLocalizationQualityOptions
	) => Effect.Effect<
		import("./localization-quality-schema.js").LocalizationQualityReport,
		IndexFailure | import("./game-text-rules.js").GameTextRuleDocumentError
	>;
	/**
	 * Source quality rules evaluated over the index in bounded pages: the query
	 * `textQualityQuery(evaluateGameTextSourceQuality(corpus, ruleDocument))` gives, without
	 * building the corpus's units. The scan yields between pages and can be interrupted, and
	 * reports `source_quality` progress through `GameTextIndexProgressReporter`.
	 */
	readonly sourceQuality: (
		ruleDocument: GameTextRuleDocument
	) => Effect.Effect<AsyncTextQualityQuery, IndexFailure>;
}

/**
 * Expected index failures retain their domain identity: orchestration, cache
 * filesystem/session, or cache format. Hosts use recovery guidance instead of flattening them
 * into a generic retry.
 */
export type { IndexFailure } from "./index-failure.js";
import type { IndexFailure } from "./index-failure.js";
/**
 * Complete project/target refresh and invalidation port. A refresh returns a scoped pinned
 * model; invalidation affects disposable derived data, never the host's selected project or
 * authored files.
 */
export class GameTextIndexRefresh extends Context.Service<
	GameTextIndexRefresh,
	{
		readonly refresh: (
			request: GameTextIndexRefreshRequest
		) => Effect.Effect<GameTextIndexRefreshResult, IndexFailure, Scope.Scope>;
		readonly invalidate: (
			request: GameTextIndexRefreshRequest
		) => Effect.Effect<void, IndexFailure>;
	}
>()("@ue-shed/game-text/GameTextIndexRefresh") {}
