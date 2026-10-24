import { Schema } from "effect";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { localizationCheckCatalogue } from "./localization-check-catalogue.js";
import { BuiltInCheckId } from "./localization-check-ids.js";
import { TextQualityRuleId, TextRoleId } from "./quality-schema.js";

/**
 * Default project-relative starter-policy location. Hosts may choose another rules file; this
 * location is a composition default rather than an Unreal requirement.
 */
export const GAME_TEXT_RULES_RELATIVE_PATH = "Config/UEShed/GameTextRules.json";

/**
 * The checks a starter file runs: every built-in check but the opt-in ones, and
 * `segment_separator`, which needs the project's separator.
 */
export const STARTER_CHECKS: readonly BuiltInCheckId[] = BuiltInCheckId.literals.filter(
	(id) => !localizationCheckCatalogue[id].optIn && id !== "segment_separator"
);

/** A rules file that runs the starter's checks with their catalogue settings, and nothing else. */
export const STARTER_CHECK_RULES: GameTextRuleDocument = Schema.decodeUnknownSync(
	GameTextRuleDocument
)({ schemaVersion: 1, roles: [], rules: STARTER_CHECKS.map((kind) => ({ kind })) });

/** The starter's checks, and examples to replace with a project's own scopes, budgets and vocabulary. */
export const STARTER_GAME_TEXT_RULES: GameTextRuleDocument = {
	schemaVersion: 1,
	roles: [
		{
			id: TextRoleId.make("example-display-name"),
			description: "Example: Data table DisplayName cells. Replace with your own scope.",
			scopes: [
				{
					matchers: [
						{ kind: "location_kind", value: "data_table_cell" },
						{ kind: "property_path", operator: "exact", value: "DisplayName" }
					]
				}
			]
		},
		{
			id: TextRoleId.make("example-game-text"),
			description: "Example: saved text under /Game/. Replace with your own scope.",
			scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }]
		}
	],
	rules: [
		...STARTER_CHECK_RULES.rules,
		{
			id: TextQualityRuleId.make("example-name-limit"),
			kind: "character_budget",
			role: TextRoleId.make("example-display-name"),
			maximumCharacters: 32,
			recovery: "Example: shorten the display name, or set a budget appropriate for your UI."
		},
		{
			id: TextQualityRuleId.make("example-terminology"),
			kind: "terminology",
			role: TextRoleId.make("example-game-text"),
			caseSensitive: false,
			terms: [
				{ kind: "preferred", term: "entry", alternatives: ["row"] },
				{ kind: "forbidden", term: "placeholder" }
			],
			recovery:
				"Example: use entry instead of row and replace placeholder with finished text. Customize these example terms."
		}
	]
};
