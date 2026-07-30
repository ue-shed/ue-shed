import { describe, expect, it } from "vitest";
import {
	pointMapBoundsOf,
	pointMapCanvasAspect,
	pointMapColorForClass,
	pointMapFitViewportSize,
	pointMapMarkerRadius,
	pointMapPanViewportBy,
	pointMapStabilizeViewport,
	pointMapWorldWindowSize,
	pointMapZoomViewportAt
} from "./point-map-core.js";

describe("point map core", () => {
	it("fits resolved points and their bounds without squashing the world window", () => {
		const bounds = pointMapBoundsOf([
			{ className: "Light", key: "light", x: 0, y: 0, extentX: 10, extentY: 5 },
			{ className: "Mesh", key: "mesh", x: 100, y: 40, extentX: 20, extentY: 10 }
		]);
		expect(bounds).toEqual({ minX: -10, maxX: 120, minY: -5, maxY: 50 });
		const fit = pointMapFitViewportSize(bounds, 2, 0);
		expect(fit).toBe(130);
		const window = pointMapWorldWindowSize({ centerX: 55, centerY: 22.5, size: fit }, 2);
		expect(window).toEqual({ width: 130, height: 65 });
	});

	it("retains a stable fitted view for small point motion", () => {
		const first = pointMapStabilizeViewport(undefined, {
			minX: 0,
			maxX: 100,
			minY: 0,
			maxY: 100
		});
		const nudged = pointMapStabilizeViewport(first, {
			minX: 2,
			maxX: 102,
			minY: 1,
			maxY: 101
		});
		expect(nudged).toEqual(first);
	});

	it("zooms at an anchor and pans in screen direction", () => {
		const start = { centerX: 0, centerY: 0, size: 1_000 };
		const zoomed = pointMapZoomViewportAt(start, 200, 200, 100, 100, 2);
		expect(zoomed).toEqual({ centerX: 0, centerY: 0, size: 500 });
		const panned = pointMapPanViewportBy(start, 200, 200, 20, 0);
		expect(panned.centerX).toBe(-100);
		expect(pointMapCanvasAspect(400, 200)).toBe(2);
	});

	it("uses deterministic class colors and readable dense markers", () => {
		expect(pointMapColorForClass("PointLight")).toBe(pointMapColorForClass("PointLight"));
		expect(pointMapMarkerRadius(8, 800, 800)).toBeGreaterThan(
			pointMapMarkerRadius(4_096, 800, 800)
		);
	});
});
