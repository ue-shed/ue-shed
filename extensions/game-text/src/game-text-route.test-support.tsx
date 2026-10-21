import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { textQualityQuery } from "@ue-shed/game-text/corpus";
import { evaluateGameTextSourceQuality } from "@ue-shed/game-text/rules";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	TextQualityRuleDocument,
	TextQualityRuleId,
	TextRoleId,
	type TextCorpus
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import { type GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute, type GameTextPreferences } from "./game-text-query-route.js";
export const corpus: TextCorpus = {
	coverage: {
		discoveredPackages: 2,
		failedPackages: 0,
		inspectedPackages: 2,
		partialPackages: 0,
		resolvedOccurrences: 2,
		textOccurrences: 2,
		textUnits: 2,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1,
	status: "complete",
	units: [
		{
			id: makeTextUnitId("unreal:UI:Continue"),
			identity: { key: "Continue", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					devNotes: "",
					editCapability: "source_editable",
					id: makeTextOccurrenceId("occurrence:continue"),
					identity: { key: "Continue", namespace: "UI", status: "resolved" },
					location: {
						entryKey: "PromptContinue",
						kind: "string_table_entry",
						objectPath: "/Game/Text/ST_Game.ST_Game"
					},
					packageFile: "Content/Text/ST_Game.uasset",
					source: "Continue"
				}
			],
			source: { status: "consistent", value: "Continue" }
		},
		{
			id: makeTextUnitId("unreal:UI:Quit"),
			identity: { key: "Quit", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					devNotes: "",
					editCapability: "read_only",
					id: makeTextOccurrenceId("occurrence:quit"),
					identity: { key: "Quit", namespace: "UI", status: "resolved" },
					location: {
						kind: "data_table_cell",
						objectPath: "/Game/Text/DT_Menu.DT_Menu",
						propertyPath: "Prompt",
						row: "Quit"
					},
					packageFile: "Content/Text/DT_Menu.uasset",
					source: "Quit game?"
				}
			],
			source: { status: "consistent", value: "Quit game?" }
		}
	]
};
export const rulesDocument = TextQualityRuleDocument.make({
	schemaVersion: 1,
	roles: [
		{
			id: TextRoleId.make("all-game"),
			scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }]
		},
		{
			id: TextRoleId.make("empty-role"),
			scopes: [
				{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/NoText/" }] }
			]
		}
	],
	rules: [
		{
			id: TextQualityRuleId.make("example-limit"),
			kind: "character_budget",
			role: TextRoleId.make("all-game"),
			maximumCharacters: 4,
			recovery: "Shorten this example line."
		},
		{
			id: TextQualityRuleId.make("example-terms"),
			kind: "terminology",
			role: TextRoleId.make("all-game"),
			caseSensitive: false,
			terms: [{ kind: "preferred", term: "Exit", alternatives: ["Quit"] }],
			recovery: "Use the preferred example term."
		}
	]
});
export const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear()
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
export function makeClient(
	input: TextCorpus = corpus,
	overrides: Partial<GameTextClientApi> = {}
): GameTextClientApi {
	const query = textCorpusQuery(input, "2026-10-07T16:53:00.000Z");
	let quality = textQualityQuery(evaluateGameTextSourceQuality(input, rulesDocument));
	return {
		loadConfiguredProject: () =>
			Effect.succeed({ status: "completed", summary: query.summary() }),
		progress: () =>
			Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "game_text" }),
		search: (request) => Effect.succeed({ status: "ready", page: query.search(request) }),
		focus: (request) => {
			const focus = query.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		locateAsset: (objectPath) =>
			Effect.succeed({
				contract: {
					name: "unreal-editor-asset-navigation",
					version: { major: 1, minor: 0 }
				},
				objectPath,
				status: "located"
			}),
		chooseQualityRules: () =>
			Effect.succeed({
				status: "completed",
				document: rulesDocument,
				summary: quality.summary()
			}),
		qualitySearch: (request) =>
			Effect.succeed({ status: "ready", page: quality.search(request) }),
		qualityFocus: (request) => {
			const focus = quality.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		previewQualityRules: (draft) => {
			quality = textQualityQuery(evaluateGameTextSourceQuality(input, draft));
			return Effect.succeed({
				status: "completed",
				document: draft,
				summary: quality.summary()
			});
		},
		saveQualityRules: (draft) => {
			quality = textQualityQuery(evaluateGameTextSourceQuality(input, draft));
			return Effect.succeed({
				status: "completed",
				document: draft,
				summary: quality.summary()
			});
		},
		...overrides
	};
}
export function mount(client = makeClient(), preferences?: GameTextPreferences, key?: string) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={client} initialPreferences={preferences} projectKey={key} />
		</EffectRuntimeProvider>
	));
}
export async function chooseFilter(
	user: ReturnType<typeof userEvent.setup>,
	field: string,
	value: string | RegExp
) {
	// Counts and items refresh with each page; open the menu once the search has settled.
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	const filter = screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u });
	await user.click(filter);
	await user.click(await screen.findByRole("menuitem", { name: new RegExp(`^${field}`, "u") }));
	await user.click(
		within(screen.getByRole("menu", { name: field })).getByRole("menuitemcheckbox", {
			name: value
		})
	);
	await user.click(filter);
}
export async function openQuality(user: ReturnType<typeof userEvent.setup>) {
	await screen.findByRole("region", { name: "Results" });
	await user.click(screen.getByRole("tab", { name: "Quality checks" }));
	await user.click(screen.getByRole("button", { name: "Load rules" }));
	return screen.findByRole("region", { name: "Findings" });
}
