import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { expect, it } from "vitest";
import {
	EditorWindowActivationRequest,
	EditorWindowActivationResult
} from "./editor-window-activation.js";

it("keeps TypeScript aligned with the shared Core window contract", () => {
	for (const [name, schema] of [
		["request", EditorWindowActivationRequest],
		["result", EditorWindowActivationResult]
	] as const) {
		const wire = JSON.parse(
			readFileSync(
				new URL(
					`../contracts/core/v1/window-activation-${name}.schema.json`,
					import.meta.url
				),
				"utf8"
			)
		);
		const document = Schema.toJsonSchemaDocument(schema);
		expect({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			$defs: document.definitions,
			...document.schema
		}).toEqual(wire);
	}
});

it("rejects wildcard and invalid process targets", () => {
	for (const expectedProcessId of [0, -1, 1.5, 4_294_967_295, "42"]) {
		expect(
			Schema.decodeUnknownResult(EditorWindowActivationRequest)({ expectedProcessId })._tag
		).toBe("Failure");
	}
});
