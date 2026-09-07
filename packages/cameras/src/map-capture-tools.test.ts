import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import {
	inspectMapCaptureSelection,
	inspectMapCaptureReadiness,
	MapCaptureSelection,
	MapCaptureReadiness
} from "./map-capture-tools.js";
import { fitMapCapturePlanToSelection, makeDefaultMapCapturePlan } from "./map-tile-authoring.js";
const selection = {
	schemaVersion: 1 as const,
	status: "ready" as const,
	mapPath: "/Game/Fixture/Map",
	bounds: { minX: -100, maxX: 100, minY: 50, maxY: 250, minZ: 0, maxZ: 400 },
	actors: [{ path: "/Game/Fixture/Map.A", label: "A" }],
	skippedActorPaths: []
};
describe("capture inspection tools", () => {
	it("fits inspected bounds with padding and retains caller altitude", () => {
		const plan = makeDefaultMapCapturePlan({ projectId: "fixture" });
		const result = fitMapCapturePlanToSelection(plan, selection);
		expect(result.requestedBounds).toEqual({ minX: -120, maxX: 120, minY: 30, maxY: 270 });
		expect(result.capture.z).toBe(plan.capture.z);
		expect(result.project.mapPath).toBe(selection.mapPath);
		expect(() => fitMapCapturePlanToSelection(plan, selection, -1)).toThrow();
	});
	it("rejects contradictory readiness and reversed bounds", () => {
		expect(
			Schema.is(MapCaptureReadiness)({
				schemaVersion: 1,
				backend: "lit_camera_tiles",
				ready: true,
				blockers: [{ code: "busy", message: "Wait" }]
			})
		).toBe(false);
		expect(
			Schema.is(MapCaptureSelection)({
				...selection,
				bounds: { ...selection.bounds, minX: 200 }
			})
		).toBe(false);
	});
	it("negotiates capabilities before inspection and retains typed responses", async () => {
		const calls: string[] = [];
		const layer = Layer.succeed(RemoteControlClient, {
			request: (request) => {
				calls.push(request.functionName);
				return Effect.succeed(
					request.functionName === "GetCapabilityManifest"
						? {
								schemaVersion: 1,
								producerKind: "unreal_editor",
								capabilities: ["cameras.capture-selection.v1"]
							}
						: selection
				);
			}
		});
		expect(
			await Effect.runPromise(
				inspectMapCaptureSelection("http://fixture").pipe(Effect.provide(layer))
			)
		).toEqual(selection);
		expect(calls).toEqual(["GetCapabilityManifest", "InspectMapCaptureSelection"]);
		await expect(
			Effect.runPromise(
				inspectMapCaptureReadiness("http://fixture", "/Game/Fixture/Map").pipe(
					Effect.provide(layer)
				)
			)
		).rejects.toThrow("does not advertise");
		expect(calls.at(-1)).toBe("GetCapabilityManifest");
	});
});
