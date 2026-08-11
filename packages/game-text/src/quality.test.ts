import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
	decodeTextQualityReport,
	decodeTextQualityRuleDocument,
	decodeTextQualityRuleDocumentJson,
	TextQualityRuleDocumentError
} from "./quality-schema.js";
import { evaluateTextQuality, matchesTextRole } from "./quality.js";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	type TextCorpus,
	type TextOccurrence
} from "./schema.js";

const fixtureRules = fileURLToPath(new URL("../fixtures/quality-rules.v1.json", import.meta.url));

const menuOccurrence: TextOccurrence = {
	editCapability: "source_editable",
	id: makeTextOccurrenceId("occurrence:menu"),
	identity: { key: "MenuConfirm", namespace: "Fixture", status: "resolved" },
	location: {
		kind: "data_table_cell",
		objectPath: "/Game/Fixture/Text/DT_Menu.DT_Menu",
		propertyPath: "Label",
		row: "Confirm"
	},
	packageFile: "Content/Fixture/UI/DT_Menu.uasset",
	source: "Press the old button now"
};

const unrelatedOccurrence: TextOccurrence = {
	editCapability: "read_only",
	id: makeTextOccurrenceId("occurrence:unrelated"),
	identity: { key: "Unrelated", namespace: "Fixture", status: "resolved" },
	location: {
		classPath: "/Script/Fixture.GenericAsset",
		kind: "asset_property",
		objectPath: "/Game/Fixture/World/A_Unrelated.A_Unrelated",
		propertyPath: "Description"
	},
	packageFile: "Content/Fixture/World/A_Unrelated.uasset",
	source: "Old Press Click should stay outside"
};

const corpus: TextCorpus = {
	coverage: {
		discoveredPackages: 3,
		failedPackages: 0,
		inspectedPackages: 3,
		partialPackages: 1,
		resolvedOccurrences: 4,
		textOccurrences: 4,
		textUnits: 3,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 1
	},
	diagnostics: [
		{
			code: "unsupported_text_history",
			message: "Fixture keeps this unsupported evidence visible.",
			objectPath: "/Game/Fixture/UI/A_Partial.A_Partial",
			packageFile: "Content/Fixture/UI/A_Partial.uasset",
			propertyPath: "Nested.Unsupported"
		}
	],
	schemaVersion: 1,
	status: "partial",
	units: [
		{
			id: makeTextUnitId("text:unrelated"),
			identity: unrelatedOccurrence.identity,
			occurrences: [unrelatedOccurrence],
			source: { status: "consistent", value: unrelatedOccurrence.source }
		},
		{
			id: makeTextUnitId("text:menu"),
			identity: menuOccurrence.identity,
			occurrences: [
				menuOccurrence,
				{
					...menuOccurrence,
					editCapability: "read_only",
					id: makeTextOccurrenceId("occurrence:menu-evidence"),
					location: {
						classPath: "/Script/Fixture.GenericAsset",
						kind: "asset_property",
						objectPath: "/Game/Fixture/World/A_MenuEvidence.A_MenuEvidence",
						propertyPath: "Description"
					},
					packageFile: "Content/Fixture/World/A_MenuEvidence.uasset"
				}
			],
			source: { status: "consistent", value: menuOccurrence.source }
		},
		{
			id: makeTextUnitId("text:string-table"),
			identity: { key: "Prompt.Continue", namespace: "Fixture", status: "resolved" },
			occurrences: [
				{
					editCapability: "source_editable",
					id: makeTextOccurrenceId("occurrence:string-table"),
					identity: { key: "Prompt.Continue", namespace: "Fixture", status: "resolved" },
					location: {
						entryKey: "Prompt.Continue",
						kind: "string_table_entry",
						objectPath: "/Game/Fixture/Text/ST_Prompts.ST_Prompts"
					},
					packageFile: "Content/Fixture/UI/ST_Prompts.uasset",
					source: "Click here"
				}
			],
			source: { status: "consistent", value: "Click here" }
		}
	]
};

it.effect(
	"decodes the generic version-1 fixture and emits deterministic explainable findings",
	() =>
		Effect.gen(function* () {
			const json = yield* Effect.promise(() => readFile(fixtureRules, "utf8"));
			const document = yield* decodeTextQualityRuleDocumentJson(json);
			const first = evaluateTextQuality(corpus, document);
			const second = evaluateTextQuality(corpus, document);

			expect(second).toEqual(first);
			expect(first.status).toBe("partial");
			expect(first.coverage).toEqual(corpus.coverage);
			expect(first.diagnostics).toEqual(corpus.diagnostics);
			expect(first.roles).toEqual([
				{ matchedOccurrences: 2, matchedTextUnits: 2, role: "ui.prompt" }
			]);
			expect(first.rules).toEqual([
				{ findingCount: 1, ruleId: "ui.prompt.characters" },
				{ findingCount: 3, ruleId: "ui.prompt.terms" }
			]);
			expect(first.findings).toHaveLength(4);
			expect(first.findings.map((finding) => finding.textUnitId)).not.toContain(
				"text:unrelated"
			);
			expect(first.findings[0]).toMatchObject({
				actual: { characterCount: 24, kind: "character_count" },
				affectedOccurrences: [{ id: "occurrence:menu" }],
				expectation: { kind: "maximum_characters", maximumCharacters: 10 },
				kind: "character_budget",
				role: "ui.prompt",
				ruleId: "ui.prompt.characters",
				textUnitId: "text:menu"
			});
			expect(first.findings.slice(1).map((finding) => finding.actual)).toEqual([
				expect.objectContaining({ kind: "terminology_match", start: 10, term: "old" }),
				expect.objectContaining({ kind: "terminology_match", start: 0, term: "Press" }),
				expect.objectContaining({ kind: "terminology_match", start: 0, term: "Click" })
			]);
			expect(first.findings.slice(1).map((finding) => finding.expectation)).toEqual([
				{ kind: "forbidden_term", term: "old" },
				{ discouragedTerm: "press", kind: "preferred_term", preferredTerm: "select" },
				{ discouragedTerm: "click", kind: "preferred_term", preferredTerm: "select" }
			]);
			yield* decodeTextQualityReport(first);
		})
);

