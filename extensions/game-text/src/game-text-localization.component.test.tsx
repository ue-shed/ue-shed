// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	joinLocalizationTarget,
	localizationFocusPage,
	textCorpusQuery,
	LocalizationJoin,
	LocalizationSelection,
	type LocalizationCultureState,
	type LocalizationEditRequest,
	type LocalizationEditResult,
	type LocalizationLinePreview,
	type LocalizationFocusResult,
	type LocalizationTranslation,
	type LocalizationTargetResult
} from "@ue-shed/game-text/browser";
import {
	corpus,
	unit,
	evidence,
	archiveEntry,
	manifestEntry,
	poDocument,
	cultureCode,
	target
} from "../../../packages/game-text/src/localization.test-support.js";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";
import { decodeGameTextPreferences } from "./game-text-preferences.js";
import { LocalizationRow } from "./game-text-localization-view.js";

const runtime = ManagedRuntime.make(Layer.empty);
const text = corpus([unit("K", "Welcome"), unit("Fresh", "Fresh line")]);
const base = joinLocalizationTarget(
	text,
	evidence(
		[
			manifestEntry("K", "Welcome"),
			manifestEntry("Code", "Code greeting", "Source/Example.cpp(12)")
		],
		[archiveEntry("K", "Old greeting", "Willkommen")],
		poDocument("Neue Begrüßung")
	)
);
const joined = LocalizationJoin.make({
	...base,
	cultures: [...base.cultures, cultureCode("fr")],
	lines: base.lines.map((line) => ({
		...line,
		cultures: line.cultures
			.map<LocalizationCultureState>((mark) =>
				mark.culture === "en"
					? {
							...mark,
							state: "translated",
							facts: ["translated"],
							archive: archiveEntry("K", "Welcome", line.source),
							poTranslation: null,
							po: null
						}
					: mark
			)
			.concat([
				{
					culture: cultureCode("fr"),
					state:
						line.identity?.key === "K"
							? "needs_update"
							: (line.cultures[0]?.state ?? "unknown"),
					facts: line.identity?.key === "K" ? ["needs_update"] : [],
					unknownReasons: [],
					reducedSourceChecking: false,
					archive:
						line.identity?.key === "K"
							? archiveEntry("K", "Old greeting", "Bienvenue")
							: null,
					poTranslation: null,
					po: null
				}
			])
	}))
});
const localized = textCorpusQuery(text, undefined, joined);
const plain = textCorpusQuery(text);
const second = LocalizationSelection.fields.target.make("Second");

function client(
	options: {
		readonly twoTargets?: boolean;
		readonly targets?: GameTextClientApi["localizationTargets"];
		readonly target?: GameTextClientApi["localizationTarget"];
	} = {}
): GameTextClientApi {
	const descriptor = {
		name: target.name,
		nativeCulture: joined.nativeCulture,
		cultures: joined.cultures
	};
	const baseline = localized.search({
		query: "",
		capability: "all",
		pageSize: 50,
		localization: { target: target.name }
	});
	return {
		projectKey: () => Effect.succeed("localization-project"),
		localizationTargets:
			options.targets ??
			(() =>
				Effect.succeed({
					status: "ready",
					targets: options.twoTargets
						? [descriptor, { ...descriptor, name: second }]
						: [descriptor]
				})),
		localizationTarget:
			options.target ??
			((name) =>
				Effect.succeed({
					status: "ready",
					target: { ...descriptor, name },
					lines: baseline.total,
					notSynced: baseline.localization?.notSynced ?? 0
				})),
		localizationFocus: (request) => {
			const id =
				request.selection.kind === "line"
					? request.selection.id
					: localized.focus({ id: request.selection.id, pageSize: 1 })?.localization?.id;
			const line = id ? localized.localizationFocus(id) : undefined;
			return Effect.succeed(
				line
					? { status: "found", focus: localizationFocusPage(joined, line, request) }
					: { status: "not_found" }
			);
		},
		loadConfiguredProject: () =>
			Effect.succeed({ status: "completed", summary: plain.summary() }),
		chooseProjectAndScan: () =>
			Effect.succeed({ status: "completed", summary: plain.summary() }),
		search: (request) =>
			Effect.succeed({
				status: "ready",
				page: (request.localization
					? textCorpusQuery(text, undefined, {
							...joined,
							target: request.localization.target
						})
					: plain
				).search(request)
			}),
		focus: (request) => {
			const focus = plain.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		progress: () =>
			Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "game_text" }),
		locateAsset: (objectPath) =>
			Effect.succeed({
				status: "located",
				objectPath,
				contract: {
					name: "unreal-editor-asset-navigation",
					version: { major: 1, minor: 0 }
				}
			}),
		chooseQualityRules: () => Effect.succeed({ status: "not_ready" }),
		qualitySearch: () => Effect.succeed({ status: "not_ready" }),
		qualityFocus: () => Effect.succeed({ status: "not_ready" }),
		previewQualityRules: () => Effect.succeed({ status: "not_ready" }),
		saveQualityRules: () => Effect.succeed({ status: "not_ready" })
	};
}

