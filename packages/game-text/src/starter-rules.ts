import { type TextQualityRuleDocument, TextQualityRuleId, TextRoleId } from "./quality-schema.js";

export const GAME_TEXT_RULES_RELATIVE_PATH = "Config/UEShed/GameTextRules.json";

/** Examples to replace with a project's own scopes, budgets and vocabulary. */
export const STARTER_GAME_TEXT_RULES: TextQualityRuleDocument = {
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
