import { Effect } from "effect";
import { gameTextCsv as formatCsv } from "./csv.js";
import { exportGameTextInvestigation as exportInvestigation } from "./investigation.js";
import { textCorpusQuery, type TextCorpusQuery } from "./query.test-support.js";
import type { TextCorpus } from "./schema.js";
import { GameTextIndexError } from "./index-contract.js";

/** Supplies independent in-memory results to export-format tests; never a production backend. */
export function gameTextCsv(corpus: TextCorpus, reviewCorpus = corpus) {
	const query = textCorpusQuery(reviewCorpus);
	return formatCsv(
		corpus,
		new Map(
			corpus.units.map((unit) => [
				unit.id,
				query.focus({ id: unit.id, pageSize: 1 })!.unit.reviewSignals
			])
		)
	);
}

export function exportGameTextInvestigation(
	corpus: TextCorpus,
	preset: Parameters<typeof exportInvestigation>[1],
	source: Parameters<typeof exportInvestigation>[2],
	query?: TextCorpusQuery,
	workspace?: Parameters<typeof exportInvestigation>[4]
) {
	const reference = query ?? (preset.query.localization ? undefined : textCorpusQuery(corpus));
	return exportInvestigation(
		corpus,
		preset,
		source,
		reference
			? {
					export: (request) =>
						Effect.try({
							try: () => reference.export(request),
							catch: (cause) =>
								new GameTextIndexError({
									code: "index_failed",
									operation: "test_export",
									message: "The test selection is invalid.",
									recovery:
										"Select a localization target or repair the test selection.",
									retrySafe: false,
									nextStep: "fix_input",
									cause
								})
						})
				}
			: undefined,
		workspace
	);
}
