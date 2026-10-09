import { readdirSync, readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	EditorForegroundLeaseRequest,
	EditorForegroundLeaseResult,
	EditorForegroundStateRequest,
	EditorForegroundStateResult
} from "./editor-foreground-responsiveness.js";

const contract = new URL("../contracts/core/v1/", import.meta.url);
const fixtures = new URL("fixtures/foreground-responsiveness/", contract);

function fixture(name: string): Schema.Json {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(new URL(name, fixtures), "utf8"))
	);
}

describe("editor foreground responsiveness contract", () => {
	it("keeps TypeScript aligned with the shared Core schemas", () => {
		for (const [name, schema] of [
			["foreground-lease-request", EditorForegroundLeaseRequest],
			["foreground-lease-result", EditorForegroundLeaseResult],
			["foreground-state-request", EditorForegroundStateRequest],
			["foreground-state-result", EditorForegroundStateResult]
		] as const) {
			const wire = JSON.parse(readFileSync(new URL(`${name}.schema.json`, contract), "utf8"));
			const document = Schema.toJsonSchemaDocument(schema);
			expect({
				$schema: "https://json-schema.org/draft/2020-12/schema",
				$defs: document.definitions,
				...document.schema
			}).toEqual(wire);
		}
	});

	it("accepts the valid request fixtures and rejects every invalid one", () => {
		const names = readdirSync(fixtures).filter((name) => name.startsWith("request-"));
		expect(names.filter((name) => name.startsWith("request-valid-")).length).toBeGreaterThan(0);
		expect(names.filter((name) => name.startsWith("request-invalid-")).length).toBeGreaterThan(
			0
		);
		for (const name of names) {
			const decoded = Schema.decodeUnknownResult(EditorForegroundLeaseRequest)(
				fixture(name),
				{
					onExcessProperty: "error"
				}
			);
			expect([name, decoded._tag]).toEqual([
				name,
				name.startsWith("request-valid-") ? "Success" : "Failure"
			]);
		}
	});

	it("decodes every result fixture", () => {
		for (const name of readdirSync(fixtures).filter((entry) => entry.startsWith("result-")))
			expect([
				name,
				Schema.decodeUnknownResult(EditorForegroundLeaseResult)(fixture(name))._tag
			]).toEqual([name, "Success"]);
		expect(
			Schema.decodeUnknownResult(EditorForegroundStateResult)(fixture("state-reported.json"))
				._tag
		).toBe("Success");
	});

	it("requires a lease ID and TTL on a grant", () => {
		const granted = Schema.decodeUnknownSync(EditorForegroundLeaseResult)(
			fixture("result-granted.json")
		);
		expect(granted.status).toBe("granted");
		if (granted.status !== "granted") return;
		const { leaseId: _leaseId, ...withoutLease } = granted;
		const { ttlMs: _ttlMs, ...withoutTtl } = granted;
		for (const incomplete of [withoutLease, withoutTtl])
			expect(Schema.decodeUnknownResult(EditorForegroundLeaseResult)(incomplete)._tag).toBe(
				"Failure"
			);
	});
});
