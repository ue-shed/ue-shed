import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it as effectIt } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { nativeTermMatches as termMatches } from "./native-rule-reports.test-support.js";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { expectSameSourceQuality } from "./source-quality-index.test-support.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import {
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf
} from "./localization-workspace.js";
it.each(["prefixTODOsuffix", "éTODO", "TODO界", "2TODO", "TODO٢", "𐐀TODO", "TODO𐐀"])(
	"does not match a term beside a Unicode letter or number in %s",
	(text) => {
		expect(termMatches(text, "TODO", false)).toEqual([]);
	}
);
it("treats combining marks as part of the word around a term", () => {
	// A decomposed accent before or after the term, as the precomposed "éTODO" above.
	expect(termMatches("éTODO", "TODO", false)).toEqual([]);
	expect(termMatches("TODÓsuffix", "TODO", false)).toEqual([]);
	// An Indic vowel sign continues the word: "क" is not matched inside "किताब".
	expect(termMatches("किताब", "क", false)).toEqual([]);
	// A term ending in a mark still matches whole, with UTF-16 offsets.
	expect(termMatches("x café y", "café", false)).toEqual([{ start: 2, end: 7, matched: "café" }]);
});
it("keeps case behavior, phrases, punctuation and UTF-16 offsets", () => {
	expect(termMatches("😀 todo TODO", "TODO", false)).toEqual([
		{ start: 3, end: 7, matched: "todo" },
		{ start: 8, end: 12, matched: "TODO" }
	]);
	expect(termMatches("todo TODO", "TODO", true)).toEqual([{ start: 5, end: 9, matched: "TODO" }]);
	expect(termMatches("old phrase old phrases", "old phrase", true)).toEqual([
		{ start: 0, end: 10, matched: "old phrase" }
	]);
	expect(termMatches("(A+B), xA+By", "A+B", true)).toEqual([
		{ start: 1, end: 4, matched: "A+B" }
	]);
	expect(termMatches("C++ xC++y", "C++", true)).toEqual([{ start: 0, end: 3, matched: "C++" }]);
});
effectIt.live(
	"agrees on term boundaries in memory, source index, translation policy and workspace focus",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeIndexRegressionFixture();
			const text =
				"prefixTODOsuffix TODO todo, éTODO TODO界 2TODO TODO٢ 𐐀TODO TODO𐐀; A+B xA+By C++ xC++y old phrase old phrases draft term draft terms";
			fixture.setSource(text);
			yield* Effect.promise(async () => {
				for (const culture of fixture.target.cultures) {
					await writeFile(
						join(fixture.projectRoot, `${culture}.archive`),
						fixture.contents.archive.replace("Shipped", text)
					);
					await writeFile(
						join(fixture.projectRoot, `${culture}.po`),
						fixture.contents.po.replace("Shipped", text)
					);
				}
			});
			const terms = [
				...["TODO", "old phrase", "A+B", "C++"].map((term) => ({
					kind: "forbidden",
					term
				})),
				{ kind: "preferred", term: "approved term", alternatives: ["draft term"] }
			];
			const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
				schemaVersion: 1,
				roles: [
					{
						id: "all",
						scopes: [{ matchers: [{ kind: "location_kind", value: "asset_property" }] }]
					}
				],
				rules: [
					{
						id: "source.terms",
						kind: "terminology",
						role: "all",
						caseSensitive: false,
						recovery: "Use approved terms.",
						terms
					},
					{
						id: "translation.terms",
						kind: "localization_terminology",
						role: "all",
						caseSensitive: false,
						recovery: "Use approved terms.",
						cultures: { de: terms }
					}
				]
			});
			yield* Effect.gen(function* () {
				const indexed = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				const source = yield* expectSameSourceQuality(indexed, document);
				expect(source.report.findings).toHaveLength(6);
				const report = yield* indexed.localizationCheck(document, { checks: [] });
				expect(report.findings).toHaveLength(6);
				const quality = yield* indexed.localizationQuality(document, { checks: [] });
				const sourceReport = yield* (yield* indexed.sourceQuality(document)).export("all");
				const memory = localizationQualityWorkspace(
					sourceReport,
					report,
					yield* indexed.localizationJoin
				);
				const columnar = localizationQualityWorkspaceOf(sourceReport, quality);
				const request = {
					target: fixture.target.name,
					culture: fixture.target.cultures[1]!,
					filter: "terminology" as const
				};
				expect(yield* columnar.search(request)).toEqual(memory.search(request));
				for (const { id } of memory.search(request).findings) {
					expect(yield* columnar.focus({ ...request, id })).toEqual(
						memory.focus({ ...request, id })
					);
				}
			}).pipe(Effect.provide(fixture.layer()));
		}).pipe(Effect.scoped)
);
