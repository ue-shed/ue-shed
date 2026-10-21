import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { type GameTextRuleDocument } from "@ue-shed/game-text/rules";
import { makeTextOccurrenceId, makeTextUnitId, type TextCorpus } from "@ue-shed/game-text/schema";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { GameTextClientError, type GameTextClientApi } from "./game-text-client.js";
import { storedGameTextPreferences } from "./game-text-preferences.js";
import {
	corpus,
	makeClient,
	mount,
	openQuality,
	rulesDocument
} from "./game-text-route.test-support.js";
describe("Game Text audit recovery", () => {
	it("retries the failed search without scanning the project", async () => {
		const user = userEvent.setup({ delay: null });
		const base = makeClient();
		let failed = false;
		const scan = vi.fn(base.loadConfiguredProject);
		const search = vi.fn((request: Parameters<GameTextClientApi["search"]>[0]) => {
			if (!failed) {
				failed = true;
				return Effect.fail(
					new GameTextClientError({
						message: "The GameTextClient operation failed.",
						retrySafe: false,
						nextStep: "reconcile",
						code: "game_text_client_failed",
						operation: "search",
						cause: "temporary search failure",
						recovery: "Retry the search."
					})
				);
			}
			return base.search(request);
		});
		mount({ ...base, loadConfiguredProject: scan, search });
		await screen.findByText("Search failed");
		await user.click(screen.getByRole("button", { name: "Retry search" }));
		await screen.findByText("2 matches");
		expect(scan).toHaveBeenCalledTimes(1);
		expect(search.mock.calls.filter(([request]) => !request.openGroup)).toHaveLength(2);
	});
	it("offers a failed group's retry and retains the other results", async () => {
		const user = userEvent.setup({ delay: null });
		const base = makeClient();
		let failed = false;
		mount({
			...base,
			search: (request) => {
				if (request.openGroup && !failed) {
					failed = true;
					return Effect.fail(
						new GameTextClientError({
							message: "The GameTextClient operation failed.",
							retrySafe: false,
							nextStep: "reconcile",
							code: "game_text_client_failed",
							operation: "group",
							cause: "temporary group failure",
							recovery: "Retry this group."
						})
					);
				}
				return base.search(request);
			}
		});
		await screen.findByRole("button", { name: "Retry group" });
		expect(screen.getByText("2 matches")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Retry group" }));
		await within(screen.getByRole("region", { name: "Results" })).findByRole("button", {
			name: /^Continue/u
		});
		expect(screen.queryByText("Group unavailable")).toBeNull();
	});
	it.each(["problem", "none"] as const)(
		"retains %s grouping, loaded pages and scroll across a rescan",
		async (group) => {
			const user = userEvent.setup({ delay: null });
			const first = corpus.units[0];
			if (!first) throw new Error("Missing source fixture");
			const many: TextCorpus = {
				...corpus,
				units: Array.from({ length: 120 }, (_, index) => ({
					...first,
					id: makeTextUnitId(`line:${index}`),
					identity: { status: "resolved", namespace: "UI", key: `Line${index}` },
					source: { status: "consistent", value: `Line ${index}` },
					occurrences: first.occurrences.map((occurrence) => ({
						...occurrence,
						id: makeTextOccurrenceId(`occurrence:${index}`),
						identity: { status: "resolved", namespace: "UI", key: `Line${index}` },
						source: `Line ${index}`
					}))
				}))
			};
			mount(makeClient(many), {
				query: "",
				capability: "all",
				lens: "all",
				selectedId: undefined,
				group,
				filter: []
			});
			const results = await screen.findByRole("region", { name: "Results" });
			await waitFor(() =>
				expect(results.querySelectorAll("button[data-row]")).toHaveLength(50)
			);
			await user.click(within(results).getByRole("button", { name: /Show.*more/u }));
			await waitFor(() =>
				expect(results.querySelectorAll("button[data-row]")).toHaveLength(100)
			);
			results.scrollTop = 75;
			await user.click(screen.getByRole("button", { name: "Rescan" }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty(
					"disabled",
					false
				)
			);
			await waitFor(() =>
				expect(results.querySelectorAll("button[data-row]")).toHaveLength(100)
			);
			expect(results.scrollTop).toBe(75);
			if (group === "none") return;
			const header = within(results).getByRole("button", { name: /Up to date.*120/u });
			await user.click(header);
			await user.click(screen.getByRole("button", { name: "Rescan" }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty(
					"disabled",
					false
				)
			);
			expect(header.getAttribute("aria-expanded")).toBe("false");
		}
	);
	it("guards rule replacement and recovers an invalid draft after restarting", async () => {
		const user = userEvent.setup({ delay: null });
		const base = makeClient();
		const loadRules = vi.fn(base.chooseQualityRules);
		const first = mount(
			{ ...base, chooseQualityRules: loadRules },
			undefined,
			"audit-rule-draft"
		);
		await openQuality(user);
		await user.click(screen.getByRole("button", { name: "Edit rules" }));
		const budget = await screen.findByRole("spinbutton", {
			name: "Maximum characters for example-limit"
		});
		const ruleForm = screen.getByRole("region", { name: "Selected quality rule" });
		expect(within(ruleForm).getByText("Saved", { exact: true })).toBeDefined();
		await user.clear(budget);
		await user.type(budget, "0");
		expect(within(ruleForm).getByText("Unsaved changes", { exact: true })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Preview" }));
		expect(screen.getAllByText(/whole-number character limit/).length).toBeGreaterThan(0);
		await user.click(screen.getByRole("button", { name: "Reload rules" }));
		await screen.findByRole("alertdialog", { name: "Unsaved quality rules" });
		expect(loadRules).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: "Keep editing" }));
		await waitFor(() =>
			expect(
				storedGameTextPreferences("audit-rule-draft").qualityEditor?.draft.rules[0]
			).toMatchObject({ maximumCharacters: 0 })
		);
		first.unmount();
		mount(base, undefined, "audit-rule-draft");
		await user.click(await screen.findByRole("button", { name: "Edit rules" }));
		expect(
			await screen.findByRole("spinbutton", { name: "Maximum characters for example-limit" })
		).toHaveProperty("value", "");
	});
	it("saves a recovered rule draft when the host still has its rules file", async () => {
		const user = userEvent.setup({ delay: null });
		const base = makeClient();
		const saves: GameTextRuleDocument[] = [];
		// The host keeps the rules file across route mounts and says so on each preview.
		const attached: GameTextClientApi = {
			...base,
			previewQualityRules: (draft) =>
				base
					.previewQualityRules(draft)
					.pipe(
						Effect.map((result) =>
							result.status === "completed"
								? { ...result, ruleFile: "attached" as const }
								: result
						)
					),
			saveQualityRules: (draft) => {
				saves.push(draft);
				return base.saveQualityRules(draft);
			}
		};
		const first = mount(attached, undefined, "attached-rule-draft");
		await openQuality(user);
		await user.click(screen.getByRole("button", { name: "Edit rules" }));
		const budget = await screen.findByRole("spinbutton", {
			name: "Maximum characters for example-limit"
		});
		await user.clear(budget);
		await user.type(budget, "9");
		await waitFor(() =>
			expect(
				storedGameTextPreferences("attached-rule-draft").qualityEditor?.draft.rules[0]
			).toMatchObject({ maximumCharacters: 9 })
		);
		first.unmount();
		mount(attached, undefined, "attached-rule-draft");
		await user.click(await screen.findByRole("tab", { name: /^Quality checks/u }));
		await user.click(await screen.findByRole("button", { name: "Edit rules" }));
		await screen.findByText("Unsaved changes");
		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() => expect(save).toHaveProperty("disabled", false));
		await user.click(save);
		await waitFor(() => expect(saves).toHaveLength(1));
		expect(saves[0]?.rules[0]).toMatchObject({ maximumCharacters: 9 });
	});
	it("enters filter submenus by keyboard and restores focus one level at a time", async () => {
		mount();
		const user = userEvent.setup({ delay: null });
		await screen.findByText("2 matches");
		const trigger = screen.getByRole("button", { name: /^Filter(, \d+ active)?$/u });
		trigger.focus();
		await user.keyboard("{Enter}");
		expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter by" }));
		await user.keyboard("{ArrowDown}{ArrowRight}");
		expect(document.activeElement).toBe(
			screen.getByRole("searchbox", { name: "Filter Problem" })
		);
		await user.keyboard("{Escape}");
		expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Problem" }));
		await user.keyboard("{Escape}");
		expect(document.activeElement).toBe(trigger);
	});
});
it("retries a failed rescan while keeping the current search results", async () => {
	const base = makeClient();
	let failed = false;
	const scan = vi.fn((refresh = false) => {
		if (refresh && !failed) {
			failed = true;
			return Effect.fail(
				new GameTextClientError({
					message: "The GameTextClient operation failed.",
					retrySafe: false,
					nextStep: "reconcile",
					code: "game_text_client_failed",
					operation: "scan",
					cause: "temporary scan failure",
					recovery: "Retry the rescan."
				})
			);
		}
		return base.loadConfiguredProject(refresh);
	});
	mount({ ...base, loadConfiguredProject: scan });
	const user = userEvent.setup({ delay: null });
	await screen.findByText("2 matches");
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await screen.findByRole("button", { name: /^Retry$/u });
	expect(screen.getByText("2 matches")).toBeDefined();
	await user.click(screen.getByRole("button", { name: /^Retry$/u }));
	await waitFor(() =>
		expect(scan.mock.calls.map(([refresh]) => refresh)).toEqual([false, true, true])
	);
});
it("discarding recovered rule edits clears dirty state without attaching a file", async () => {
	const user = userEvent.setup({ delay: null });
	const incomplete = {
		...rulesDocument,
		rules: rulesDocument.rules.map((rule) =>
			rule.kind === "character_budget" ? { ...rule, maximumCharacters: 0 } : rule
		)
	};
	const preview = vi.fn(makeClient().previewQualityRules);
	mount(
		{ ...makeClient(), previewQualityRules: preview },
		{
			query: "",
			capability: "all",
			lens: "all",
			selectedId: undefined,
			mode: "quality",
			qualityDocument: rulesDocument,
			qualityEditor: { draft: incomplete, savedDocument: rulesDocument }
		}
	);
	await user.click(await screen.findByRole("button", { name: "Edit rules" }));
	await user.click(screen.getByRole("button", { name: "Discard edits" }));
	await screen.findByText("No rule file", { exact: true });
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Discard edits" })).toHaveProperty(
			"disabled",
			true
		)
	);
	expect(screen.queryByText("Unsaved changes")).toBeNull();
	expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
	expect(preview.mock.calls.at(-1)?.[0]).toEqual(rulesDocument);
	expect(
		screen.getByRole("spinbutton", { name: "Maximum characters for example-limit" })
	).toHaveProperty("value", "4");
});
