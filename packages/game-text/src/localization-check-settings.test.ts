import { indexedTestReports } from "./indexed-reports.test-support.js";
import { Effect } from "effect";
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
import { localizationCheckDefaults } from "./localization-check-catalogue.js";
import { BuiltInCheckId } from "./localization-check-ids.js";
import type {
	LocalizationCheckOptions,
	LocalizationQualityFinding,
	LocalizationQualityReport
} from "./localization-quality-schema.js";
import {
	type BuiltInCheckEntry,
	GameTextRuleDocument,
	decodeGameTextRuleDocumentJson,
	resolveLocalizationChecks
} from "./game-text-rules.js";
import { STARTER_CHECKS } from "./starter-rules.js";
const noPO = () => success(parsePO(new TextEncoder().encode("")));
/** One gathered line with the same archive translation in every culture. */
function line(
	source: string,
	translation: string,
	rules?: GameTextRuleDocument,
	options: LocalizationCheckOptions = {}
): LocalizationQualityReport {
	const text = corpus([unit("K", source)]);
	const files = evidence(
		[manifestEntry("K", source)],
		[archiveEntry("K", source, translation)],
		noPO()
	);
	return indexedTestReports(text, files).localization(rules, options);
}
const german = (value: LocalizationQualityReport) =>
	value.findings.filter(
		(finding): finding is LocalizationQualityFinding =>
			"culture" in finding && finding.culture === "de"
	);
const kinds = (value: LocalizationQualityReport) => german(value).map((finding) => finding.kind);
type Settings = {
	readonly [Id in BuiltInCheckId]?: Omit<
		Extract<typeof BuiltInCheckEntry.Encoded, { readonly kind: Id }>,
		"kind"
	>;
};
type Roles = (typeof GameTextRuleDocument.Encoded)["roles"];
/** The JSON of a file with these rules, decoded as a host reads it. */
const decode = (rules: string, fields = "") =>
	Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(
				`{"schemaVersion":1,"roles":[],"rules":[${rules}]${fields ? `,${fields}` : ""}}`
			)
		)
	);
const file = (rules: readonly object[], roles: Roles = []) => {
	const result = Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(JSON.stringify({ schemaVersion: 1, roles, rules }))
		)
	);
	if (result._tag === "Failure") throw new Error(result.failure.code);
	return result.success;
};
/** A file of only these checks, with these settings. */
const only = (settings: Settings, roles?: Roles) =>
	file(
		Object.entries(settings).map(([kind, setting]) => ({ kind, ...setting })),
		roles
	);
/** The starter's checks with these settings, and any other check given settings. */
const starter = (settings: Settings = {}, roles?: Roles) =>
	file(
		[
			...STARTER_CHECKS.map((kind) => ({ kind, ...settings[kind] })),
			...Object.entries(settings)
				.filter(([kind]) => !STARTER_CHECKS.some((check) => check === kind))
				.map(([kind, setting]) => ({ kind, ...setting }))
		],
		roles
	);
