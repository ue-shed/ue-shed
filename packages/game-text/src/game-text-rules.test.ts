import { indexedTestReports } from "./indexed-reports.test-support.js";
import { Effect, Schema } from "effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import {
	GameTextRuleDocument,
	GameTextRuleOverlay,
	applyRuleOverlay,
	decodeGameTextRuleDocument,
	decodeGameTextRuleDocumentJson,
	resolveLocalizationChecks
} from "./game-text-rules.js";
import { localizationCheckDefaults } from "./localization-check-catalogue.js";
import { BuiltInCheckId } from "./localization-check-ids.js";
import { STARTER_CHECKS, STARTER_GAME_TEXT_RULES } from "./starter-rules.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	unit
} from "./localization.test-support.js";
import { LocalizationQualityReport } from "./localization-quality-schema.js";

const menu = {
	id: "menu",
	scopes: [{ matchers: [{ kind: "location_kind", value: "string_table_entry" }] }]
};
const authored = {
	schemaVersion: 1,
	roles: [menu],
	rules: [
		// Every starter check but the notes, which therefore don't run.
		...STARTER_CHECKS.filter((id) => id !== "missing_translator_notes").map((kind) => ({
			kind
		})),
		{
			kind: "localization_character_budget",
			id: "menu.budget",
			role: "menu",
			cultures: { de: 4, ja: 5 },
			defaultMaximumCharacters: 6,
			recovery: "Shorten this translation."
		},
		{
			kind: "localization_terminology",
			id: "menu.terms",
			role: "menu",
			cultures: {
				de: [
					{ kind: "forbidden", term: "ALT" },
					{ kind: "preferred", term: "Neu", alternatives: ["alt"] }
				]
			},
			caseSensitive: false,
			recovery: "Use the authored glossary."
		}
	]
};
const decodeFailure = <Input>(input: Input) =>
	decodeGameTextRuleDocument(input).pipe(
		Effect.flip,
		Effect.map((error) => error.code)
	);

it.effect("decodes the starter file, which runs its example source rules", () =>
	Effect.gen(function* () {
		const starter = yield* decodeGameTextRuleDocumentJson(
			JSON.stringify(STARTER_GAME_TEXT_RULES)
		);
		expect(starter).toEqual(STARTER_GAME_TEXT_RULES);
		const report = indexedTestReports(corpus()).source(starter);
		expect(report.ruleDocumentVersion).toBe(1);
		expect(report.rules.map((rule) => rule.ruleId)).toEqual([
			"example-name-limit",
			"example-terminology"
		]);
	})
);
it.effect("rejects malformed JSON with safe syntax recovery", () =>
	Effect.gen(function* () {
		const error = yield* decodeGameTextRuleDocumentJson("{secret-project-term").pipe(
			Effect.flip
		);
		expect(error._tag).toBe("GameTextRuleDocumentError");
		expect(error.code).toBe("invalid_json");
		expect(error.message).toContain("not valid JSON");
		expect(error.recovery).toContain("Correct the JSON syntax");
		expect(`${error.message} ${error.recovery}`).not.toContain("secret-project-term");
	})
);
it.effect("runs source rules beside localization rules", () =>
	Effect.gen(function* () {
		const document = yield* decodeGameTextRuleDocumentJson(
			JSON.stringify({
				...authored,
				rules: [
					...authored.rules,
					{
						kind: "character_budget",
						id: "source.budget",
						role: "menu",
						maximumCharacters: 3,
						recovery: "Shorten the source."
					}
				]
			})
		);
		const report = indexedTestReports(corpus()).source(document);
		expect(report.ruleDocumentVersion).toBe(1);
		expect(report.findings).toMatchObject([
			{ kind: "character_budget", actual: { source: "Source", characterCount: 6 } }
		]);
	})
);
it.effect(
	"validates localization rules, checks pending PO text, and warns about project-wide cultures",
	() =>
		Effect.gen(function* () {
			const document = yield* decodeGameTextRuleDocumentJson(JSON.stringify(authored));
			const text = corpus([unit("K", "Source")]);
			const files = evidence(
				[manifestEntry()],
				[archiveEntry("K", "Source", "OK")],
				poDocument("😀 ALT alt")
			);
			const report = indexedTestReports(text, files).localization(document, {});
			expect(report.ruleDocumentVersion).toBe(1);
			expect(report.ruleDiagnostics).toMatchObject([
				{ severity: "warning", culture: "ja", code: "rule_culture_not_in_target" }
			]);
			const budgets = report.findings.filter(
				(finding) => finding.kind === "localization_character_budget"
			);
			expect(budgets.map((finding) => finding.culture)).toEqual(["de", "en"]);
			expect(budgets.every((finding) => finding.translationOrigin === "po")).toBe(true);
			const terms = report.findings.filter(
				(finding) => finding.kind === "localization_terminology"
			);
			expect(
				terms.map((finding) => [finding.culture, finding.actual.start, finding.actual.end])
			).toEqual([
				["de", 3, 6],
				["de", 3, 6],
				["de", 7, 10],
				["de", 7, 10]
			]);
			expect(
				report.findings.some((finding) => finding.kind === "missing_translator_notes")
			).toBe(false);
			expect(
				Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationQualityReport))(
					JSON.stringify(report)
				)
			).toEqual(report);
			expect(report.coverage).toEqual(text.coverage);
		})
);
it.effect(
	"fails duplicate culture keys before JSON can discard them, invalid terms, budgets and roles",
	() =>
		Effect.gen(function* () {
			const json = JSON.stringify(authored);
			for (const input of [
				json.replace('"de":4', '"de":4,"\\u0064e":5'),
				json.replace('"de":4', '"de":0'),
				json.replace('"term":"ALT"', '"term":" "'),
				json.replace('"role":"menu"', '"role":"missing"')
			]) {
				const result = yield* decodeGameTextRuleDocumentJson(input).pipe(Effect.result);
				expect(result._tag).toBe("Failure");
			}
			const result = yield* decodeGameTextRuleDocumentJson(
				json.replace('"de":4', '"de":4,"de":5')
			).pipe(Effect.result);
			if (result._tag !== "Failure") throw new Error("Duplicate cultures were accepted.");
			expect(result.failure.code).toBe("duplicate_culture_key");
		})
);
it("omits unlisted culture policies without a default and preserves case-sensitive offsets", () => {
	const document = Schema.decodeUnknownSync(Schema.fromJsonString(GameTextRuleDocument))(
		JSON.stringify(authored)
			.replace(',"defaultMaximumCharacters":6', "")
			.replace('"caseSensitive":false', '"caseSensitive":true')
	);
	const text = corpus(),
		files = evidence(
			[manifestEntry()],
			[archiveEntry("K", "Source", "😀 ALT")],
			poDocument("😀 ALT")
		);
	const report = indexedTestReports(text, files).localization(document, {});
	expect(
		report.findings
			.filter((finding) => finding.kind === "localization_character_budget")
			.map((finding) => finding.culture)
	).toEqual([cultureCode("de")]);
	expect(
		report.findings
			.filter((finding) => finding.kind === "localization_terminology")
			.map((finding) => finding.actual)
	).toEqual([
		{ kind: "terminology_match", translation: "😀 ALT", term: "ALT", start: 3, end: 6 }
	]);
});

