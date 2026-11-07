import { makeWireJsonSchemaDocument, canonicalJsonSchemaReferences } from "./json-schema.js";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { EditorWindowActivationRequest, EditorWindowActivationResult } from "./editor-window-activation.js";
const tryDecodeActivationRequest = Schema.decodeUnknownResult(EditorWindowActivationRequest);
it("keeps TypeScript aligned with the shared Core window contract", () => {
    for (const [name, schema] of [
        ["request", EditorWindowActivationRequest],
        ["result", EditorWindowActivationResult]
    ]) {
        const wire = JSON.parse(readFileSync(new URL(`../contracts/core/v1/window-activation-${name}.schema.json`, import.meta.url), "utf8"));
        const document = makeWireJsonSchemaDocument(schema);
        expect(canonicalJsonSchemaReferences({
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $defs: document.definitions,
            ...document.schema
        })).toEqual(canonicalJsonSchemaReferences(wire));
    }
});
it("rejects wildcard and invalid process targets", () => {
    for (const expectedProcessId of [0, -1, 1.5, 4_294_967_295, "42"]) {
        expect(tryDecodeActivationRequest({ expectedProcessId })._tag).toBe("Failure");
    }
});
