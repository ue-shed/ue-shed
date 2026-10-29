import { describe, expect, it } from "vitest";
import { changelistRevisionSpecs } from "./perforce-revisions.js";

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
