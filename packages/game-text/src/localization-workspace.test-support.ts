import { Schema } from "effect";
import { parsePO } from "@ue-shed/localization/browser";
import {
	corpus,
	unit,
	evidence,
	manifestEntry,
	archiveEntry,
	success
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { checkLocalizationTarget } from "./localization-checks.js";
import { GameTextRuleDocument, evaluateGameTextSourceQuality } from "./quality-rules-v2.js";
import { localizationQualityWorkspace, localizationReportPage } from "./localization-workspace.js";
import { createLocalizationBaseline, localizationProgressReport } from "./localization-reports.js";

export function qualityFixture(count = 1) {
	const source = "Hello {PlayerName}";
	const text = corpus(Array.from({ length: count }, (_, index) => unit("K" + index, source)));
	const po = success(
		parsePO(
			new TextEncoder().encode(
				text.units
					.map(
						(_, index) =>
							`msgctxt "NS,K${index}"\nmsgid "${source}"\nmsgstr "Hallo {Name}"\n`
					)
					.join("\n")
			)
		)
	);
	const files = evidence(
		text.units.map((_, index) => manifestEntry("K" + index, source)),
		text.units.map((_, index) => archiveEntry("K" + index, source, "Hallo {Name}")),
		po
	);
	const join = joinLocalizationTarget(text, files);
	const document = Schema.decodeUnknownSync(GameTextRuleDocument)({
		schemaVersion: 2,
		roles: [
			{
				id: "menu",
				scopes: [
					{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }
				]
			}
		],
		rules: [
			{
				id: "source.limit",
				kind: "character_budget",
				role: "menu",
				maximumCharacters: 3,
				recovery: "Shorten the line."
			}
		],
		localizationRules: [
			{
				id: "translation.limit",
				kind: "localization_character_budget",
				role: "menu",
				cultures: { de: 4 },
				defaultMaximumCharacters: 20,
				recovery: "Shorten the translation."
			},
			{
				id: "translation.terms",
				kind: "localization_terminology",
				role: "menu",
				cultures: {
					de: [{ kind: "preferred", term: "Willkommen", alternatives: ["Hallo"] }]
				},
				caseSensitive: false,
				recovery: "Use Willkommen."
			}
		]
	});
	const sourceReport = evaluateGameTextSourceQuality(text, document);
	const report = checkLocalizationTarget(text, join, files, {}, document);
	const workspace = localizationQualityWorkspace(sourceReport, report, join);
	const baseline = createLocalizationBaseline(text, files, "2026-10-07T00:00:00Z");
	const progress = localizationProgressReport(text, join, files, baseline);
	const page = localizationReportPage(
		progress,
		join.nativeCulture,
		{ target: files.target.name },
		baseline
	);
	return { text, files, join, document, sourceReport, report, workspace, baseline, page };
}
