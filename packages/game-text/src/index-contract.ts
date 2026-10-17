import { Context, Schema, type Effect, type Scope, type Stream } from "effect";
import {
	LocalizationError,
	type LocalizationTargetEvidence,
	type LocalizationReviewSnapshot
} from "@ue-shed/localization";
import type { SavedAssetPackageTextEvent } from "@ue-shed/unreal-assets";
import type { PackageTextInventoryEntry, refreshPackageTextLayer } from "./package-text-layer.js";
import type { importLocalizationTarget } from "./localization-import.js";
import type { SnapshotStoreError } from "./snapshot-store.js";
import type { SnapshotFormatError } from "./snapshot-format.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import type { TextCorpusQuery } from "./query.js";
import type { TextCorpus, TextCorpusSearchRequest, TextCorpusSearchPage } from "./schema.js";
import type { LocalizationJoin } from "./localization-schema.js";
import type { IndexedLocalizationQualityOptions } from "./localization-quality-index.js";
import type { LocalizationQuality } from "./localization-workspace.js";
import type { TextQualityQuery } from "./quality-query.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import { LocalizationKeyChangePair } from "./localization-key-changes.js";
import type { refreshJoinedTarget } from "./joined-target.js";
import type { GameTextProjectIndex } from "./index-steps.js";
export class GameTextIndexError extends Schema.TaggedError<GameTextIndexError>()(
	"GameTextIndexError",
	{
		nextStep: Schema.Literals(["fix_input", "retry", "reconcile", "escalate"]),
		code: Schema.Literal("index_failed"),
		operation: Schema.String,
		message: Schema.String,
		recovery: Schema.String,
		retrySafe: Schema.Boolean,
		localizationError: Schema.optionalKey(LocalizationError),
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}
/** Tag guard for Game Text index failures; match by tag, not `instanceof`. */
export const isGameTextIndexError = Schema.is(GameTextIndexError);

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
	}
>()("@ue-shed/game-text/GameTextIndexSource") {}

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
export interface GameTextIndexRefreshResult {
	/** Present on the steps implementation; optional for existing host-provided refresh adapters. */
	readonly project?: GameTextProjectIndex | undefined;
	/** Opaque immutable query identity. Compare only within the same project, cache and backend;
	 * never parse, construct or persist it as a durable identifier. Absent on legacy adapters.
	 */
	readonly queryRevision?: string | undefined;
	readonly joined: JoinedTargetReader;
	readonly query: TextCorpusQuery;
	/** Asynchronous search adapter; worker-backed when selected by the host's layer. */
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchPage, IndexFailure>;
	readonly imported: ImportedTarget;
	readonly packages: Effect.Success<ReturnType<typeof refreshPackageTextLayer>>;
	readonly join: Effect.Success<ReturnType<typeof refreshJoinedTarget>>;
	readonly corpus: TextCorpus;
	readonly localizationJoin: LocalizationJoin;
	readonly evidence: LocalizationTargetEvidence;
	readonly review: LocalizationReviewSnapshot;
	/**
	 * Localization quality checked over the index in bounded pages, with findings kept as columns.
	 * The scan yields between pages and can be interrupted, and reports `localization_quality`
	 * progress through `GameTextIndexProgressReporter`. Arguments are in the same order as
	 * `sourceQuality`: the rule document first.
	 */
	readonly localizationQuality: (
		ruleDocument?: GameTextRuleDocument,
		options?: IndexedLocalizationQualityOptions
	) => Effect.Effect<LocalizationQuality>;
	/**
	 * Source quality rules evaluated over the index in bounded pages: the query
	 * `textQualityQuery(evaluateGameTextSourceQuality(corpus, ruleDocument))` gives, without
	 * building the corpus's units. The scan yields between pages and can be interrupted, and
	 * reports `source_quality` progress through `GameTextIndexProgressReporter`.
	 */
	readonly sourceQuality: (ruleDocument: GameTextRuleDocument) => Effect.Effect<TextQualityQuery>;
}

export type IndexFailure = SnapshotStoreError | SnapshotFormatError | GameTextIndexError;
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
