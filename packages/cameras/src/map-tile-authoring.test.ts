import { describe, expect, it } from "vitest";
import {
	makeDefaultMapCapturePlan,
	mapCaptureSafeIdentifier,
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
	});

	it("keeps generated identifiers inside the portable contract", () => {
		expect(mapCaptureSafeIdentifier(" --- ", "fallback")).toBe("fallback");
		expect(mapCaptureSafeIdentifier("A/B:C", "fallback")).toBe("A-B-C");
	});
});
