import assert from "node:assert/strict";
import { test } from "vitest";
import { Schema } from "effect";
import { LocalizationChange, parsePO } from "../packages/localization/dist/index.js";
import { indexedTestReports } from "../packages/game-text/src/indexed-reports.test-support.ts";
import { joinLocalizationTarget } from "../packages/game-text/src/localization.ts";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	success,
	unit
} from "../packages/game-text/src/localization.test-support.ts";
import { diffCorpus } from "./game-text-corpus-contract.ts";
import { planCorpus } from "./game-text-corpus-plan.ts";

for (const seed of [1, 73139]) {
	test(`nested plural recipes include today's Japanese modifier evidence, seed ${seed}`, () => {
		const plan = planCorpus({ seed, lines: 1, density: 2, root: "/Game/Fixture/Corpus" });
		const subjects = plan.expectations.subjects.filter(
			(subject) =>
				subject.case.startsWith("format-renamed-nested") && subject.culture === "ja"
		);
		assert.equal(subjects.length, 4);
		for (const subject of subjects) {
			const text = corpus([
				unit(subject.key, subject.source, "Content/Text/Table.uasset", subject.namespace)
			]);
			const initial = evidence(
				[
					manifestEntry(
						subject.key,
						subject.source,
						"/Game/Text/Table.Table",
						subject.namespace
					)
				],
				[
					archiveEntry(
						subject.key,
						subject.source,
						subject.stages.archive!,
						subject.namespace
					)
				],
				success(parsePO(new TextEncoder().encode("")))
			);
			const files = {
				...initial,
				target: { ...initial.target, cultures: [cultureCode("en"), cultureCode("ja")] },
				cultures: initial.cultures.map((culture) =>
					culture.culture === "de" ? { ...culture, culture: cultureCode("ja") } : culture
				)
			};
			const report = indexedTestReports(text, files).localization(undefined, {
				checks: ["argument_modifiers"]
			});
			assert.deepEqual(
				report.findings
					.filter((finding) => "culture" in finding && finding.culture === "ja")
					.map((finding) => ({
						check: `localization.${finding.kind}`,
						actual: finding.actual,
						expectation: finding.expectation
					})),
				subject.findings,
				subject.case
			);
		}
	});

	test(`planted rename fixes equal today's check, including nested plural forms, seed ${seed}`, () => {
		const plan = planCorpus({ seed, lines: 1, density: 2, root: "/Game/Fixture/Corpus" });
		const subjects = plan.expectations.subjects.filter((subject) =>
			subject.findings.some((finding) => finding.fix)
		);
		assert.ok(subjects.some((subject) => subject.case.startsWith("format-renamed-nested@")));
		assert.ok(subjects.some((subject) => subject.case.startsWith("format-renamed@")));
		for (const subject of subjects) {
			const expected = subject.findings.find((finding) => finding.fix)!.fix!;
			assert.deepEqual(Schema.decodeUnknownSync(LocalizationChange)(expected), expected);
			const text = corpus([
				unit(expected.key, expected.source, "Content/Text/Table.uasset", expected.namespace)
			]);
			const initial = evidence(
				[
					manifestEntry(
						expected.key,
						expected.source,
						"/Game/Text/Table.Table",
						expected.namespace
					)
				],
				[
					archiveEntry(
						expected.key,
						expected.source,
						expected.previousTranslation!,
						expected.namespace
					)
				],
				success(parsePO(new TextEncoder().encode("")))
			);
			const translatedCulture = cultureCode(expected.culture);
			const files = {
				...initial,
				target: { ...initial.target, cultures: [cultureCode("en"), translatedCulture] },
				cultures: initial.cultures.map((culture) =>
					culture.culture === "de" ? { ...culture, culture: translatedCulture } : culture
				)
			};
			const join = joinLocalizationTarget(text, files);
			const report = indexedTestReports(text, files).localization(undefined, {
				checks: ["format_argument_renamed"]
			});
			const finding = report.findings.find(
				(finding) => "culture" in finding && finding.culture === expected.culture
			);
			assert.ok(finding && "suggestedChange" in finding, subject.case);
			assert.deepEqual(
				finding.suggestedChange,
				{ ...expected, target: join.target },
				subject.case
			);
		}
	});
}

test("a missing or incorrect proposed fix fails the corpus diff", () => {
	const plan = planCorpus({ seed: 7, lines: 1, density: 1, root: "/Game/Fixture/Corpus" });
	for (const translation of [undefined, "A wrong proposed replacement"]) {
		const subjects = plan.expectations.subjects.map((subject) => ({
			...subject,
			findings: subject.findings.map((finding) => {
				if (!finding.fix) return finding;
				const { fix, ...evidence } = finding;
				return translation === undefined
					? evidence
					: { ...evidence, fix: { ...fix, translation } };
			})
		}));
		assert.ok(
			diffCorpus(plan.expectations, subjects).some((difference) =>
				difference.case.startsWith("format-renamed-nested@")
			)
		);
	}
});
