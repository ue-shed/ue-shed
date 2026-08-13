import { makeDefaultMapCapturePlan } from "@ue-shed/cameras/map-tiles";
import { describe, expect, it } from "vitest";
import {
	mapCaptureDraftCenter,
	mapCaptureDraftGrid,
	mapCaptureDraftSize,
	mapCapturePlanDraft,
	recenterMapCapturePlanDraft,
	resizeMapCapturePlanDraft,
	setMapCaptureDraftGridSize,
	setMapCaptureDraftTileSize,
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

	it("limits Workbench authoring to square capture areas", () => {
		const validation = validateMapCapturePlanDraft({
			...mapCapturePlanDraft(plan),
			requestedBounds: { maxX: 2_000, maxY: 1_000, minX: -2_000, minY: -1_000 }
		});

		expect(validation).toMatchObject({
			errors: ["Workbench authors square capture areas; set one equal size for X and Y."],
			status: "invalid"
		});
	});

	it("changes tile image resolution without changing grid coverage or framing", () => {
		const draft = mapCapturePlanDraft(plan);
		const original = mapCaptureDraftGrid(validateMapCapturePlanDraft(draft));
		const resized = setMapCaptureDraftTileSize(draft, 2_048);
		const updated = mapCaptureDraftGrid(validateMapCapturePlanDraft(resized));

		expect(resized.levels.coarsestUnitsPerPixel).toBe(1);
		expect(updated?.grid.snappedBounds).toEqual(original?.grid.snappedBounds);
		expect(
			updated?.grid.levels.map(({ columns, rows, tileWorldSize }) => ({
				columns,
				rows,
				tileWorldSize
			}))
		).toEqual(
			original?.grid.levels.map(({ columns, rows, tileWorldSize }) => ({
				columns,
				rows,
				tileWorldSize
			}))
		);
	});

	it("authors an exact square Level 0 grid without moving the capture", () => {
		const draft = resizeMapCapturePlanDraft(
			recenterMapCapturePlanDraft(mapCapturePlanDraft(plan), {
				x: 5_000,
				y: -2_000
			}),
			3_000
		);
		const resized = setMapCaptureDraftGridSize(draft, 4);
		const updated = mapCaptureDraftGrid(validateMapCapturePlanDraft(resized));

		expect(updated?.grid.levels[0]).toMatchObject({ columns: 4, rows: 4 });
		expect(updated?.grid.snappedBounds).toEqual(draft.requestedBounds);
		expect(mapCaptureDraftCenter(resized)).toEqual({ x: 5_000, y: -2_000 });
	});

	it("moves the requested capture center without changing its size", () => {
		const draft = mapCapturePlanDraft(plan);
		const moved = recenterMapCapturePlanDraft(draft, { x: 5_000, y: -2_000 });

		expect(mapCaptureDraftCenter(moved)).toEqual({ x: 5_000, y: -2_000 });
		expect(moved.requestedBounds.maxX - moved.requestedBounds.minX).toBe(
			draft.requestedBounds.maxX - draft.requestedBounds.minX
		);
		expect(moved.requestedBounds.maxY - moved.requestedBounds.minY).toBe(
			draft.requestedBounds.maxY - draft.requestedBounds.minY
		);
	});

	it("authors one square capture size symmetrically around the center", () => {
		const draft = recenterMapCapturePlanDraft(mapCapturePlanDraft(plan), {
			x: 5_000,
			y: -2_000
		});
		const resized = resizeMapCapturePlanDraft(draft, 3_000);

		expect(mapCaptureDraftSize(resized)).toBe(3_000);
		expect(resized.requestedBounds).toEqual({
			maxX: 6_500,
			maxY: -500,
			minX: 3_500,
			minY: -3_500
		});
	});
});
