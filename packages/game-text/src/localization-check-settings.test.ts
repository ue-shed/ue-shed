import { nativeLocalizationReport as checkLocalizationTarget } from "./native-rule-reports.test-support.js";

import { Effect, Schema } from "effect";
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

import { localizationCheckDefaults } from "./localization-check-catalogue.js";
import { BuiltInCheckId } from "./localization-check-ids.js";
import type {
	LocalizationCheckOptions,
	LocalizationQualityFinding,
	LocalizationQualityReport
} from "./localization-quality-schema.js";
import { TextQualityRuleDocument } from "./quality-schema.js";
import {
	GameTextRuleDocument,
	TextQualityRuleDocumentV3,
	decodeGameTextRuleDocumentJson,
	migrateGameTextRuleDocument,
	resolveLocalizationChecks
} from "./game-text-rules.js";
import { STARTER_GAME_TEXT_RULES } from "./starter-rules.js";

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
	const joined = joinLocalizationTarget(text, files, files.target);
	return checkLocalizationTarget(text, joined, files, options, rules);
}

const german = (value: LocalizationQualityReport) =>
	value.findings.filter(
		(finding): finding is LocalizationQualityFinding =>
			"culture" in finding && finding.culture === "de"
	);
const kinds = (value: LocalizationQualityReport) => german(value).map((finding) => finding.kind);

type V3Fields = Omit<
	typeof TextQualityRuleDocumentV3.Encoded,
	"schemaVersion" | "roles" | "rules"
> &
	Partial<Pick<typeof TextQualityRuleDocumentV3.Encoded, "roles">>;
type V1Fields = Partial<typeof TextQualityRuleDocument.Encoded>;
/** A version-3 file's JSON with these fields, decoded as a host reads it. */
const decode = (fields: string) =>
	Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(
				`{"schemaVersion":3,"roles":[],"rules":[]${fields ? `,${fields}` : ""}}`
			)
		)
	);
const v3 = (fields: V3Fields) => {
	const result = Effect.runSync(
		Effect.result(
			decodeGameTextRuleDocumentJson(
				JSON.stringify({ schemaVersion: 3, roles: [], rules: [], ...fields })
			)
		)
	);
	if (result._tag === "Failure") throw new Error(result.failure.code);
	return result.success;
};
const v1 = (fields: V1Fields) =>
	Schema.decodeUnknownSync(GameTextRuleDocument)({ ...STARTER_GAME_TEXT_RULES, ...fields });

const harbour = "A fairly long sentence about the harbour";

