import { indexedTestReports } from "./indexed-reports.test-support.js";
import { Effect } from "effect";
import { textQualityQuery } from "./quality-query.js";
import { referenceCorpusCsv as formatCsv } from "./csv-reference.test-support.js";
import { exportGameTextInvestigation as exportInvestigation } from "./investigation.js";
import type { NativeTextQuery } from "./native-query-contract.js";
import type { TextCorpus, TextReviewSignal, TextUnit } from "./schema.js";
/**
 * Supplies planted results to export-format tests; never a production backend. Units without
 * planted review signals have none.
 */
export function corpusCsvForTest(
	corpus: TextCorpus,
	signals: ReadonlyMap<TextUnit["id"], readonly TextReviewSignal[]> = new Map()
) {
	return formatCsv(
		corpus,
		new Map(corpus.units.map((unit) => [unit.id, signals.get(unit.id) ?? []]))
	);
}
/**
 * Without a query, a corpus export without a localization target selects every unit of
 * `corpus`; tests whose selection matters pass a native query.
 */
export function exportGameTextInvestigation(
	corpus: TextCorpus,
	preset: Parameters<typeof exportInvestigation>[1],
	source: Parameters<typeof exportInvestigation>[2],
	query?: Pick<NativeTextQuery, "export">,
	workspace?: Parameters<typeof exportInvestigation>[4]
) {
	const selected =
		query ?? (preset.query.localization ? undefined : { export: () => Effect.succeed(corpus) });
	return exportInvestigation(
		{
			sourceQuality: (document) => {
				const source = textQualityQuery(indexedTestReports(corpus).source(document));
				return Effect.succeed({
					summary: source.summary,
					search: (request) => Effect.succeed(source.search(request)),
					focus: (request) => Effect.succeed(source.focus(request)),
					export: (filter) => Effect.succeed(source.export(filter))
				});
			}
		},
		preset,
		source,
		selected,
		workspace
	);
}
