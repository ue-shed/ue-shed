import { indexedTestReports } from "./indexed-reports.test-support.js";
import { Schema } from "effect";
import { parsePO } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	success,
	unit
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import {
	type LocalizationCheckOptions,
	type LocalizationQualityFinding,
	LocalizationQualityReport
} from "./localization-quality-schema.js";
import { STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import { TextQualityRuleDocument } from "./quality-schema.js";
function checked(
	source: string,
	translation: string,
	options: LocalizationCheckOptions = { culture: cultureCode("de") },
	poTranslation = translation
) {
	const text = corpus([unit("K", source)]);
	const po = success(
		parsePO(
			new TextEncoder().encode(
				`msgctxt "NS,K"\nmsgid ${JSON.stringify(source)}\nmsgstr ${JSON.stringify(poTranslation)}\n`
			)
		)
	);
	const files = evidence(
		[manifestEntry("K", source)],
		[archiveEntry("K", source, translation)],
		po
	);
	return {
		text,
		files,
		report: indexedTestReports(text, files).localization(undefined, options)
	};
}
function findings(report: LocalizationQualityReport): readonly LocalizationQualityFinding[] {
	return report.findings.filter(
		(finding): finding is LocalizationQualityFinding => "culture" in finding
	);
}
describe("built-in localization quality checks", () => {
	it("finds a renamed argument and stages a one-argument rename with PO preconditions", () => {
		const { text, files, report } = checked("Hello {Name}", "Hallo {Wrong}");
		const finding = findings(report).find(
			(finding) => finding.kind === "format_argument_renamed"
		);
		expect(finding?.actual).toEqual({
			arguments: ["Wrong"],
			renamed: [{ from: "Wrong", to: "Name" }]
		});
		expect(finding?.severity).toBe("normal");
		expect(findings(report).some((finding) => finding.kind === "format_arguments")).toBe(false);
		expect(report.changes.changes[0]).toMatchObject({
			culture: "de",
			namespace: "NS",
			key: "K",
			source: "Hello {Name}",
			previousTranslation: "Hallo {Wrong}",
			translation: "Hallo {Name}"
		});
		expect(finding?.affectedOccurrences[0]?.packageFile).toBe(
			["Content", "Text", "Table.uasset"].join(process.platform === "win32" ? "\\" : "/")
		);
		expect(report.coverage).toEqual(text.coverage);
		expect(report.diagnostics).toEqual(text.diagnostics);
		expect(files.cultures[1]?.archive.status).toBe("read");
		expect(
			Schema.decodeUnknownSync(LocalizationQualityReport)(JSON.parse(JSON.stringify(report)))
		).toEqual(report);
	});
	it("checks pending PO text even when another fact has primary state, and never fixes several renames", () => {
		const pending = checked("Hello {Name}", "Hallo {Name}", undefined, "Hallo {Wrong}").report;
		expect(
			findings(pending).find((finding) => finding.kind === "format_argument_renamed")
				?.translationOrigin
		).toBe("po");
		expect(pending.changes.changes[0]?.previousTranslation).toBe("Hallo {Wrong}");
		expect(checked("{A} {B}", "{X} {Y}").report.changes.changes).toEqual([]);
		const source = '{N}|plural(one="{Owner} has one",other="{Owner} has many")';
		const translation = '{N}|plural(one="{Wrong} hat eins",other="{Wrong} hat viele")';
		expect(checked(source, translation).report.changes.changes[0]?.translation).toBe(
			'{N}|plural(one="{Owner} hat eins",other="{Owner} hat viele")'
		);
	});
	it("keeps source modifier failures when translation is absent and rejects invalid selections", () => {
		const text = corpus([unit("K", "{N}|plural(one=x)")]);
		const files = evidence(
			[manifestEntry("K", "{N}|plural(one=x)")],
			[],
			success(parsePO(new TextEncoder().encode("")))
		);
		expect(
			findings(indexedTestReports(text, files).localization(undefined, undefined)).some(
				(finding) =>
					finding.kind === "argument_modifiers" && finding.actual.side === "source"
			)
		).toBe(true);
		expect(() =>
			indexedTestReports(text, files).localization(undefined, { culture: cultureCode("fr") })
		).toThrow("selection is invalid");
	});
	it("reports equal-source identities without linking their translations and orders findings stably", () => {
		const text = corpus([unit("A", "Same"), unit("B", "Same")]);
		const files = evidence(
			[manifestEntry("A", "Same"), manifestEntry("B", "Same")],
			[archiveEntry("A", "Same", "A translation")],
			success(parsePO(new TextEncoder().encode("")))
		);
		const joined = joinLocalizationTarget(text, files, files.target);
		const report = indexedTestReports(text, files).localization(undefined, undefined);
		// A fact about the shared text: once per text, on the first key, under the native culture.
		const shared = findings(report).filter((finding) => finding.kind === "duplicate_source");
		expect(shared.map((finding) => [finding.identity?.key, finding.culture])).toEqual([
			["A", "en"]
		]);
		expect(shared[0]?.actual).toMatchObject({ identityCount: 2 });
		expect(shared[0]?.severity).toBe("low");
		expect(
			joined.lines.find((line) => line.identity?.key === "B")?.cultures[0]?.archive
		).toBeNull();
		expect(indexedTestReports(text, files).localization(undefined, undefined)).toEqual(report);
	});
	it("supports built-in filters and compatible v1 disabling without a rule document", () => {
		const selected = findings(
			checked("{Name}", "{Wrong}", { checks: ["format_argument_renamed"] }).report
		);
		expect(selected.length).toBeGreaterThan(0);
		expect(selected.every((finding) => finding.kind === "format_argument_renamed")).toBe(true);
		const doc = Schema.decodeUnknownSync(TextQualityRuleDocument)({
			...STARTER_GAME_TEXT_RULES,
			disabledLocalizationChecks: ["format_argument_renamed"]
		});
		const { text, files } = checked("{Name}", "{Wrong}");
		const report = indexedTestReports(text, files).localization(doc, {});
		expect(findings(report).some((finding) => finding.kind === "format_argument_renamed")).toBe(
			false
		);
		expect(report.changes.changes).toEqual([]);
		expect(
			Schema.decodeUnknownSync(TextQualityRuleDocument)(STARTER_GAME_TEXT_RULES).schemaVersion
		).toBe(1);
	});
	it("reports syntax limits without claiming argument differences or staging guesses", () => {
		const report = checked(`{Name}${"x".repeat(1000001)}`, "{Wrong}").report;
		expect(
			report.checkDiagnostics.some((diagnostic) => diagnostic.code === "syntax_limit")
		).toBe(true);
		expect(findings(report).some((finding) => finding.kind === "format_arguments")).toBe(false);
		expect(report.changes.changes).toEqual([]);
	});
});

it("checks foreign archive staleness against Unreal's native translation", () => {
	for (const stale of [false, true]) {
		const text = corpus([unit("K", "Raw source")]);
		const initial = evidence(
			[manifestEntry("K", "Raw source")],
			[archiveEntry("K", stale ? "Raw source" : "Native source", "Foreign text")],
			success(parsePO(new TextEncoder().encode("")))
		);
		const files = {
			...initial,
			cultures: initial.cultures.map((culture) => {
				if (culture.culture !== "en" || culture.archive.status !== "read") return culture;
				return {
					...culture,
					archive: {
						...culture.archive,
						value: {
							...culture.archive.value,
							entries: [archiveEntry("K", "Raw source", "Native source")]
						}
					}
				};
			})
		};
		// An absent PO leaves the archive as the translation being checked.
		const join = joinLocalizationTarget(text, files);
		const foreign = join.lines[0]!.cultures.find((culture) => culture.culture === "de")!;
		expect(foreign.facts.includes("needs_update")).toBe(stale);
		const report = indexedTestReports(text, files).localization(undefined, {
			checks: ["outdated_translation"]
		});
		expect(
			findings(report).map((finding) => ({
				kind: finding.kind,
				actual: finding.actual,
				expectation: finding.expectation
			}))
		).toEqual(
			stale
				? [
						{
							kind: "outdated_translation",
							actual: { translatedSource: "Raw source" },
							expectation: { source: "Native source" }
						}
					]
				: []
		);
	}
});
it("finds malformed modifiers, culture forms and missing/added modifiers", () => {
	for (const [source, translation] of [
		["{N}|plural(one=x,other=y)", "{N}|plural(one=x)"],
		["{N}|ordinal(one=x,two=y,few=z,other=a)", "{N}|ordinal(other=x)"],
		["{G}|gender(He,She)", "{G}|gender(He)"],
		["{Name}|hpp(은,는)", "{Name}|hpp(ist)"],
		["{N}|plural(one=x,other=y)", "{N}"],
		["{N}", "{N}|plural(one=x,other=y)"]
	] satisfies ReadonlyArray<readonly [string, string]>)
		expect(
			findings(checked(source, translation).report).some(
				(finding) => finding.kind === "argument_modifiers"
			)
		).toBe(true);
});
it("distinguishes an existing empty entry from missing translation evidence", () => {
	expect(
		findings(checked("Source", "").report).some(
			(finding) => finding.kind === "empty_translation"
		)
	).toBe(true);
	expect(
		findings(checked("Source", "Archive text", undefined, "").report).some(
			(finding) => finding.kind === "empty_translation" && finding.translationOrigin === "po"
		)
	).toBe(true);
	const text = corpus();
	const files = evidence([manifestEntry()], [], success(parsePO(new TextEncoder().encode(""))));
	const report = indexedTestReports(text, files).localization(undefined, undefined);
	expect(findings(report).some((finding) => finding.kind === "empty_translation")).toBe(false);
	expect(
		report.checkDiagnostics.some((diagnostic) => diagnostic.code === "translation_unavailable")
	).toBe(true);
});
it("checks gathered-only pending text and Crowdin text using manifest source", () => {
	const text = corpus([]);
	const po = success(
		parsePO(new TextEncoder().encode('msgid "NS,K"\nmsgstr "Hallo {Wrong}"\n'), {
			format: "Crowdin"
		})
	);
	const files = evidence(
		[manifestEntry("K", "Hello {Name}", "Source/Game/Text.cpp - line 12")],
		[archiveEntry("K", "Hello {Name}", "Hallo {Name}")],
		po
	);
	const joined = joinLocalizationTarget(text, files, files.target);
	expect(
		joined.lines[0]?.cultures.every(
			(culture) =>
				culture.state === "gathered_only" &&
				culture.facts.includes("not_synced") &&
				culture.reducedSourceChecking
		)
	).toBe(true);
	const report = indexedTestReports(text, files).localization(undefined, {
		culture: cultureCode("de")
	});
	const finding = findings(report).find((finding) => finding.kind === "format_argument_renamed");
	expect(finding?.translationOrigin).toBe("po");
	expect(finding?.affectedOccurrences).toEqual([]);
	expect(finding?.manifestLocations).toEqual(["Source/Game/Text.cpp - line 12"]);
	expect(report.changes.changes[0]?.translation).toBe("Hallo {Name}");
	expect(
		report.checkDiagnostics.some((diagnostic) => diagnostic.code === "reduced_source_checking")
	).toBe(true);
});
it("finds missing notes once per line and accepts occurrence and manifest notes", () => {
	const noteCultures = (options: LocalizationCheckOptions) =>
		findings(checked("Source", "Translation", options).report)
			.filter((finding) => finding.kind === "missing_translator_notes")
			.map((finding) => finding.culture);
	// The native culture carries the line's one finding; another culture's selection has none.
	expect(noteCultures({})).toEqual(["en"]);
	expect(noteCultures({ culture: cultureCode("en") })).toEqual(["en"]);
	expect(noteCultures({ culture: cultureCode("de") })).toEqual([]);
	const original = unit();
	const text = corpus([
		{
			...original,
			occurrences: original.occurrences.map((occurrence) => ({
				...occurrence,
				devNotes: "Use a greeting"
			}))
		}
	]);
	const files = evidence();
	expect(
		findings(indexedTestReports(text, files).localization(undefined, undefined)).some(
			(finding) => finding.kind === "missing_translator_notes"
		)
	).toBe(false);
	const notes = evidence([
		{ ...manifestEntry(), metadata: { Info: { Comment: "Source context" } } }
	]);
	expect(
		findings(indexedTestReports(corpus(), notes).localization(undefined, undefined)).some(
			(finding) => finding.kind === "missing_translator_notes"
		)
	).toBe(false);
});
it("excludes blank-source noise while retaining raw coverage", () => {
	const { text, report } = checked(" \t", "");
	expect(report.findings).toEqual([]);
	expect(report.coverage).toEqual(text.coverage);
});
