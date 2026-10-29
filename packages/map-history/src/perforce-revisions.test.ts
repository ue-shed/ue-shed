import { describe, expect, it } from "vitest";
import {
	changelistRevisionSpecs,
	rangeRevisionSpecs,
	specBatches,
	workspaceHolds
} from "./perforce-revisions.js";

const file = (action: string, revision: number) => ({
	depotPath: "//Project/Main/Content/UI/WBP_Menu.uasset",
	action,
	revision
});

describe("a changelist's revisions", () => {
	it("compares a submitted file's revision with the one before it", () => {
		expect(changelistRevisionSpecs(file("edit", 4), 220, false)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#3",
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
		expect(changelistRevisionSpecs(file("add", 1), 220, false)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#1"
		});
		expect(changelistRevisionSpecs(file("delete", 5), 220, false)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
		expect(changelistRevisionSpecs(file("move/add", 1), 220, false)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset#1"
		});
	});

	it("compares a shelved file with the revision the shelf is based on", () => {
		expect(changelistRevisionSpecs(file("edit", 4), 230, true)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4",
			head: "//Project/Main/Content/UI/WBP_Menu.uasset@=230"
		});
		expect(changelistRevisionSpecs(file("add", 0), 230, true)).toEqual({
			head: "//Project/Main/Content/UI/WBP_Menu.uasset@=230"
		});
		expect(changelistRevisionSpecs(file("delete", 4), 230, true)).toEqual({
			base: "//Project/Main/Content/UI/WBP_Menu.uasset#4"
		});
	});
});

describe("a range's revisions", () => {
	it("compares a file's revision at the start with its last one in the range", () => {
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 7, deleted: false }, 4)
		).toEqual({ action: "edit", base: "//p/A.uasset#4", head: "//p/A.uasset#7" });
	});

	it("has no base for a file the range adds, and no head for one it deletes", () => {
		expect(
			rangeRevisionSpecs(
				{ depotPath: "//p/A.uasset", revision: 1, deleted: false },
				undefined
			)
		).toEqual({ action: "add", head: "//p/A.uasset#1" });
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 5, deleted: true }, 4)
		).toEqual({ action: "delete", base: "//p/A.uasset#4" });
	});

	it("lists a long range's files in batches a command line holds", () => {
		const specs = Array.from(
			{ length: 600 },
			(_, index) => `//Project/Main/Content/UI/Widgets/WBP_Widget_${index}.uasset@220670`
		);
		const batches = specBatches(specs);
		expect(batches.length).toBeGreaterThan(1);
		expect(batches.flat()).toEqual(specs);
		for (const batch of batches)
			expect(batch.reduce((size, spec) => size + spec.length + 3, 0)).toBeLessThanOrEqual(
				24_000
			);
		expect(specBatches([])).toEqual([]);
	});

	it("leaves out a file the range adds and deletes", () => {
		expect(
			rangeRevisionSpecs({ depotPath: "//p/A.uasset", revision: 2, deleted: true }, undefined)
		).toBeUndefined();
	});
});

describe("a file at a revision", () => {
	it("is read from the workspace only when the workspace has that revision unopened", () => {
		expect(workspaceHolds(7, 7, false)).toBe(true);
		expect(workspaceHolds(7, 8, false)).toBe(false);
		expect(workspaceHolds(7, undefined, false)).toBe(false);
		// Checked out: the workspace copy may hold edits.
		expect(workspaceHolds(7, 7, true)).toBe(false);
	});
});
