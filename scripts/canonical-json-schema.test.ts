import assert from "node:assert/strict";
import { test } from "node:test";
import { assertJsonSchemaEquivalent } from "./canonical-json-schema.ts";

void test("compares recursive definitions through renamed aliases and equivalent conjunctions", () => {
	const first = {
		$ref: "#/$defs/Alias",
		$defs: {
			Alias: { $ref: "#/$defs/Node" },
			Node: {
				type: "object",
				properties: {
					next: { $ref: "#/$defs/Alias" },
					size: { type: "integer", allOf: [{ minimum: 1, maximum: 10 }] }
				},
				additionalProperties: false
			}
		}
	};
	const second = {
		$ref: "#/$defs/Renamed",
		$defs: {
			Renamed: {
				type: "object",
				properties: {
					size: { type: "integer", allOf: [{ maximum: 10 }, { minimum: 1 }] },
					next: { $ref: "#/$defs/Renamed" }
				},
				additionalProperties: false
			}
		}
	};
	assertJsonSchemaEquivalent(first, second);
});

void test("compares equivalent alternatives through nested anyOf wrappers", () => {
	const nested = {
		anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }, { type: "number" }]
	};
	const flat = { anyOf: [{ type: "string" }, { type: "null" }, { type: "number" }] };
	assertJsonSchemaEquivalent(nested, flat);
	assert.throws(() =>
		assertJsonSchemaEquivalent(nested, {
			anyOf: [{ type: "string" }, { type: "boolean" }, { type: "number" }]
		})
	);
});

void test("still detects changed bounds, required fields, patterns and object closure", () => {
	const original = {
		type: "object",
		properties: { path: { type: "string", allOf: [{ minLength: 7 }, { pattern: "^/Game/" }] } },
		required: ["path"],
		additionalProperties: false
	};
	for (const changed of [
		{ ...original, required: [] },
		{ ...original, additionalProperties: true },
		{
			...original,
			properties: {
				path: { type: "string", allOf: [{ minLength: 4 }, { pattern: "^/Game/" }] }
			}
		},
		{
			...original,
			properties: {
				path: { type: "string", allOf: [{ minLength: 7 }, { pattern: "^/Other/" }] }
			}
		}
	])
		assert.throws(() => assertJsonSchemaEquivalent(original, changed));
});

void test("rejects missing definitions and cyclic aliases", () => {
	assert.throws(
		() => assertJsonSchemaEquivalent({ $ref: "#/$defs/Missing" }, {}),
		/Missing JSON Schema definition/
	);
	assert.throws(
		() =>
			assertJsonSchemaEquivalent(
				{
					$ref: "#/$defs/A",
					$defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } }
				},
				{}
			),
		/Cyclic JSON Schema alias/
	);
});
