import { indexedTestReports } from "./indexed-reports.test-support.js";
import { parsePO } from "@ue-shed/localization/browser";
import { describe, expect, it } from "vitest";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	success,
	unit
} from "./localization.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { localizationQualityWorkspace } from "./localization-workspace.js";
/** Lines whose findings come from checks that did not change. */
const cases = [
	["A", "Take {Count} {Item}", "Nimm {Count}"],
	["B", "<Em>Hello</>", "<Em>Hallo"],
	["C", "Hello", " Hallo"],
	["D", "Line", "Zeile\\n"],
	["E", "Empty", ""],
	["F", "{N}|plural(one=x,other=y)", "{N}|plural(one=x)"]
] as const;
/**
 * Finding IDs the same lines had before checks were rated and split. IDs hash the line, culture,
 * rule and evidence; a check whose evidence did not change keeps its findings' IDs, so a saved
 * selection or a link to a finding still finds it. Recorded from main before this change.
 */
const before = {
	"A de format_arguments": "localization-finding:04828ae7ec927d49",
	"A en format_arguments": "localization-finding:f3cfbf93ce348954",
	"A en missing_translator_notes": "localization-finding:9f9f57121dae732f",
	"B de rich_text": "localization-finding:712bc86999d14213",
	"B en missing_translator_notes": "localization-finding:8c5d4ac30e229c89",
	"B en rich_text": "localization-finding:f864de657ab66607",
	"C de whitespace": "localization-finding:5e279be7344d9693",
	"C en missing_translator_notes": "localization-finding:f23017ac22ccf6c6",
	"C en whitespace": "localization-finding:6ce1843fca8235e9",
	"D de po_escape_safety": "localization-finding:5f87ef67ff5c5ea4",
	"D en missing_translator_notes": "localization-finding:8d5ff63dc453f3b6",
	"D en po_escape_safety": "localization-finding:6dc3eabfaa7ce903",
	"E de empty_translation": "localization-finding:d4929a030350cc43",
	"E en empty_translation": "localization-finding:8f6c47efee355b97",
	"E en missing_translator_notes": "localization-finding:65b790ee0eac74f8",
	"F de argument_modifiers": "localization-finding:d7c07cf54487539a",
	"F en argument_modifiers": "localization-finding:3e4398818d4d986d",
	"F en missing_translator_notes": "localization-finding:92b05aef395e7b7d"
};
describe("finding IDs of unchanged checks", () => {
	it("stay as they were", () => {
		const text = corpus(cases.map(([key, source]) => unit(key, source)));
		const files = evidence(
			cases.map(([key, source]) => manifestEntry(key, source)),
			cases.map(([key, source, translation]) => archiveEntry(key, source, translation)),
			success(parsePO(new TextEncoder().encode("")))
		);
		const join = joinLocalizationTarget(text, files, files.target);
		const report = indexedTestReports(text, files).localization(undefined, undefined);
		const workspace = localizationQualityWorkspace(undefined, report, join);
		const ids = Object.fromEntries(
			workspace
				.export({ target: join.target, filter: "all" })
				.findings.map((finding) => [
					`${finding.context.split(" · ")[1]} ${finding.culture} ${finding.filter}`,
					finding.id
				])
		);
		for (const [name, id] of Object.entries(before))
			expect([name, ids[name]]).toEqual([name, id]);
	});
});
describe("finding places", () => {
	it("name the first place a finding affects and how many it affects", () => {
		const text = corpus(cases.map(([key, source]) => unit(key, source)));
		const files = evidence(
			cases.map(([key, source]) => manifestEntry(key, source)),
			cases.map(([key, source, translation]) => archiveEntry(key, source, translation)),
			success(parsePO(new TextEncoder().encode("")))
		);
		const join = joinLocalizationTarget(text, files, files.target);
		const report = indexedTestReports(text, files).localization(undefined, undefined);
		const workspace = localizationQualityWorkspace(undefined, report, join);
		const { findings } = workspace.export({ target: join.target, filter: "all" });
		expect(findings.length).toBeGreaterThan(0);
		for (const finding of findings) {
			const unitOf = text.units.find(
				(candidate) =>
					candidate.identity.status === "resolved" &&
					candidate.identity.key === finding.context.split(" · ")[1]
			);
			expect(finding.locations).toBe(unitOf?.occurrences.length);
			expect(finding.location).toEqual(unitOf?.occurrences[0]?.location);
		}
	});
});
