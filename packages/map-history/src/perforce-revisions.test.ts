import { describe, expect, it } from "vitest";
import { changelistRevisionSpecs, workspaceHolds } from "./perforce-revisions.js";

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

describe("a file at a revision", () => {
	it("is read from the workspace only when the workspace has that revision unopened", () => {
		expect(workspaceHolds(7, 7, false)).toBe(true);
		expect(workspaceHolds(7, 8, false)).toBe(false);
		expect(workspaceHolds(7, undefined, false)).toBe(false);
		// Checked out: the workspace copy may hold edits.
		expect(workspaceHolds(7, 7, true)).toBe(false);
	});
});
