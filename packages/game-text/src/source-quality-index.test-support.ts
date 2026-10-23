import { Effect } from "effect";
import { expect } from "vitest";
import type { GameTextIndexRefreshResult } from "./index-contract.js";
import {
	TextQualityFilter,
	TextQualityFindingId,
	textQualityQuery,
	type TextQualityQuery,
	type AsyncTextQualityQuery
} from "./quality-query.js";
import { type GameTextRuleDocument } from "./game-text-rules.js";
import type { TextOccurrenceId } from "./schema.js";
/** Walks every search page by cursor, as a host does. */
export const pages = Effect.fn("Test.GameText.sourcePages")(function* (
	query: TextQualityQuery | AsyncTextQualityQuery,
	filter: TextQualityFilter,
	pageSize: number
) {
	const result = [];
	let cursor: TextQualityFindingId | undefined;
	do {
		const read = query.search({ filter, pageSize, ...(cursor ? { cursor } : undefined) });
		const page = Effect.isEffect(read) ? yield* read : read;
		result.push(page);
		cursor = page.nextCursor;
	} while (cursor !== undefined);
	return result;
});
/** Compare paged index reads with the presentation query over its shipped full report. */
export const expectSameSourceQuality = Effect.fn("Test.GameText.sameSourceQuality")(function* (
	result: GameTextIndexRefreshResult,
	document: GameTextRuleDocument
) {
	const indexed = yield* result.sourceQuality(document);
	const report = yield* indexed.export("all");
	// The corpus fixture is verified by the index tests; the presentation query consumes the
	// shipped report, rather than deriving another set of source rows in TypeScript.
	const legacy = textQualityQuery(report);
	expect(indexed.summary()).toEqual(legacy.summary());
	for (const filter of TextQualityFilter.literals) {
		expect(yield* indexed.export(filter)).toEqual(legacy.export(filter));
		for (const pageSize of [1, 7, 50])
			expect(yield* pages(indexed, filter, pageSize)).toEqual(
				yield* pages(legacy, filter, pageSize)
			);
	}
	for (const { findings } of yield* pages(legacy, "all", 50))
		for (const { id } of findings) {
			expect(yield* indexed.focus({ id, pageSize: 50 })).toEqual(
				legacy.focus({ id, pageSize: 50 })
			);
			// Every occurrence page of the finding, one occurrence at a time.
			let occurrenceCursor: TextOccurrenceId | undefined;
			do {
				const request = {
					id,
					pageSize: 1,
					...(occurrenceCursor ? { occurrenceCursor } : undefined)
				};
				const focus = yield* indexed.focus(request);
				expect(focus).toEqual(legacy.focus(request));
				occurrenceCursor = focus?.nextOccurrenceCursor;
			} while (occurrenceCursor !== undefined);
		}
	const unknown = TextQualityFindingId.make("quality-finding:0");
	expect(yield* indexed.focus({ id: unknown, pageSize: 1 })).toEqual(
		legacy.focus({ id: unknown, pageSize: 1 })
	);
	for (const malformed of ["quality-finding:00ff", "quality-finding:xyz", "other"]) {
		const id = TextQualityFindingId.make(malformed);
		expect(yield* indexed.focus({ id, pageSize: 1 })).toBeUndefined();
		expect(yield* indexed.search({ filter: "all", pageSize: 3, cursor: id })).toEqual(
			legacy.search({ filter: "all", pageSize: 3, cursor: id })
		);
	}
	return { report, indexed };
});
