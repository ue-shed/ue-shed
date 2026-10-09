import { describe, expect, it } from "vitest";
import { stripPackageNamespace } from "./text-namespace.js";

describe("Unreal package namespaces", () => {
	it.each([
		["", ""],
		["[ABC]", ""],
		["NS [ABC]", "NS"],
		["NS  [ABC]", "NS"],
		["NS[ABC]", "NS"],
		["[A] [B]", "[A]"],
		["NS [ABC] trailing", "NS [ABC] trailing"],
		["NS]", "NS]"],
		["NS \t[ABC]", "NS"],
		["NS [ABC] ", "NS [ABC] "],
		["NS []", "NS"],
		["NS [A[B]", "NS [A"],
		["NS \t", "NS \t"]
	])("strips %j to %j", (saved, clean) => {
		expect(stripPackageNamespace(saved)).toBe(clean);
	});
});
