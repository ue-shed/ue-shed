import { describe, expect, it } from "vitest";
import { defaultCustodianPolicy, resolvePolicyDocument } from "./policy.js";

describe("Project Custodian policy", () => {
	it("keeps destructive-cost targets conservative by default", () => {
		expect(defaultCustodianPolicy.keepBinariesForCpp).toBe(true);
		expect(defaultCustodianPolicy.targets).toContain("autosaves");
		expect(defaultCustodianPolicy.targets).not.toContain("saved_config");
	});

	it("applies a known project policy without mutating defaults", () => {
		const resolution = resolvePolicyDocument({
			enabled: true,
			min_age_days: 30,
			min_free_gb: 50,
			keep_binaries_for_cpp: false,
			targets: ["intermediate", "saved_config"]
		});

		expect(resolution.error).toBeUndefined();
		expect(resolution.policy).toMatchObject({
			minAgeDays: 30,
			minFreeGb: 50,
			keepBinariesForCpp: false,
			targets: ["intermediate", "saved_config"],
			source: "project"
		});
		expect(defaultCustodianPolicy.keepBinariesForCpp).toBe(true);
	});

	it("fails closed for unknown target and field names", () => {
		for (const document of [
			{ targets: ["intermediate", "Content"] },
			{ targets: ["intermediate"], minimum_age_days: 7 }
		]) {
			const resolution = resolvePolicyDocument(document);
			expect(resolution.error).toBeDefined();
			expect(resolution.policy.enabled).toBe(false);
			expect(resolution.policy.targets).toEqual([]);
		}
	});
});
