import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeLegacyEvidence } from "./evidence.js";

const root = fileURLToPath(new URL("./EvidenceContractFixtures/", import.meta.url));

describe("legacy commandlet evidence contract", () => {
	for (const name of readdirSync(join(root, "valid")).toSorted()) {
		it(`accepts synthetic valid sample ${name} in both schemas`, () => {
			const input: unknown = JSON.parse(readFileSync(join(root, "valid", name), "utf8"));
			expect(decodeLegacyEvidence(input)).toEqual(input);
		});
	}
	for (const name of readdirSync(join(root, "invalid")).toSorted()) {
		it(`rejects synthetic invalid sample ${name}`, () => {
			const input: unknown = JSON.parse(readFileSync(join(root, "invalid", name), "utf8"));
			expect(() => decodeLegacyEvidence(input)).toThrow();
		});
	}
});
