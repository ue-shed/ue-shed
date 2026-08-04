import { describe, expect, it } from "vitest";
import { parseArguments } from "./benchmark-project-index.js";

describe("project-index benchmark arguments", () => {
	it("builds the default release reader unless explicitly disabled", () => {
		expect(parseArguments(["--project", "fixtures/unreal-project"])?.buildReader).toBe(true);
		expect(
			parseArguments(["--project", "fixtures/unreal-project", "--no-build"])?.buildReader
		).toBe(false);
	});

	it("treats an explicitly supplied reader as a prebuilt artifact", () => {
		const options = parseArguments([
			"--project",
			"fixtures/unreal-project",
			"--reader",
			"out/uasset"
		]);
		expect(options?.buildReader).toBe(false);
		expect(options?.reader).toMatch(/out[\\/]uasset$/);
	});

	it("rejects missing projects and invalid sample counts", () => {
		expect(() => parseArguments([])).toThrow("--project is required");
		expect(() =>
			parseArguments(["--project", "fixtures/unreal-project", "--runs", "0"])
		).toThrow("positive integer");
	});
});
