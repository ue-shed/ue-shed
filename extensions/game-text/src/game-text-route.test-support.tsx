import { indexedTestReports } from "../../../packages/game-text/src/indexed-reports.test-support.js";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { textQualityQuery } from "@ue-shed/game-text/corpus";
import { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	TextQualityRuleId,
	TextRoleId,
	type TextCorpus,
	type TextCorpusFocus,
	type TextCorpusQuerySummary,
	type TextCorpusSearchCounts,
	type TextFacets,
	type TextGroup,
	type TextUnitSearchResult
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import {
	cannedFocus,
	cannedSearch,
	searchRowsFrom,
	type CannedAnswer,
	type CannedRow,
	type CannedWhen
} from "./game-text-canned-search.test-support.js";
import { type GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute, type GameTextPreferences } from "./game-text-query-route.js";

// Quality reports come from the native engine, in one driver process per distinct rule
// document, which can outlast the component suite's 5 s default under CI load.
vi.setConfig({ testTimeout: 20_000 });
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
export const rulesDocument = GameTextRuleDocument.make({
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
/** The Continue line as a search lists it: an editable String Table entry. */
export const continueRow: TextUnitSearchResult = {
	id: makeTextUnitId("unreal:UI:Continue"),
	identity: { key: "Continue", namespace: "UI", status: "resolved" },
	source: { status: "consistent", value: "Continue" },
	contexts: [
		{
			editCapability: "source_editable",
			location: {
				entryKey: "PromptContinue",
				kind: "string_table_entry",
				objectPath: "/Game/Text/ST_Game.ST_Game"
			}
		}
	],
	locationKinds: ["string_table_entry"],
	characterCount: 8,
	wordCount: 1,
	occurrenceCount: 1,
	remainingContextCount: 0,
	reviewSignals: [],
	audience: "player",
	problems: ["up_to_date"]
};
/** The Quit line as a search lists it: a read-only Data Table cell. */
export const quitRow: TextUnitSearchResult = {
	id: makeTextUnitId("unreal:UI:Quit"),
	identity: { key: "Quit", namespace: "UI", status: "resolved" },
	source: { status: "consistent", value: "Quit game?" },
	contexts: [
		{
			editCapability: "read_only",
			location: {
				kind: "data_table_cell",
				objectPath: "/Game/Text/DT_Menu.DT_Menu",
				propertyPath: "Prompt",
				row: "Quit"
			}
		}
	],
	locationKinds: ["data_table_cell"],
	characterCount: 10,
	wordCount: 2,
	occurrenceCount: 1,
	remainingContextCount: 0,
	reviewSignals: ["evidence_only"],
	audience: "player",
	problems: ["up_to_date"]
};
/** A planted row in Content/Text with nothing to do. */
export const upToDate = (unit: TextUnitSearchResult): CannedRow => ({
	unit,
	groups: { problem: "up_to_date", folder: "content/text" }
});
/** A group or facet entry with nothing to do. */
export const quiet = (key: string, label: string, count: number): TextGroup => ({
	key,
	label,
	count,
	needWork: 0,
	worst: "up_to_date"
});
export const counts: TextCorpusSearchCounts = {
	all: 2,
	unresolved: 0,
	conflicting: 0,
	editable: 1,
	readOnly: 1,
	withoutNotes: 2,
	origins: { string_table: 1, data_table: 1, asset: 0, cpp: 0, other_source: 0 }
};
export const facets: TextFacets = {
	assets: {
		entries: [
			quiet("content/text/dt_menu", "Content/Text/DT_Menu", 1),
			quiet("content/text/st_game", "Content/Text/ST_Game", 1)
		],
		more: 0
	},
	origins: {
		entries: [quiet("data_table", "Data table", 1), quiet("string_table", "String table", 1)],
		more: 0
	},
	audiences: { entries: [quiet("player", "Player text", 2)], more: 0 },
	assetTypes: { entries: [], more: 0 },
	facts: { unresolved: 0, conflicting: 0, evidence_only: 1, compiled_copy_differs: 0 }
};
/** An answer listing these rows, each up to date in Content/Text, with the planted aggregates. */
export function answer(
	when: CannedWhen,
	units: readonly TextUnitSearchResult[],
	extra: Partial<CannedAnswer> = {}
): CannedAnswer {
	return {
		when,
		rows: units.map(upToDate),
		counts,
		groups: {
			problem: units.length ? [quiet("up_to_date", "Up to date", units.length)] : [],
			folder: units.length ? [quiet("content/text", "Content/Text", units.length)] : []
		},
		facets,
		folders: {
			"": { entries: [quiet("content", "Content", 2)], more: 0 },
			Content: { entries: [quiet("content/text", "Content/Text", 2)], more: 0 }
		},
		...extra
	};
}
/** A unit's focus listing every place the corpus plants for it. */
export function focusOf(input: TextCorpus, unit: TextUnitSearchResult): TextCorpusFocus {
	const occurrences = input.units.find((item) => item.id === unit.id)?.occurrences ?? [];
	return { diagnostics: [], occurrences, totalOccurrences: occurrences.length, unit };
}
export const summary: TextCorpusQuerySummary = {
	counts,
	scannedAt: "2026-10-07T16:53:00.000Z",
	searchable: { textUnits: 2, textOccurrences: 2 },
	schemaVersion: 1,
	status: "complete",
	coverage: corpus.coverage,
	diagnosticCount: 0,
	review: { all: 2, unresolved: 0, conflicting: 0 },
	sources: { assetProperty: 0, dataTable: 1, mixed: 0, stringTable: 1 }
};

/** What a fake client answers: the corpus its quality reports read, and the planted text answers. */
export interface PlantedText {
	readonly corpus: TextCorpus;
	readonly summary: TextCorpusQuerySummary;
	readonly answers: readonly CannedAnswer[];
	readonly focus: readonly TextCorpusFocus[];
}
export const planted: PlantedText = {
	corpus,
	summary,
	answers: [
		answer({}, [continueRow, quitRow]),
		answer({ query: "Q" }, [quitRow]),
		answer({ query: "Quit" }, [quitRow]),
		answer({ query: "Continue" }, [continueRow]),
		answer({ query: "missing" }, []),
		answer({ filter: [{ field: "origin", op: "is", values: ["data_table"] }] }, [quitRow]),
		answer({ filter: [{ field: "origin", op: "is", values: ["string_table"] }] }, [
			continueRow
		]),
		answer({ filter: [{ field: "folder", op: "is", values: ["content\\text\\st"] }] }, [
			continueRow
		]),
		answer(
			{ query: "Continue", filter: [{ field: "editing", op: "is", values: ["editable"] }] },
			[continueRow]
		),
		answer(
			{
				query: "Continue",
				filter: [
					{ field: "editing", op: "is", values: ["editable"] },
					{ field: "notes", op: "is", values: ["missing"] }
				]
			},
			[continueRow]
		),
		answer(
			{ where: { files: ["Content\\Text\\DT_Menu.uexp", "Source/Unrelated.cpp"] } },
			[quitRow],
			{ fileScope: { files: 2, textFiles: 1, outside: 0 } }
		)
	],
	focus: [focusOf(corpus, continueRow), focusOf(corpus, quitRow)]
};
export function makeClient(
	text: PlantedText = planted,
	overrides: Partial<GameTextClientApi> = {}
): GameTextClientApi {
	let quality = textQualityQuery(indexedTestReports(text.corpus).source(rulesDocument));
	return {
		loadConfiguredProject: () => Effect.succeed({ status: "completed", summary: text.summary }),
		progress: Stream.make({ completed: 0, total: 0, phase: "idle" }),
		...cannedSearch(text.answers),
		focus: cannedFocus(text.focus),
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
			quality = textQualityQuery(indexedTestReports(text.corpus).source(draft));
			return Effect.succeed({
				status: "completed",
				document: draft,
				summary: quality.summary()
			});
		},
		saveQualityRules: (draft) => {
			quality = textQualityQuery(indexedTestReports(text.corpus).source(draft));
			return Effect.succeed({
				status: "completed",
				document: draft,
				summary: quality.summary()
			});
		},
		...overrides
	};
}

export { searchRowsFrom };

/** Waits for every open group's rows, which load after the header that lists the groups. */
export const groupRows = () =>
	waitFor(() =>
		expect(
			[...document.querySelectorAll("section[data-group] [role='status']")].filter(
				(status) => status.textContent === "Loading…"
			)
		).toHaveLength(0)
	);

/** The client a test mounts, its rows reads answered from its own `search`. */
export const withSearchRows = (client: GameTextClientApi): GameTextClientApi => ({
	...client,
	searchRows: searchRowsFrom(client.search)
});

export function mount(client = makeClient(), preferences?: GameTextPreferences, key?: string) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute
				client={withSearchRows(client)}
				initialPreferences={preferences}
				projectKey={key}
			/>
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
	await user.click(screen.getByRole("button", { name: "Choose a rules file…" }));
	return screen.findByRole("region", { name: "Findings" });
}
