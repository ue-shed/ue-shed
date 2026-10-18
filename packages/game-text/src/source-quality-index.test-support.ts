import { Effect } from "effect";
import { expect } from "vitest";
import type { GameTextIndexRefreshResult } from "./index-contract.js";
import {
	TextQualityFilter,
	TextQualityFindingId,
	textQualityQuery,
	type TextQualityQuery
} from "./quality-query.js";
import { evaluateGameTextSourceQuality, type GameTextRuleDocument } from "./game-text-rules.js";
import type { TextCorpus, TextOccurrenceId } from "./schema.js";

/** Walks every search page by cursor, as a host does. */
export function pages(query: TextQualityQuery, filter: TextQualityFilter, pageSize: number) {
	const result = [];
	let cursor: TextQualityFindingId | undefined;
	do {
		const page = query.search({ filter, pageSize, ...(cursor ? { cursor } : undefined) });
		result.push(page);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return result;
}

/**
 * The indexed query against the in-memory report and query over the index's corpus; with
 * `memory`, that report must also equal the one over a corpus built without the index.
 */
export const expectSameSourceQuality = Effect.fn("Test.GameText.sameSourceQuality")(function* (
	result: GameTextIndexRefreshResult,
	memory: TextCorpus | undefined,
	document: GameTextRuleDocument
) {
	const report = evaluateGameTextSourceQuality(yield* result.corpus, document);
	if (memory) expect(evaluateGameTextSourceQuality(memory, document)).toEqual(report);
	const legacy = textQualityQuery(report);
	const indexed = yield* result.sourceQuality(document);
	expect(indexed.summary()).toEqual(legacy.summary());
	for (const filter of TextQualityFilter.literals) {
		expect(indexed.export(filter)).toEqual(legacy.export(filter));
		for (const pageSize of [1, 7, 50])
			expect(pages(indexed, filter, pageSize)).toEqual(pages(legacy, filter, pageSize));
	}
	for (const { findings } of pages(legacy, "all", 50))
		for (const { id } of findings) {
			expect(indexed.focus({ id, pageSize: 50 })).toEqual(legacy.focus({ id, pageSize: 50 }));
			// Every occurrence page of the finding, one occurrence at a time.
			let occurrenceCursor: TextOccurrenceId | undefined;
			do {
				const request = {
					id,
					pageSize: 1,
					...(occurrenceCursor ? { occurrenceCursor } : undefined)
				};
				const focus = indexed.focus(request);
				expect(focus).toEqual(legacy.focus(request));
				occurrenceCursor = focus?.nextOccurrenceCursor;
			} while (occurrenceCursor !== undefined);
		}
	const unknown = TextQualityFindingId.make("quality-finding:0");
	expect(indexed.focus({ id: unknown, pageSize: 1 })).toEqual(
		legacy.focus({ id: unknown, pageSize: 1 })
	);
	for (const malformed of ["quality-finding:00ff", "quality-finding:xyz", "other"]) {
		const id = TextQualityFindingId.make(malformed);
		expect(indexed.focus({ id, pageSize: 1 })).toBeUndefined();
		expect(indexed.search({ filter: "all", pageSize: 3, cursor: id })).toEqual(
			legacy.search({ filter: "all", pageSize: 3, cursor: id })
		);
	}
	return { report, indexed };
});