describe("the rules file", () => {
	it.effect("decodes each built-in check with its own parameters", () =>
		Effect.gen(function* () {
			const document = yield* decodeGameTextRuleDocument({
				schemaVersion: 1,
				roles: [],
				rules: BuiltInCheckId.literals.map((kind) =>
					kind === "segment_separator"
						? { kind, params: { separator: "//" } }
						: { kind, params: {} }
				)
			});
			const resolved = resolveLocalizationChecks(document);
			for (const id of BuiltInCheckId.literals) {
				expect(resolved[id].enabled).toBe(true);
				expect(resolved[id].params).toEqual(
					id === "segment_separator" ? { separator: "//" } : localizationCheckDefaults[id]
				);
			}
			// A parameter of another check is an unknown key.
			expect(
				yield* decodeFailure({
					schemaVersion: 1,
					roles: [],
					rules: [{ kind: "length_outlier", params: { separator: "//" } }]
				})
			).toBe("invalid_structure");
		})
	);
	it.effect("runs only what it lists, and nothing without a file", () =>
		Effect.gen(function* () {
			expect(
				BuiltInCheckId.literals.filter(
					(id) => resolveLocalizationChecks(undefined)[id].enabled
				)
			).toEqual([]);
			const resolved = resolveLocalizationChecks(
				yield* decodeGameTextRuleDocument({
					schemaVersion: 1,
					roles: [],
					rules: [
						{ kind: "long", severity: "normal", params: { limit: 12 } },
						{ kind: "whitespace", enabled: false }
					]
				})
			);
			expect(BuiltInCheckId.literals.filter((id) => resolved[id].enabled)).toEqual(["long"]);
			expect(resolved.long).toEqual({
				enabled: true,
				severity: "normal",
				params: { limit: 12 }
			});
			expect(resolved.whitespace.severity).toBe("normal");
		})
	);
	it.effect("rejects unknown kinds and keys, reused IDs, and IDs that pass for a check's", () =>
		Effect.gen(function* () {
			const file = (rules: readonly object[], roles: readonly object[] = [menu]) => ({
				schemaVersion: 1,
				roles,
				rules
			});
			const budget = (id: string) => ({
				kind: "character_budget",
				id,
				role: "menu",
				maximumCharacters: 8,
				recovery: "Shorten it."
			});
			expect(yield* decodeFailure(file([{ kind: "no_such_check" }]))).toBe(
				"invalid_structure"
			);
			expect(yield* decodeFailure(file([{ kind: "whitespace", note: "x" }]))).toBe(
				"invalid_structure"
			);
			expect(yield* decodeFailure({ ...file([]), preset: "default" })).toBe(
				"invalid_structure"
			);
			expect(
				yield* decodeFailure(file([{ kind: "whitespace" }, { kind: "whitespace" }]))
			).toBe("duplicate_rule_id");
			expect(yield* decodeFailure(file([budget("a"), budget("a")]))).toBe(
				"duplicate_rule_id"
			);
			expect(yield* decodeFailure(file([budget("whitespace")]))).toBe("invalid_structure");
			expect(yield* decodeFailure(file([budget("localization.mine")]))).toBe(
				"invalid_structure"
			);
			expect(yield* decodeFailure(file([{ kind: "segment_separator" }]))).toBe(
				"invalid_structure"
			);
			expect(
				yield* decodeFailure(file([{ kind: "whitespace", scope: { roles: ["missing"] } }]))
			).toBe("unknown_role_id");
			expect(
				yield* decodeFailure(
					file(
						[menu, menu].map(() => budget("a")),
						[menu, menu]
					)
				)
			).toBe("duplicate_role_id");
			// Turned off, the separator check needs no separator.
			yield* decodeGameTextRuleDocument(
				file([{ kind: "segment_separator", enabled: false }])
			);
		})
	);
});

