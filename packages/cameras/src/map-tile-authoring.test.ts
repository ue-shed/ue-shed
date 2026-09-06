import { describe, expect, it } from "vitest";
import {
	makeDefaultMapCapturePlan,
	mapCaptureSafeIdentifier,
	mapCaptureBackendIssue,
	savedMapPathToGameMapPath
} from "./map-tile-authoring.js";

describe("Map Capture Plan authoring", () => {
	it("turns saved project map paths into Unreal package paths", () => {
		expect(savedMapPathToGameMapPath("Content/Maps/L_City.umap")).toBe("/Game/Maps/L_City");
		expect(savedMapPathToGameMapPath("D:\\Game\\Content\\Maps\\L_City.umap")).toBe(
			"/Game/Maps/L_City"
		);
		expect(savedMapPathToGameMapPath("Content/Maps/Bad Map.umap")).toBeUndefined();
	});

	it("creates a valid portable v1 plan from project context", () => {
		const plan = makeDefaultMapCapturePlan({
			mapPath: "/Game/Maps/L_City",
			projectId: "My Unreal Project"
		});

		expect(plan.id).toBe("map-overview");
		expect(plan.project).toEqual({ id: "My-Unreal-Project", mapPath: "/Game/Maps/L_City" });
		expect(plan.levels.count).toBe(3);
		expect(plan.gutterPixels).toBe(16);
		expect(plan.capture.render.effects).toEqual({ fog: false, volumetricFog: false });
		expect(mapCaptureBackendIssue(plan, "lit_camera_tiles")).toBeUndefined();
		expect(
			mapCaptureBackendIssue(
				{
					...plan,
					capture: {
						...plan.capture,
						render: { ...plan.capture.render, profile: "seam_stable" }
					}
				},
				"lit_camera_tiles"
			)
		).toContain("Full fidelity");
	});

	it("keeps generated identifiers inside the portable contract", () => {
		expect(mapCaptureSafeIdentifier(" --- ", "fallback")).toBe("fallback");
		expect(mapCaptureSafeIdentifier("A/B:C", "fallback")).toBe("A-B-C");
	});
});
