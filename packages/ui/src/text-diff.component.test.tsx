import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { TextDiff, entryRows } from "./text-diff.js";
import type { TextDiffEntry, TextDiffFilter, TextDiffGroup } from "./text-diff-model.js";

afterEach(cleanup);

const quit: TextDiffEntry = {
	id: "quit",
	kind: "edited",
	before: { label: "Quit", full: "Menu,Quit" },
	after: { label: "Quit", full: "Menu,Quit" },
	file: "Localization/Game/fr/Game.po",
	fields: [
		{ label: "Source", before: "Quit", after: "Quit" },
		{ label: "Translation", before: "Quitter", after: "Quitter le jeu" }
	]
};
const credits: TextDiffEntry = {
	id: "credits",
	kind: "added",
	after: { label: "Credits", full: "Menu,Credits" },
	file: "Localization/Game/fr/Game.po",
	fields: [
		{ label: "Source", after: "Credits" },
		{ label: "Notes", after: "Shown at the end", secondary: true }
	]
};
const line: TextDiffEntry = {
	id: "line",
	kind: "rekeyed",
	before: { label: "Line_01", full: "Dialogue,Line_01" },
	after: { label: "6F1C", full: "Dialogue,6F1C" },
	file: "Localization\\Game\\de\\Game.po",
	fields: [
		{ label: "Source", before: "Where were you?", after: "Where were you?" },
		{ label: "Translation", before: "Wo warst du?", after: "Wo warst du?", context: true }
	]
};
const entries = [quit, credits, line];

it("groups entries by file, splitting a Windows path, and marks only what changed", () => {
	render(() => <TextDiff label="Changes" entries={entries} />);
	const files = screen.getAllByRole("list", { name: "Changes in Game.po" });
	expect(files).toHaveLength(2);
	const [french] = files;
	if (french === undefined) throw new Error("No French file.");
	const edit = within(within(french).getByRole("listitem", { name: "Edited" }));
	expect(
		edit.getAllByText(/le jeu/u, { selector: "mark" }).map((mark) => mark.textContent)
	).toEqual([" le jeu"]);
	expect(screen.getByText("Localization\\Game\\de")).toBeTruthy();
});

it("shows a new key's old and new key, and its unchanged translation as context", () => {
	expect(entryRows(line).map((row) => [row.sign, row.tone, row.field ?? ""])).toEqual([
		["~", "moved", "Source"],
		[" ", "context", "Translation"]
	]);
	render(() => <TextDiff label="Changes" entries={[line]} />);
	const entry = screen.getByRole("listitem", { name: "New key" });
	expect(within(entry).getByText("Line_01")).toBeTruthy();
	expect(within(entry).getByText("6F1C")).toBeTruthy();
});

it("folds an added entry's secondary fields until asked", () => {
	render(() => <TextDiff label="Changes" entries={[credits]} />);
	const entry = screen.getByRole("listitem", { name: "Added" });
	expect(within(entry).queryByText("Shown at the end")).toBeNull();
	fireEvent.click(within(entry).getByRole("button", { name: "More details" }));
	expect(within(entry).getByText("Shown at the end")).toBeTruthy();
});

it("draws a removed space and names a changed symbol", () => {
	const percent: TextDiffEntry = {
		id: "percent",
		kind: "edited",
		file: "Game.po",
		after: { label: "Percent", full: "UI,Percent" },
		fields: [{ label: "Source", before: "0 %", after: "0%" }]
	};
	const apostrophe: TextDiffEntry = {
		id: "apostrophe",
		kind: "edited",
		file: "Game.po",
		after: { label: "Smell", full: "UI,Smell" },
		fields: [{ label: "Source", before: "It's here", after: "It’s here" }]
	};
	render(() => <TextDiff label="Changes" entries={[percent, apostrophe]} />);
	const marks = Array.from(document.querySelectorAll("mark"));
	expect(marks.map((mark) => [mark.textContent, mark.getAttribute("title")])).toEqual([
		["· ", "U+0020"],
		["'", "U+0027"],
		["’", "U+2019"]
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
	fireEvent.click(screen.getByRole("button", { name: "Added, 4" }));
	expect(screen.getAllByRole("listitem", { name: "Added" })).toHaveLength(1);
	expect(screen.queryByRole("listitem", { name: "Edited" })).toBeNull();
	expect(screen.getByText(/Filtering the first 3 of 10/u)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "All, 10" }));
	fireEvent.input(screen.getByRole("searchbox", { name: "Filter by text or key" }), {
		target: { value: "where" }
	});
	expect(screen.getAllByRole("listitem", { name: "New key" })).toHaveLength(1);
	expect(screen.queryByRole("listitem", { name: "Added" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Load more" }));
	expect(more).toHaveBeenCalledOnce();
});

const groups: readonly TextDiffGroup[] = [
	{ id: "rekeyed", label: "Moved to a new key", tone: "rekeyed", count: 1 },
	{ id: "added", label: "Added", tone: "added", count: 1 },
	{ id: "translation", label: "Translation changed", tone: "edited", count: 1 },
	{ id: "context", label: "Notes only", tone: "edited", count: 1, folded: true }
];

it("lists entries in their groups' sections, and leaves filtering to the host that does it", () => {
	const filters: TextDiffFilter[] = [];
	const [filter, setFilter] = createSignal<TextDiffFilter>({ query: "" });
	render(() => (
		<TextDiff
			label="Changes"
			groups={groups}
			entries={[
				{ ...line, group: "rekeyed" },
				{ ...credits, group: "added" },
				{ ...quit, group: "translation" }
			]}
			total={3}
			filter={filter()}
			onFilter={(next) => {
				filters.push(next);
				setFilter(next);
			}}
		/>
	));
	expect(
		screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent)
	).toEqual(["Moved to a new key", "Added", "Translation changed"]);
	fireEvent.click(screen.getByRole("button", { name: "Added, 1" }));
	expect(filters).toEqual([{ kind: "added", query: "" }]);
	// The host filters: everything it passed stays listed until it passes a new page.
	expect(screen.getAllByRole("listitem")).toHaveLength(3);
	expect(screen.getByRole("button", { name: "Added, 1" }).getAttribute("aria-pressed")).toBe(
		"true"
	);
});

it("folds a folded group's section until it is shown", () => {
	render(() => (
		<TextDiff
			label="Changes"
			groups={groups.filter((group) => group.id === "context")}
			entries={[{ ...quit, group: "context" }]}
		/>
	));
	expect(screen.queryByRole("listitem", { name: "Edited" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Show" }));
	expect(screen.getByRole("listitem", { name: "Edited" })).toBeTruthy();
});

it("says when nothing changed", () => {
	render(() => <TextDiff label="Changes" entries={[]} />);
	expect(screen.getByText("No text changed.")).toBeTruthy();
});
