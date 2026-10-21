import { screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { makeTextOccurrenceId, makeTextUnitId, type TextCorpus } from "@ue-shed/game-text/schema";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { textCorpusQuery } from "../../../packages/game-text/src/query.test-support.js";
import { corpus, makeClient, mount } from "./game-text-route.test-support.js";
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
	const user = userEvent.setup({ delay: null });
	mount(makeClient(input));
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
	const first = corpus.units[0]!;
	const input: TextCorpus = {
		...corpus,
		units: Array.from({ length: 62 }, (_, index) => ({
			...first,
			id: makeTextUnitId("page-line:" + index.toString().padStart(3, "0")),
			source: { status: "consistent", value: "Line " + index }
		}))
	};
	const user = userEvent.setup({ delay: null });
	mount(makeClient(input));
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
	const first = corpus.units[0]!;
	const input: TextCorpus = {
		...corpus,
		units: Array.from({ length: 62 }, (_, index) => ({
			...first,
			id: makeTextUnitId("late-line:" + index.toString().padStart(3, "0")),
			source: { status: "consistent", value: "Line " + index }
		}))
	};
	const query = textCorpusQuery(input, "2026-10-07T16:53:00.000Z");
	const later = Effect.runSync(Deferred.make<void>());
	const user = userEvent.setup({ delay: null });
	mount(
		makeClient(input, {
			search: (request) =>
				(request.cursor ? Deferred.await(later) : Effect.void).pipe(
					Effect.as({ status: "ready" as const, page: query.search(request) })
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
	const first = corpus.units[0]!;
	const savedLine = (id: string, source: string) => {
		const identity = { status: "resolved" as const, namespace: "UI", key: id };
		return {
			...first,
			id: makeTextUnitId(id),
			identity,
			occurrences: first.occurrences.map((occurrence) => ({
				...occurrence,
				id: makeTextOccurrenceId(`occurrence:${id}`),
				identity,
				// Each line is its own String Table entry: keys at one place are not duplicates.
				location:
					occurrence.location.kind === "string_table_entry"
						? { ...occurrence.location, entryKey: id }
						: occurrence.location,
				source
			})),
			source: { status: "consistent" as const, value: source }
		};
	};
	const input: TextCorpus = {
		...corpus,
		units: [
			// 62 lines with the same text are findings; one line on its own is up to date.
			...Array.from({ length: 62 }, (_, index) =>
				savedLine("same-line:" + index.toString().padStart(3, "0"), "Same text")
			),
			savedLine("unique-line", "Unique line")
		]
	};
	const user = userEvent.setup({ delay: null });
	mount(makeClient(input));
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
	// The findings group is open with its first page loaded.
	await openUnique();
	await within(page()).findByText("63 of 63");
	await user.click(within(page()).getByRole("button", { name: "Previous line" }));
	await within(page()).findByText("62 of 63", undefined, { timeout: 3000 });
	// Closed, the group opens and loads every page before its last line is picked.
	await user.click(within(page()).getByRole("button", { name: /Lines/u }));
	await user.click(header(/Findings/u));
	await openUnique();
	await within(page()).findByText("63 of 63");
	await user.click(within(page()).getByRole("button", { name: "Previous line" }));
	await within(page()).findByText("62 of 63", undefined, { timeout: 3000 });
});
