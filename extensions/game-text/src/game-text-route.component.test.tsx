import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { type LocalizationTargetsResult } from "@ue-shed/game-text/corpus";
import {
	makeTextOccurrenceId,
	type TextCorpus,
	type TextCorpusQueryRunResult,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect } from "effect";
import { expect, it, vi } from "vitest";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import { GameTextRoute, type GameTextPreferences } from "./game-text-query-route.js";
import {
	chooseFilter,
	corpus,
	makeClient,
	mount,
	openQuality,
	runtime
} from "./game-text-route.test-support.js";
it("keeps the indexed list searchable during a rescan and focuses search with Ctrl K", async () => {
	const response = await Effect.runPromise(Deferred.make<TextCorpusQueryRunResult>());
	const query = textCorpusQuery(corpus);
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient(corpus, {
			loadConfiguredProject: (refresh) =>
				refresh
					? Deferred.await(response)
					: Effect.succeed({ status: "completed", summary: query.summary() })
		})
	);
	await screen.findByText("2 matches");
	const status = screen.getByLabelText("Index status");
	await waitFor(() => expect(status.textContent).toContain("assets"));
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await screen.findByText("Rescanning");
	expect(within(status).getByRole("status").textContent).toContain("elapsed");
	expect(status.textContent).not.toContain("assets");
	const search = screen.getByRole("searchbox");
	expect(search).toHaveProperty("disabled", false);
	expect(screen.queryByRole("dialog")).toBeNull();
	await user.keyboard("{Control>}k{/Control}");
	expect(document.activeElement).toBe(search);
	await user.type(search, "Quit");
	await screen.findByText("1 match");
	const results = within(screen.getByRole("region", { name: "Results" }));
	expect(results.getByRole("button", { name: /^Quit game/u })).toBeDefined();
	await Effect.runPromise(
		Deferred.succeed(response, { status: "completed", summary: query.summary() })
	);
	await waitFor(() => expect(screen.queryByText("Rescanning")).toBeNull());
	expect(screen.getByLabelText("Index status")).toBe(status);
	await waitFor(() => expect(status.textContent).toContain("assets"));
	expect(search).toHaveProperty("value", "Quit");
});
it("opens a line as a page, steps to the next line and goes back to the list", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	await screen.findByText("2 matches");
	const results = within(screen.getByRole("region", { name: "Results" }));
	await user.click(results.getByRole("button", { name: /Continue/u }));
	const page = screen.getByRole("complementary", { name: "Text focus" });
	await within(page).findByRole("heading", { name: "Continue" });
	// The page knows where the line sits in the list and offers its neighbours.
	const rows = results.getAllByRole("button").filter((button) => button.hasAttribute("data-row"));
	const index = rows.findIndex((row) => row.textContent?.includes("Continue"));
	expect(within(page).getByText(`${index + 1} of ${rows.length}`)).toBeDefined();
	const properties = within(screen.getByRole("region", { name: "Properties" }));
	expect(properties.queryByText("Up to date")).toBeNull();
	expect(properties.getByText("UI")).toBeDefined();
	expect(properties.getByText("8 characters · 1 word")).toBeDefined();
	expect(properties.getByText("ST_Game")).toBeDefined();
	expect(properties.getByText("Content/Text")).toBeDefined();
	expect(properties.getByText("Editable")).toBeDefined();
	// An up-to-date line has nothing to resolve.
	expect(within(page).queryByRole("note", { name: "What this line needs" })).toBeNull();
	const step = index === 0 ? "Next line" : "Previous line";
	await user.click(within(page).getByRole("button", { name: step }));
	await within(page).findByRole("heading", { name: "Quit game?" });
	expect(properties.getByText("Read only")).toBeDefined();
	await user.click(within(page).getByRole("button", { name: "‹ Lines" }));
	await waitFor(() =>
		expect(screen.getByRole("tablist", { name: "Where the lines are" })).toBeDefined()
	);
	expect(screen.queryByRole("region", { name: "Properties" })).toBeNull();
});
it("offers only findings that have lines", async () => {
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
	const user = userEvent.setup({ delay: null });
	mount(makeClient(shared));
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u }));
	await user.click(screen.getByRole("menuitem", { name: /^Finding/u }));
	const findings = within(screen.getByRole("menu", { name: "Finding" }));
	expect(
		findings.getByRole("menuitemcheckbox", { name: "Used in several places 1" })
	).toBeDefined();
	// Findings without lines stay out of the menu.
	expect(findings.queryByRole("menuitemcheckbox", { name: /^Long text/u })).toBeNull();
});
it("debounces source-only search, shows Searching and never flashes a false empty state", async () => {
	const release = await runtime.runPromise(Deferred.make<void>());
	const initial = await runtime.runPromise(Deferred.make<void>());
	const query = textCorpusQuery(corpus);
	const client = makeClient(corpus, {
		search: (request) =>
			request.query === ""
				? Deferred.await(initial).pipe(
						Effect.as({ status: "ready" as const, page: query.search(request) })
					)
				: Deferred.await(release).pipe(
						Effect.as({ status: "ready" as const, page: query.search(request) })
					)
	});
	const user = userEvent.setup({ delay: null });
	mount(client);
	await screen.findByText("Searching…");
	expect(screen.queryByText(/No text matches/u)).toBeNull();
	await runtime.runPromise(Deferred.succeed(initial, undefined));
	await screen.findByText("2 matches");
	const input = screen.getByRole("searchbox", { name: "Search game text" });
	await user.type(input, "missing");
	expect(screen.getByText("Searching…")).toBeDefined();
	expect(screen.queryByText(/No text matches/u)).toBeNull();
	expect(document.activeElement).toBe(input);
	await runtime.runPromise(Deferred.succeed(release, undefined));
	await screen.findByText("0 matches");
	expect(screen.getByText(/No text matches/u)).toBeDefined();
});
it("requests a loaded scan's first page at once and debounces only typing", async () => {
	const query = textCorpusQuery(corpus);
	let loadedAt = 0;
	const searches: { query: string; at: number }[] = [];
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient(corpus, {
			loadConfiguredProject: () =>
				Effect.sync(() => {
					loadedAt = performance.now();
					return { status: "completed" as const, summary: query.summary() };
				}),
			search: (request) =>
				Effect.sync(() => {
					searches.push({ query: request.query, at: performance.now() });
					return { status: "ready" as const, page: query.search(request) };
				})
		})
	);
	await screen.findByText("2 matches");
	expect(searches[0]!.at - loadedAt).toBeLessThan(100);
	const typedAt = performance.now();
	await user.type(screen.getByRole("searchbox", { name: "Search game text" }), "Q");
	await screen.findByText("1 match");
	expect(searches.at(-1)!.query).toBe("Q");
	expect(searches.at(-1)!.at - typedAt).toBeGreaterThanOrEqual(110);
});
it("drops a late response when the search request has changed", async () => {
	const release = await runtime.runPromise(Deferred.make<void>());
	const requested: string[] = [];
	const query = textCorpusQuery(corpus);
	const user = userEvent.setup({ delay: null });
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
	const user = userEvent.setup({ delay: null });
	mount(makeClient(input));
	await screen.findByText("2 matches");
	await chooseFilter(user, "Translator notes", "No translator notes 1");
	await screen.findByText("1 match");
	expect(
		within(screen.getByRole("region", { name: "Results" })).queryByText("Quit game?")
	).toBeNull();
	await chooseFilter(user, "Editing", /^Editable/u);
	const pills = () => within(screen.getByRole("list", { name: "Filters" }));
	expect(pills().getByText("Translator notes")).toBeDefined();
	expect(pills().getByText("Editable")).toBeDefined();
	await user.click(screen.getByRole("button", { name: /^Remove Translator notes/u }));
	const results = within(screen.getByRole("region", { name: "Results" }));
	await results.findByText("Continue");
	// A pill's operator switches it to "is not".
	await user.click(pills().getByRole("button", { name: "is" }));
	expect(await results.findByText("Quit game?")).toBeDefined();
	expect(results.queryByText("Continue")).toBeNull();
	expect(pills().getByRole("button", { name: "is not" })).toBeDefined();
});
it("filters by origin and by a typed folder, and the side counts where lines are", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	await screen.findByText("2 matches");
	await chooseFilter(user, "Origin", "Data table 1");
	await screen.findByText("1 match");
	const results = () => within(screen.getByRole("region", { name: "Results" }));
	expect(results().getByText("Quit game?")).toBeDefined();
	expect(results().queryByText("Continue")).toBeNull();
	await user.click(screen.getByRole("button", { name: "Remove Origin is Data table" }));
	await screen.findByText("2 matches");

	// The Folder submenu browses a level at a time, like the side pane, and shares its level.
	await user.click(screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u }));
	await user.click(screen.getByRole("menuitem", { name: /^Folder/u }));
	const folders = () => within(screen.getByRole("menu", { name: "Folder" }));
	await user.click(folders().getByRole("menuitem", { name: "Folders in Content" }));
	await user.click(await folders().findByRole("menuitemcheckbox", { name: "Text 2 lines" }));
	await waitFor(() =>
		expect(
			within(screen.getByRole("list", { name: "Filters" })).getByText("content/text/")
		).toBeDefined()
	);
	// Inside a folder, the first item goes back up.
	expect(folders().getByRole("menuitem", { name: "Top folders" })).toBeDefined();
	await user.click(screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u }));
	await user.click(screen.getByRole("button", { name: /^Remove Folder/u }));
	// The side pane opened at the same level.
	const pane = within(screen.getByRole("region", { name: "Where the lines are" }));
	expect(pane.getByRole("button", { name: "Text 2 lines" })).toBeDefined();

	// Typed text narrows the level, and can add a path prefix in any spelling.
	await user.click(screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u }));
	await user.click(screen.getByRole("menuitem", { name: /^Folder/u }));
	await user.type(screen.getByRole("searchbox", { name: "Filter Folder" }), "content\\text\\st");
	expect(folders().queryByRole("menuitemcheckbox", { name: "Text 2 lines" })).toBeNull();
	await user.click(
		folders().getByRole("menuitemcheckbox", { name: "Path starts with content\\text\\st" })
	);
	await screen.findByText("1 match");
	expect(results().getByText("Continue")).toBeDefined();

	// The side lists origins; a name there adds its pill too.
	await user.click(screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u }));
	await user.click(screen.getByRole("button", { name: /^Remove Folder/u }));
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("tab", { name: "Origins" }));
	const side = within(screen.getByRole("region", { name: "Where the lines are" }));
	await user.click(side.getByRole("button", { name: /^String table/u }));
	await screen.findByText("1 match");
	expect(results().getByText("Continue")).toBeDefined();
});
it("shows the text a pasted changed-file list touches, for this session only", async () => {
	const saved: GameTextPreferences[] = [];
	const user = userEvent.setup({ delay: null });
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute
				client={makeClient()}
				onPreferencesChange={(preferences) => saved.push(preferences)}
			/>
		</EffectRuntimeProvider>
	));
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("button", { name: "Changed files" }));
	await user.type(
		screen.getByRole("textbox", { name: "Changed files, one path per line" }),
		"# from p4 opened{Enter}Content\\Text\\DT_Menu.uexp{Enter}Source/Unrelated.cpp"
	);
	await user.click(screen.getByRole("button", { name: "Show their text" }));
	await screen.findByText("1 match");
	const results = within(screen.getByRole("region", { name: "Results" }));
	expect(results.getByText("Quit game?")).toBeDefined();
	const trigger = screen.getByRole("button", { name: "Changed files, 2 files" });
	expect(trigger.getAttribute("aria-pressed")).toBe("true");
	await screen.findByText("2 files · 1 with text");
	expect(saved.at(-1)?.where).toBeUndefined();

	await user.click(trigger);
	await user.click(screen.getByRole("button", { name: "Clear files" }));
	await screen.findByText("2 matches");
	expect(screen.getByRole("button", { name: "Changed files" })).toBeDefined();
});
it.each([undefined, "example-project"])(
	"scans the host selected project only after the primary action (preference key: %s)",
	async (key) => {
		const calls: boolean[] = [];
		const query = textCorpusQuery(corpus);
		const user = userEvent.setup({ delay: null });
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
			key
		);
		await screen.findByText(
			"Game Text reads the project's saved assets, so Unreal does not need to be running."
		);
		expect(calls).toEqual([false]);
		await user.click(screen.getByRole("button", { name: "Scan project" }));
		await screen.findByText("2 matches");
		expect(calls).toEqual([false, true]);
	}
);
it("sends users to the workspace project picker when no project is selected", async () => {
	mount(
		makeClient(corpus, {
			loadConfiguredProject: () => Effect.succeed({ status: "not_configured" })
		})
	);
	await screen.findByText(
		"Choose a project using the workspace project picker, then return here."
	);
	expect(screen.queryByRole("button", { name: "Scan project" })).toBeNull();
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
	const user = userEvent.setup({ delay: null });
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
	await chooseFilter(user, "Editing", /^Editable/u);
	await screen.findByText("1 match");
	await chooseFilter(user, "Translator notes", /^No translator notes/u);
	await screen.findByText("1 match");
	await user.click(screen.getByRole("button", { name: "Display" }));
	await user.click(screen.getByRole("radio", { name: "Folder" }));
	await waitFor(() =>
		expect(window.localStorage.getItem("ue-shed:game-text:project-a")).toContain("Continue")
	);
	view.unmount();
	mount(client, undefined, "project-a");
	await screen.findByText("1 match");
	expect(screen.getByRole("searchbox")).toHaveProperty("value", "Continue");
	expect(await screen.findByRole("heading", { name: "Continue" })).toBeDefined();
	const pills = within(screen.getByRole("list", { name: "Filters" }));
	expect(pills.getByText("Editable")).toBeDefined();
	expect(pills.getByText("No translator notes")).toBeDefined();
	// The grouping is remembered too.
	expect(await screen.findByRole("region", { name: "Content/Text" })).toBeDefined();
	expect(calls).toEqual([false, false]);
	cleanup();
	mount(client, undefined, "project-b");
	await screen.findByText("2 matches");
	expect(screen.getByRole("searchbox")).toHaveProperty("value", "");
});
it("clears a remembered missing selection and safely defaults corrupt saved preferences", async () => {
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
	expect(screen.getByRole("tablist", { name: "Where the lines are" })).toBeDefined();
	cleanup();
	window.localStorage.setItem("ue-shed:game-text:project-a", "broken JSON");
	mount(makeClient(), undefined, "project-a");
	await screen.findByText("2 matches");
	expect(screen.getByRole("searchbox")).toHaveProperty("value", "");
});
it("shows key, stats, full paths and translator notes in detail and copies the key", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	const results = await screen.findByRole("region", { name: "Results" });
	await user.click(await within(results).findByRole("button", { name: /Continue/ }));
	const focus = screen.getByRole("complementary", { name: "Text focus" });
	await waitFor(() => expect(focus.textContent).toContain("UI · Continue"));
	expect(focus.textContent).toContain("8 characters · 1 word");
	expect(focus.textContent).toContain("1 location");
	expect(focus.textContent).toContain("String table entry");
	expect(focus.textContent).toContain("/Game/Text/ST_Game.ST_Game");
	expect(focus.textContent).toContain("No translator notes");
	await user.click(within(focus).getByRole("button", { name: "Copy key" }));
	await waitFor(() => expect(navigator.clipboard.readText()).resolves.toBe("UI · Continue"));
	const copyKey = within(focus).getByRole("button", { name: "Copy key" });
	await waitFor(() => expect(copyKey.getAttribute("title")).toBe("Copied"));
	expect(copyKey.textContent).toBe("");
	await user.click(within(focus).getByRole("button", { name: "Copy asset path" }));
	await waitFor(() =>
		expect(navigator.clipboard.readText()).resolves.toBe("/Game/Text/ST_Game.ST_Game")
	);
	await user.click(within(focus).getByRole("button", { name: "Copy text" }));
	await waitFor(() => expect(navigator.clipboard.readText()).resolves.toBe("Continue"));
});
it("does not warn about packages Unreal does not gather either", async () => {
	mount(
		makeClient({
			...corpus,
			coverage: { ...corpus.coverage, discoveredPackages: 3 },
			packageCoverage: [{ packageFile: "Content/Native.uasset", status: "not_gatherable" }],
			diagnostics: [
				{
					code: "package_not_gatherable",
					packageFile: "Content/Native.uasset",
					message: "Excluded because Unreal does not gather this package."
				}
			]
		})
	);
	await screen.findByText("2 matches");
	expect(screen.queryByRole("button", { name: "Read problems" })).toBeNull();
});
it("keeps unread gathered lines, excluded packages and related read problems inspectable", async () => {
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient({
			...corpus,
			status: "partial",
			coverage: {
				...corpus.coverage,
				discoveredPackages: 3,
				partialPackages: 1,
				failedPackages: 1,
				unsupportedTextProperties: 2,
				missingGatherableText: 3
			},
			packageCoverage: ["A", "B", "C", "D"].map((name) => ({
				packageFile: `Content/Native/${name}.uasset`,
				status: "not_gatherable" as const
			})),
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
	expect(trigger.textContent).toBe("3 lines not read");
	await user.click(trigger);
	const problems = screen.getByRole("dialog", { name: "Read problems" });
	expect(problems.textContent).toContain("Some text Unreal gathers");
	expect(problems.textContent).toContain(
		"3 lines listed in the assets' gather data could not be read"
	);
	expect(problems.textContent).toContain("4 assets skipped because Unreal does not gather");
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
it("cancels a scan without offering route-owned project selection", async () => {
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient(corpus, {
			loadConfiguredProject: (refresh) =>
				Effect.succeed({ status: refresh ? "cancelled" : "not_scanned" })
		})
	);
	await user.click(await screen.findByRole("button", { name: "Scan project" }));
	await screen.findByText("Scan cancelled. Your workspace project selection is unchanged.");
	expect(screen.getByRole("button", { name: "Scan project" })).toHaveProperty("disabled", false);
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
	await userEvent
		.setup({ delay: null })
		.click(await screen.findByRole("button", { name: "Scan project" }));
	const progress = await screen.findByRole("progressbar", {
		name: "Inspecting text-bearing packages"
	});
	expect(progress.getAttribute("aria-valuenow")).toBe("1");
	expect(progress.getAttribute("aria-valuemax")).toBe("2");
	expect(progress.querySelector("span")?.style.width).toBe("50%");
	expect(screen.queryByText(/No text matches/u)).toBeNull();
	await Effect.runPromise(
		Deferred.succeed(response, { status: "completed", summary: query.summary() })
	);
	await screen.findByText("2 matches");
	expect(screen.queryByRole("progressbar")).toBeNull();
});
it("keeps progress through translations and the first results query", async () => {
	let now = 1000;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const translations = await Effect.runPromise(Deferred.make<LocalizationTargetsResult>());
	const firstPage = await Effect.runPromise(Deferred.make<TextCorpusSearchResult>());
	const query = textCorpusQuery(corpus);
	mount(
		makeClient(corpus, {
			localizationTargets: () => Deferred.await(translations),
			localizationTarget: () => Effect.succeed({ status: "not_ready" }),
			localizationFocus: () => Effect.succeed({ status: "not_ready" }),
			progress: () =>
				Effect.succeed({
					completed: 3,
					total: 21,
					phase: "scanning",
					stage: "game_text",
					detail: "Reading localization files"
				}),
			search: () => Deferred.await(firstPage)
		})
	);
	const progress = await screen.findByRole("progressbar", {
		name: "Reading localization files"
	});
	expect(progress.getAttribute("aria-valuenow")).toBe("3");
	expect(progress.getAttribute("aria-valuemax")).toBe("21");
	expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", true);
	now = 61000;
	await Effect.runPromise(Deferred.succeed(translations, { status: "ready", targets: [] }));
	await waitFor(() =>
		expect(screen.getByLabelText("Index status").textContent).toContain("Loading first results")
	);
	expect(screen.queryByRole("progressbar")).toBeNull();
	expect(
		screen.getByLabelText("Index status").querySelector("[data-scan-activity]")
	).not.toBeNull();
	expect(screen.queryByText(/Ready in/u)).toBeNull();
	now = 181000;
	await Effect.runPromise(
		Deferred.succeed(firstPage, {
			status: "ready",
			page: query.search({ query: "", capability: "all", pageSize: 50 })
		})
	);
	await screen.findByText("2 matches");
	await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
	expect(screen.getByText(/Ready in 3:00/u)).toBeDefined();
	expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", false);
	clock.mockRestore();
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
		const user = userEvent.setup({ delay: null });
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
		await user.click(await within(list).findByRole("button", { name: /Continue/u }));
		const detail = screen.getByRole("complementary", {
			name: view === "quality" ? "Finding detail" : "Text focus"
		});
		await waitFor(() =>
			expect(within(detail).getAllByRole("button", { name: "Show in Unreal" })).toHaveLength(
				50
			)
		);
		await user.click(within(detail).getByRole("button", { name: "Show 1 more location" }));
		await waitFor(() =>
			expect(within(detail).getAllByRole("button", { name: "Show in Unreal" })).toHaveLength(
				51
			)
		);
		expect(within(detail).getByRole("heading", { name: "Continue" })).toBeDefined();
		expect(sizes.length).toBeGreaterThanOrEqual(2);
		expect(sizes.every((size) => size === 50)).toBe(true);
		expect(within(detail).queryByRole("button", { name: /Show \d+ more/u })).toBeNull();
	}
);
it("shows the quality overview and a warning for scopes with no lines", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	await openQuality(user);
	expect(screen.getByRole("tab", { name: "Quality checks, 3 findings" })).toBeDefined();
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
	const user = userEvent.setup({ delay: null });
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
	expect(screen.getByRole("button", { name: /^Terminology/ }).getAttribute("aria-pressed")).toBe(
		"true"
	);
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
