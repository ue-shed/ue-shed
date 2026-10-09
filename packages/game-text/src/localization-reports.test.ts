import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	success,
	unit
} from "./localization.test-support.js";
import {
	createLocalizationBaseline,
	decodeLocalizationBaselineJson,
	diffLocalizationBaselines,
	localizationProgressReport,
	LocalizationProgressReport
} from "./localization-reports.js";
import { joinLocalizationTarget } from "./localization.js";
import { localizationWordCount } from "./localization-words.js";
import { canonicalLocalizationJson, localizationFingerprint } from "./localization-fingerprint.js";
import { LocalizationError } from "@ue-shed/localization/browser";

describe("localization progress and manifest baselines", () => {
	it("fingerprints the corpus JSON encoding including optional diagnostic fields", () => {
		const text = {
			...corpus(),
			diagnostics: [
				{
					code: "package_partially_decoded",
					message: "Partial package evidence.",
					packageFile: "Content/Text/Table.uasset",
					objectPath: undefined,
					propertyPath: undefined
				}
			]
		} satisfies ReturnType<typeof corpus>;
		const encoded = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
			JSON.stringify(text)
		);
		const baseline = createLocalizationBaseline(text, evidence(), "2026-10-07T00:00:00Z");
		expect(baseline.provenance.corpusGeneration).toBe(
			localizationFingerprint(canonicalLocalizationJson(encoded))
		);
	});
	it("follows the CSV commandlet's empty-native-culture helper rather than runtime fallback", () => {
		const text = corpus([]);
		const original = evidence(
			[manifestEntry()],
			[archiveEntry("K", "Native wording", "Foreign translation")]
		);
		const files = {
			...original,
			cultures: original.cultures.map((culture) =>
				culture.culture === cultureCode("en") && culture.archive.status === "read"
					? {
							...culture,
							archive: {
								...culture.archive,
								value: {
									formatVersion: 2,
									diagnostics: [],
									entries: [archiveEntry("K", "Source", "Native wording")]
								}
							} satisfies typeof culture.archive
						}
					: culture
			)
		};
		const report = localizationProgressReport(
			text,
			joinLocalizationTarget(text, files, files.target),
			files
		);
		expect(
			report.cultures.find((culture) => culture.culture === cultureCode("de"))
				?.upToDateArchive
		).toEqual({ lines: 0, sourceWords: 0 });
		expect(
			report.cultures.find((culture) => culture.culture === cultureCode("en"))
				?.upToDateArchive
		).toEqual({ lines: 1, sourceWords: 1 });
		const empty = evidence(
			[manifestEntry()],
			[archiveEntry("K", "Source", "")],
			poDocument("")
		);
		expect(
			localizationProgressReport(
				text,
				joinLocalizationTarget(text, empty, empty.target),
				empty
			).cultures.find((culture) => culture.culture === cultureCode("en"))?.upToDateArchive
		).toEqual({ lines: 0, sourceWords: 0 });
	});
	it("counts current archive source words independently of pending PO and corpus drift", () => {
		const text = corpus([unit("K", "Changed source")]);
		const original = evidence(
			[manifestEntry("K", "Gathered source")],
			[archiveEntry("K", "Gathered source", "Translation")],
			poDocument("Pending text")
		);
		const files = {
			...original,
			cultures: original.cultures.map((culture) =>
				culture.culture === cultureCode("en") && culture.archive.status === "read"
					? {
							...culture,
							archive: {
								...culture.archive,
								status: "read",
								value: {
									formatVersion: 2,
									diagnostics: [],
									entries: [
										archiveEntry("K", "Gathered source", "Gathered source")
									]
								}
							} satisfies typeof culture.archive
						}
					: culture
			)
		};
		const report = localizationProgressReport(
			text,
			joinLocalizationTarget(text, files, files.target),
			files
		);
		for (const culture of report.cultures) {
			expect(culture.total).toEqual({ lines: 1, sourceWords: 2 });
			expect(culture.upToDateArchive).toEqual({ lines: 1, sourceWords: 2 });
			expect(culture.translatedPercent).toEqual({ lines: 100, words: 100 });
			expect(culture.reviewed).toBe("not_tracked");
			expect(culture.proofread).toBe("not_tracked");
			expect(culture.states.changed_since_gather.lines).toBe(1);
			expect(culture.notSynced).toEqual({ lines: 1, sourceWords: 2 });
		}
		expect(report.coverage).toEqual(text.coverage);
		expect(report.packageCoverage).toEqual(text.packageCoverage);
		expect(
			Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationProgressReport))(
				JSON.stringify(report)
			)
		).toEqual(report);
	});
	it("excludes optional manifest contexts, deduplicates paths, and reports missing archive coverage", () => {
		const text = corpus([]);
		const original = evidence([
			manifestEntry(),
			manifestEntry("K", "Source", "/Game/Text/Other.Other"),
			{ ...manifestEntry("Optional", "Optional source"), optional: true }
		]);
		const files = {
			...original,
			cultures: original.cultures.map((culture) => ({
				...culture,
				archive: {
					status: "failed",
					relativePath: null,
					error: new LocalizationError({
						code: "file_missing",
						message: "Missing evidence.",
						recovery: "Regenerate archives."
					})
				} satisfies typeof culture.archive
			}))
		};
		const report = localizationProgressReport(
			text,
			joinLocalizationTarget(text, files, files.target),
			files
		);
		for (const culture of report.cultures) {
			expect(culture.total).toEqual({ lines: 1, sourceWords: 1 });
			expect(culture.upToDateArchive).toEqual({ lines: null, sourceWords: null });
			expect(culture.translatedPercent).toEqual({ lines: null, words: null });
		}
		expect(
			report.gatherEvidence.some(
				(file) => file.kind === "archive" && file.status === "failed"
			)
		).toBe(true);
	});
	it("pairs keys that changed between baselines instead of counting them as new work", () => {
		const before = createLocalizationBaseline(
			corpus(),
			evidence([
				manifestEntry("Row", "Start game", "/Game/Text/DT.DT.Start.Label"),
				manifestEntry("Entry", "Welcome back")
			]),
			"2026-10-07T00:00:00Z"
		);
		const after = createLocalizationBaseline(
			corpus(),
			evidence([
				manifestEntry("RowRenamed", "Start the game", "/Game/Text/DT.DT.Start.Label"),
				manifestEntry("EntryRenamed", "Welcome back")
			]),
			"2026-10-08T00:00:00Z"
		);
		const delta = diffLocalizationBaselines(before, after);
		expect(delta.keyChanged.map((item) => [item.from.key, item.to.key, item.match])).toEqual([
			["Entry", "EntryRenamed", "same_text"],
			["Row", "RowRenamed", "same_place"]
		]);
		expect(delta.added).toEqual([]);
		expect(delta.removed).toEqual([]);
		expect(delta.keyChangedCounts.lines).toBe(2);
	});
	it("never pairs baseline keys by text an unchanged key also has", () => {
		const before = createLocalizationBaseline(
			corpus(),
			evidence([
				manifestEntry("Removed", "OK", "/Game/Text/Old.Old"),
				manifestEntry("Kept", "OK", "/Game/Text/Kept.Kept")
			]),
			"2026-10-07T00:00:00Z"
		);
		const after = createLocalizationBaseline(
			corpus(),
			evidence([
				manifestEntry("Added", "OK", "/Game/Text/New.New"),
				manifestEntry("Kept", "OK", "/Game/Text/Kept.Kept")
			]),
			"2026-10-08T00:00:00Z"
		);
		const delta = diffLocalizationBaselines(before, after);
		expect(delta.keyChanged).toEqual([]);
		expect(delta.added.map((entry) => entry.key)).toEqual(["Added"]);
		expect(delta.removed.map((entry) => entry.key)).toEqual(["Removed"]);
	});
	it("round-trips baselines and distinguishes added, changed, unchanged and removed identities", () => {
		const before = createLocalizationBaseline(
			corpus(),
			evidence([
				manifestEntry("Same"),
				manifestEntry("Change", "Old source"),
				manifestEntry("Remove", "Removed source")
			]),
			"2026-10-07T00:00:00Z"
		);
		const afterFiles = evidence([
			manifestEntry("Same"),
			manifestEntry("Change", "New source with words"),
			manifestEntry("Add", "Added source")
		]);
		const after = createLocalizationBaseline(corpus(), afterFiles, "2026-10-08T00:00:00Z");
		expect(success(decodeLocalizationBaselineJson(JSON.stringify(before)))).toEqual(before);
		const delta = diffLocalizationBaselines(before, after);
		expect(delta.added.map((entry) => entry.key)).toEqual(["Add"]);
		expect(delta.changed.map((entry) => entry.key)).toEqual(["Change"]);
		expect(delta.removed.map((entry) => entry.key)).toEqual(["Remove"]);
		expect(delta.addedCounts).toEqual({ lines: 1, sourceWords: 2 });
		expect(delta.changedCounts).toEqual({ lines: 1, sourceWords: 4 });
		expect(delta.removedCounts).toEqual({ lines: 1, sourceWords: 2 });
		const text = corpus([]),
			join = joinLocalizationTarget(text, afterFiles, afterFiles.target);
		expect(
			localizationProgressReport(text, join, afterFiles, before).cultures.every(
				(culture) => JSON.stringify(culture.baselineDelta) === JSON.stringify(delta)
			)
		).toBe(true);
		expect(() =>
			diffLocalizationBaselines(before, {
				...after,
				target: Schema.decodeUnknownSync(LocalizationProgressReport.fields.target)("Other")
			})
		).toThrowError(expect.objectContaining({ code: "baseline_target_mismatch" }));
		expect(
			decodeLocalizationBaselineJson(
				JSON.stringify({ ...before, entries: [...before.entries, ...before.entries] })
			)._tag
		).toBe("Failure");
	});
	it("fingerprints exact source including opaque metadata, with stable object ordering", () => {
		expect(localizationFingerprint("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		expect(localizationFingerprint("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
		expect(localizationFingerprint("a".repeat(1000))).toBe(
			"41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
		);
		expect(canonicalLocalizationJson({ b: 2, a: 1 })).toBe(
			canonicalLocalizationJson({ a: 1, b: 2 })
		);
		const original = createLocalizationBaseline(corpus(), evidence(), "2026-10-07T00:00:00Z");
		const changed = createLocalizationBaseline(
			corpus(),
			evidence([{ ...manifestEntry(), source: { Text: "Source", Context: "New metadata" } }]),
			"2026-10-07T00:00:00Z"
		);
		expect(diffLocalizationBaselines(original, changed).changedCounts).toEqual({
			lines: 1,
			sourceWords: 1
		});
	});
	it("makes dictionary limitations explicit and refuses a baseline with uncountable source", () => {
		expect(localizationWordCount("Hello world")).toEqual({ status: "counted", words: 2 });
		expect(localizationWordCount("First\r\nSecond")).toEqual({ status: "counted", words: 2 });
		expect(localizationWordCount("ไทย")).toEqual({
			status: "unknown",
			reason: "dictionary_line_breaking_unavailable"
		});
		const text = corpus([]),
			files = evidence([manifestEntry("K", "ไทย")]);
		const report = localizationProgressReport(
			text,
			joinLocalizationTarget(text, files, files.target),
			files
		);
		expect(
			report.cultures.every(
				(culture) =>
					culture.total.sourceWords === null && culture.translatedPercent.words === null
			)
		).toBe(true);
		expect(report.wordCountDiagnostics).toMatchObject([
			{ code: "dictionary_line_breaking_unavailable" }
		]);
		expect(() => createLocalizationBaseline(text, files, "2026-10-07T00:00:00Z")).toThrowError(
			expect.objectContaining({ code: "word_count_unavailable" })
		);
	});
});
