import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive,
	LocalizationTarget
} from "@ue-shed/localization";
import { CultureCode, TextNamespace, TextKey } from "@ue-shed/localization/browser";
import { corpus } from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { checkLocalizationTarget, localizationShippedTranslation } from "./localization-checks.js";
import { parseUnrealFormatPattern, unrealPluralForms } from "./unreal-text-syntax.js";

const Format = Schema.Struct({
	valid: Schema.Boolean,
	errors: Schema.Array(Schema.String),
	arguments: Schema.Array(Schema.String)
});
const Oracle = Schema.Struct({
	entries: Schema.Array(
		Schema.Struct({
			culture: CultureCode,
			namespace: TextNamespace,
			key: TextKey,
			manifestSource: Schema.NullOr(Schema.String),
			poDecodedMsgstr: Schema.NullOr(Schema.String),
			validation: Schema.NullOr(
				Schema.Struct({
					checkedTranslation: Schema.NullOr(Schema.String),
					sourceFormat: Format,
					translationFormat: Schema.NullOr(Format),
					cardinalForms: Schema.Array(Schema.String),
					ordinalForms: Schema.Array(Schema.String),
					sourceRichTextValid: Schema.Boolean,
					translationRichTextValid: Schema.NullOr(Schema.Boolean),
					sourceSafeWhitespaceValid: Schema.Boolean,
					translationSafeWhitespaceValid: Schema.NullOr(Schema.Boolean),
					poRoundTripTranslation: Schema.NullOr(Schema.String)
				})
			)
		})
	)
});

describe("built-ins against Unreal's recorded validators", () => {
	for (const version of ["5.7", "5.8"]) {
		it(`covers every validator failure from Unreal ${version} on the same shipped text`, async () => {
			const projectRoot = resolve("fixtures/unreal-project");
			const expected = Schema.decodeUnknownSync(Schema.fromJsonString(Oracle))(
				readFileSync(
					resolve(projectRoot, `FixtureExpected/localization/evidence.ue${version}.json`),
					"utf8"
				)
			);
			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* LocalizationEvidence;
					const discovery = yield* service.discover({ projectRoot });
					const original = discovery.targets.find((item) => item.name === "FixtureGame");
					if (!original) throw new Error("The fixture target was not discovered.");
					const directory =
						version === "5.8"
							? "FixtureExpected/localization/ue5.8-output"
							: "Content/Localization/FixtureGame";
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
							locmeta: `${directory}/FixtureGame.locmeta`,
							wordCount: `${directory}/FixtureGame.csv`
						}
					});
					return yield* service.read({ projectRoot, target });
				}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
			);
			expect(files.manifest.status).toBe("read");
			expect(
				files.cultures.every(
					(culture) => culture.archive.status === "read" && culture.po.status === "read"
				)
			).toBe(true);
			const text = corpus([]);
			const joined = joinLocalizationTarget(text, files, files.target);
			const report = checkLocalizationTarget(text, joined, files);
			let compared = 0;
			const failures = new Set<string>();
			for (const entry of expected.entries) {
				const validation = entry.validation;
				if (!validation) {
					expect(entry.manifestSource).toBeNull();
					continue;
				}
				compared++;
				const line = joined.lines.find(
					(line) =>
						line.identity?.namespace === entry.namespace &&
						line.identity.key === entry.key
				);
				const culture = line?.cultures.find((culture) => culture.culture === entry.culture);
				if (!line || !culture || entry.manifestSource === null)
					throw new Error("Oracle identity is missing from the joined fixture.");
				expect(localizationShippedTranslation(culture).value).toBe(
					validation.checkedTranslation
				);
				expect(culture.po?.msgstr["0"] ?? null).toBe(entry.poDecodedMsgstr);
				expect(unrealPluralForms(entry.culture, "cardinal")).toEqual(
					validation.cardinalForms
				);
				expect(unrealPluralForms(entry.culture, "ordinal")).toEqual(
					validation.ordinalForms
				);
				const findings = report.findings.filter(
					(finding) =>
						"culture" in finding &&
						finding.culture === entry.culture &&
						finding.identity.namespace === entry.namespace &&
						finding.identity.key === entry.key
				);
				const source = parseUnrealFormatPattern(entry.manifestSource, entry.culture);
				const engineIssue = (code: (typeof source.issues)[number]["code"]) =>
					[
						"unexpected_modifier",
						"missing_form",
						"unused_form",
						"redundant_modifier"
					].includes(code);
				expect(!source.issues.some((issue) => engineIssue(issue.code))).toBe(
					validation.sourceFormat.valid
				);
				expect(
					[...new Set(source.arguments.map((argument) => argument.name))].sort()
				).toEqual(validation.sourceFormat.arguments);
				if (!validation.sourceFormat.valid)
					expect(
						findings.some(
							(finding) =>
								finding.kind === "argument_modifiers" &&
								finding.actual.side === "source"
						)
					).toBe(true);
				if (validation.checkedTranslation !== null && validation.translationFormat) {
					const translation = parseUnrealFormatPattern(
						validation.checkedTranslation,
						entry.culture
					);
					expect(!translation.issues.some((issue) => engineIssue(issue.code))).toBe(
						validation.translationFormat.valid
					);
					expect(
						[...new Set(translation.arguments.map((argument) => argument.name))].sort()
					).toEqual(validation.translationFormat.arguments);
					if (!validation.translationFormat.valid) {
						failures.add("argument_modifiers");
						expect(
							findings.some(
								(finding) =>
									finding.kind === "argument_modifiers" &&
									finding.actual.side === "translation"
							)
						).toBe(true);
					}
				}
				if (validation.translationRichTextValid === false) {
					failures.add("rich_text");
					expect(findings.some((finding) => finding.kind === "rich_text")).toBe(true);
				}
				if (validation.translationSafeWhitespaceValid === false) {
					failures.add("whitespace");
					expect(findings.some((finding) => finding.kind === "whitespace")).toBe(true);
				}
				if (validation.poRoundTripTranslation !== validation.checkedTranslation) {
					failures.add("po_escape_safety");
					expect(findings.some((finding) => finding.kind === "po_escape_safety")).toBe(
						true
					);
				}
			}
			expect(compared).toBe(joined.lines.length * files.target.cultures.length);
			expect([...failures].sort()).toEqual([
				"argument_modifiers",
				"po_escape_safety",
				"rich_text",
				"whitespace"
			]);
			expect(report.coverage).toEqual(text.coverage);
		});
	}
});