describe("rule file v3", () => {
	it("resolves every check's own parameter schema and defaults", () => {
		for (const id of BuiltInCheckId.literals) {
			const resolved = resolveLocalizationChecks(
				v3({ checks: { [id]: { severity: "low", params: {} } } })
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
		const added = german(line(source, translation, v3({ preset: "none", checks })));
		expect(added).toMatchObject([{ kind: "rich_text_tags_added", actual: { added: ["i"] } }]);
		expect(added).toHaveLength(1);
		const independent = german(
			line(
				source,
				translation,
				v3({
					preset: "none",
					checks: {
						...checks,
						rich_text_tags: { enabled: true, params: { optionalTags: ["i"] } }
					}
				})
			)
		);
		expect(independent.map((f) => f.kind)).toEqual(["rich_text_tags", "rich_text_tags_added"]);
		expect(independent.find((f) => f.kind === "rich_text_tags_added")?.actual).toMatchObject({
			added: ["i"]
		});
		const shared = v3({
			preset: "none",
			checks: {
				rich_text_tags: { enabled: true },
				rich_text_tags_added: { enabled: true }
			}
		});
		expect(kinds(line(source, translation, shared))).toEqual(["rich_text_tags"]);
		expect(
			kinds(line(source, translation, shared, { disabledChecks: ["rich_text_tags"] }))
		).toEqual(["rich_text_tags_added"]);
		for (const schemaVersion of [1, 2]) {
			const legacy = Schema.decodeUnknownSync(GameTextRuleDocument)({
				...STARTER_GAME_TEXT_RULES,
				schemaVersion,
				disabledLocalizationChecks: ["rich_text_tags"]
			});
			expect(kinds(line(source, translation, legacy))).toContain("rich_text_tags_added");
		}
	});

	it("reports argument differences when the rename check is disabled", () => {
		const source = "Hello {Old}",
			translation = "Hallo {New}";
		const enabled = v3({
			preset: "none",
			checks: {
				format_arguments: { enabled: true },
				format_argument_renamed: { enabled: true }
			}
		});
		expect(kinds(line(source, translation, enabled))).toEqual(["format_argument_renamed"]);
		const disabled = v3({
			preset: "none",
			checks: {
				format_arguments: { enabled: true },
				format_argument_renamed: { enabled: false }
			}
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
		for (const schemaVersion of [1, 2]) {
			const legacy = Schema.decodeUnknownSync(GameTextRuleDocument)({
				...STARTER_GAME_TEXT_RULES,
				schemaVersion,
				disabledLocalizationChecks: ["format_argument_renamed"]
			});
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

	it("decodes a file of check settings alone and validates scopes and parameters", () => {
		const document = v3({
			checks: { length_outlier: { severity: "low", params: { maximumRatio: 4 } } }
		});
		expect(document.schemaVersion).toBe(3);
		const resolved = resolveLocalizationChecks(document);
		expect(resolved.length_outlier).toEqual({
			enabled: true,
			severity: "low",
			params: { ...localizationCheckDefaults.length_outlier, maximumRatio: 4 }
		});
		expect(resolved.format_arguments.severity).toBe("normal");
		const failure = (fields: string) => {
			const result = decode(fields);
			return result._tag === "Failure" ? result.failure.code : undefined;
		};
		expect(failure(`"checks":{"length_outlier":{"scope":{"roles":["ui"]}}}`)).toBe(
			"unknown_role_id"
		);
		expect(failure(`"checks":{"length_outlier":{"params":{"minimumRatio":-1}}}`)).toBe(
			"invalid_structure"
		);
		// Version 3 rejects unknown keys: a misspelt parameter or check is not ignored.
		expect(failure(`"checks":{"length_outlier":{"params":{"ratio":2}}}`)).toBe(
			"invalid_structure"
		);
		expect(failure(`"checks":{"no_such_check":{"enabled":false}}`)).toBe("invalid_structure");
		expect(failure(`"segmentSeparator":"//"`)).toBe("invalid_structure");
		expect(failure("")).toBeUndefined();
	});

	it("applies enabled, preset, severity and parameters", () => {
		expect(kinds(line(harbour, "Hafen"))).toContain("length_outlier");
		const low = line(harbour, "Hafen", v3({ checks: { length_outlier: { severity: "low" } } }));
		expect(german(low).find((finding) => finding.kind === "length_outlier")?.severity).toBe(
			"low"
		);
		expect(
			kinds(line(harbour, "Hafen", v3({ checks: { length_outlier: { enabled: false } } })))
		).not.toContain("length_outlier");
		expect(
			kinds(
				line(
					harbour,
					"Hafen",
					v3({ checks: { length_outlier: { params: { minimumRatio: 0.1 } } } })
				)
			)
		).not.toContain("length_outlier");
		// `none` runs only what the file enables.
		const only = v3({ preset: "none", checks: { length_outlier: { enabled: true } } });
		expect(kinds(line(harbour, "Hafen  ", only))).toEqual(["length_outlier"]);
		expect(kinds(line(harbour, "Hafen  "))).toContain("whitespace");
		// The host's selection still narrows what runs.
		expect(
			kinds(line(harbour, "Hafen", undefined, { disabledChecks: ["length_outlier"] }))
		).not.toContain("length_outlier");
		// The separator check runs once it has a separator.
		const separated = "First part of it//second part of it";
		expect(kinds(line(separated, "Erster Teil zweiter Teil"))).not.toContain(
			"segment_separator"
		);
		expect(
			kinds(
				line(
					separated,
					"Erster Teil zweiter Teil",
					v3({ checks: { segment_separator: { params: { separator: "//" } } } })
				)
			)
		).toContain("segment_separator");
		expect(
			kinds(
				line(
					"Something to say about it",
					"Translation that only has TBD",
					v3({ checks: { placeholder_text: { params: { markers: [], phrases: [] } } } })
				)
			)
		).not.toContain("placeholder_text");
	});

	it("reads v1 and v2 check fields as their v3 settings and migrates them unchanged", () => {
		const legacy = v1({
			disabledLocalizationChecks: ["missing_translator_notes"],
			segmentSeparator: "//",
			optionalTags: ["italic"],
			optionalArguments: ["ParentLabel"]
		});
		const migrated = migrateGameTextRuleDocument(legacy);
		expect(migrated.schemaVersion).toBe(3);
		expect(migrated.checks?.missing_translator_notes).toEqual({ enabled: false });
		expect(migrated.checks?.segment_separator?.params).toEqual({ separator: "//" });
		expect(migrated.checks?.rich_text_tags?.params).toEqual({
			optionalTags: ["italic"],
			optionalArguments: ["ParentLabel"]
		});
		expect(Effect.runSync(decodeGameTextRuleDocumentJson(JSON.stringify(migrated)))).toEqual(
			migrated
		);
		expect(resolveLocalizationChecks(migrated)).toEqual(resolveLocalizationChecks(legacy));
		for (const [source, translation] of [
			["Cookie! Yummy nummy!", "<PlayerName>{ParentLabel}</>, cookie! Yummy nummy!"],
			["<i>Hi</> {BabyNameAuto}", "<italic>Hallo</> {BabyName1} {ParentLabel}"],
			["First part//second part", "Erster Teil zweiter Teil"],
			[harbour, "skip"]
		] as const) {
			const before = line(source, translation, legacy);
			const after = line(source, translation, migrated);
			expect(after.findings).toEqual(before.findings);
			expect(after.rules).toEqual(before.rules);
		}
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
		const outlier = (
			checks: NonNullable<V3Fields["checks"]>,
			objectPath = "/Game/Text/Asset.Asset"
		) => {
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
			const joined = joinLocalizationTarget(text, files, files.target);
			return kinds(checkLocalizationTarget(text, joined, files, {}, v3({ roles, checks })));
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
		expect(kinds(line(...tagged))).toContain("rich_text_tags");
		expect(kinds(line(...tagged))).not.toContain("rich_text_tags_added");
		expect(kinds(line(...tagged, v3({ checks: { rich_text_tags: elsewhere } })))).toContain(
			"rich_text_tags_added"
		);
		// A rename is two format_arguments differences when format_argument_renamed is out of scope.
		const renamed = ["Hello {Name}, welcome", "Hallo {Nom}, willkommen"] as const;
		const actual = (value: LocalizationQualityReport) =>
			german(value).find((finding) => finding.kind === "format_arguments")?.actual;
		expect(actual(line(...renamed))).toBeUndefined();
		expect(
			actual(line(...renamed, v3({ checks: { format_argument_renamed: elsewhere } })))
		).toMatchObject({ missing: ["Name"], added: ["Nom"] });
	});
});
