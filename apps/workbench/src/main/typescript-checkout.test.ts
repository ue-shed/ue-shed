import { describe, expect, it } from "vitest";
import { typescriptCheckoutArgs, typescriptLoader } from "./typescript-checkout.js";

describe("typescriptCheckoutArgs", () => {
	it("loads checkout scripts through the tsx hook", () => {
		expect(typescriptLoader.startsWith("file:")).toBe(true);
		expect(typescriptLoader.includes("tsx")).toBe(true);
		expect(typescriptCheckoutArgs("scripts/unreal-project.ts", ["launch"])).toEqual([
			"--import",
			typescriptLoader,
			"scripts/unreal-project.ts",
			"launch"
		]);
	});
});