it.effect("returns typed actionable failures without echoing authored rule contents", () =>
	Effect.gen(function* () {
		const invalidJson = yield* decodeTextQualityRuleDocumentJson("{secret-authored-term").pipe(
			Effect.flip
		);
		expect(invalidJson).toBeInstanceOf(TextQualityRuleDocumentError);
		expect(invalidJson.code).toBe("invalid_json");
		expect(invalidJson.recovery).toContain("JSON syntax");
		expect(invalidJson.message).not.toContain("secret-authored-term");

		const emptyScope = yield* decodeTextQualityRuleDocument({
			roles: [{ id: "role", scopes: [{ matchers: [] }] }],
			rules: [
				{
					id: "rule",
					kind: "character_budget",
					maximumCharacters: 10,
					recovery: "Shorten it.",
					role: "role"
				}
			],
			schemaVersion: 1
		}).pipe(Effect.flip);
		expect(emptyScope.code).toBe("invalid_structure");
		expect(emptyScope.recovery).toContain("non-empty");

		const emptyEvidence = yield* decodeTextQualityRuleDocument({
			roles: [
				{
					id: "role",
					scopes: [
						{
							matchers: [{ kind: "object_path", operator: "prefix", value: "   " }]
						}
					]
				}
			],
			rules: [
				{
					id: "rule",
					kind: "terminology",
					caseSensitive: false,
					recovery: "Use approved terminology.",
					role: "role",
					terms: [{ kind: "forbidden", term: "   " }]
				}
			],
			schemaVersion: 1
		}).pipe(Effect.flip);
		expect(emptyEvidence.code).toBe("invalid_structure");

		const unknownRole = yield* decodeTextQualityRuleDocument({
			roles: [
				{
					id: "declared",
					scopes: [{ matchers: [{ kind: "location_kind", value: "data_table_cell" }] }]
				}
			],
			rules: [
				{
					id: "rule",
					kind: "character_budget",
					maximumCharacters: 10,
					recovery: "Shorten it.",
					role: "secret-role-name"
				}
			],
			schemaVersion: 1
		}).pipe(Effect.flip);
		expect(unknownRole.code).toBe("unknown_role_id");
		expect(unknownRole.message).not.toContain("secret-role-name");
	})
);

it.effect("rejects duplicate IDs and never constructs an implicit whole-project role", () =>
	Effect.gen(function* () {
		const duplicate = yield* decodeTextQualityRuleDocument({
			roles: [
				{
					id: "same",
					scopes: [{ matchers: [{ kind: "location_kind", value: "data_table_cell" }] }]
				},
				{
					id: "same",
					scopes: [{ matchers: [{ kind: "location_kind", value: "asset_property" }] }]
				}
			],
			rules: [
				{
					id: "rule",
					kind: "character_budget",
					maximumCharacters: 10,
					recovery: "Shorten it.",
					role: "same"
				}
			],
			schemaVersion: 1
		}).pipe(Effect.flip);
		expect(duplicate.code).toBe("duplicate_role_id");

		const duplicateRules = yield* decodeTextQualityRuleDocument({
			roles: [
				{
					id: "role",
					scopes: [{ matchers: [{ kind: "location_kind", value: "data_table_cell" }] }]
				}
			],
			rules: [10, 20].map((maximumCharacters) => ({
				id: "same-rule",
				kind: "character_budget",
				maximumCharacters,
				recovery: "Shorten it.",
				role: "role"
			})),
			schemaVersion: 1
		}).pipe(Effect.flip);
		expect(duplicateRules.code).toBe("duplicate_rule_id");

		const json = yield* Effect.promise(() => readFile(fixtureRules, "utf8"));
		const document = yield* decodeTextQualityRuleDocumentJson(json);
		const role = document.roles.at(0);
		expect(role).toBeDefined();
		if (role === undefined) return;
		expect(matchesTextRole(menuOccurrence, role)).toBe(true);
		expect(matchesTextRole(unrelatedOccurrence, role)).toBe(false);
	})
);
