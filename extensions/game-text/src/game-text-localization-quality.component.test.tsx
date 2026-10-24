import { indexedTestReports } from "../../../packages/game-text/src/indexed-reports.test-support.js";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	localizationFocusPage,
	localizationQualityWorkspace,
	textQualityQuery
} from "@ue-shed/game-text/corpus";
import type { GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qualityFixture } from "../../../packages/game-text/src/localization-workspace.test-support.js";
import { cultureCode } from "../../../packages/game-text/src/localization.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import type { GameTextPreferences } from "./game-text-preferences.js";
import { GameTextRoute } from "./game-text-query-route.js";
const runtime = ManagedRuntime.make(Layer.empty);
const fixture = qualityFixture();
function client(): GameTextClientApi {
	let document = fixture.document;
	let quality = fixture.workspace;
	const text = textCorpusQuery(fixture.text, undefined, fixture.join);
	const source = () =>
		textQualityQuery(indexedTestReports(fixture.text, fixture.files).source(document));
	const reviewed = (next: GameTextRuleDocument) => {
		document = next;
		quality = localizationQualityWorkspace(
			indexedTestReports(fixture.text, fixture.files).source(next),
			indexedTestReports(fixture.text, fixture.files).localization(next, {}),
			fixture.join
		);
		return Effect.succeed({
			status: "completed",
			document: next,
			summary: source().summary()
		} as const);
	};
	return {
		projectKey: () => Effect.succeed("quality-project"),
		loadConfiguredProject: () =>
			Effect.succeed({ status: "completed", summary: text.summary() }),
		search: (request) => Effect.succeed({ status: "ready", page: text.search(request) }),
		focus: (request) => {
			const focus = text.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		progress: () =>
			Effect.succeed({ completed: 0, total: 0, phase: "idle", stage: "game_text" }),
		locateAsset: () => Effect.die("Not used"),
		chooseQualityRules: () => reviewed(document),
		previewQualityRules: reviewed,
		saveQualityRules: reviewed,
		qualitySearch: (request) =>
			Effect.succeed({ status: "ready", page: source().search(request) }),
		qualityFocus: (request) => {
			const focus = source().focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		localizationTargets: () =>
			Effect.succeed({
				status: "ready",
				targets: [
					{
						name: fixture.join.target,
						cultures: fixture.join.cultures,
						nativeCulture: fixture.join.nativeCulture
					}
				]
			}),
		localizationTarget: () =>
			Effect.succeed({
				status: "ready",
				target: {
					name: fixture.join.target,
					cultures: fixture.join.cultures,
					nativeCulture: fixture.join.nativeCulture
				},
				lines: 1,
				notSynced: 0
			}),
		localizationFocus: (request) => {
			const line = fixture.join.lines[0];
			if (!line) throw new Error("Missing fixture line");
			return Effect.succeed({
				status: "found",
				focus: localizationFocusPage(fixture.join, line, request)
			});
		},
		localizationQualitySearch: (request) =>
			Effect.succeed({ status: "ready", page: quality.search(request) }),
		localizationQualityFocus: (request) => Effect.succeed(quality.focus(request)),
		localizationChanges: (request) => Effect.succeed(quality.changes(request)),
		localizationReport: () => {
			const { baseline: _baseline, ...page } = fixture.page;
			return Effect.succeed({ status: "ready", page });
		},
		localizationReportFile: (request) =>
			Effect.succeed(
				request.operation === "compare_baseline"
					? { status: "compared", page: fixture.page }
					: {
							status: "saved",
							message:
								request.operation === "save_baseline"
									? "Baseline saved."
									: "Report CSV exported."
						}
			)
	};
}
function mount(api = client(), extra: Partial<GameTextPreferences> = {}) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute
				client={api}
				initialPreferences={{
					query: "",
					capability: "all",
					lens: "all",
					selectedId: undefined,
					mode: "quality",
					localizationTarget: fixture.join.target,
					localizationCulture: cultureCode("de"),
					qualityDocument: fixture.document,
					...extra
				}}
			/>
		</EffectRuntimeProvider>
	));
}
it("keeps text search available without starting a full localization quality check", async () => {
	const api = client();
	const qualitySearch = vi.fn(() => Effect.never);
	const textSearch = vi.fn(api.search);
	const user = userEvent.setup({ delay: null });
	mount(
		{ ...api, search: textSearch, localizationQualitySearch: qualitySearch },
		{ mode: "corpus" }
	);
	await screen.findByRole("region", { name: "Results" });
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	expect(qualitySearch).not.toHaveBeenCalled();
	const initialSearches = textSearch.mock.calls.length;
	await user.type(screen.getByRole("searchbox", { name: "Search game text" }), "welcome");
	await waitFor(() => expect(textSearch.mock.calls.length).toBeGreaterThan(initialSearches));
	expect(qualitySearch).not.toHaveBeenCalled();
	await user.click(screen.getByRole("tab", { name: "Quality checks" }));
	await waitFor(() => expect(qualitySearch).toHaveBeenCalled());
});
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
afterAll(() => runtime.dispose());
describe("localization quality and reports", () => {
	it("shows culture counts, exact asset/key rows, argument highlights and copy-only diffs", async () => {
		const user = userEvent.setup({ delay: null }),
			write = vi.fn(async (_text: string) => undefined);
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: write
		});
		mount();
		await user.click(await screen.findByRole("button", { name: "Renamed format arguments 1" }));
		const rows = screen.getByRole("region", { name: "Findings" });
		await user.click(
			await within(rows).findByRole("button", {
				name: /de · \{Name\} should be \{PlayerName\}/u
			})
		);
		const detail = screen.getByRole("complementary", { name: "Finding detail" });
		await within(detail).findByRole("region", { name: "Suggested fix" });
		expect(detail.querySelector("h2 mark")?.textContent).toBe("{PlayerName}");
		expect(detail.querySelectorAll("mark").length).toBeGreaterThanOrEqual(4);
		expect(rows.textContent).toContain("Table · K0 · Renamed format arguments");
		const suggested = within(detail).getByRole("region", { name: "Suggested fix" });
		expect(Array.from(suggested.querySelectorAll("mark"), (mark) => mark.textContent)).toEqual([
			"{Name}",
			"{PlayerName}"
		]);
		expect(detail.textContent).toContain("Translation the game uses");
		expect(detail.textContent).toContain(
			"Edit the translation in Text to stage it, or copy the change set for ue-shed loc apply."
		);
		expect(within(detail).getByRole("article", { name: "Translation de" })).toBeTruthy();
		await user.click(within(detail).getByRole("button", { name: "Copy change set" }));
		await screen.findByText("Change set copied.");
		expect(JSON.parse(write.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
			schemaVersion: 1,
			changes: [{ translation: "Hallo {PlayerName}", previousTranslation: "Hallo {Name}" }]
		});
	});
	it("copies all filtered suggestions in one bounded document", async () => {
		const user = userEvent.setup({ delay: null }),
			write = vi.fn(async (_text: string) => undefined);
		Object.defineProperty(navigator.clipboard, "writeText", {
			configurable: true,
			value: write
		});
		const capability = client().localizationChanges;
		if (!capability) throw new Error("Expected changes capability");
		const changes = vi.fn(capability);
		mount({ ...client(), localizationChanges: changes });
		await user.click(await screen.findByRole("button", { name: "Renamed format arguments 1" }));
		await user.click(
			await screen.findByRole("button", { name: "Resolve all: copy suggested fixes (1)" })
		);
		await screen.findByText("1 suggested fix copied.");
		expect(changes.mock.calls).toEqual([
			[{ target: fixture.join.target, culture: "de", filter: "format_argument_renamed" }]
		]);
		expect(JSON.parse(write.mock.calls[0]?.[0] ?? "{}").changes).toHaveLength(1);
		expect(screen.queryByRole("button", { name: /Apply|Write translation/u })).toBeNull();
	});
	it("shows loading without a false empty finding state", async () => {
		mount({ ...client(), localizationQualitySearch: () => Effect.never });
		await screen.findByText("Loading findings…");
		expect(screen.queryByText("No findings match this filter.")).toBeNull();
		expect(screen.queryByRole("button", { name: "All findings 0" })).toBeNull();
		expect(screen.queryByRole("table", { name: "Rules overview" })).toBeNull();
		expect(screen.getByRole("tab", { name: "Quality checks" })).toBeTruthy();
	});
	it("renders a dense native-first report and baseline save/compare/export flows", async () => {
		const user = userEvent.setup({ delay: null }),
			api = client();
		if (!api.localizationReportFile) throw new Error("Expected report file capability");
		const operation = vi.fn(api.localizationReportFile);
		mount({ ...api, localizationReportFile: operation }, { mode: "reports" });
		const table = await screen.findByRole("table", { name: "Localization report" });
		expect(within(table).getAllByRole("row")[1]?.getAttribute("aria-label")).toBe("en");
		expect(screen.getAllByText("Reviewed · Proofread: not tracked yet")).toHaveLength(1);
		expect(screen.queryByRole("columnheader", { name: "New words" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Save baseline…" }));
		await screen.findByText("Baseline saved.");
		await user.click(screen.getByRole("button", { name: "Compare with baseline…" }));
		await screen.findByText("Baseline compared.");
		expect(within(table).getByRole("columnheader", { name: "New words" })).toBeTruthy();
		expect(
			within(table)
				.getAllByRole("row")
				.slice(1)
				.every((row) =>
					within(row)
						.getAllByRole("cell")
						.slice(-2)
						.every((cell) => cell.textContent === "0")
				)
		).toBe(true);
		await user.click(screen.getByRole("button", { name: "Export CSV" }));
		await screen.findByText("Report CSV exported.");
		expect(operation.mock.calls.map(([request]) => request.operation)).toEqual([
			"save_baseline",
			"compare_baseline",
			"export_csv"
		]);
	});
	it("restores Reports, the culture filter and finding across fresh mounts without rescanning", async () => {
		const user = userEvent.setup({ delay: null }),
			api = client(),
			load = vi.fn(api.loadConfiguredProject);
		const first = mount({ ...api, loadConfiguredProject: load });
		await user.click(await screen.findByRole("button", { name: "Renamed format arguments 1" }));
		await user.click(
			await within(screen.getByRole("region", { name: "Findings" })).findByRole("button", {
				name: /de · \{Name\} should be/u
			})
		);
		await screen.findByRole("region", { name: "Suggested fix" });
		await user.click(screen.getByRole("tab", { name: "Reports" }));
		await screen.findByRole("table", { name: "Localization report" });
		await waitFor(() =>
			expect(localStorage.getItem("ue-shed:game-text:quality-project")).toContain(
				'"mode":"reports"'
			)
		);
		first.unmount();
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<GameTextRoute client={{ ...api, loadConfiguredProject: load }} />
			</EffectRuntimeProvider>
		));
		await screen.findByRole("table", { name: "Localization report" });
		await user.click(screen.getByRole("tab", { name: /^Quality checks/u }));
		expect(
			(
				await screen.findByRole("button", { name: "Renamed format arguments 1" })
			).getAttribute("aria-pressed")
		).toBe("true");
		await screen.findByRole("region", { name: "Suggested fix" });
		expect(load.mock.calls).toEqual([[false], [false]]);
	});
	it("keeps Reports loading and baseline failures separate from real table values", async () => {
		const first = mount(
			{ ...client(), localizationReport: () => Effect.never },
			{ mode: "reports" }
		);
		await screen.findByText("Loading reports…");
		expect(screen.queryByRole("table", { name: "Localization report" })).toBeNull();
		first.unmount();
		const user = userEvent.setup({ delay: null });
		mount(
			{
				...client(),
				localizationReportFile: () =>
					Effect.succeed({
						status: "failed",
						message: "Baseline belongs to another target.",
						recovery: "Choose this target's baseline."
					})
			},
			{ mode: "reports" }
		);
		await screen.findByRole("table", { name: "Localization report" });
		await user.click(screen.getByRole("button", { name: "Compare with baseline…" }));
		await screen.findByText(
			"Baseline belongs to another target. Choose this target's baseline."
		);
		expect(screen.queryByRole("columnheader", { name: "New words" })).toBeNull();
	});
	it("edits culture budgets, glossaries, alternatives and recovery before explicit save", async () => {
		const user = userEvent.setup({ delay: null }),
			api = client();
		const preview = vi.fn(api.previewQualityRules),
			save = vi.fn(api.saveQualityRules);
		mount({ ...api, previewQualityRules: preview, saveQualityRules: save });
		await user.click(await screen.findByRole("button", { name: "Edit rules" }));
		await user.click(screen.getByRole("button", { name: "Choose another rules file…" }));
		await user.click(
			screen.getByRole("button", { name: /Character limit.*translation.limit/u })
		);
		await user.clear(screen.getByRole("spinbutton", { name: "Maximum characters for de" }));
		await user.type(
			screen.getByRole("spinbutton", { name: "Maximum characters for de" }),
			"50"
		);
		await user.clear(screen.getByRole("spinbutton", { name: "Default maximum characters" }));
		await user.type(
			screen.getByRole("spinbutton", { name: "Default maximum characters" }),
			"25"
		);
		await user.type(screen.getByRole("textbox", { name: "New culture code" }), "en");
		await user.click(screen.getByRole("button", { name: "Add culture" }));
		await user.clear(screen.getByRole("spinbutton", { name: "Maximum characters for en" }));
		await user.type(
			screen.getByRole("spinbutton", { name: "Maximum characters for en" }),
			"10"
		);
		await user.click(screen.getByRole("button", { name: /Terminology.*translation.terms/u }));
		await user.clear(screen.getByRole("textbox", { name: "de term 1" }));
		await user.type(screen.getByRole("textbox", { name: "de term 1" }), "Guten Tag");
		await user.clear(screen.getByRole("textbox", { name: "de alternatives 1" }));
		await user.type(
			screen.getByRole("textbox", { name: "de alternatives 1" }),
			"Hallo, Willkommen"
		);
		await user.click(screen.getByRole("checkbox", { name: "Case-sensitive matching" }));
		await user.click(screen.getByRole("button", { name: "Add forbidden term" }));
		await user.type(screen.getByRole("textbox", { name: "de term 2" }), "vermeiden");
		await user.type(screen.getByRole("textbox", { name: "New culture code" }), "en");
		await user.click(screen.getByRole("button", { name: "Add culture" }));
		await user.click(screen.getByRole("button", { name: "Remove en" }));
		await user.clear(
			screen.getByRole("textbox", { name: "Recovery guidance for translation.terms" })
		);
		await user.type(
			screen.getByRole("textbox", { name: "Recovery guidance for translation.terms" }),
			"Use the approved German wording."
		);
		await user.click(screen.getByRole("button", { name: "Preview" }));
		await screen.findByText("Preview updated. Changes are not saved yet.");
		expect(save).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await screen.findByText("Rule file saved.");
		const saved = save.mock.calls[0]?.[0];
		expect(saved?.schemaVersion).toBe(1);
		expect(
			saved?.rules.filter(
				(rule) =>
					rule.kind === "localization_character_budget" ||
					rule.kind === "localization_terminology"
			)
		).toMatchObject([
			{ cultures: { de: 50, en: 10 }, defaultMaximumCharacters: 25 },
			{
				recovery: "Use the approved German wording.",
				caseSensitive: true,
				cultures: {
					de: [
						{
							kind: "preferred",
							term: "Guten Tag",
							alternatives: ["Hallo", "Willkommen"]
						},
						{ kind: "forbidden", term: "vermeiden" }
					]
				}
			}
		]);
	}, 30_000);
});
