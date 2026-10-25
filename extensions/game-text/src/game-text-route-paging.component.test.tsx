import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { makeTextUnitId, type TextUnitSearchResult } from "@ue-shed/game-text/schema";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { cannedPage } from "./game-text-canned-search.test-support.js";
import {
	answer,
	continueRow,
	corpus,
	focusOf,
	makeClient,
	mount,
	planted,
	quiet,
	type PlantedText
} from "./game-text-route.test-support.js";

/** Planted lines named by a prefix and their index, each with Continue's one place. */
const savedLines = (prefix: string, length: number): TextUnitSearchResult[] =>
	Array.from({ length }, (_, index) => ({
		...continueRow,
		id: makeTextUnitId(prefix + index.toString().padStart(3, "0")),
		source: { status: "consistent", value: "Line " + index }
	}));
const listing = (units: readonly TextUnitSearchResult[]): PlantedText => ({
	...planted,
	answers: [answer({}, units)],
	focus: units.map((unit) => ({ ...focusOf(corpus, continueRow), unit }))
});
it("appends bounded pages while keeping the full query count", async () => {
	const user = userEvent.setup({ delay: null });
	mount(makeClient(listing(savedLines("page-line:", 62))));
	await screen.findByText("62 matches");
	const results = screen.getByRole("region", { name: "Results" });
	// Line rows only: not the group header or its "Show more".
	const rows = () =>
		within(results)
			.getAllByRole("button")
			.filter(
				(button) =>
					!button.hasAttribute("aria-expanded") &&
					!(button.textContent ?? "").startsWith("Show more")
			);
	await waitFor(() => expect(rows()).toHaveLength(50));
	await user.click(within(results).getByRole("button", { name: "Show more (12 left)" }));
	await waitFor(() => expect(rows()).toHaveLength(62));
	expect(screen.getByText("62 matches")).toBeDefined();
});
it("steps past the last loaded line by loading the group's next page", async () => {
	const user = userEvent.setup({ delay: null });
	mount(makeClient(listing(savedLines("page-line:", 62))));
	await screen.findByText("62 matches");
	const results = screen.getByRole("region", { name: "Results" });
	const rows = () =>
		within(results)
			.getAllByRole("button")
			.filter((button) => button.hasAttribute("data-row"));
	await waitFor(() => expect(rows()).toHaveLength(50));
	await user.click(rows()[49]!);
	const page = screen.getByRole("complementary", { name: "Text focus" });
	await within(page).findByText("50 of 62");
	await user.click(within(page).getByRole("button", { name: "Next line" }));
	await within(page).findByText("51 of 62");
	expect(rows()).toHaveLength(62);
});
it("does not reopen a line when the list is back before the next page arrives", async () => {
	const input = listing(savedLines("late-line:", 62));
	const later = Effect.runSync(Deferred.make<void>());
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient(input, {
			search: (request) =>
				(request.cursor ? Deferred.await(later) : Effect.void).pipe(
					Effect.as({
						status: "ready" as const,
						page: cannedPage(input.answers, request)
					})
				)
		})
	);
	await screen.findByText("62 matches");
	await user.click(screen.getByRole("button", { name: "Display" }));
	await user.click(screen.getByRole("radio", { name: "No grouping" }));
	await user.keyboard("{Escape}");
	await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "Group by" })).toBeNull());
	// The flat page replaces the grouped rows once its search settles.
	await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
	const results = screen.getByRole("region", { name: "Results" });
	const rows = () =>
		within(results)
			.queryAllByRole("button")
			.filter((button) => button.hasAttribute("data-row"));
	await waitFor(() => expect(rows()).toHaveLength(50));
	await user.click(rows()[49]!);
	const page = screen.getByRole("complementary", { name: "Text focus" });
	await within(page).findByText("50 of 62");
	await user.click(within(page).getByRole("button", { name: "Next line" }));
	await user.click(within(page).getByRole("button", { name: /Lines$/u }));
	await waitFor(() => expect(screen.queryByText("50 of 62")).toBeNull());
	Effect.runSync(Deferred.succeed(later, undefined));
	await waitFor(() => expect(rows()).toHaveLength(62));
	expect(screen.queryByText("51 of 62")).toBeNull();
	expect(rows().every((row) => row.getAttribute("aria-current") !== "true")).toBe(true);
	await user.click(rows()[49]!);
	const reopened = screen.getByRole("complementary", { name: "Text focus" });
	await within(reopened).findByText("50 of 62");
	await user.click(within(reopened).getByRole("button", { name: "Next line" }));
	await within(reopened).findByText("51 of 62");
});
it("steps back to the previous group's last line, loading the pages it has not shown", async () => {
	// 62 lines whose key has two texts conflict; one line on its own is up to date.
	const conflicting = savedLines("conflicting-line:", 62).map((unit) => ({
		...unit,
		source: { status: "conflicting" as const, values: ["One", "Two"] },
		reviewSignals: ["conflicting" as const],
		problems: ["conflicting_source" as const]
	}));
	const unique = {
		...continueRow,
		id: makeTextUnitId("unique-line"),
		source: { status: "consistent" as const, value: "Unique line" }
	};
	const input = listing([...conflicting, unique]);
	const listed = answer({}, [...conflicting, unique]);
	const lines: PlantedText = {
		...input,
		answers: [
			{
				...listed,
				rows: listed.rows.map((row) =>
					row.unit === unique
						? row
						: { ...row, groups: { problem: "conflicting_source" } }
				),
				groups: {
					problem: [
						{
							key: "conflicting_source",
							label: "Same key, different text",
							count: 62,
							needWork: 62,
							worst: "conflicting_source"
						},
						quiet("up_to_date", "Up to date", 1)
					]
				}
			}
		]
	};
	const user = userEvent.setup({ delay: null });
	mount(makeClient(lines));
	await screen.findByText("63 matches");
	const results = screen.getByRole("region", { name: "Results" });
	const header = (name: RegExp) =>
		within(results)
			.getAllByRole("button")
			.find(
				(button) =>
					button.hasAttribute("aria-expanded") && name.test(button.textContent ?? "")
			)!;
	const openUnique = async () => {
		if (header(/Up to date/u).getAttribute("aria-expanded") === "false")
			await user.click(header(/Up to date/u));
		await user.click(await within(results).findByRole("button", { name: /^Unique line/u }));
	};
	const page = () => screen.getByRole("complementary", { name: "Text focus" });
	// The conflicting group is open with its first page loaded.
	await openUnique();
	await within(page()).findByText("63 of 63");
	await user.click(within(page()).getByRole("button", { name: "Previous line" }));
	await within(page()).findByText("62 of 63", undefined, { timeout: 3000 });
	// Closed, the group opens and loads every page before its last line is picked.
	await user.click(within(page()).getByRole("button", { name: /Lines/u }));
	await user.click(header(/Same key, different text/u));
	await openUnique();
	await within(page()).findByText("63 of 63");
	await user.click(within(page()).getByRole("button", { name: "Previous line" }));
	await within(page()).findByText("62 of 63", undefined, { timeout: 3000 });
});
