import type { Effect } from "effect";
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
	/** Explicit bulk export, assembled and serialized by Rust before the host decodes it. */
	readonly export: (
		request: Omit<TextCorpusSearchRequest, "cursor" | "pageSize">
	) => Effect.Effect<TextCorpus, GameTextIndexError>;
}

export interface NativeTextExport {
	readonly corpus: TextCorpus;
	readonly reviewSignals: ReadonlyMap<TextUnit["id"], readonly TextReviewSignal[]>;
}
