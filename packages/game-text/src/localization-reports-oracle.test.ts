import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget
} from "@ue-shed/localization";
import { parseWordCountCSV } from "@ue-shed/localization/browser";
import { corpus, success } from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { createLocalizationBaseline, localizationProgressReport } from "./localization-reports.js";

describe("word-count reports against Unreal's committed CSVs", () => {
	for (const version of ["5.7", "5.8"])
		it(`matches Unreal ${version} total and every culture without adjustments`, async () => {
			const projectRoot = resolve("fixtures/unreal-project");
			const directory =
				version === "5.8"
					? "FixtureExpected/localization/ue5.8-output"
					: "Content/Localization/FixtureGame";
			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* LocalizationEvidence;
					const discovery = yield* service.discover({ projectRoot });
					const original = discovery.targets.find(
						(target) => target.name === "FixtureGame"
					);
					if (!original) throw new Error("The fixture target is missing.");
					const target = Schema.decodeUnknownSync(LocalizationTarget)({
						...original,
						outputPaths: {
							...original.outputPaths,
							manifest: `${directory}/FixtureGame.manifest`,
							archives: Object.fromEntries(
								original.cultures.map((culture) => [
									culture,
									`${directory}/${culture}/FixtureGame.archive`
								])
							),
							portableObjects: Object.fromEntries(
								original.cultures.map((culture) => [
									culture,
									`${directory}/${culture}/FixtureGame.po`
								])
							),
							wordCount: `${directory}/FixtureGame.csv`,
							locmeta: `${directory}/FixtureGame.locmeta`
						}
					});
					return yield* service.read({ projectRoot, target });
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			);
			const csv = success(
				parseWordCountCSV(readFileSync(resolve(projectRoot, directory, "FixtureGame.csv")))
			);
			const row = csv.rows.at(-1);
			if (!row) throw new Error("The Unreal word-count oracle has no row.");
			expect(row.wordCount).toBe(62);
			const text = corpus([]),
				join = joinLocalizationTarget(text, files, files.target);
			const report = localizationProgressReport(text, join, files);
			expect(report.wordCountDiagnostics).toEqual([]);
			for (const culture of report.cultures) {
				expect(culture.total.sourceWords).toBe(row.wordCount);
				expect(culture.upToDateArchive.sourceWords).toBe(
					row.cultureWordCounts[culture.culture]
				);
			}
			expect(
				report.cultures
					.map((culture) => [culture.culture, culture.upToDateArchive.sourceWords])
					.sort()
			).toEqual([
				["de", 59],
				["en", 62],
				["fr", 54]
			]);
			const baseline = createLocalizationBaseline(text, files, "2026-10-07T00:00:00Z");
			expect(baseline.entries.reduce((total, entry) => total + entry.sourceWords, 0)).toBe(
				row.wordCount
			);
		});
});
