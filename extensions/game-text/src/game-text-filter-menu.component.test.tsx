import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type { TextFilter, TextGroupList } from "@ue-shed/game-text/schema";
import { afterEach, expect, it, vi } from "vitest";
import { FilterMenu, FilterPills, type FilterCounts } from "./game-text-filter-menu.js";

afterEach(cleanup);

const rules: TextGroupList = {
	entries: [
		{
			key: "custom.exclaim",
			label: "Exclamation mark",
			count: 3,
			needWork: 0,
			worst: "finding"
		},
		{ key: "localization.long", label: "Long text", count: 0, needWork: 0, worst: "up_to_date" }
	],
	more: 0
};

const counts = (patch: Partial<FilterCounts>): FilterCounts => ({
	choices: {
		fact: { unresolved: 2, conflicting: 0, evidence_only: 0, compiled_copy_differs: 1 }
	},
	folders: undefined,
	assets: undefined,
	assetTypes: undefined,
	findings: rules,
	findingsStatus: "ready",
	...patch
});

function open(filterCounts: FilterCounts, filter: TextFilter = []) {
	const onChange = vi.fn<(filter: TextFilter) => void>();
	render(() => (
		<FilterMenu
			filter={filter}
			counts={filterCounts}
			hasTarget={true}
			disabled={false}
			onChange={onChange}
		/>
	));
	return onChange;
}

it("lists the project's rules as findings and the four facts, hiding rules without rows", async () => {
	const user = userEvent.setup();
	const onChange = open(counts({}));
	await user.click(screen.getByRole("button", { name: "Filter" }));
	await user.click(screen.getByRole("menuitem", { name: /^Finding/u }));
	expect(screen.getByRole("menuitemcheckbox", { name: "Exclamation mark 3" })).toBeTruthy();
	expect(screen.queryByRole("menuitemcheckbox", { name: /Long text/u })).toBeNull();
	await user.click(screen.getByRole("menuitemcheckbox", { name: "Exclamation mark 3" }));
	expect(onChange).toHaveBeenLastCalledWith([
		{ field: "finding", op: "is", values: ["custom.exclaim"] }
	]);
	await user.click(screen.getByRole("menuitem", { name: /^Fact/u }));
	expect(screen.getByRole("menuitemcheckbox", { name: "Not localizable 2" })).toBeTruthy();
	expect(
		screen.queryByRole("menuitemcheckbox", { name: /Same key, different text/u })
	).toBeNull();
});

it("says the rules are checking while pending, and has no Finding field without rules", async () => {
	const user = userEvent.setup();
	open(counts({ findings: undefined, findingsStatus: "pending" }));
	await user.click(screen.getByRole("button", { name: "Filter" }));
	expect(screen.getByRole("menuitem", { name: /Finding \(checking rules…\)/u })).toBeTruthy();
	cleanup();
	open(counts({ findings: undefined, findingsStatus: "none" }));
	await user.click(screen.getByRole("button", { name: "Filter" }));
	expect(screen.queryByRole("menuitem", { name: /^Finding/u })).toBeNull();
	expect(screen.getByRole("menuitem", { name: /^Fact/u })).toBeTruthy();
});

it("shows a finding pill by its rule's label", () => {
	render(() => (
		<FilterPills
			filter={[{ field: "finding", op: "is", values: ["custom.exclaim", "unknown.rule"] }]}
			onChange={() => undefined}
			rules={new Map([["custom.exclaim", "Exclamation mark"]])}
		/>
	));
	expect(
		screen.getByRole("button", {
			name: "Remove Finding is any of Exclamation mark, unknown.rule"
		})
	).toBeTruthy();
});