const harbour = "A fairly long sentence about the harbour";
describe("built-in check settings", () => {
	it("resolves every check's own parameter schema and defaults", () => {
		for (const id of BuiltInCheckId.literals.filter((id) => id !== "segment_separator")) {
			const resolved = resolveLocalizationChecks(
				only({ [id]: { severity: "low", params: {} } })
			);
			expect(resolved[id].params).toEqual(localizationCheckDefaults[id]);
			expect(resolved[id].severity).toBe("low");
		}
	});
	it("reports added tags with their own policy when a sibling is disabled or ignores them", () => {
		const source = "<b>Source</>",
			translation = "<i>Übersetzung</>";
		const checks = {
			rich_text_tags: { enabled: false, params: { optionalTags: ["i"] } },
			rich_text_tags_added: { enabled: true }
		};
		const added = german(line(source, translation, only(checks)));
		expect(added).toMatchObject([{ kind: "rich_text_tags_added", actual: { added: ["i"] } }]);
		expect(added).toHaveLength(1);
		const independent = german(
			line(
				source,
				translation,
				only({
					...checks,
					rich_text_tags: { enabled: true, params: { optionalTags: ["i"] } }
				})
			)
		);
		expect(independent.map((f) => f.kind)).toEqual(["rich_text_tags", "rich_text_tags_added"]);
		expect(independent.find((f) => f.kind === "rich_text_tags_added")?.actual).toMatchObject({
			added: ["i"]
		});
		const shared = only({ rich_text_tags: {}, rich_text_tags_added: {} });
		expect(kinds(line(source, translation, shared))).toEqual(["rich_text_tags"]);
		expect(
			kinds(line(source, translation, shared, { disabledChecks: ["rich_text_tags"] }))
		).toEqual(["rich_text_tags_added"]);
		expect(
			kinds(line(source, translation, starter({ rich_text_tags: { enabled: false } })))
		).toContain("rich_text_tags_added");
	});
	it("reports argument differences when the rename check is disabled", () => {
		const source = "Hello {Old}",
			translation = "Hallo {New}";
		const enabled = only({ format_arguments: {}, format_argument_renamed: {} });
		expect(kinds(line(source, translation, enabled))).toEqual(["format_argument_renamed"]);
		const disabled = only({
			format_arguments: {},
			format_argument_renamed: { enabled: false }
		});
		const findings = german(line(source, translation, disabled));
		expect(findings).toMatchObject([
			{ kind: "format_arguments", actual: { missing: ["Old"], added: ["New"] } }
		]);
		expect(findings).toHaveLength(1);
		expect(
			kinds(
				line(source, translation, enabled, { disabledChecks: ["format_argument_renamed"] })
			)
		).toEqual(["format_arguments"]);
		{
			const legacy = starter({ format_argument_renamed: { enabled: false } });
			expect(german(line(source, translation, legacy))).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "format_arguments",
						actual: expect.objectContaining({ missing: ["Old"], added: ["New"] })
					})
				])
			);
		}
	});
	it("decodes check settings and validates scopes and parameters", () => {
		const document = only({ length_outlier: { severity: "low", params: { maximumRatio: 4 } } });
		expect(document.schemaVersion).toBe(1);
		const resolved = resolveLocalizationChecks(document);
		expect(resolved.length_outlier).toEqual({
			enabled: true,
			severity: "low",
			params: { ...localizationCheckDefaults.length_outlier, maximumRatio: 4 }
		});
		expect(resolved.format_arguments).toMatchObject({ enabled: false, severity: "normal" });
		const failure = (rules: string, fields?: string) => {
			const result = decode(rules, fields);
			return result._tag === "Failure" ? result.failure.code : undefined;
		};
		expect(failure(`{"kind":"length_outlier","scope":{"roles":["ui"]}}`)).toBe(
			"unknown_role_id"
		);
		expect(failure(`{"kind":"length_outlier","params":{"minimumRatio":-1}}`)).toBe(
			"invalid_structure"
		);
		// Unknown keys are rejected: a misspelt parameter or check is not ignored.
		expect(failure(`{"kind":"length_outlier","params":{"ratio":2}}`)).toBe("invalid_structure");
		expect(failure(`{"kind":"no_such_check"}`)).toBe("invalid_structure");
		expect(failure("", `"segmentSeparator":"//"`)).toBe("invalid_structure");
		expect(failure("")).toBeUndefined();
	});
	it("applies enabled, severity and parameters, and runs nothing without a file", () => {
		expect(kinds(line(harbour, "Hafen  "))).toEqual([]);
		expect(kinds(line(harbour, "Hafen", starter()))).toContain("length_outlier");
		const low = line(harbour, "Hafen", starter({ length_outlier: { severity: "low" } }));
		expect(german(low).find((finding) => finding.kind === "length_outlier")?.severity).toBe(
			"low"
		);
		expect(
			kinds(line(harbour, "Hafen", starter({ length_outlier: { enabled: false } })))
		).not.toContain("length_outlier");
		expect(
			kinds(
				line(
					harbour,
					"Hafen",
					starter({ length_outlier: { params: { minimumRatio: 0.1 } } })
				)
			)
		).not.toContain("length_outlier");
		// A file runs only what it lists.
		expect(kinds(line(harbour, "Hafen  ", only({ length_outlier: {} })))).toEqual([
			"length_outlier"
		]);
		expect(kinds(line(harbour, "Hafen  ", starter()))).toContain("whitespace");
		// The host's selection still narrows what runs.
		expect(
			kinds(line(harbour, "Hafen", starter(), { disabledChecks: ["length_outlier"] }))
		).not.toContain("length_outlier");
		// The separator check runs once it has a separator.
		const separated = "First part of it//second part of it";
		expect(kinds(line(separated, "Erster Teil zweiter Teil", starter()))).not.toContain(
			"segment_separator"
		);
		expect(
			kinds(
				line(
					separated,
					"Erster Teil zweiter Teil",
					starter({ segment_separator: { params: { separator: "//" } } })
				)
			)
		).toContain("segment_separator");
		expect(
			kinds(
				line(
					"Something to say about it",
					"Translation that only has TBD",
					starter({ placeholder_text: { params: { markers: [], phrases: [] } } })
				)
			)
		).not.toContain("placeholder_text");
	});
	it("applies a check's scope after its finding, by culture, role and object path", () => {
		const roles = [
			{
				id: "ui",
				scopes: [
					{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/UI/" }] }
				]
			}
		] as const;
		const outlier = (checks: Settings, objectPath = "/Game/Text/Asset.Asset") => {
			const text = corpus([
				{
					...unit("K", harbour),
					occurrences: unit("K", harbour).occurrences.map((occurrence) => ({
						...occurrence,
						location: { ...occurrence.location, objectPath }
					}))
				}
			]);
			const files = evidence(
				[manifestEntry("K", harbour)],
				[archiveEntry("K", harbour, "Hafen")],
				noPO()
			);
			return kinds(indexedTestReports(text, files).localization(starter(checks, roles), {}));
		};
		expect(outlier({ length_outlier: { scope: { cultures: ["de"] } } })).toContain(
			"length_outlier"
		);
		expect(outlier({ length_outlier: { scope: { cultures: ["fr"] } } })).not.toContain(
			"length_outlier"
		);
		expect(outlier({ length_outlier: { scope: { roles: ["ui"] } } })).not.toContain(
			"length_outlier"
		);
		expect(
			outlier({ length_outlier: { scope: { roles: ["ui"] } } }, "/Game/UI/Menu.Menu")
		).toContain("length_outlier");
		expect(outlier({ length_outlier: { scope: { pathPrefixes: ["/Game/Text/"] } } })).toContain(
			"length_outlier"
		);
		expect(
			outlier({ length_outlier: { scope: { pathPrefixes: ["/Game/UI/"] } } })
		).not.toContain("length_outlier");
		// Both dimensions must hold for one saved place.
		expect(
			outlier(
				{ length_outlier: { scope: { roles: ["ui"], pathPrefixes: ["/Game/Text/"] } } },
				"/Game/UI/Menu.Menu"
			)
		).not.toContain("length_outlier");
	});
	it("lets a check report what an out-of-scope check would have taken", () => {
		const elsewhere = { scope: { cultures: ["fr"] } };
		// Added tags are rich_text_tags_added's own finding when rich_text_tags is out of scope.
		const tagged = [
			"<b>Bold</> and <i>more</> text",
			"<i>Fett</> und <u>mehr</> Text"
		] as const;
		expect(kinds(line(...tagged, starter()))).toContain("rich_text_tags");
		expect(kinds(line(...tagged, starter()))).not.toContain("rich_text_tags_added");
		expect(kinds(line(...tagged, starter({ rich_text_tags: elsewhere })))).toContain(
			"rich_text_tags_added"
		);
		// A rename is two format_arguments differences when format_argument_renamed is out of scope.
		const renamed = ["Hello {Name}, welcome", "Hallo {Nom}, willkommen"] as const;
		const actual = (value: LocalizationQualityReport) =>
			german(value).find((finding) => finding.kind === "format_arguments")?.actual;
		expect(actual(line(...renamed, starter()))).toBeUndefined();
		expect(
			actual(line(...renamed, starter({ format_argument_renamed: elsewhere })))
		).toMatchObject({ missing: ["Name"], added: ["Nom"] });
	});
});
