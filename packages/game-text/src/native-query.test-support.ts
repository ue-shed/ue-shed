import { writeFileSync } from "node:fs";
import { Effect } from "effect";
import { gameTextCsv } from "./csv.js";
import { hasSearchableSource } from "./search.js";
import { textCorpusReportHeader } from "./corpus-summary.js";
import type { NativeTextQuery } from "./native-query.js";
import { referenceSearchRows, type TextCorpusQuery } from "./query.test-support.js";
import type { TextCorpus } from "./schema.js";
import { GameTextIndexError } from "./index-contract.js";
import {
	derivedAggregate,
	derivedCorpusFingerprint,
	derivedCorpusHeader,
	derivedLineViews,
	type DerivedReadsBase
} from "./index-derived-reads.test-support.js";

/** Writes a reference export's text as an engine sink would, and answers as it does. */
const written = (path: string, text: string, rows: number) => {
	const bytes = new TextEncoder().encode(text);
	writeFileSync(path, bytes);
	return { status: "written" as const, rows, bytes: bytes.byteLength };
};

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
		findingsEvaluate: () => Effect.die("This query-only test fixture does not evaluate rules."),
		findingsAccept: () => Effect.die("This query-only test fixture has no findings layer."),
		findingsQuery: () => Effect.die("This query-only test fixture has no findings layer."),
		findingsWrite: () => Effect.die("This query-only test fixture has no findings layer."),
		rulesCheck: () => Effect.die("This query-only test fixture does not check rules."),
		readCorpus: () => Effect.succeed(corpus),
		aggregate: (request) => read("aggregate", () => derivedAggregate(base, request)),
		selectLocalizationLines: (request, fields) =>
			read("localization_lines", () => derivedLineViews(base, request, fields)),
		writeLocalizationLinesCsv: () =>
			Effect.die("This reference query encodes no files; the engine's sinks do."),
		// Hosts' export flows run over this query too; it writes the files the engine's sinks do.
		writeCorpusCsv: (request, file) =>
			read("export", () => {
				const selected = query.export(request);
				const reviewSignals = new Map(
					selected.units.map((unit) => [
						unit.id,
						query.focus({ id: unit.id, pageSize: 1 })!.unit.reviewSignals
					])
				);
				return written(
					file.path,
					gameTextCsv(selected, reviewSignals),
					selected.units
						.filter(hasSearchableSource)
						.reduce((rows, unit) => rows + unit.occurrences.length, 0)
				);
			}),
		writeCorpusJson: (request, file, envelope) =>
			read("export", () => {
				const { units } = query.export(request);
				const indent = (depth: number) => `\n${"\t".repeat(depth)}`;
				const array = units.length
					? `[${units
							.map(
								(unit, index) =>
									`${index ? "," : ""}${indent(envelope.depth + 1)}${JSON.stringify(
										unit,
										null,
										"\t"
									).replaceAll("\n", indent(envelope.depth + 1))}`
							)
							.join("")}${indent(envelope.depth)}]`
					: "[]";
				return written(
					file.path,
					`${envelope.before}${array}${envelope.after}`,
					units.length
				);
			}),
		readCorpusHeader: () => Effect.succeed(derivedCorpusHeader(corpus)),
		readCorpusReportHeader: () =>
			Effect.succeed(textCorpusReportHeader(derivedCorpusHeader(corpus))),
		readUnits: (ids) => Effect.succeed(corpus.units.filter((unit) => ids.includes(unit.id))),
		corpusFingerprint: () => read("corpus_fingerprint", () => derivedCorpusFingerprint(corpus)),
		readLocalizationLines: () =>
			read("localization_corpus", () => query.readLocalizationLines()),
		summary: () => read("summary", query.summary),
		search: (request) => read("search", () => query.search(request)),
		searchRows: (request) =>
			read("search", () => referenceSearchRows((input) => query.search(input), request)),
		focus: (request) => read("focus", () => query.focus(request)),
		localizationFocus: (id) => read("localization_focus", () => query.localizationFocus(id)),
		related: () => Effect.die("This reference query has no related lines."),
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
