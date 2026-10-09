import { describe, expect, it } from "vitest";
import { resolveLocalizationGatherPath } from "./browser.js";

describe("localization gather path roots", () => {
	it.each([
		["Content/UI/*", "plain", "Content/UI/*"],
		["%LOCPROJECTROOT%Content/UI/*", "project", "Content/UI/*"],
		["%LOCPROJECTROOT%/Content/UI/*", "project", "Content/UI/*"],
		["%locprojectroot%\\Content\\UI\\*", "project", "Content\\UI\\*"],
		["%LOCENGINEROOT%Content/*", "engine", "Content/*"],
		["%locengineroot%/Content/*", "engine", "Content/*"],
		["%FOO%Content/*", "unknown", "%FOO%Content/*"],
		["Content/%FOO%/*", "unknown", "Content/%FOO%/*"]
	])("resolves %s", (input, root, path) => {
		expect(resolveLocalizationGatherPath(input)).toEqual({ root, path });
	});
});
