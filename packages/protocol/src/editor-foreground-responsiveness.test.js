import { makeWireJsonSchemaDocument, canonicalJsonSchemaReferences } from "./json-schema.js";
import { readdirSync, readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { EditorForegroundLeaseRequest, EditorForegroundLeaseResult, EditorForegroundStateRequest, EditorForegroundStateResult } from "./editor-foreground-responsiveness.js";
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const tryDecodeLeaseRequest = Schema.decodeUnknownResult(EditorForegroundLeaseRequest);
const tryDecodeLeaseResult = Schema.decodeUnknownResult(EditorForegroundLeaseResult);
const tryDecodeStateResult = Schema.decodeUnknownResult(EditorForegroundStateResult);
const decodeLeaseResult = Schema.decodeUnknownSync(EditorForegroundLeaseResult);
const contract = new URL("../contracts/core/v1/", import.meta.url);
const fixtures = new URL("fixtures/foreground-responsiveness/", contract);
function fixture(name) {
    return decodeJson(JSON.parse(readFileSync(new URL(name, fixtures), "utf8")));
}
describe("editor foreground responsiveness contract", () => {
    it("keeps TypeScript aligned with the shared Core schemas", () => {
        for (const [name, schema] of [
            ["foreground-lease-request", EditorForegroundLeaseRequest],
            ["foreground-lease-result", EditorForegroundLeaseResult],
            ["foreground-state-request", EditorForegroundStateRequest],
            ["foreground-state-result", EditorForegroundStateResult]
        ]) {
            const wire = JSON.parse(readFileSync(new URL(`${name}.schema.json`, contract), "utf8"));
            const document = makeWireJsonSchemaDocument(schema);
            expect(canonicalJsonSchemaReferences({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                $defs: document.definitions,
                ...document.schema
            })).toEqual(canonicalJsonSchemaReferences(wire));
        }
    });
    it("accepts the valid request fixtures and rejects every invalid one", () => {
        const names = readdirSync(fixtures).filter((name) => name.startsWith("request-"));
        expect(names.filter((name) => name.startsWith("request-valid-")).length).toBeGreaterThan(0);
        expect(names.filter((name) => name.startsWith("request-invalid-")).length).toBeGreaterThan(0);
        for (const name of names) {
            const decoded = tryDecodeLeaseRequest(fixture(name), {
                onExcessProperty: "error"
            });
            expect([name, decoded._tag]).toEqual([
                name,
                name.startsWith("request-valid-") ? "Success" : "Failure"
            ]);
        }
    });
    it("decodes every result fixture", () => {
        for (const name of readdirSync(fixtures).filter((entry) => entry.startsWith("result-")))
            expect([name, tryDecodeLeaseResult(fixture(name))._tag]).toEqual([name, "Success"]);
        expect(tryDecodeStateResult(fixture("state-reported.json"))._tag).toBe("Success");
    });
    it("requires a lease ID and TTL on a grant", () => {
        const granted = decodeLeaseResult(fixture("result-granted.json"));
        expect(granted.status).toBe("granted");
        if (granted.status !== "granted")
            return;
        const { leaseId: _leaseId, ...withoutLease } = granted;
        const { ttlMs: _ttlMs, ...withoutTtl } = granted;
        for (const incomplete of [withoutLease, withoutTtl])
            expect(tryDecodeLeaseResult(incomplete)._tag).toBe("Failure");
    });
});
