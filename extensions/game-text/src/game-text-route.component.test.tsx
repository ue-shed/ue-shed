// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	textCorpusQuery,
	textQualityQuery,
	evaluateGameTextSourceQuality,
	STARTER_GAME_TEXT_RULES,
	TextQualityRuleDocument,
	type GameTextRuleDocument,
	TextRoleId,
	TextQualityRuleId,
	type TextCorpus,
	type TextCorpusQueryRunResult,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute, type GameTextPreferences } from "./game-text-query-route.js";
import { decodeGameTextPreferences } from "./game-text-preferences.js";

const corpus: TextCorpus = {
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

const rulesDocument = TextQualityRuleDocument.make({
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
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
// Node 26 defines its own global localStorage, which hides jsdom's storage unless Node is given a
// storage file, so each test gets an isolated in-memory store.
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

function makeClient(
	input: TextCorpus = corpus,
	overrides: Partial<GameTextClientApi> = {}
): GameTextClientApi {
	const query = textCorpusQuery(input, "2026-10-07T16:53:00.000Z");
	let quality = textQualityQuery(evaluateGameTextSourceQuality(input, rulesDocument));
	return {
		chooseProjectAndScan: () =>
			Effect.succeed({ status: "completed", summary: query.summary() }),
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

function mount(client = makeClient(), preferences?: GameTextPreferences, key?: string) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={client} initialPreferences={preferences} projectKey={key} />
		</EffectRuntimeProvider>
	));
}

async function openQuality(user: ReturnType<typeof userEvent.setup>) {
	await screen.findByRole("region", { name: "Results" });
	await user.click(screen.getByRole("tab", { name: "Quality checks" }));
	await user.click(screen.getByRole("button", { name: "Load rules" }));
	return screen.findByRole("region", { name: "Findings" });
}

describe("Game Text writing workspace", () => {
	it("uses a compact toolbar, live count and zero-count hint without a header or select", async () => {
		mount();
		await screen.findByText("2 matches");
		expect(screen.queryByRole("heading", { name: /Game text/i })).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
		expect(screen.getByRole("button", { name: "All text 2" })).toBeDefined();
		expect(screen.queryByRole("button", { name: /Used in several places/ })).toBeNull();
		expect(
			screen.getByText("Nothing reused, duplicated, too long or unlocalizable")
		).toBeDefined();
		expect(screen.getByText(/lines in/).textContent).toContain("2 lines in 2 assets");
		expect(screen.getByText(/Select a line to see/)).toBeDefined();
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getByText("ST_Game · PromptContinue")).toBeDefined();
		expect(within(results).getByText("DT_Menu · Quit · Prompt")).toBeDefined();
	});

	it("pluralizes a single line, asset, character, word and location", async () => {
		const first = corpus.units[0]!;
		mount(
			makeClient({
				...corpus,
				coverage: { ...corpus.coverage, discoveredPackages: 1, inspectedPackages: 1 },
				units: [
					{
						...first,
						source: { status: "consistent", value: "X" },
						occurrences: first.occurrences.map((occurrence) => ({
							...occurrence,
							source: "X"
						}))
					}
				]
			})
		);
		await screen.findByText("1 match");
		expect(screen.getByText(/line in/).textContent).toContain("1 line in 1 asset");
		const results = screen.getByRole("region", { name: "Results" });
		await userEvent
			.setup()
			.click(within(results).getByRole("button", { name: /^X\s?ST_Game/u }));
		await screen.findByText("1 character · 1 word · 1 location");
	});

	it("shows nonzero review chips and keeps a selected zero-count chip visible", async () => {
		const first = corpus.units[0];
		if (!first) throw new Error("Missing test line");
		const shared = {
			...corpus,
			units: [
				{
					...first,
					occurrences: [
						...first.occurrences,
						{ ...first.occurrences[0]!, id: makeTextOccurrenceId("another") }
					]
				},
				...corpus.units.slice(1)
			]
		};
		const user = userEvent.setup();
		mount(makeClient(shared), {
			query: "",
			capability: "all",
			lens: "long",
			selectedId: undefined
		});
		await screen.findByText("0 matches");
		expect(screen.getByRole("button", { name: "Long text 0" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: /^All text/ }));
		await screen.findByRole("button", { name: "Used in several places 1" });
		expect(screen.queryByRole("button", { name: /^Long text/ })).toBeNull();
	});

	it("debounces source-only search, shows Searching and never flashes a false empty state", async () => {
		const release = await runtime.runPromise(Deferred.make<void>());
		const query = textCorpusQuery(corpus);
		const client = makeClient(corpus, {
			search: (request) =>
				request.query === ""
					? Effect.succeed({ status: "ready", page: query.search(request) })
					: Deferred.await(release).pipe(
							Effect.as({ status: "ready" as const, page: query.search(request) })
						)
		});
		const user = userEvent.setup();
		mount(client);
		await screen.findByText("2 matches");
		const input = screen.getByRole("searchbox", { name: "Search game text" });
		await user.type(input, "missing");
		expect(screen.getByText("Searching…")).toBeDefined();
		expect(screen.queryByText("No text matches these filters.")).toBeNull();
		expect(document.activeElement).toBe(input);
		await runtime.runPromise(Deferred.succeed(release, undefined));
		await screen.findByText("0 matches");
		expect(screen.getByText("No text matches these filters.")).toBeDefined();
	});

	it("does not show empty results before the first response", async () => {
		const release = await runtime.runPromise(Deferred.make<void>());
		const query = textCorpusQuery(corpus);
		mount(
			makeClient(corpus, {
				search: (request) =>
					Deferred.await(release).pipe(
						Effect.as({
							status: "ready" as const,
							page: query.search(request)
						})
					)
			})
		);
		await screen.findByText("Searching…");
		expect(screen.queryByText("No text matches these filters.")).toBeNull();
		await runtime.runPromise(Deferred.succeed(release, undefined));
		await screen.findByText("2 matches");
	});

	it("drops a late response when the search request has changed", async () => {
		const release = await runtime.runPromise(Deferred.make<void>());
		const requested: string[] = [];
		const query = textCorpusQuery(corpus);
		const user = userEvent.setup();
		mount(
			makeClient(corpus, {
				search: (request) => {
					requested.push(request.query);
					const result: TextCorpusSearchResult = {
						status: "ready",
						page: query.search(request)
					};
					return request.query === "Continue"
						? Deferred.await(release).pipe(Effect.as(result))
						: Effect.succeed(result);
				}
			})
		);
		await screen.findByText("2 matches");
		const input = screen.getByRole("searchbox");
		await user.type(input, "Continue");
		await waitFor(() => expect(requested).toContain("Continue"));
		await user.clear(input);
		await user.type(input, "Quit");
		await screen.findByText("1 match");
		await runtime.runPromise(Deferred.succeed(release, undefined));
		expect(
			within(screen.getByRole("region", { name: "Results" })).queryByText("Continue")
		).toBeNull();
		expect(
			within(screen.getByRole("region", { name: "Results" })).getByText("Quit game?")
		).toBeDefined();
	});

	it("toggles editable and no-notes counts through the package query", async () => {
		const input: TextCorpus = {
			...corpus,
			units: corpus.units.map((unit, index) => ({
				...unit,
				occurrences: unit.occurrences.map((occurrence) => ({
					...occurrence,
					devNotes: index === 1 ? "Translator note" : " \t "
				}))
			}))
		};
		const user = userEvent.setup();
		mount(makeClient(input));
		await screen.findByText("2 matches");
		expect(screen.getByRole("button", { name: "No translator notes 1" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: /^No translator notes/ }));
		await screen.findByText("1 match");
		expect(
			within(screen.getByRole("region", { name: "Results" })).queryByText("Quit game?")
		).toBeNull();
		await user.click(screen.getByRole("button", { name: /^Editable/ }));
		expect(screen.getByRole("button", { name: /^Editable/ }).getAttribute("aria-pressed")).toBe(
			"true"
		);
	});

	it("filters by where text comes from and by path, keeping each origin's count", async () => {
		const user = userEvent.setup();
		mount();
		await screen.findByText("2 matches");
		expect(screen.getByRole("button", { name: "String table 1" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Data table 1" }));
		await screen.findByText("1 match");
		const results = () => within(screen.getByRole("region", { name: "Results" }));
		expect(results().getByText("Quit game?")).toBeDefined();
		expect(results().queryByText("Continue")).toBeNull();
		// The origin facet does not narrow its own counts.
		expect(screen.getByRole("button", { name: "String table 1" })).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Data table 1" }).getAttribute("aria-pressed")
		).toBe("true");

		await user.click(screen.getByRole("button", { name: "Path…" }));
		await user.type(
			screen.getByRole("textbox", { name: "Path starts with" }),
			"content\\text\\st{Enter}"
		);
		await screen.findByText("0 matches");
		await user.click(screen.getByRole("button", { name: /^Data table/ }));
		await screen.findByText("1 match");
		expect(results().getByText("Continue")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Path: content\\text\\st" }));
		await user.clear(screen.getByRole("textbox", { name: "Path starts with" }));
		await user.keyboard("{Enter}");
		await screen.findByText("2 matches");
		expect(screen.getByRole("button", { name: "Path…" })).toBeDefined();
	});

	it("restores a saved origin filter", async () => {
		mount(makeClient(), {
			query: "",
			capability: "all",
			lens: "all",
			selectedId: undefined,
			where: { kinds: ["string_table"] }
		});
		await screen.findByText("1 match");
		expect(
			screen.getByRole("button", { name: "String table 1" }).getAttribute("aria-pressed")
		).toBe("true");
	});

	it("shows the starting sentence and scans only after the primary action", async () => {
		const calls: boolean[] = [];
		const query = textCorpusQuery(corpus);
		const user = userEvent.setup();
		mount(
			makeClient(corpus, {
				loadConfiguredProject: (refresh = true) => {
					calls.push(refresh);
					return Effect.succeed(
						refresh
							? { status: "completed", summary: query.summary() }
							: { status: "not_scanned" }
					);
				}
			}),
			undefined,
			"example-project"
		);
		await screen.findByText(
			"Game Text reads the project's saved assets, so Unreal does not need to be running."
		);
		expect(calls).toEqual([false]);
		await user.click(screen.getByRole("button", { name: "Scan project" }));
		await screen.findByText("2 matches");
		expect(calls).toEqual([false, true]);
	});

	it("restores per-project search, toggles and selection across fresh mounts without rescanning", async () => {
		const calls: boolean[] = [];
		const client = makeClient(corpus, {
			loadConfiguredProject: (refresh = true) => {
				calls.push(refresh);
				return Effect.succeed({
					status: "completed",
					summary: textCorpusQuery(corpus).summary()
				});
			}
		});
		const user = userEvent.setup();
		const view = mount(client, undefined, "project-a");
		await screen.findByText("2 matches");
		await user.type(screen.getByRole("searchbox"), "Continue");
		await screen.findByText("1 match");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /Continue/
			})
		);
		await screen.findByRole("heading", { name: "Continue" });
		await user.click(screen.getByRole("button", { name: /^Editable/ }));
		await screen.findByText("1 match");
		await user.click(screen.getByRole("button", { name: /^No translator notes/ }));
		await screen.findByText("1 match");
		await waitFor(() =>
			expect(window.localStorage.getItem("ue-shed:game-text:project-a")).toContain("Continue")
		);
		view.unmount();
		mount(client, undefined, "project-a");
		await screen.findByText("1 match");
		expect(screen.getByRole("searchbox")).toHaveProperty("value", "Continue");
		expect(await screen.findByRole("heading", { name: "Continue" })).toBeDefined();
		expect(screen.getByRole("button", { name: /^Editable/ }).getAttribute("aria-pressed")).toBe(
			"true"
		);
		expect(
			screen
				.getByRole("button", { name: /^No translator notes/ })
				.getAttribute("aria-pressed")
		).toBe("true");
		expect(calls).toEqual([false, false]);
		cleanup();
		mount(client, undefined, "project-b");
		await screen.findByText("2 matches");
		expect(screen.getByRole("searchbox")).toHaveProperty("value", "");
	});

	it("clears a remembered missing selection and safely defaults corrupt saved preferences", async () => {
		expect(decodeGameTextPreferences('{"lens":"not-a-lens"}')).toMatchObject({
			query: "",
			capability: "all",
			lens: "all",
			withoutNotes: false
		});
		expect(decodeGameTextPreferences("broken JSON")).toMatchObject({ query: "", lens: "all" });
		window.localStorage.setItem(
			"ue-shed:game-text:project-a",
			JSON.stringify({
				query: "",
				capability: "all",
				lens: "all",
				selectedId: "missing-line"
			})
		);
		mount(makeClient(), undefined, "project-a");
		await screen.findByText("2 matches");
		await waitFor(() =>
			expect(
				JSON.parse(window.localStorage.getItem("ue-shed:game-text:project-a") ?? "{}")
					.selectedId
			).toBeUndefined()
		);
		expect(screen.getByText(/Select a line to see/)).toBeDefined();
		cleanup();
		window.localStorage.setItem("ue-shed:game-text:project-a", "broken JSON");
		mount(makeClient(), undefined, "project-a");
		await screen.findByText("2 matches");
		expect(screen.getByRole("searchbox")).toHaveProperty("value", "");
	});

	it("shows key, stats, full paths and translator notes in detail and copies the key", async () => {
		const user = userEvent.setup();
		mount();
		const results = await screen.findByRole("region", { name: "Results" });
		await user.click(await within(results).findByRole("button", { name: /Continue/ }));
		const focus = screen.getByRole("complementary", { name: "Text focus" });
		await waitFor(() => expect(focus.textContent).toContain("UI · Continue"));
		expect(focus.textContent).toContain("8 characters · 1 word · 1 location");
		expect(focus.textContent).toContain("String table entry");
		expect(focus.textContent).toContain("/Game/Text/ST_Game.ST_Game");
		expect(focus.textContent).toContain("No translator notes");
		await user.click(within(focus).getByRole("button", { name: "Copy key" }));
		await waitFor(() => expect(navigator.clipboard.readText()).resolves.toBe("UI · Continue"));
		const copyKey = within(focus).getByRole("button", { name: "Copy key" });
		await waitFor(() => expect(copyKey.getAttribute("title")).toBe("Copied"));
		expect(copyKey.textContent).toBe("");
		await waitFor(() => expect(copyKey.getAttribute("title")).toBe("Copy key"), {
			timeout: 2500
		});
		await user.click(within(focus).getByRole("button", { name: "Copy asset path" }));
		await waitFor(() =>
			expect(navigator.clipboard.readText()).resolves.toBe("/Game/Text/ST_Game.ST_Game")
		);
		await user.click(within(focus).getByRole("button", { name: "Copy text" }));
		await waitFor(() => expect(navigator.clipboard.readText()).resolves.toBe("Continue"));
		await user.click(within(focus).getByText("Saved file"));
		expect(
			within(focus).getByText("Content/Text/ST_Game.uasset").closest("details")
		).toHaveProperty("open", true);
		await user.click(within(focus).getByRole("button", { name: "Show in Unreal" }));
		await within(focus).findByText("Opened");
		expect(within(focus).getByRole("status").textContent).toContain("Content Browser");
	});

	it("restores Read only, keeps capability toggles exclusive and accepts keyboard search", async () => {
		const user = userEvent.setup();
		mount();
		await screen.findByText("2 matches");
		await user.click(screen.getByRole("button", { name: "Read only 1" }));
		await screen.findByText("1 match");
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).queryByText("Continue")).toBeNull();
		const row = within(results).getByRole("button", { name: /Quit game/u });
		row.focus();
		await user.keyboard("{Enter}");
		await screen.findByRole("heading", { name: "Quit game?" });
		await user.click(screen.getByRole("button", { name: /^Editable/u }));
		await screen.findByText("1 match");
		expect(
			screen.getByRole("button", { name: /^Read only/u }).getAttribute("aria-pressed")
		).toBe("false");
		expect(
			screen.getByRole("button", { name: /^Editable/u }).getAttribute("aria-pressed")
		).toBe("true");
		await user.click(screen.getByRole("button", { name: /^Editable/u }));
		await screen.findByText("2 matches");
		await user.type(screen.getByRole("searchbox"), "Quit{Enter}");
		await screen.findByText("1 match");
		expect(within(results).queryByText("Continue")).toBeNull();
	});

	it("keeps partial coverage, unsupported fields and related read problems inspectable", async () => {
		const user = userEvent.setup();
		mount(
			makeClient({
				...corpus,
				status: "partial",
				coverage: {
					...corpus.coverage,
					discoveredPackages: 3,
					partialPackages: 1,
					failedPackages: 1,
					unsupportedTextProperties: 2
				},
				diagnostics: [
					{
						code: "unsupported_text_history",
						message: "This text field could not be decoded.",
						packageFile: "Content/Text/ST_Game.uasset",
						objectPath: "/Game/Text/ST_Game.ST_Game",
						propertyPath: "UnsupportedPrompt"
					}
				]
			})
		);
		await screen.findByText("2 matches");
		const trigger = screen.getByRole("button", { name: "Read problems" });
		expect(trigger.textContent).toBe("2 assets not fully read");
		await user.click(trigger);
		const problems = screen.getByRole("dialog", { name: "Read problems" });
		expect(problems.textContent).toContain("Only part of the project's saved text was read");
		expect(problems.textContent).toContain("2 text fields could not be decoded");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Read problems" })).toBeNull();
		const results = screen.getByRole("region", { name: "Results" });
		await user.click(within(results).getByRole("button", { name: /Continue/u }));
		const notes = await screen.findByRole("region", { name: "Read problems for this line" });
		expect(notes.textContent).toContain("This text field could not be decoded.");
		expect(notes.textContent).toContain("Content/Text/ST_Game.uasset");
		expect(notes.textContent).toContain("UnsupportedPrompt");
		await user.click(screen.getByRole("tab", { name: "Quality checks" }));
		expect(screen.getByRole("button", { name: "Read problems" })).toBeDefined();
	});

	it("reports cancelled project selection and leaves Scan project available", async () => {
		const user = userEvent.setup();
		mount(
			makeClient(corpus, {
				loadConfiguredProject: () => Effect.succeed({ status: "not_scanned" }),
				chooseProjectAndScan: () => Effect.succeed({ status: "cancelled" })
			})
		);
		await user.click(await screen.findByRole("button", { name: "Scan project" }));
		await screen.findByText("Project selection was cancelled. Choose a project to scan.");
		expect(screen.getByRole("button", { name: "Scan project" })).toHaveProperty(
			"disabled",
			false
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps scan progress visible until the scan completes", async () => {
		const response = await Effect.runPromise(Deferred.make<TextCorpusQueryRunResult>());
		const query = textCorpusQuery(corpus);
		let scanning = false;
		mount(
			makeClient(corpus, {
				loadConfiguredProject: (refresh) => {
					if (!refresh) return Effect.succeed({ status: "not_scanned" });
					scanning = true;
					return Deferred.await(response);
				},
				progress: () =>
					Effect.sync(() => ({
						completed: scanning ? 1 : 0,
						total: scanning ? 2 : 0,
						phase: scanning ? "scanning" : "idle",
						stage: "game_text"
					}))
			}),
			undefined,
			"progress-project"
		);
		await userEvent.setup().click(await screen.findByRole("button", { name: "Scan project" }));
		const progress = await screen.findByRole("progressbar", {
			name: "Inspecting text-bearing packages"
		});
		expect(progress.getAttribute("aria-valuenow")).toBe("1");
		expect(progress.getAttribute("aria-valuemax")).toBe("2");
		expect(screen.queryByText("No text matches these filters.")).toBeNull();
		await Effect.runPromise(
			Deferred.succeed(response, { status: "completed", summary: query.summary() })
		);
		await screen.findByText("2 matches");
		expect(screen.queryByRole("progressbar")).toBeNull();
	});

	it.each(["text", "quality"])(
		"pages %s locations without losing the selected detail",
		async (view) => {
			const first = corpus.units[0];
			if (!first) throw new Error("Missing test line");
			const occurrence = first.occurrences[0];
			if (!occurrence) throw new Error("Missing test location");
			const input: TextCorpus = {
				...corpus,
				units: [
					{
						...first,
						occurrences: Array.from({ length: 51 }, (_, index) => ({
							...occurrence,
							id: makeTextOccurrenceId("place:" + index.toString().padStart(3, "0"))
						}))
					}
				]
			};
			const user = userEvent.setup();
			const client = makeClient(input);
			const sizes: number[] = [];
			mount({
				...client,
				focus: (request) => {
					sizes.push(request.pageSize);
					return client.focus(request);
				},
				qualityFocus: (request) => {
					sizes.push(request.pageSize);
					return client.qualityFocus(request);
				}
			});
			await screen.findByText("1 match");
			const list =
				view === "quality"
					? await openQuality(user)
					: screen.getByRole("region", { name: "Results" });
			await user.click(await within(list).findByRole("button"));
			const detail = screen.getByRole("complementary", {
				name: view === "quality" ? "Finding detail" : "Text focus"
			});
			await waitFor(() =>
				expect(
					within(detail).getAllByRole("button", { name: "Show in Unreal" })
				).toHaveLength(50)
			);
			await user.click(within(detail).getByRole("button", { name: "Show 1 more location" }));
			await waitFor(() =>
				expect(
					within(detail).getAllByRole("button", { name: "Show in Unreal" })
				).toHaveLength(51)
			);
			expect(within(detail).getByRole("heading", { name: "Continue" })).toBeDefined();
			expect(sizes.length).toBeGreaterThanOrEqual(2);
			expect(sizes.every((size) => size === 50)).toBe(true);
			expect(within(detail).queryByRole("button", { name: /Show \d+ more/u })).toBeNull();
		}
	);

	it("shows the quality overview and a warning for scopes with no lines", async () => {
		const user = userEvent.setup();
		mount();
		await openQuality(user);
		expect(screen.getByRole("tab", { name: "Quality checks (3)" })).toBeDefined();
		expect(screen.getByRole("table", { name: "Rules overview" })).toBeDefined();
		expect(screen.getByRole("table", { name: "Roles overview" })).toBeDefined();
		expect(screen.getByText("None: check this role's matchers")).toBeDefined();
		expect(screen.queryByRole("heading", { name: /Continue/ })).toBeNull();
		const findings = screen.getByRole("region", { name: "Findings" });
		await waitFor(() => expect(within(findings).getAllByRole("button")).toHaveLength(3));
		expect(findings.textContent).toContain("ST_Game · PromptContinue");
		expect(findings.textContent).toContain("DT_Menu · Quit · Prompt");
		expect(findings.textContent).toContain("1 location");
		expect(findings.textContent).not.toContain("1 locations");
	});

	it("restores the quality view, filter and finding and clears a vanished finding quietly", async () => {
		const user = userEvent.setup();
		const view = mount(makeClient(), undefined, "quality-project");
		await openQuality(user);
		await user.click(screen.getByRole("button", { name: /^Terminology/ }));
		const findings = screen.getByRole("region", { name: "Findings" });
		await waitFor(() => expect(within(findings).getAllByRole("button")).toHaveLength(1));
		await user.click(within(findings).getByRole("button"));
		await waitFor(() =>
			expect(
				screen.getByRole("complementary", { name: "Finding detail" }).querySelector("mark")
					?.textContent
			).toBe("Quit")
		);
		await waitFor(() =>
			expect(window.localStorage.getItem("ue-shed:game-text:quality-project")).toContain(
				"selectedFindingId"
			)
		);
		view.unmount();
		const restored = mount(makeClient(), undefined, "quality-project");
		await waitFor(() =>
			expect(
				screen.getByRole("complementary", { name: "Finding detail" }).querySelector("mark")
					?.textContent
			).toBe("Quit")
		);
		expect(
			screen.getByRole("button", { name: /^Terminology/ }).getAttribute("aria-pressed")
		).toBe("true");
		restored.unmount();
		mount(
			makeClient(corpus, { qualityFocus: () => Effect.succeed({ status: "not_found" }) }),
			undefined,
			"quality-project"
		);
		await screen.findByRole("table", { name: "Rules overview" });
		await waitFor(() =>
			expect(
				JSON.parse(window.localStorage.getItem("ue-shed:game-text:quality-project") ?? "{}")
					.selectedFindingId
			).toBeUndefined()
		);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("appends bounded pages while keeping the full query count", async () => {
		const first = corpus.units[0]!;
		const input: TextCorpus = {
			...corpus,
			units: Array.from({ length: 62 }, (_, index) => ({
				...first,
				id: makeTextUnitId("page-line:" + index.toString().padStart(3, "0")),
				source: { status: "consistent", value: "Line " + index }
			}))
		};
		const user = userEvent.setup();
		mount(makeClient(input));
		await screen.findByText("62 matches");
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getAllByRole("button")).toHaveLength(51);
		await user.click(within(results).getByRole("button", { name: "Show 12 more" }));
		await waitFor(() => expect(within(results).getAllByRole("button")).toHaveLength(62));
		expect(screen.getByText("62 matches")).toBeDefined();
	});

	it("highlights terminology, shows its asset in Unreal and opens the matching line in Text", async () => {
		const user = userEvent.setup();
		const located: string[] = [];
		const client = makeClient();
		mount({
			...client,
			locateAsset: (path) => {
				located.push(path);
				return client.locateAsset(path);
			}
		});
		const findings = await openQuality(user);
		await user.click(screen.getByRole("button", { name: /^Terminology/ }));
		await waitFor(() => expect(within(findings).getAllByRole("button")).toHaveLength(1));
		await user.click(within(findings).getByRole("button"));
		const detail = screen.getByRole("complementary", { name: "Finding detail" });
		await waitFor(() => expect(detail.querySelector("mark")?.textContent).toBe("Quit"));
		expect(detail.textContent).toContain("How to fix");
		expect(within(detail).getByRole("button", { name: "Copy asset path" })).toBeDefined();
		await user.click(within(detail).getByRole("button", { name: "Show in Unreal" }));
		await within(detail).findByText("Opened");
		expect(located).toEqual(["/Game/Text/DT_Menu.DT_Menu"]);
		await user.click(
			within(detail).getByRole("button", { name: "Show key and translator notes" })
		);
		await screen.findByRole("heading", { name: "Quit game?" });
		expect(screen.getByRole("tab", { name: "Text" }).getAttribute("aria-selected")).toBe(
			"true"
		);
	});

	it("keeps the rule editor reachable and retains unsaved edits across view changes", async () => {
		const user = userEvent.setup();
		let preferences: GameTextPreferences | undefined;
		const view = render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<GameTextRoute
					client={makeClient()}
					onPreferencesChange={(next) => {
						preferences = next;
					}}
				/>
			</EffectRuntimeProvider>
		));
		await openQuality(user);
		await user.click(screen.getByRole("button", { name: "Edit rules" }));
		const maximum = await screen.findByRole("spinbutton", {
			name: "Maximum characters for example-limit"
		});
		const ruleForm = screen.getByRole("region", { name: "Selected quality rule" });
		expect(within(ruleForm).getByText("Saved", { exact: true })).toBeDefined();
		await user.clear(maximum);
		await user.type(maximum, "0");
		expect(within(ruleForm).getByText("Unsaved changes", { exact: true })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Preview" }));
		expect(screen.getByText(/needs a whole-number character limit/)).toBeDefined();
		view.unmount();
		mount(makeClient(), preferences);
		await user.click(await screen.findByRole("button", { name: "Edit rules" }));
		expect(
			await screen.findByRole("spinbutton", {
				name: "Maximum characters for example-limit"
			})
		).toHaveProperty("value", "0");
	});

	it("retains every editable rule field, term actions, preview and save", async () => {
		const user = userEvent.setup();
		const client = makeClient();
		const previews: GameTextRuleDocument[] = [];
		const saves: GameTextRuleDocument[] = [];
		mount({
			...client,
			previewQualityRules: (draft) => {
				previews.push(draft);
				return client.previewQualityRules(draft);
			},
			saveQualityRules: (draft) => {
				saves.push(draft);
				return client.saveQualityRules(draft);
			}
		});
		await openQuality(user);
		await user.click(screen.getByRole("button", { name: "Edit rules" }));
		const maximum = await screen.findByRole("spinbutton", {
			name: "Maximum characters for example-limit"
		});
		await user.clear(maximum);
		await user.type(maximum, "12");
		const rules = screen.getByRole("complementary", { name: "Quality rule list" });
		await user.click(within(rules).getByRole("button", { name: /example-terms/u }));
		await user.click(screen.getByRole("checkbox", { name: "Case-sensitive matching" }));
		const preferred = screen.getByRole("textbox", { name: "Preferred term 1" });
		await user.clear(preferred);
		await user.type(preferred, "Leave");
		const alternatives = screen.getByRole("textbox", {
			name: "Alternatives for preferred term 1"
		});
		await user.clear(alternatives);
		await user.type(alternatives, "Quit, Depart");
		await user.click(screen.getByRole("button", { name: "Add forbidden term" }));
		await user.type(screen.getByRole("textbox", { name: "Forbidden term 2" }), "obsolete");
		await user.click(screen.getByRole("button", { name: "Add preferred term" }));
		await user.type(screen.getByRole("textbox", { name: "Preferred term 3" }), "Continue");
		await user.clear(
			screen.getByRole("textbox", { name: "Alternatives for preferred term 3" })
		);
		await user.type(
			screen.getByRole("textbox", { name: "Alternatives for preferred term 3" }),
			"proceed"
		);
		const recovery = screen.getByRole("textbox", {
			name: "Recovery guidance for example-terms"
		});
		await user.clear(recovery);
		await user.type(recovery, "Use the example wording.");
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await screen.findByText("Preview updated.", { exact: false });
		expect(previews.at(-1)?.rules).toEqual([
			{ ...rulesDocument.rules[0], maximumCharacters: 12 },
			{
				...rulesDocument.rules[1],
				caseSensitive: true,
				recovery: "Use the example wording.",
				terms: [
					{ kind: "preferred", term: "Leave", alternatives: ["Quit", "Depart"] },
					{ kind: "forbidden", term: "obsolete" },
					{ kind: "preferred", term: "Continue", alternatives: ["proceed"] }
				]
			}
		]);
		expect(
			screen.getByRole("complementary", { name: "Quality role scopes" }).textContent
		).toContain("/Game/");
		await user.click(screen.getByRole("button", { name: "Remove term 2" }));
		expect(screen.queryByRole("textbox", { name: "Forbidden term 2" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Rule file saved.", { exact: false });
		expect(saves).toHaveLength(1);
		expect(saves[0]?.rules[1]).toMatchObject({
			caseSensitive: true,
			terms: [
				{ kind: "preferred", term: "Leave", alternatives: ["Quit", "Depart"] },
				{ kind: "preferred", term: "Continue", alternatives: ["proceed"] }
			],
			recovery: "Use the example wording."
		});
	});

	it("offers to load an existing starter rules file and labels invalid rules", async () => {
		const user = userEvent.setup();
		const loaded = textQualityQuery(
			evaluateGameTextSourceQuality(corpus, STARTER_GAME_TEXT_RULES)
		);
		const requested: boolean[] = [];
		mount(
			makeClient(corpus, {
				createStarterRules: (loadExisting) => {
					requested.push(loadExisting);
					return Effect.succeed(
						loadExisting
							? {
									status: "completed",
									document: STARTER_GAME_TEXT_RULES,
									summary: loaded.summary()
								}
							: {
									status: "failed",
									error: {
										code: "already_exists",
										message: "The rules file already exists.",
										recovery: "Load it to use its writing checks.",
										retrySafe: true
									}
								}
					);
				},
				qualitySearch: (request) =>
					Effect.succeed({
						status: "ready",
						page: loaded.search(request)
					}),
				qualityFocus: (request) => {
					const focus = loaded.focus(request);
					return Effect.succeed(
						focus ? { status: "found", focus } : { status: "not_found" }
					);
				},
				chooseQualityRules: () =>
					Effect.succeed({
						status: "failed",
						error: {
							code: "invalid_rules",
							message: "Invalid rules.",
							recovery: "Correct the file.",
							retrySafe: true
						}
					})
			})
		);
		await screen.findByText("2 matches");
		await user.click(screen.getByRole("tab", { name: "Quality checks" }));
		await user.click(screen.getByRole("button", { name: "Create rules file" }));
		await screen.findByRole("button", { name: "Load existing rules" });
		await user.click(screen.getByRole("button", { name: "Load rules" }));
		await screen.findByRole("tab", { name: "Quality checks (rules invalid)" });
		await user.click(screen.getByRole("button", { name: "Create rules file" }));
		await user.click(await screen.findByRole("button", { name: "Load existing rules" }));
		await screen.findByRole("table", { name: "Rules overview" });
		expect(requested).toEqual([false, false, true]);
	});
});
