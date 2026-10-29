import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { TextDiff, entryRows } from "./text-diff.js";
import type { TextDiffEntry } from "./text-diff-model.js";

afterEach(cleanup);

const entries: TextDiffEntry[] = [
	{
		id: "quit",
		kind: "edited",
		before: { label: "Menu,Quit", full: "Menu,Quit" },
		after: { label: "Menu,Quit", full: "Menu,Quit" },
		file: "Localization/Game/fr/Game.po",
		fields: [
			{ label: "Source", before: "Quit", after: "Quit" },
			{ label: "Translation", before: "Quitter", after: "Quitter le jeu" }
		]
	},
	{
		id: "credits",
		kind: "added",
		after: { label: "Menu,Credits", full: "Menu,Credits" },
		file: "Localization/Game/fr/Game.po",
		fields: [{ label: "Source", after: "Credits" }]
	},
	{
		id: "line",
		kind: "rekeyed",
		before: { label: "Dialogue,Line_01", full: "Dialogue,Line_01" },
		after: { label: "Dialogue,6F1C", full: "Dialogue,6F1C" },
		file: "Localization/Game/de/Game.po",
		fields: [
			{ label: "Source", before: "Where were you?", after: "Where were you?" },
			{ label: "Key", before: "Dialogue,Line_01", after: "Dialogue,6F1C", code: true }
		]
	}
];

it("groups entries by file and marks only the words that changed", () => {
	render(() => <TextDiff label="Changes" entries={entries} />);
	const files = screen.getAllByRole("list", { name: "Changes in Game.po" });
	expect(files).toHaveLength(2);
	const [french] = files;
	if (french === undefined) throw new Error("No French file.");
	const edit = within(within(french).getByRole("listitem", { name: "Edited" }));
	expect(
		edit.getAllByText(/le jeu/u, { selector: "mark" }).map((mark) => mark.textContent)
	).toEqual([" le jeu"]);
});

it("shows a new key's text once and its old and new key as a field", () => {
	const rekey = entries.find((entry) => entry.kind === "rekeyed");
	if (rekey === undefined) throw new Error("No new key.");
	const rows = entryRows(rekey);
	expect(rows.map((row) => [row.sign, row.field ?? ""])).toEqual([
		["~", ""],
		["−", "Key"],
		["+", "Key"]
	]);
});

it("filters by kind and by text on the entries it has, and asks for more", () => {
	const more = vi.fn();
	render(() => (
		<TextDiff
			label="Changes"
			entries={entries}
			total={10}
			counts={{ added: 4, removed: 1, rekeyed: 2, edited: 3 }}
			onMore={more}
		/>
	));
	fireEvent.click(screen.getByRole("button", { name: /Added/u }));
	expect(screen.getAllByRole("listitem", { name: "Added" })).toHaveLength(1);
	expect(screen.queryByRole("listitem", { name: "Edited" })).toBeNull();
	expect(screen.getByText(/Filtering the first 3 of 10/u)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /All/u }));
	fireEvent.input(screen.getByRole("searchbox", { name: "Filter by text, key or file" }), {
		target: { value: "where" }
	});
	expect(screen.getAllByRole("listitem", { name: "New key" })).toHaveLength(1);
	expect(screen.queryByRole("listitem", { name: "Added" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Load more" }));
	expect(more).toHaveBeenCalledOnce();
});

it("says when nothing changed", () => {
	render(() => <TextDiff label="Changes" entries={[]} />);
	expect(screen.getByText("No text changed.")).toBeTruthy();
});
