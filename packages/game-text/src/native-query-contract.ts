import type { Effect } from "effect";
import type { TextCorpusReportHeader } from "./corpus-summary.js";
import type {
	TextCorpus,
	TextCorpusQuerySummary,
	TextCorpusSearchRequest,
	TextCorpusSearchPage,
	TextCorpusFocusRequest,
	TextCorpusFocus,
	TextUnit,
	TextReviewSignal
} from "./schema.js";
import type { LocalizationLine, LocalizationLineId } from "./localization-schema.js";
import type { GameTextIndexError } from "./index-error.js";
import type { LocalizationFocus, LocalizationFocusRequest } from "./localization-view.js";
import type {
	LocalizationLineField,
	LocalizationLineView,
	TextAggregate,
	TextAggregateRequest,
	TextCorpusHeader
} from "./index-reads.js";

/** Native queries are asynchronous process calls; this interface owns no query or column data. */
export interface NativeTextQuery {
	/** Full saved corpus, including blank units retained as provenance. */
	readonly readCorpus: () => Effect.Effect<TextCorpus, GameTextIndexError>;
	/** Complete joined provenance, including blank-source lines. */
	readonly readLocalizationLines: () => Effect.Effect<
		readonly LocalizationLine[],
		GameTextIndexError
	>;
	readonly summary: () => Effect.Effect<TextCorpusQuerySummary, GameTextIndexError>;
	readonly search: (
		request: TextCorpusSearchRequest
	) => Effect.Effect<TextCorpusSearchPage, GameTextIndexError>;
	readonly focus: (
		request: TextCorpusFocusRequest
	) => Effect.Effect<TextCorpusFocus | undefined, GameTextIndexError>;
	readonly localizationFocus: (
		id: LocalizationLineId
	) => Effect.Effect<LocalizationLine | undefined, GameTextIndexError>;
	/** Evidence is selected and paged in Rust, before host decoding. */
	readonly localizationDetail: (
		request: LocalizationFocusRequest
	) => Effect.Effect<LocalizationFocus | undefined, GameTextIndexError>;
	/** Explicit bulk read; interactive consumers use search and focus pages. */
	readonly localizationLines: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<readonly LocalizationLine[], GameTextIndexError>;
	/** Export context includes native review signals for CSV formatting without a second engine. */
	readonly exportWithSignals: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<NativeTextExport, GameTextIndexError>;
	/**
	 * Grouped counts and word totals of every row a request matches, by up to four stored
	 * dimensions. Rust counts them on the bulk lane; nothing is exported.
	 */
	readonly aggregate: (
		request: TextAggregateRequest
	) => Effect.Effect<TextAggregate, GameTextIndexError>;
	/**
	 * Every line a request matches with only the named fields: an explicit bulk read, written by
	 * Rust to a scoped file. Name the fields a file export or a gate needs instead of reading
	 * whole lines and the corpus.
	 */
	readonly selectLocalizationLines: <const F extends LocalizationLineField>(
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">,
		fields: readonly F[]
	) => Effect.Effect<readonly LocalizationLineView<F>[], GameTextIndexError>;
	/** The named units with every occurrence (at most 5,000 IDs); IDs no unit has are left out. */
	readonly readUnits: (
		ids: readonly TextUnit["id"][]
	) => Effect.Effect<readonly TextUnit[], GameTextIndexError>;
	/** The corpus without its units: status, coverage, package coverage and diagnostics. */
	readonly readCorpusHeader: () => Effect.Effect<TextCorpusHeader, GameTextIndexError>;
	/**
	 * The corpus header as a report shows it, computed in Rust: coverage, every diagnostic and
	 * package count, and the first `MAX_CORPUS_REPORT_ITEMS` diagnostics and incomplete packages.
	 */
	readonly readCorpusReportHeader: () => Effect.Effect<
		TextCorpusReportHeader,
		GameTextIndexError
	>;
	/**
	 * SHA-256 of the whole corpus in canonical JSON (`sha256-canonical-json-utf8-v1`), computed in
	 * Rust: equal corpora have equal fingerprints on every machine.
	 */
	readonly corpusFingerprint: () => Effect.Effect<string, GameTextIndexError>;
	/** Explicit bulk export, assembled and serialized by Rust before the host decodes it. */
	readonly export: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<TextCorpus, GameTextIndexError>;
}

export interface NativeTextExport {
	readonly corpus: TextCorpus;
	readonly reviewSignals: ReadonlyMap<TextUnit["id"], readonly TextReviewSignal[]>;
}
