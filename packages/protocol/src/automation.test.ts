import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	AutomationCsvRequest,
	AutomationInputRequest,
	AutomationPlayersRequest,
	AutomationCsvResult
} from "./automation.js";
import { AuthoringActorReferencesRequest } from "./authoring-actor-references.js";
import { CompanionCapabilityManifest } from "./companion.js";

function fixture(path: string): Schema.Json {
	return Schema.decodeUnknownSync(Schema.Json)(
		JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"))
	);
}

describe("automation and live reference wire contracts", () => {
	it("accepts the shared native request fixtures", () => {
		expect(
			Schema.decodeUnknownSync(AutomationPlayersRequest)(
				fixture("../contracts/automation/v1/fixtures/players-request.json")
			).worldObjectPath
		).toContain("FixtureWorld");
		expect(
			Schema.decodeUnknownSync(AutomationInputRequest)(
				fixture("../contracts/automation/v1/fixtures/input-request.json")
			).value
		).toEqual({ kind: "axis2d", x: 0.25, y: -0.5 });
		expect(
			Schema.decodeUnknownSync(AutomationCsvRequest)(
				fixture("../contracts/automation/v1/fixtures/csv-status-request.json")
			).command
		).toBe("status");
		expect(
			Schema.decodeUnknownSync(AuthoringActorReferencesRequest)(
				fixture("../contracts/authoring/v1/fixtures/actor-references-request.json")
			).maxActors
		).toBe(1000);
	});

	it("requires explicit targets and rejects nonfinite input coordinates", () => {
		const input = Schema.decodeUnknownSync(AutomationInputRequest)(
			fixture("../contracts/automation/v1/fixtures/input-request.json")
		);
		for (const value of [
			{ kind: "axis1d", x: Infinity },
			{ kind: "axis2d", x: 0 },
			{ kind: "axis3d", x: 0, y: 0, z: NaN },
			{ kind: "boolean", value: 1 }
		]) {
			expect(() =>
				Schema.decodeUnknownSync(AutomationInputRequest)({
					...input,
					value
				})
			).toThrow();
		}
		expect(() =>
			Schema.decodeUnknownSync(AutomationInputRequest)({
				...input,
				worldObjectPath: ""
			})
		).toThrow();
	});

	it("bounds live-world scans and rejects unsupported contract versions", () => {
		const request = Schema.decodeUnknownSync(AuthoringActorReferencesRequest)(
			fixture("../contracts/authoring/v1/fixtures/actor-references-request.json")
		);
		for (const maxActors of [0, 1.5, 100001]) {
			expect(() =>
				Schema.decodeUnknownSync(AuthoringActorReferencesRequest)({
					...request,
					maxActors
				})
			).toThrow();
		}
		expect(() =>
			Schema.decodeUnknownSync(AuthoringActorReferencesRequest)({
				...request,
				maxResults: 10001
			})
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(AuthoringActorReferencesRequest)({
				...request,
				contract: { ...request.contract, version: { major: 2, minor: 0 } }
			})
		).toThrow();
	});

	it("represents asynchronous captures and unavailable profilers honestly", () => {
		for (const state of ["starting", "stopping", "unavailable"]) {
			expect(
				Schema.decodeUnknownSync(AutomationCsvResult)({
					contract: { name: "unreal-automation-csv", version: { major: 1, minor: 0 } },
					status: "ok",
					state,
					outputDirectory: "",
					outputFile: null,
					errors: []
				}).state
			).toBe(state);
		}
	});

	it("accepts an automation-only packaged runtime producer", () => {
		expect(
			Schema.decodeUnknownSync(CompanionCapabilityManifest)({
				producerKind: "unreal_runtime",
				schemaVersion: 1,
				automationObjectPath: "/Script/UEShedAutomation.Default__UEShedAutomationLibrary",
				capabilities: ["automation.players.v1", "automation.input.v1"]
			}).producerKind
		).toBe("unreal_runtime");
	});
});
