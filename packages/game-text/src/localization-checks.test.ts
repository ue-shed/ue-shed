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
import { checkLocalizationTarget } from "./localization-checks.js";
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
		report: checkLocalizationTarget(
			text,
			joinLocalizationTarget(text, files, files.target),
			files,
			options
		)
	};
}

function findings(report: LocalizationQualityReport): readonly LocalizationQualityFinding[] {
	return report.findings.filter(
		(finding): finding is LocalizationQualityFinding => "culture" in finding
	);
}

describe("built-in localization quality checks", () => {
	it("finds missing and added arguments and stages a one-argument rename with PO preconditions", () => {
		const { text, files, report } = checked("Hello {Name}", "Hallo {Wrong}");
		const finding = findings(report).find((finding) => finding.kind === "format_arguments");
		expect(finding?.actual).toEqual({
			arguments: ["Wrong"],
			missing: ["Name"],
			added: ["Wrong"]
		});
		expect(report.changes.changes[0]).toMatchObject({
			culture: "de",
			namespace: "NS",
			key: "K",
			source: "Hello {Name}",
			previousTranslation: "Hallo {Wrong}",
			translation: "Hallo {Name}"
		});
		expect(finding?.affectedOccurrences[0]?.packageFile).toBe("Content/Text/Table.uasset");
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
			findings(pending).find((finding) => finding.kind === "format_arguments")
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
	it("finds rich-text imbalance, unsafe PO escapes and whitespace/line-break drift", () => {
		expect(
			findings(checked("<Em>Hello</>", "<Em>Hallo").report).some(
				(finding) => finding.kind === "rich_text"
			)
		).toBe(true);
		expect(
			findings(checked("Hello", "Schreib \\n, \\r, \\t", undefined, "").report).find(
				(finding) => finding.kind === "po_escape_safety"
			)?.actual
		).toMatchObject({ sequences: ["\\n", "\\r", "\\t"] });
		expect(
			findings(checked("Hello\nWorld", " Hallo Welt ").report).find(
				(finding) => finding.kind === "whitespace"
			)?.actual
		).toEqual({ leading: " ", trailing: " ", lineBreaks: 0 });
		expect(
			findings(checked("Hello\r\nWorld", "Hallo\nWelt").report).some(
				(finding) => finding.kind === "whitespace"
			)
		).toBe(false);
	});
	it("distinguishes an existing empty entry from missing translation evidence", () => {
		expect(
			findings(checked("Source", "").report).some(
				(finding) => finding.kind === "empty_translation"
			)
		).toBe(true);
		expect(
			findings(checked("Source", "Archive text", undefined, "").report).some(
				(finding) =>
					finding.kind === "empty_translation" && finding.translationOrigin === "po"
			)
		).toBe(true);
		const text = corpus();
		const files = evidence(
			[manifestEntry()],
			[],
			success(parsePO(new TextEncoder().encode("")))
		);
		const report = checkLocalizationTarget(
			text,
			joinLocalizationTarget(text, files, files.target),
			files
		);
		expect(findings(report).some((finding) => finding.kind === "empty_translation")).toBe(
			false
		);
		expect(
			report.checkDiagnostics.some(
				(diagnostic) => diagnostic.code === "translation_unavailable"
			)
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
		const report = checkLocalizationTarget(text, joined, files, { culture: cultureCode("de") });
		const finding = findings(report).find((finding) => finding.kind === "format_arguments");
		expect(finding?.translationOrigin).toBe("po");
		expect(finding?.affectedOccurrences).toEqual([]);
		expect(finding?.manifestLocations).toEqual(["Source/Game/Text.cpp - line 12"]);
		expect(report.changes.changes[0]?.translation).toBe("Hallo {Name}");
		expect(
			report.checkDiagnostics.some(
				(diagnostic) => diagnostic.code === "reduced_source_checking"
			)
		).toBe(true);
	});
	it("keeps source modifier failures when translation is absent and rejects invalid selections", () => {
		const text = corpus([unit("K", "{N}|plural(one=x)")]);
		const files = evidence(
			[manifestEntry("K", "{N}|plural(one=x)")],
			[],
			success(parsePO(new TextEncoder().encode("")))
		);
		const joined = joinLocalizationTarget(text, files, files.target);
		expect(
			findings(checkLocalizationTarget(text, joined, files)).some(
				(finding) =>
					finding.kind === "argument_modifiers" && finding.actual.side === "source"
			)
		).toBe(true);
		expect(() =>
			checkLocalizationTarget(text, joined, files, { culture: cultureCode("fr") })
		).toThrow("selection is invalid");
	});
	it("finds missing notes but accepts occurrence and manifest notes", () => {
		expect(
			findings(checked("Source", "Translation").report).some(
				(finding) => finding.kind === "missing_translator_notes"
			)
		).toBe(true);
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
			findings(
				checkLocalizationTarget(
					text,
					joinLocalizationTarget(text, files, files.target),
					files
				)
			).some((finding) => finding.kind === "missing_translator_notes")
		).toBe(false);
		const notes = evidence([
			{ ...manifestEntry(), metadata: { Info: { Comment: "Source context" } } }
		]);
		expect(
			findings(
				checkLocalizationTarget(
					corpus(),
					joinLocalizationTarget(corpus(), notes, notes.target),
					notes
				)
			).some((finding) => finding.kind === "missing_translator_notes")
		).toBe(false);
	});
	it("reports equal-source identities without linking their translations and orders findings stably", () => {
		const text = corpus([unit("A", "Same"), unit("B", "Same")]);
		const files = evidence(
			[manifestEntry("A", "Same"), manifestEntry("B", "Same")],
			[archiveEntry("A", "Same", "A translation")],
			success(parsePO(new TextEncoder().encode("")))
		);
		const joined = joinLocalizationTarget(text, files, files.target);
		const report = checkLocalizationTarget(text, joined, files);
		expect(
			findings(report).filter((finding) => finding.kind === "duplicate_source")
		).toHaveLength(4);
		expect(
			joined.lines.find((line) => line.identity?.key === "B")?.cultures[0]?.archive
		).toBeNull();
		expect(
			checkLocalizationTarget(text, { ...joined, lines: [...joined.lines].reverse() }, files)
		).toEqual(report);
	});
	it("supports built-in filters and compatible v1 disabling without a rule document", () => {
		expect(
			findings(checked("{Name}", "{Wrong}", { checks: ["format_arguments"] }).report).every(
				(finding) => finding.kind === "format_arguments"
			)
		).toBe(true);
		const doc = Schema.decodeUnknownSync(TextQualityRuleDocument)({
			...STARTER_GAME_TEXT_RULES,
			disabledLocalizationChecks: ["format_arguments"]
		});
		const { text, files } = checked("{Name}", "{Wrong}");
		const report = checkLocalizationTarget(
			text,
			joinLocalizationTarget(text, files, files.target),
			files,
			{},
			doc
		);
		expect(findings(report).some((finding) => finding.kind === "format_arguments")).toBe(false);
		expect(report.changes.changes).toEqual([]);
		expect(
			Schema.decodeUnknownSync(TextQualityRuleDocument)(STARTER_GAME_TEXT_RULES).schemaVersion
		).toBe(1);
	});
	it("reports syntax limits without claiming argument differences or staging guesses", () => {
		const report = checked(`{Name}${"x".repeat(1_000_001)}`, "{Wrong}").report;
		expect(
			report.checkDiagnostics.some((diagnostic) => diagnostic.code === "syntax_limit")
		).toBe(true);
		expect(findings(report).some((finding) => finding.kind === "format_arguments")).toBe(false);
		expect(report.changes.changes).toEqual([]);
	});
	it("excludes blank-source noise while retaining raw coverage", () => {
		const { text, report } = checked(" \t", "");
		expect(report.findings).toEqual([]);
		expect(report.coverage).toEqual(text.coverage);
	});
});
