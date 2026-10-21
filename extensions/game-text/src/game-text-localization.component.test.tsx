import { render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	joinLocalizationTarget,
	localizationFocusPage,
	type LocalizationFileProblem,
	type LocalizationFocusResult,
	type LocalizationTargetResult,
	type LocalizationTranslation
} from "@ue-shed/game-text/corpus";
import { type LocalizationLinePreview } from "@ue-shed/game-text/schema";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	poDocument,
	target,
	unit
} from "../../../packages/game-text/src/localization.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { LocalizationRow } from "./game-text-localization-view.js";
import {
	choose,
	chooseFilter,
	client,
	filterValues,
	joined,
	localized,
	mount,
	second
} from "./game-text-localization.test-support.js";
import { storedGameTextPreferences } from "./game-text-preferences.js";
describe("Game Text localization", () => {
	it("connects the browse columns, culture summary and state filter while keeping the list beside the line", async () => {
		const user = userEvent.setup({ delay: null });
		mount();
		await screen.findByText("3 matches");
		await choose(user, "Culture", "fr");
		await user.click(screen.getByRole("button", { name: /^Culture:/u }));
		await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getByText("Key")).toBeDefined();
		expect(within(results).getByText("Translation · fr")).toBeDefined();
		const row = within(results).getByRole("button", { name: /^Welcome/u });
		expect(row.textContent).toContain("Bienvenue");
		expect(row.textContent).toContain("Needs update");
		await chooseFilter(user, "Translation", /^Needs update/u);
		await screen.findByText("1 match");
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		await within(screen.getByRole("complementary", { name: "Text focus" })).findByRole(
			"heading",
			{ name: "Welcome" }
		);
		const translations = await within(
			screen.getByRole("complementary", { name: "Text focus" })
		).findAllByRole("article", { name: /^Translation /u });
		expect(translations[0]?.getAttribute("aria-label")).toBe("Translation fr");
		expect(within(results).getByRole("button", { name: /^Welcome/u })).toBeDefined();
		expect(results.hasAttribute("hidden")).toBe(false);
		expect(screen.getByRole("region", { name: "Translation summary" }).textContent).toContain(
			"Needs update 1"
		);
		await user.click(
			screen.getByRole("button", { name: /Remove Translation is Needs update/u })
		);
		await screen.findByText("3 matches");
	});

	it("loads another target through the host and remembers the choice", async () => {
		const user = userEvent.setup({ delay: null });
		const api = client({ twoTargets: true });
		if (!api.localizationTarget) throw new Error("Missing target capability");
		const select = vi.fn(api.localizationTarget);
		const first = mount({ ...api, localizationTarget: select });
		await screen.findByText("3 matches");
		await choose(user, "Localization target", "Second");
		await screen.findByRole("button", { name: "Localization target: Second" });
		await screen.findByText("3 matches");
		await waitFor(() => expect(select.mock.calls).toEqual([[target.name], [second]]));
		await waitFor(() =>
			expect(storedGameTextPreferences("localization-project").localizationTarget).toBe(
				second
			)
		);
		first.unmount();
		select.mockClear();
		mount({ ...api, localizationTarget: select });
		await screen.findByText("3 matches");
		expect(screen.getByRole("button", { name: "Localization target: Second" })).toBeDefined();
		expect(select.mock.calls).toEqual([[second]]);
	});

	it("clears a vanished target, culture and remembered gathered selection quietly", async () => {
		window.localStorage.setItem(
			"ue-shed:game-text:localization-project",
			JSON.stringify({
				localizationTarget: "Vanished",
				localizationCulture: "xx",
				selectedLocalizationId: "vanished-line"
			})
		);
		const api = client();
		const search = vi.fn(api.search);
		mount({ ...api, search });
		await screen.findByText("3 matches");
		await waitFor(() => {
			const stored = storedGameTextPreferences("localization-project");
			expect(stored.localizationTarget).toBe(target.name);
			expect(stored.localizationCulture).toBeUndefined();
			expect(stored.selectedLocalizationId).toBeUndefined();
		});
		expect(
			search.mock.calls.every(([request]) => request.localization?.culture === undefined)
		).toBe(true);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("tablist", { name: "Where the lines are" })).toBeDefined();
	});

	it("clears a line that vanished from the remembered target", async () => {
		window.localStorage.setItem(
			"ue-shed:game-text:localization-project",
			JSON.stringify({
				localizationTarget: target.name,
				selectedLocalizationId: "vanished-line"
			})
		);
		mount();
		await screen.findByText("3 matches");
		await waitFor(() =>
			expect(
				storedGameTextPreferences("localization-project").selectedLocalizationId
			).toBeUndefined()
		);
		expect(screen.getByRole("tablist", { name: "Where the lines are" })).toBeDefined();
	});

	function withUnknownArchive(
		api: GameTextClientApi,
		problems?: readonly LocalizationFileProblem[]
	): GameTextClientApi {
		const focus = api.localizationFocus;
		const target = api.localizationTarget;
		if (!focus || !target) throw new Error("Missing localization capability");
		return {
			...api,
			localizationTarget: (name) =>
				target(name).pipe(
					Effect.map((result) =>
						result.status === "ready" && problems
							? { ...result, fileProblems: problems }
							: result
					)
				),
			localizationFocus: (request) =>
				focus(request).pipe(
					Effect.map(
						(result): LocalizationFocusResult =>
							result.status === "found"
								? {
										...result,
										focus: {
											...result.focus,
											translations:
												result.focus.translations.map<LocalizationTranslation>(
													(mark) =>
														mark.culture === "de"
															? {
																	...mark,
																	state: "unknown",
																	unknownReasons: [
																		"missing_archive"
																	],
																	gameTranslation: null,
																	gameTextKind: "unavailable"
																}
															: mark
												)
										}
									}
								: result
					)
				)
		};
	}

	async function openWelcome() {
		const user = userEvent.setup({ delay: null });
		await screen.findByText("3 matches");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
	}

	it("explains unavailable translation evidence in plain words", async () => {
		mount(withUnknownArchive(client()));
		await openWelcome();
		await screen.findByText("The game's translation file is unavailable.");
		expect(
			within(screen.getByRole("article", { name: "Translation de" })).getByText("Unknown")
		).toBeDefined();
	});

	it("names a translation file the working copy does not have", async () => {
		mount(
			withUnknownArchive(client(), [
				{
					kind: "archive",
					culture: cultureCode("de"),
					path: "Content/Localization/Game/de/Game.archive",
					state: "missing",
					code: "file_missing",
					recovery: "Restore the expected file."
				}
			])
		);
		await openWelcome();
		const text = await screen.findByText(
			/^Not in this working copy: Content\/Localization\/Game\/de\/Game\.archive/u
		);
		expect(text.textContent).toContain("Run the target's Gather step");
		expect(screen.queryByText(/could not be read/u)).toBeNull();
	});

	it("adds target/culture pickers, query counts and a persistent pending-translation warning", async () => {
		const user = userEvent.setup({ delay: null });
		mount(client({ twoTargets: true }));
		await screen.findByText("3 matches");
		expect(screen.getByRole("button", { name: /^Localization target:/u })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Culture: All cultures" }));
		const choices = screen.getByRole("dialog", { name: "Culture choices" });
		expect(within(choices).getAllByRole("button")).toHaveLength(4);
		expect(
			within(choices)
				.getByRole("button", { name: "All cultures" })
				.getAttribute("aria-pressed")
		).toBe("true");
		await user.keyboard("{Escape}");
		expect(
			screen.getByText(
				(_text, element) =>
					element?.tagName === "SPAN" &&
					element.textContent?.startsWith("3 lines · 1 asset") === true
			)
		).toBeDefined();
		// Translation work in the Filter menu, counted from the page.
		expect(await filterValues(user, "Translation")).toEqual(["Needs update 1", "Not synced 1"]);
		const indicator = screen.getByText("1 not synced", { exact: true });
		expect(indicator.title).toBe(
			"Translations saved in PO files that Unreal has not imported yet"
		);
		await choose(user, "Culture", "de");
		await chooseFilter(user, "Translation", /^Not synced/u);
		await screen.findByText("1 match");
		expect(screen.getByText("1 not synced", { exact: true })).toBeDefined();
		await user.type(screen.getByRole("searchbox"), "absent");
		await screen.findByText("0 matches");
		// The pill stays while nothing matches.
		expect(
			within(screen.getByRole("list", { name: "Filters" })).getByText("Not synced")
		).toBeDefined();
	});
	it("shows selected-culture translations, opt-in translation search and native-first details", async () => {
		const user = userEvent.setup({ delay: null });
		mount();
		await screen.findByText("3 matches");
		expect(screen.queryByRole("button", { name: /^Localization target:/u })).toBeNull();
		const results = screen.getByRole("region", { name: "Results" });
		// Without a picked culture, each line shows every culture's state as a strip.
		expect(within(results).getByText("de not synced · fr need update")).toBeDefined();
		expect(
			within(results).getByRole("img", { name: "en shipped, de not synced, fr need update" })
		).toBeDefined();
		await choose(user, "Culture", "de");
		await screen.findByText("Neue Begrüßung");
		expect(
			within(results).getAllByText(/Not translated|Not gathered yet/).length
		).toBeGreaterThan(0);
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		const translations = await screen.findByRole("region", { name: "Translations" });
		await within(translations).findByText("Willkommen");
		const cards = within(translations).getAllByRole("article");
		expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
			"Translation de",
			"Translation en",
			"Translation fr"
		]);
		const german = within(translations).getByRole("article", { name: "Translation de" });
		expect(within(german).getByText("In PO, not synced")).toBeDefined();
		expect(within(german).getByText("Neue Begrüßung")).toBeDefined();
		expect(within(german).getByText("Old greeting")).toBeDefined();
		expect(within(german).getByText("translator")).toBeDefined();
		expect(within(german).getByText("PO flags: fuzzy")).toBeDefined();
		expect(within(translations).getByText("Manifest key path")).toBeDefined();
		const french = within(translations).getByRole("article", { name: "Translation fr" });
		expect(
			within(french).getByText("Welcome (source text — the translation is out of date)")
		).toBeDefined();
		expect(within(french).getByText("Translation (out of date)")).toBeDefined();
		expect(within(french).getByText("Bienvenue")).toBeDefined();
		expect(within(french).queryByText("In PO, not synced")).toBeNull();
		await user.type(screen.getByRole("searchbox"), "Neue");
		await screen.findByText("0 matches");
		await user.click(screen.getByRole("button", { name: "Search translations" }));
		await screen.findByText("1 match");
		expect(screen.getByPlaceholderText("Search text and translations")).toBeDefined();
	});
	it("supports keyboard culture choices and restores focus without native selects", async () => {
		const user = userEvent.setup({ delay: null });
		mount();
		await screen.findByText("3 matches");
		expect(screen.queryByRole("combobox")).toBeNull();
		const trigger = screen.getByRole("button", { name: "Culture: All cultures" });
		trigger.focus();
		await user.keyboard("{Enter}");
		const choices = await screen.findByRole("dialog", { name: "Culture choices" });
		await waitFor(() =>
			expect(within(choices).getByRole("button", { name: "All cultures" })).toBe(
				document.activeElement
			)
		);
		// Enter picks a culture and keeps the choices open, so several can be picked.
		await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		await screen.findByRole("button", { name: "Culture: de" });
		expect(within(choices).getByRole("button", { name: "de" })).toBe(document.activeElement);
		await user.keyboard("{ArrowDown}{Enter}");
		await screen.findByRole("button", { name: "Culture: de, fr" });
		await user.keyboard("{Escape}");
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("dialog", { name: "Culture choices" })).toBeNull();
		// Reopening focuses the first picked culture; "All cultures" clears the choice.
		await user.keyboard("{Enter}");
		const reopened = await screen.findByRole("dialog", { name: "Culture choices" });
		await waitFor(() =>
			expect(within(reopened).getByRole("button", { name: "de" })).toBe(
				document.activeElement
			)
		);
		await user.keyboard("{Home}{Enter}{Escape}");
		await screen.findByRole("button", { name: "Culture: All cultures" });
	});

	it("narrows counts, the strip and translation search to several picked cultures", async () => {
		const user = userEvent.setup({ delay: null });
		mount();
		await screen.findByText("3 matches");
		await user.click(screen.getByRole("button", { name: "Culture: All cultures" }));
		const choices = screen.getByRole("dialog", { name: "Culture choices" });
		// Each culture shows its work over the current filters.
		expect(
			within(choices).getByRole("button", { name: "de", description: /not synced/u })
		).toBeDefined();
		await user.click(within(choices).getByRole("button", { name: "en" }));
		await user.click(within(choices).getByRole("button", { name: "fr" }));
		await user.keyboard("{Escape}");
		await screen.findByRole("button", { name: "Culture: en, fr" });
		const results = within(screen.getByRole("region", { name: "Results" }));
		// The strip shows the picked cultures only.
		expect(
			await results.findByRole("img", { name: "en shipped, fr need update" })
		).toBeDefined();
		expect(results.queryByText(/de not synced/u)).toBeNull();
		// Translation search covers every picked culture.
		await user.click(screen.getByRole("button", { name: "Search translations" }));
		await user.type(screen.getByRole("searchbox"), "Bienvenue");
		await waitFor(() => expect(results.getByText(/Welcome/u)).toBeDefined());
	});
	it("omits informational or fully translated row marks, while keeping translations visible", () => {
		const preview = localized.search({
			query: "Welcome",
			capability: "all",
			pageSize: 50,
			localization: { target: target.name }
		}).localization?.lines[0];
		if (!preview) throw new Error("Missing preview");
		for (const state of ["outside_target", "gathered_only"] as const) {
			const line = {
				...preview,
				cultures: preview.cultures.map<LocalizationLinePreview["cultures"][number]>(
					(mark) => ({ ...mark, state, facts: [state], translation: null })
				)
			};
			const selected = render(() => <LocalizationRow line={line} culture="de" />);
			expect(selected.container.textContent).toBe("");
			selected.unmount();
			const all = render(() => <LocalizationRow line={line} culture={undefined} />);
			expect(all.container.textContent).toBe("");
			all.unmount();
		}
		const translated = {
			...preview,
			cultures: preview.cultures.map<LocalizationLinePreview["cultures"][number]>((mark) => ({
				...mark,
				state: "translated",
				facts: ["translated"],
				translation: "Translation"
			}))
		};
		const all = render(() => <LocalizationRow line={translated} culture={undefined} />);
		expect(all.container.textContent).toBe("");
		all.unmount();
		const visible = render(() => <LocalizationRow line={translated} culture="de" />);
		expect(visible.container.textContent).toBe("Translation");
	});
	it("summarizes an excluded asset once without empty culture cards or runtime claims", async () => {
		const user = userEvent.setup({ delay: null });
		const outside = joinLocalizationTarget(
			corpus([unit("K", "Welcome", "Content/Elsewhere/Table.uasset")]),
			evidence([], [], { ...poDocument(""), blocks: [] })
		);
		const line = outside.lines[0];
		if (!line) throw new Error("Missing outside line");
		mount({
			...client(),
			localizationFocus: (request) =>
				Effect.succeed({
					status: "found",
					focus: localizationFocusPage(outside, line, request)
				})
		});
		await screen.findByText("3 matches");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
		const translations = await screen.findByRole("region", { name: "Translations" });
		await within(translations).findByText(
			"Not part of Test: its asset is excluded by the target's gather settings."
		);
		expect(within(translations).queryByRole("article")).toBeNull();
		expect(within(translations).queryByText("In the game")).toBeNull();
		expect(within(translations).queryByText("No translation")).toBeNull();
	});
	it("shows source text in the game for an untranslated culture without a pending PO edit", async () => {
		const user = userEvent.setup({ delay: null });
		const untranslated = joinLocalizationTarget(
			corpus([unit("K", "Welcome")]),
			evidence(
				[manifestEntry("K", "Welcome")],
				[archiveEntry("K", "Welcome", "")],
				poDocument("")
			)
		);
		const line = untranslated.lines[0];
		if (!line) throw new Error("Missing untranslated line");
		mount({
			...client(),
			localizationFocus: (request) =>
				Effect.succeed({
					status: "found",
					focus: localizationFocusPage(untranslated, line, request)
				})
		});
		await screen.findByText("3 matches");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
		const german = await screen.findByRole("article", { name: "Translation de" });
		await within(german).findByText("Welcome (source text — not translated)");
		expect(within(german).getByText("In the game")).toBeDefined();
		expect(within(german).getByText("Not translated")).toBeDefined();
		expect(within(german).queryByText("In PO, not synced")).toBeNull();
		expect(within(german).queryByText("No translation")).toBeNull();
	});
	it("loads more PO comments and flags through bounded detail requests", async () => {
		const user = userEvent.setup({ delay: null });
		const api = client();
		if (!api.localizationFocus) throw new Error("Missing focus capability");
		const original = api.localizationFocus;
		const focus = vi.fn((request: Parameters<typeof original>[0]) =>
			original(request).pipe(
				Effect.map(
					(result): LocalizationFocusResult =>
						result.status === "found"
							? {
									...result,
									focus: {
										...result.focus,
										translations:
											result.focus.translations.map<LocalizationTranslation>(
												(mark) => {
													if (mark.culture !== "de") return mark;
													const offset = request.poContextOffset ?? 0;
													return {
														...mark,
														translatorComments: Array.from(
															{ length: 57 },
															(_, index) => "Comment " + index
														).slice(offset, offset + 50),
														flags: Array.from(
															{ length: 53 },
															(_, index) => "flag-" + index
														).slice(offset, offset + 50),
														remainingComments: Math.max(
															0,
															57 - offset - 50
														),
														remainingFlags: Math.max(
															0,
															53 - offset - 50
														),
														...(offset === 0
															? { nextContextOffset: 50 }
															: undefined)
													};
												}
											)
									}
								}
							: result
				)
			)
		);
		mount({ ...api, localizationFocus: focus });
		await screen.findByText("3 matches");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
		await screen.findByText("Comment 49");
		expect(screen.queryByText("Comment 50")).toBeNull();
		await user.click(screen.getByRole("button", { name: "Show more PO comments and flags" }));
		await screen.findByText("Comment 56");
		expect(screen.getByText("Comment 0")).toBeDefined();
		expect(screen.getByText(/PO flags: flag-0.*flag-52/u)).toBeDefined();
		expect(
			screen.queryByRole("button", { name: "Show more PO comments and flags" })
		).toBeNull();
		expect(focus.mock.calls.at(-1)?.[0]).toMatchObject({
			cultureOffset: 0,
			poContextOffset: 50
		});
	});
	it("presents gathered-only locations without asset actions", async () => {
		const user = userEvent.setup({ delay: null });
		mount();
		await screen.findByText("3 matches");
		await chooseFilter(user, "Line state", "Gathered only 1");
		await screen.findByText("1 match");
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getByText("Source/Example.cpp(12) · C++")).toBeDefined();
		await user.click(within(results).getByRole("button", { name: /^Code greeting/u }));
		const detail = screen.getByRole("complementary", { name: "Text focus" });
		await within(detail).findByRole("heading", { name: "Code greeting" });
		expect(within(detail).queryByRole("button", { name: "Show in Unreal" })).toBeNull();
		expect(within(detail).queryByRole("button", { name: "Copy asset path" })).toBeNull();
		expect(within(detail).getByText(/Gathered from source code/)).toBeDefined();
	});
	it("persists target, culture, state, translation-search and selected line across fresh mounts", async () => {
		const user = userEvent.setup({ delay: null });
		const api = client();
		const load = vi.fn(api.loadConfiguredProject);
		const first = mount({ ...api, loadConfiguredProject: load });
		await screen.findByText("3 matches");
		await choose(user, "Culture", "de");
		await user.click(screen.getByRole("button", { name: "Search translations" }));
		await chooseFilter(user, "Translation", /^Not synced/u);
		await screen.findByText("1 match");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
		await screen.findByRole("region", { name: "Translations" });
		await waitFor(() =>
			expect(
				storedGameTextPreferences("localization-project").selectedLocalizationId
			).toBeDefined()
		);
		first.unmount();
		mount({ ...api, loadConfiguredProject: load });
		await screen.findByText("1 match");
		expect(screen.getByRole("button", { name: "Culture: de" })).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Search translations" }).getAttribute("aria-pressed")
		).toBe("true");
		expect(
			within(screen.getByRole("list", { name: "Filters" })).getByText("Not synced")
		).toBeDefined();
		await screen.findByRole("region", { name: "Translations" });
		expect(load.mock.calls).toEqual([[false], [false]]);
	});
	it("shows loading without false rows, counts or empty states while evidence is pending", async () => {
		const user = userEvent.setup({ delay: null });
		const pending = await Effect.runPromise(Deferred.make<LocalizationTargetResult>());
		mount(client({ target: () => Deferred.await(pending) }));
		await waitFor(() =>
			expect(screen.getByLabelText("Index status").textContent).toContain(
				"Loading translations"
			)
		);
		expect(screen.queryByRole("progressbar")).toBeNull();
		expect(screen.queryByText("No text matches these filters.")).toBeNull();
		expect(screen.queryByText("0 matches")).toBeNull();
		expect(screen.queryByRole("button", { name: /Not synced/ })).toBeNull();
		const descriptor = {
			name: target.name,
			nativeCulture: joined.nativeCulture,
			cultures: joined.cultures
		};
		await Effect.runPromise(
			Deferred.succeed(pending, {
				status: "ready",
				target: descriptor,
				lines: 3,
				notSynced: 1
			})
		);
		await screen.findByText("3 matches");
		await choose(user, "Culture", "de");
		expect(screen.queryByText("Loading translations…")).toBeNull();
	});

	it.each([true])(
		"keeps source browsing available after a failed evidence read (saved filters: %s)",
		async (filtered) => {
			if (filtered)
				window.localStorage.setItem(
					"ue-shed:game-text:localization-project",
					JSON.stringify({
						filter: [
							{ field: "translation", op: "is", values: ["to_update"] },
							{ field: "problem", op: "is", values: ["key_changed"] }
						]
					})
				);
			mount(
				client({
					target: () =>
						Effect.succeed({
							status: "failed",
							code: "file_unreadable",
							message: "Localization files could not be loaded.",
							recovery: "Rescan to try again."
						})
				})
			);
			await screen.findByRole("alert");
			await screen.findByText("2 matches");
			expect(screen.getByRole("button", { name: "Retry translations" })).toBeDefined();
			expect(screen.queryByText("Loading translations…")).toBeNull();
			expect(screen.queryByText("0 matches")).toBeNull();
			expect(screen.queryByText("No text matches these filters.")).toBeNull();
		}
	);
});
