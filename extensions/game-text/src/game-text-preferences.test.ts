// @vitest-environment jsdom
import { LocalizationEdit } from "@ue-shed/game-text/corpus";
import { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { LocalizationSelection, TextQualityRuleId, TextRoleId } from "@ue-shed/game-text/schema";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeGameTextPreferences,
	saveGameTextPreferences,
	storedGameTextPreferences,
	writeGameTextPreferences,
	type GameTextPreferences
} from "./game-text-preferences.js";

const rules = GameTextRuleDocument.make({
	schemaVersion: 1,
	roles: [
		{
			id: TextRoleId.make("all-game"),
			scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }]
		}
	],
	rules: [
		{
			id: TextQualityRuleId.make("example-limit"),
			kind: "character_budget",
			role: TextRoleId.make("all-game"),
			maximumCharacters: 4,
			recovery: "Shorten this example line."
		}
	]
});
const target = LocalizationSelection.fields.target.make("Game");
const edit = Schema.decodeUnknownSync(LocalizationEdit)({
	culture: "fr",
	namespace: "UI",
	key: "Continue",
	seenTranslation: null,
	translation: "Continuer"
});
const base: GameTextPreferences = {
	query: "Continue",
	capability: "all",
	lens: "all",
	selectedId: undefined
};

let values: Map<string, string>;
beforeEach(() => {
	values = new Map();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear()
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("Game Text preferences", () => {
	it("stores an unedited rules document once and restores the editor from it", () => {
		expect(
			writeGameTextPreferences("p", {
				...base,
				qualityDocument: rules,
				qualityEditor: { draft: rules, savedDocument: rules }
			})
		).toBe("saved");
		const stored = [...values.values()].join("");
		expect(stored.split('"example-limit"')).toHaveLength(2);
		expect(storedGameTextPreferences("p").qualityEditor).toEqual({
			draft: rules,
			savedDocument: rules
		});
	});

	it("keeps an edited draft beside the applied document", () => {
		const draft = {
			...rules,
			rules: rules.rules.map((rule) =>
				rule.kind === "character_budget" ? { ...rule, maximumCharacters: 0 } : rule
			)
		};
		writeGameTextPreferences("p", {
			...base,
			qualityDocument: rules,
			qualityEditor: { draft, savedDocument: rules }
		});
		expect(storedGameTextPreferences("p").qualityEditor).toEqual({
			draft,
			savedDocument: rules
		});
	});

	it("writes the view alone and drops an older copy of drafts that no longer fit", () => {
		const session = (translation: string) => ({
			staged: [],
			drafts: [{ target, edit: { ...edit, translation }, source: "Continue" }]
		});
		writeGameTextPreferences("p", { ...base, editSession: session("Old draft") });
		expect(storedGameTextPreferences("p").editSession?.drafts).toHaveLength(1);
		const huge = Array.from({ length: 40 }, (_, index) => ({
			target,
			edit: {
				...edit,
				key: LocalizationEdit.fields.key.make(`K${index}`),
				translation: "x".repeat(60_000)
			},
			source: "Continue"
		}));
		expect(
			writeGameTextPreferences("p", {
				...base,
				query: "Newer",
				editSession: { staged: [], drafts: huge }
			})
		).toBe("drafts_not_saved");
		const restored = storedGameTextPreferences("p");
		expect(restored.query).toBe("Newer");
		expect(restored.editSession).toBeUndefined();
	});

	it("keeps at most the hundred most recent drafts", () => {
		const drafts = Array.from({ length: 120 }, (_, index) => ({
			target,
			edit: { ...edit, key: LocalizationEdit.fields.key.make(`K${index}`) },
			source: "Continue"
		}));
		writeGameTextPreferences("p", { ...base, editSession: { staged: [], drafts } });
		const kept = storedGameTextPreferences("p").editSession?.drafts ?? [];
		expect(kept).toHaveLength(100);
		expect(kept[0]?.edit.key).toBe("K20");
	});

	it("drops only the field that no longer decodes", () => {
		expect(
			decodeGameTextPreferences(
				JSON.stringify({ query: "Kept", lens: "not-a-lens", group: "folder" })
			)
		).toMatchObject({ query: "Kept", lens: "all", group: "folder" });
	});

	it("reads work saved by versions that stored the view and its drafts together", () => {
		values.set(
			"ue-shed:game-text:p",
			JSON.stringify({
				...base,
				editSession: { staged: [{ target, edit, source: "Continue" }], drafts: [] }
			})
		);
		expect(storedGameTextPreferences("p").editSession?.staged).toHaveLength(1);
	});
});

it("recovers a 65,537-character typed translation alongside staged edits and incomplete rules", async () => {
	const edit = LocalizationEdit.make({
		culture: LocalizationEdit.fields.culture.make("fr"),
		namespace: LocalizationEdit.fields.namespace.make("UI"),
		key: LocalizationEdit.fields.key.make("K"),
		seenTranslation: null,
		translation: "Valid staged edit"
	});
	const target = LocalizationSelection.fields.target.make("Game");
	const incomplete = {
		...rules,
		rules: rules.rules.map((rule) =>
			rule.kind === "character_budget" ? { ...rule, maximumCharacters: 0 } : rule
		)
	};
	const preferences: GameTextPreferences = {
		query: "Retained query",
		capability: "all",
		lens: "all",
		selectedId: undefined,
		qualityDocument: rules,
		qualityEditor: { draft: incomplete, savedDocument: rules },
		editSession: {
			staged: [{ target, edit, source: "Source" }],
			drafts: [
				{
					target,
					edit: {
						...edit,
						key: LocalizationEdit.fields.key.make("Long"),
						translation: "x".repeat(65_537)
					},
					source: "Other source"
				}
			]
		}
	};
	expect(await Effect.runPromise(saveGameTextPreferences("long-draft", preferences))).toBe(
		"saved"
	);
	const recovered = storedGameTextPreferences("long-draft");
	expect(recovered.query).toBe("Retained query");
	expect(recovered.editSession?.drafts[0]?.edit.translation).toHaveLength(65_537);
	expect(recovered.editSession?.staged[0]?.edit.translation).toBe("Valid staged edit");
	expect(recovered.qualityEditor?.draft.rules[0]).toMatchObject({ maximumCharacters: 0 });
});
