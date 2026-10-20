import { Effect } from "effect";
import type { NativeTextQuery } from "./native-query.js";
import type { TextCorpusQuery } from "./query.test-support.js";
import type { TextCorpus } from "./schema.js";
import { GameTextIndexError } from "./index-contract.js";
import {
	derivedAggregate,
	derivedCorpusFingerprint,
	derivedCorpusHeader,
	derivedLineViews,
	type DerivedReadsBase
} from "./index-derived-reads.test-support.js";

/** Adapts an independent object oracle to the asynchronous host contract, only in tests. */
export function referenceNativeQuery(query: TextCorpusQuery, corpus: TextCorpus): NativeTextQuery {
	const read = <A>(operation: string, value: () => A) =>
		Effect.try({
			try: value,
			catch: (cause) =>
				new GameTextIndexError({
					code: "index_failed",
					operation,
					message: "The test query could not read this selection.",
					recovery: "Select a localization target or repair the fixture.",
					retrySafe: false,
					nextStep: "fix_input",
					cause
				})
		});
	const base: DerivedReadsBase = {
		lines: (request) => query.localizationLines(request),
		search: (request) => query.search(request),
		corpus: () => corpus,
		get cultures() {
			return query.readLocalizationLines()[0]?.cultures.map((mark) => mark.culture) ?? [];
		}
	};
	return {
		readCorpus: () => Effect.succeed(corpus),
		aggregate: (request) => read("aggregate", () => derivedAggregate(base, request)),
		selectLocalizationLines: (request, fields) =>
			read("localization_lines", () => derivedLineViews(base, request, fields)),
		readCorpusHeader: () => Effect.succeed(derivedCorpusHeader(corpus)),
		readUnits: (ids) => Effect.succeed(corpus.units.filter((unit) => ids.includes(unit.id))),
		corpusFingerprint: () => read("corpus_fingerprint", () => derivedCorpusFingerprint(corpus)),
		readLocalizationLines: () =>
			read("localization_corpus", () => query.readLocalizationLines()),
		summary: () => read("summary", query.summary),
		search: (request) => read("search", () => query.search(request)),
		focus: (request) => read("focus", () => query.focus(request)),
		localizationFocus: (id) => read("localization_focus", () => query.localizationFocus(id)),
		localizationDetail: (request) =>
			read("localization_detail", () => query.localizationDetail(request)),
		localizationLines: (request) =>
			read("localization_lines", () => query.localizationLines(request)),
		export: (request) => read("export", () => query.export(request)),
		exportWithSignals: (request) =>
			read("export", () => {
				const selected = query.export(request);
				return {
					corpus: selected,
					reviewSignals: new Map(
						selected.units.map((unit) => [
							unit.id,
							query.focus({ id: unit.id, pageSize: 1 })!.unit.reviewSignals
						])
					)
				};
			})
	};
}