function mount(api = client()) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={api} />
		</EffectRuntimeProvider>
	));
}

async function choose(
	user: ReturnType<typeof userEvent.setup>,
	label: "Culture" | "Localization target",
	value: string
) {
	await user.click(screen.getByRole("button", { name: new RegExp("^" + label + ":", "u") }));
	await user.click(
		within(screen.getByRole("dialog", { name: label + " choices" })).getByRole("button", {
			name: value
		})
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
afterAll(() => runtime.dispose());
// Node 26 owns a global localStorage too. Always use an isolated in-memory test store.
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear()
	});
});

describe("Game Text localization", () => {
	it("loads another target through the host and remembers the choice", async () => {
		const user = userEvent.setup();
		const api = client({ twoTargets: true });
		if (!api.localizationTarget) throw new Error("Missing target capability");
		const select = vi.fn(api.localizationTarget);
		const first = mount({ ...api, localizationTarget: select });
		await screen.findByText("3 matches");
		await choose(user, "Localization target", "Second");
		await screen.findByRole("button", { name: "All text 3" });
		await waitFor(() => expect(select.mock.calls).toEqual([[target.name], [second]]));
		await waitFor(() =>
			expect(
				decodeGameTextPreferences(
					window.localStorage.getItem("ue-shed:game-text:localization-project") ?? "{}"
				).localizationTarget
			).toBe(second)
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
			const stored = decodeGameTextPreferences(
				window.localStorage.getItem("ue-shed:game-text:localization-project") ?? "{}"
			);
			expect(stored.localizationTarget).toBe(target.name);
			expect(stored.localizationCulture).toBeUndefined();
			expect(stored.selectedLocalizationId).toBeUndefined();
		});
		expect(
			search.mock.calls.every(([request]) => request.localization?.culture === undefined)
		).toBe(true);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByText(/Select a line to see/)).toBeDefined();
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
				decodeGameTextPreferences(
					window.localStorage.getItem("ue-shed:game-text:localization-project") ?? "{}"
				).selectedLocalizationId
			).toBeUndefined()
		);
		expect(screen.getByText(/Select a line to see/)).toBeDefined();
	});

	it("explains unavailable translation evidence in plain words", async () => {
		const user = userEvent.setup();
		const api = client();
		if (!api.localizationFocus) throw new Error("Missing focus capability");
		const focus = api.localizationFocus;
		mount({
			...api,
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
		});
		await screen.findByText("3 matches");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
				name: /^Welcome/u
			})
		);
		await screen.findByText("The game's translation file could not be read.");
		expect(
			within(screen.getByRole("article", { name: "Translation de" })).getByText("Unknown")
		).toBeDefined();
	});
	it("adds target/culture pickers, query counts and a persistent pending-translation warning", async () => {
		const user = userEvent.setup();
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
		expect(screen.getByRole("button", { name: "All text 3" })).toBeDefined();
		expect(
			screen.getByText(
				(_text, element) =>
					element?.tagName === "SPAN" && element.textContent === "3 lines · 1 asset"
			)
		).toBeDefined();
		expect(screen.getByRole("button", { name: "Not synced 1" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Needs update 1" })).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Unknown/ })).toBeNull();
		const indicator = screen.getByText("1 not synced", { exact: true });
		expect(indicator.title).toBe(
			"Translations saved in PO files that Unreal has not imported yet"
		);
		await choose(user, "Culture", "de");
		await user.click(await screen.findByRole("button", { name: "Not synced 1" }));
		await screen.findByText("1 match");
		expect(screen.getByRole("button", { name: "All text 1" })).toBeDefined();
		expect(screen.getByText("1 not synced", { exact: true })).toBeDefined();
		await user.type(screen.getByRole("searchbox"), "absent");
		await screen.findByText("0 matches");
		expect(screen.getByRole("button", { name: "Not synced 0" })).toBeDefined();
		expect(screen.queryByRole("button", { name: /^Needs update/ })).toBeNull();
	});
	it("shows selected-culture translations, opt-in translation search and native-first details", async () => {
		const user = userEvent.setup();
		mount();
		await screen.findByText("3 matches");
		expect(screen.queryByRole("button", { name: /^Localization target:/u })).toBeNull();
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getByText(/de · not synced · fr · needs update/)).toBeDefined();
		await choose(user, "Culture", "de");
		await screen.findByText("Neue Begrüßung");
		expect(within(results).getByText(/Not translated|Not gathered yet/)).toBeDefined();
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		const translations = await screen.findByRole("region", { name: "Translations" });
		await within(translations).findByText("Willkommen");
		const cards = within(translations).getAllByRole("article");
		expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
			"Translation en",
			"Translation de",
			"Translation fr"
		]);
		expect(within(cards[1]!).getByText("In PO, not synced")).toBeDefined();
		expect(within(cards[1]!).getByText("Neue Begrüßung")).toBeDefined();
		expect(within(cards[1]!).getByText("Old greeting")).toBeDefined();
		expect(within(cards[1]!).getByText("translator")).toBeDefined();
		expect(within(cards[1]!).getByText("PO flags: fuzzy")).toBeDefined();
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
		const user = userEvent.setup();
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
		await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		await screen.findByRole("button", { name: "Culture: de" });
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("dialog", { name: "Culture choices" })).toBeNull();
		await user.keyboard("{Enter}{Escape}");
		await waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(screen.queryByRole("dialog", { name: "Culture choices" })).toBeNull();
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
		const user = userEvent.setup();
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
		const user = userEvent.setup();
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
		const user = userEvent.setup();
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
		const user = userEvent.setup();
		mount();
		await screen.findByText("3 matches");
		await user.click(screen.getByRole("button", { name: "Gathered only 1" }));
		await screen.findByText("1 match");
		const results = screen.getByRole("region", { name: "Results" });
		expect(within(results).getByText("Source/Example.cpp(12) · C++")).toBeDefined();
		await user.click(within(results).getByRole("button"));
		const detail = screen.getByRole("complementary", { name: "Text focus" });
		await within(detail).findByRole("heading", { name: "Code greeting" });
		expect(within(detail).queryByRole("button", { name: "Show in Unreal" })).toBeNull();
		expect(within(detail).queryByRole("button", { name: "Copy asset path" })).toBeNull();
		expect(within(detail).getByText(/Gathered from source code/)).toBeDefined();
	});
	it("persists target, culture, state, translation-search and selected line across fresh mounts", async () => {
		const user = userEvent.setup();
		const api = client();
		const load = vi.fn(api.loadConfiguredProject);
		const first = mount({ ...api, loadConfiguredProject: load });
		await screen.findByText("3 matches");
		await choose(user, "Culture", "de");
		await user.click(screen.getByRole("button", { name: "Search translations" }));
		await user.click(await screen.findByRole("button", { name: "Not synced 1" }));
		await screen.findByText("1 match");
		await user.click(
			within(screen.getByRole("region", { name: "Results" })).getByRole("button")
		);
		await screen.findByRole("region", { name: "Translations" });
		await waitFor(() =>
			expect(
				decodeGameTextPreferences(
					window.localStorage.getItem("ue-shed:game-text:localization-project") ?? "{}"
				).selectedLocalizationId
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
			screen.getByRole("button", { name: "Not synced 1" }).getAttribute("aria-pressed")
		).toBe("true");
		await screen.findByRole("region", { name: "Translations" });
		expect(load.mock.calls).toEqual([[false], [false]]);
	});
	it("shows loading without false rows, counts or empty states while evidence is pending", async () => {
		const user = userEvent.setup();
		const pending = await Effect.runPromise(Deferred.make<LocalizationTargetResult>());
		mount(client({ target: () => Deferred.await(pending) }));
		await screen.findByText("Loading translations…");
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
	it("leaves projects with no targets unchanged", async () => {
		mount(client({ targets: () => Effect.succeed({ status: "ready", targets: [] }) }));
		await screen.findByText("2 matches");
		expect(
			screen.queryByRole("button", { name: /^Culture:|^Localization target:/u })
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Search translations" })).toBeNull();
		expect(screen.queryByText(/not synced/u)).toBeNull();
	});

	it("shows a failed evidence read without leaving a false loading or zero state", async () => {
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
		expect(screen.getAllByText("Translations unavailable")).toHaveLength(2);
		expect(screen.queryByText("Loading translations…")).toBeNull();
		expect(screen.queryByText("0 matches")).toBeNull();
		expect(screen.queryByText("No text matches these filters.")).toBeNull();
	});
});

describe("Game Text translation editing", () => {
	function editingClient(respond: (request: LocalizationEditRequest) => LocalizationEditResult) {
		const requests: LocalizationEditRequest[] = [];
		const api: GameTextClientApi = {
			...client(),
			localizationEdits: (request) => {
				requests.push(request);
				return Effect.succeed(respond(request));
			}
		};
		return { api, requests };
	}
	const frenchPO = "Content/Localization/Fixture/fr/Fixture.po";

	async function stageFrench(user: ReturnType<typeof userEvent.setup>) {
		await screen.findByText("3 matches");
		const results = screen.getByRole("region", { name: "Results" });
		await user.click(within(results).getByRole("button", { name: /^Welcome/u }));
		const translations = await screen.findByRole("region", { name: "Translations" });
		const english = await within(translations).findByRole("article", {
			name: "Translation en"
		});
		// The native culture's text is its source; it is never edited here.
		expect(within(english).queryByRole("button", { name: "Edit" })).toBeNull();
		const french = within(translations).getByRole("article", { name: "Translation fr" });
		await user.click(within(french).getByRole("button", { name: "Edit" }));
		const field = within(french).getByRole("textbox", { name: "New fr translation" });
		expect(field).toHaveProperty("value", "Bienvenue");
		expect(within(french).getByRole("button", { name: "Stage" })).toHaveProperty(
			"disabled",
			true
		);
		await user.clear(field);
		await user.type(field, "Bon retour");
		await user.click(within(french).getByRole("button", { name: "Stage" }));
		expect(within(french).getByText("Staged: Bon retour")).toBeDefined();
	}

	it("stages an edit against the translation that ships, checks it, and writes it", async () => {
		const user = userEvent.setup();
		const outcome = (request: LocalizationEditRequest) =>
			request.edits.map((edit) => ({
				culture: edit.culture,
				namespace: edit.namespace,
				key: edit.key,
				outcome: "ready" as const,
				currentTranslation: edit.seenTranslation,
				translation: edit.translation
			}));
		const { api, requests } = editingClient((request) =>
			request.mode === "review"
				? {
						status: "reviewed",
						edits: outcome(request),
						files: [
							{
								culture: cultureCode("fr"),
								relativePath: frenchPO,
								changes: 1,
								written: false
							}
						],
						notSynced: 1
					}
				: {
						status: "written",
						edits: outcome(request),
						files: [
							{
								culture: cultureCode("fr"),
								relativePath: frenchPO,
								changes: 1,
								written: true
							}
						],
						notSynced: 2
					}
		);
		mount(api);
		await stageFrench(user);
		await user.click(screen.getByRole("button", { name: "1 staged" }));
		const panel = screen.getByRole("region", { name: "Staged translations" });
		expect(within(panel).getByText("Bienvenue")).toBeDefined();
		expect(within(panel).getByText("Bon retour")).toBeDefined();
		// Writing is only offered after the edits were checked against the project's files.
		expect(within(panel).getByRole("button", { name: "Write to PO" })).toHaveProperty(
			"disabled",
			true
		);
		await user.click(within(panel).getByRole("button", { name: "Check changes" }));
		await within(panel).findByText("Ready to write");
		expect(within(panel).getByText(frenchPO)).toBeDefined();
		expect(requests[0]).toEqual({
			target: target.name,
			mode: "review",
			edits: [
				{
					culture: "fr",
					namespace: "NS",
					key: "K",
					seenTranslation: "Bienvenue",
					translation: "Bon retour"
				}
			]
		});
		await user.click(within(panel).getByRole("button", { name: "Write to PO" }));
		await screen.findByText(
			"Wrote 1 translation to 1 PO file. They are not synced until you sync with Unreal."
		);
		expect(requests[1]?.mode).toBe("write");
		expect(screen.queryByRole("button", { name: "1 staged" })).toBeNull();
	});

	it("keeps stale edits staged and explains why nothing was written", async () => {
		const user = userEvent.setup();
		const { api } = editingClient((request) => ({
			status: "reviewed",
			edits: request.edits.map((edit) => ({
				culture: edit.culture,
				namespace: edit.namespace,
				key: edit.key,
				outcome: "stale_translation" as const,
				currentTranslation: "Changed elsewhere",
				translation: edit.translation
			})),
			files: [],
			notSynced: 1
		}));
		mount(api);
		await stageFrench(user);
		await user.click(screen.getByRole("button", { name: "1 staged" }));
		const panel = screen.getByRole("region", { name: "Staged translations" });
		await user.click(within(panel).getByRole("button", { name: "Check changes" }));
		await within(panel).findByText("The translation changed since you staged this");
		expect(within(panel).getByRole("button", { name: "Write to PO" })).toHaveProperty(
			"disabled",
			true
		);
		await user.click(within(panel).getByRole("button", { name: "Unstage" }));
		expect(screen.queryByRole("region", { name: "Staged translations" })).toBeNull();
	});
});
