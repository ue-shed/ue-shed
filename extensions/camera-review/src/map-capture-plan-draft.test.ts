import { makeDefaultMapCapturePlan } from "@ue-shed/cameras/map-tiles";
import { describe, expect, it } from "vitest";
import {
	mapCaptureDraftGrid,
	mapCapturePlanDraft,
	validateMapCapturePlanDraft
} from "./map-capture-plan-draft.js";

const plan = makeDefaultMapCapturePlan({ mapPath: "/Game/Maps/L_City", projectId: "City" });

describe("Map Capture Plan draft", () => {
	it("validates an authored plan and recomputes its deterministic tile grid", () => {
		const validation = validateMapCapturePlanDraft(mapCapturePlanDraft(plan));
		expect(validation.status).toBe("valid");
		expect(mapCaptureDraftGrid(validation)?.tileCount).toBeGreaterThan(0);
	});

	it("reports actionable authoring errors before save or capture", () => {
		const validation = validateMapCapturePlanDraft({
			...mapCapturePlanDraft(plan),
			id: "bad plan id",
			requestedBounds: { maxX: 0, maxY: 10, minX: 1, minY: 10 }
		});
		expect(validation).toMatchObject({ status: "invalid" });
		if (validation.status === "invalid") {
			expect(validation.errors).toHaveLength(2);
		}
	});
});
