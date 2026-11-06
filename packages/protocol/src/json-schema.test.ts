import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { makeWireJsonSchemaDocument } from "./json-schema.js";

describe("wire JSON Schema generation", () => {
	it("keeps encoded optional fields and property names that match schema keywords", () => {
		const schema = Schema.Struct({
			pattern: Schema.String,
			minimum: Schema.Int,
			optional: Schema.optional(Schema.String)
		});
		expect(makeWireJsonSchemaDocument(schema).schema).toEqual({
			type: "object",
			properties: {
				pattern: { type: "string" },
				minimum: { type: "integer" },
				optional: { anyOf: [{ type: "string" }, { type: "null" }] }
			},
			required: ["pattern", "minimum"],
			additionalProperties: false
		});
	});
	it("preserves declared integer bounds without changing the runtime schema", () => {
		const schema = Schema.Int.check(
			Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
		);
		const before = Schema.toJsonSchemaDocument(schema);
		expect(makeWireJsonSchemaDocument(schema).schema).toEqual({
			type: "integer",
			allOf: [{ minimum: 0 }, { maximum: Number.MAX_SAFE_INTEGER }]
		});
		expect(Schema.toJsonSchemaDocument(schema)).toEqual(before);
		expect(Schema.decodeResult(schema)(Number.MAX_SAFE_INTEGER + 1)._tag).toBe("Failure");
	});
	it("retains wire patterns, length bounds and non-finite number alternatives", () => {
		const text = Schema.String.check(Schema.isMinCodePoints(7), Schema.isPattern(/^\/Game\//u));
		expect(makeWireJsonSchemaDocument(text).schema).toEqual({
			type: "string",
			allOf: [{ minLength: 7 }, { pattern: "^\\/Game\\/" }]
		});
		expect(makeWireJsonSchemaDocument(Schema.Number).schema).toEqual({
			anyOf: [
				{ type: "number" },
				{ type: "string", enum: ["NaN"] },
				{ type: "string", enum: ["Infinity"] },
				{ type: "string", enum: ["-Infinity"] }
			]
		});
	});
});
