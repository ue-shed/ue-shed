import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	GameTextInvestigationPreset,
	type GameTextInvestigationQuery
} from "@ue-shed/game-text/corpus";
import { type TextCorpusSearchRequest, type TextFilter } from "@ue-shed/game-text/schema";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { target } from "../../../packages/game-text/src/localization.test-support.js";
import { cannedPage, tableRow, type CannedAnswer } from "./game-text-canned-search.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import {
	client,
	groupRows,
	mount,
	second,
	sourceAnswers
} from "./game-text-localization.test-support.js";
import { storedGameTextPreferences } from "./game-text-preferences.js";
describe("Game Text all-languages export", () => {
	it("opens a preset on its saved target, cultures and translation filters", async () => {
		const user = userEvent.setup({ delay: null });
		const preset = Schema.decodeUnknownSync(GameTextInvestigationPreset)({
			schemaVersion: 1,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "corpus",
				query: "",
				capability: "all",
				qualityFilter: "all",
				filter: [{ field: "translation", op: "is", values: ["missing"] }],
				localization: { target: second, cultures: ["de", "fr"], searchTranslations: true }
			}
		});
		const exported: GameTextInvestigationQuery[] = [];
		mount({
			...client({ twoTargets: true }),
			investigations: {
				export: (query) => {
					exported.push(query);
					return Effect.succeed({ status: "cancelled" });
				},
				save: () => Effect.succeed({ status: "cancelled" }),
				open: () => Effect.succeed({ status: "opened", preset, path: "C:/out/preset.json" })
			}
		});
		await screen.findByRole("button", { name: `Localization target: ${target.name}` });
		await user.click(screen.getByRole("button", { name: "Presets" }));
		await user.click(await screen.findByRole("button", { name: "Open preset…" }));
		await screen.findByRole("button", { name: "Localization target: Second" });
		await screen.findByRole("button", { name: "Culture: de, fr" });
		await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
		await user.click(screen.getByRole("button", { name: "Export" }));
		await user.click(await screen.findByRole("button", { name: "JSON" }));
		await waitFor(() => expect(exported).toHaveLength(1));
		expect(exported[0]?.localization).toEqual({
			target: second,
			cultures: ["de", "fr"],
			searchTranslations: true
		});
		expect(exported[0]?.filter).toEqual(preset.query.filter);
	});
});
it("keeps typed translations across a rescan, review writes and a fresh mount", async () => {
	const user = userEvent.setup({ delay: null });
	const api: GameTextClientApi = {
		...client(),
		localizationEdits: () => Effect.succeed({ status: "not_ready" }),
		localizationReview: () =>
			Effect.succeed({ status: "written", relativePath: "Config/Review.json" })
	};
	const first = mount(api);
	await screen.findByText("3 matches");
	await groupRows();
	const row = within(screen.getByRole("region", { name: "Results" })).getByRole("button", {
		name: /^Welcome/u
	});
	await user.click(row);
	const french = await screen.findByRole("article", { name: "Translation fr" });
	await user.click(within(french).getByRole("button", { name: /^Edit$/u }));
	const draft = await screen.findByRole("textbox", { name: "New fr translation" });
	await user.clear(draft);
	await user.type(draft, "Draft to retain");
	expect(draft.getAttribute("dir")).toBe("auto");
	expect(draft.getAttribute("lang")).toBe("fr");
	await user.click(screen.getByRole("button", { name: "Rescan" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", false)
	);
	expect(screen.getByRole("textbox", { name: "New fr translation" })).toHaveProperty(
		"value",
		"Draft to retain"
	);
	const german = await screen.findByRole("article", { name: "Translation de" });
	await user.click(within(german).getByRole("button", { name: /^Reviewed$/u }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", false)
	);
	expect(screen.getByRole("textbox", { name: "New fr translation" })).toHaveProperty(
		"value",
		"Draft to retain"
	);
	await waitFor(() =>
		expect(
			window.localStorage.getItem("ue-shed:game-text-work:localization-project")
		).toContain("Draft to retain")
	);
	first.unmount();
	mount(api);
	expect(await screen.findByRole("textbox", { name: "New fr translation" })).toHaveProperty(
		"value",
		"Draft to retain"
	);
	await user.keyboard("{Escape}");
	await waitFor(() => expect(document.activeElement?.hasAttribute("data-row")).toBe(true));
});
it.each([
	{ op: "is", removeTarget: false },
	{ op: "is_not", removeTarget: true }
] as const)(
	"keeps source predicates in mixed $op Problem filters without a target (rescan removal: $removeTarget)",
	async ({ op, removeTarget }) => {
		const savedFilter: TextFilter = [
			{ field: "problem", op, values: ["conflicting_source", "translation"] }
		];
		const effectiveFilter: TextFilter = [
			{ field: "problem", op, values: ["conflicting_source"] }
		];
		window.localStorage.setItem(
			"ue-shed:game-text:localization-project",
			JSON.stringify({ filter: savedFilter })
		);
		// Conflict's key holds two texts, so only it has the source problem; Fresh line has none.
		const conflict = {
			...tableRow("Conflict", "First source"),
			source: { status: "conflicting" as const, values: ["First source", "Second source"] },
			occurrenceCount: 2,
			reviewSignals: ["conflicting" as const],
			problems: ["conflicting_source" as const]
		};
		const [row, group] =
			op === "is"
				? [
						{ unit: conflict, groups: { problem: "conflicting_source" } },
						{
							key: "conflicting_source",
							label: "Same key, different text",
							count: 1,
							needWork: 1,
							worst: "conflicting_source" as const
						}
					]
				: [
						{
							unit: tableRow("Fresh", "Fresh line"),
							groups: { problem: "up_to_date" }
						},
						{
							key: "up_to_date",
							label: "Up to date",
							count: 1,
							needWork: 0,
							worst: "up_to_date" as const
						}
					];
		const answers = [savedFilter, effectiveFilter].map(
			(filter): CannedAnswer => ({
				...sourceAnswers[0]!,
				when: { filter },
				rows: [row],
				groups: { problem: [group] }
			})
		);
		const base = client();
		const inventory = base.localizationTargets;
		if (!inventory) throw new Error("Missing target inventory");
		let empty = !removeTarget;
		const requests: TextCorpusSearchRequest[] = [];
		const files: GameTextInvestigationQuery[] = [];
		mount({
			...base,
			localizationTargets: () =>
				empty ? Effect.succeed({ status: "ready", targets: [] }) : inventory(),
			search: (request) => {
				requests.push(request);
				const { localization: _localization, ...sourceRequest } = request;
				return Effect.succeed({
					status: "ready",
					page: cannedPage(answers, sourceRequest)
				});
			},
			investigations: {
				export: (selection) => {
					files.push(selection);
					return Effect.succeed({ status: "cancelled" });
				},
				save: (selection) => {
					files.push(selection);
					return Effect.succeed({ status: "cancelled" });
				},
				open: () => Effect.succeed({ status: "cancelled" })
			}
		});
		const user = userEvent.setup({ delay: null });
		await screen.findByText("1 match");
		await groupRows();
		if (removeTarget) {
			await screen.findByRole("button", { name: /^Culture:/u });
			empty = true;
			await user.click(screen.getByRole("button", { name: "Rescan" }));
		}
		await waitFor(() => {
			expect(screen.queryByRole("button", { name: /^Culture:/u })).toBeNull();
			expect(requests.at(-1)?.filter).toEqual(effectiveFilter);
			expect(requests.at(-1)?.localization).toBeUndefined();
			expect(screen.queryByRole("button", { name: "Search translations" })).toBeNull();
			expect(screen.queryByRole("alert")).toBeNull();
		});
		await screen.findByText("1 match");
		await groupRows();
		expect(screen.getByRole("region", { name: "Results" }).textContent).toContain(
			op === "is_not" ? "Fresh line" : "First source"
		);
		await screen.findByText(/Localization-dependent filter values are paused/u);
		await user.click(screen.getByRole("button", { name: "Export" }));
		await user.click(await screen.findByRole("button", { name: "CSV" }));
		await user.click(screen.getByRole("button", { name: "Presets" }));
		await user.click(await screen.findByRole("button", { name: /^Save preset/u }));
		await waitFor(() => expect(files).toHaveLength(2));
		for (const selection of files) {
			expect(selection.filter).toEqual(effectiveFilter);
			expect(selection.localization).toBeUndefined();
		}
		expect(storedGameTextPreferences("localization-project").filter).toEqual(savedFilter);
	}
);