describe("applyRuleOverlay", () => {
	const overlay = Schema.decodeUnknownSync(GameTextRuleOverlay);
	const project = Schema.decodeUnknownSync(GameTextRuleDocument)({
		schemaVersion: 1,
		roles: [menu],
		rules: [
			{ kind: "length_outlier", severity: "low", scope: { cultures: ["de"] } },
			{ kind: "placeholder_text", params: { markers: ["TODO"] } },
			{
				kind: "character_budget",
				id: "menu.limit",
				role: "menu",
				maximumCharacters: 8,
				recovery: "Shorten it."
			}
		]
	});
	it.effect("patches listed rules and adds rules and roles after the project's", () =>
		Effect.gen(function* () {
			const patched = yield* applyRuleOverlay(
				project,
				overlay({
					schemaVersion: 1,
					roles: [{ id: "hud", scopes: menu.scopes }],
					patches: [
						{ id: "length_outlier", enabled: false, scope: {} },
						{
							id: "placeholder_text",
							severity: "blocking",
							params: { phrases: ["tbd"], markers: ["FIXME"] }
						},
						{
							id: "menu.limit",
							params: { maximumCharacters: 12 },
							scope: { roles: ["hud"] }
						},
						// A later patch to the same rule wins key by key.
						{ id: "placeholder_text", params: { markers: ["WIP"] } }
					],
					rules: [{ kind: "shared" }]
				})
			);
			expect(patched.roles.map((role) => role.id)).toEqual(["menu", "hud"]);
			expect(patched.rules).toEqual([
				{ kind: "length_outlier", severity: "low", enabled: false },
				{
					kind: "placeholder_text",
					severity: "blocking",
					params: { markers: ["WIP"], phrases: ["tbd"] }
				},
				{
					kind: "character_budget",
					id: "menu.limit",
					role: "menu",
					maximumCharacters: 12,
					scope: { roles: ["hud"] },
					recovery: "Shorten it."
				},
				{ kind: "shared" }
			]);
			const unchanged = yield* applyRuleOverlay(project, { schemaVersion: 1 });
			expect(unchanged).toEqual(project);
		})
	);
	it.effect("rejects patches to unlisted rules, reused IDs and patches that break a rule", () =>
		Effect.gen(function* () {
			for (const input of [
				{ patches: [{ id: "whitespace", enabled: false }] },
				{ patches: [{ id: "menu.limit", params: { id: "x" } }] },
				{ patches: [{ id: "menu.limit", params: { maximumCharacters: 0 } }] },
				{ patches: [{ id: "length_outlier", params: { separator: "//" } }] },
				{ rules: [{ kind: "placeholder_text" }] },
				{ roles: [menu] }
			]) {
				const error = yield* applyRuleOverlay(
					project,
					overlay({ schemaVersion: 1, ...input })
				).pipe(Effect.flip);
				expect(error.code).toBe("invalid_overlay");
			}
		})
	);
});
