import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ContractParseError, contractParser, contractParserSync } from "./contract-parser.js";
import { decodeAutomationInputRequest } from "./automation.js";
import { decodeSavedAssetInspection } from "./uasset-inspection.js";

describe("external contract failures", () => {
	it("keeps the failing field and contract without losing recovery guidance", async () => {
		const result = await Effect.runPromise(
			Effect.result(
				contractParser(Schema.Struct({ count: Schema.Int }), "inventory")({ count: "bad" })
			)
		);
		expect(Result.isFailure(result)).toBe(true);
		if (!Result.isFailure(result)) throw new Error("Expected a rejected contract");
		expect(Schema.is(ContractParseError)(result.failure)).toBe(true);
		expect(result.failure).toMatchObject({
			code: "invalid_contract",
			contract: "inventory",
			retrySafe: false,
			nextStep: "fix_input"
		});
		expect(Schema.isSchemaError(result.failure.cause)).toBe(true);
		expect(String(result.failure.cause)).toContain("count");
	});

	it("uses the same domain error at synchronous document boundaries", () => {
		const parse = contractParserSync(Schema.Struct({ count: Schema.Int }), "recording");
		expect(() => parse({ count: "bad" })).toThrow(ContractParseError);
		expect(parse({ count: 2, futureField: true })).toEqual({ count: 2 });
	});

	it("classifies malformed native inspection and editor requests at their public parsers", async () => {
		for (const rejected of [
			decodeAutomationInputRequest(null).pipe(Effect.asVoid),
			decodeSavedAssetInspection(null).pipe(Effect.asVoid)
		]) {
			const result = await Effect.runPromise(Effect.result(rejected));
			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) throw new Error("Expected a rejected contract");
			expect(Schema.is(ContractParseError)(result.failure)).toBe(true);
			expect(Schema.isSchemaError(result.failure.cause)).toBe(true);
		}
	});
});
