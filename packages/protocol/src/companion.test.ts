import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCompanionCapabilityManifest } from "./companion.js";

describe("companion scenario capability manifest", () => {
	it("decodes the bounded optional scenario capability", async () => {
		const manifest = await Effect.runPromise(
			decodeCompanionCapabilityManifest({
				capabilities: ["scenarios.execute.pie.v1"],
				producerKind: "unreal_editor",
				scenarioLimits: {
					maxActions: 8,
					maxDurationMs: 30_000,
					maxEvidence: 8,
					maxKeyframes: 32
				},
				scenariosObjectPath: "/Script/UEShedScenariosEditor.Default__UEShedScenarioLibrary",
				schemaVersion: 1
			})
		);
		expect(manifest.scenarioLimits?.maxEvidence).toBe(8);
		expect(manifest.scenariosObjectPath).toContain("UEShedScenarioLibrary");
	});

	it("rejects negative scenario limits", async () => {
		const exit = await Effect.runPromiseExit(
			decodeCompanionCapabilityManifest({
				capabilities: [],
				producerKind: "unreal_editor",
				scenarioLimits: {
					maxActions: -1,
					maxDurationMs: 30_000,
					maxEvidence: 8,
					maxKeyframes: 32
				},
				schemaVersion: 1
			})
		);
		expect(exit._tag).toBe("Failure");
	});
});
