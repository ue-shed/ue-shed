import { createMapTileGrid, mapTileChildren } from "@ue-shed/cameras/browser";
import { describe, expect, it } from "vitest";
import {
	fitMapTileActors,
	mapTileWorldPoint,
	fitMapTileViewport,
	mapTileScreenRect,
	mapTileScreenPoint,
	mapTileViewportBounds
} from "./map-tile-viewer-model.js";

const grid = createMapTileGrid({
	coarsestUnitsPerPixel: 1,
	levelCount: 3,
	requestedBounds: { minX: -256, minY: -256, maxX: 256, maxY: 256 },
	tilePixelSize: 256
});

describe("map tile viewer alignment", () => {
	it("fits the complete snapped world without changing axis orientation", () => {
		const viewport = fitMapTileViewport({
			bounds: grid.snappedBounds,
			height: 600,
			paddingPixels: 0,
			width: 800
		});
		expect(viewport.pixelsPerWorldUnit).toBe(600 / 512);
		expect(mapTileViewportBounds(viewport)).toEqual({
			minX: -256,
			minY: -341.3333333333333,
			maxX: 256,
			maxY: 341.3333333333333
		});
	});

	it("lays four children over exactly the same rectangle as their parent", () => {
		const viewport = fitMapTileViewport({
			bounds: grid.snappedBounds,
			height: 512,
			paddingPixels: 0,
			width: 512
		});
		const parent = { zoom: 0, row: 0, column: 0 };
		const parentRect = mapTileScreenRect({ grid, key: parent, viewport });
		const children = mapTileChildren(parent).map((key) =>
			mapTileScreenRect({ grid, key, viewport })
		);
		expect(Math.min(...children.map((rect) => rect.left))).toBe(parentRect.left);
		expect(Math.min(...children.map((rect) => rect.top))).toBe(parentRect.top);
		expect(Math.max(...children.map((rect) => rect.left + rect.width))).toBe(
			parentRect.left + parentRect.width
		);
		expect(Math.max(...children.map((rect) => rect.top + rect.height))).toBe(
			parentRect.top + parentRect.height
		);
	});

	it("projects actor coordinates with the same +X north and +Y east orientation as tiles", () => {
		const viewport = fitMapTileViewport({
			bounds: grid.snappedBounds,
			height: 512,
			paddingPixels: 0,
			width: 512
		});
		expect(mapTileScreenPoint({ viewport, worldX: 256, worldY: -256 })).toEqual({
			left: 0,
			top: 0
		});
		expect(mapTileScreenPoint({ viewport, worldX: 0, worldY: 0 })).toEqual({
			left: 256,
			top: 256
		});
		expect(mapTileScreenPoint({ viewport, worldX: -256, worldY: 256 })).toEqual({
			left: 512,
			top: 512
		});
	});
});

describe("map navigation utilities", () => {
	const viewport = {
		centerX: 1234,
		centerY: -4567,
		width: 800,
		height: 500,
		pixelsPerWorldUnit: 0.37
	};
	it("inverts the tile projection after panning and zooming", () => {
		const point = { worldX: 1700, worldY: -4100 };
		const result = mapTileWorldPoint({
			viewport,
			...mapTileScreenPoint({ viewport, ...point })
		});
		expect(result.worldX).toBeCloseTo(point.worldX);
		expect(result.worldY).toBeCloseTo(point.worldY);
	});
	it("fits every filtered point with padding, including outside capture coverage", () => {
		const points = [
			{ worldX: -12000, worldY: 400 },
			{ worldX: 24000, worldY: 6000 }
		];
		const fitted = fitMapTileActors({ viewport, points, maximumScale: 2 });
		for (const point of points) {
			const screen = mapTileScreenPoint({ viewport: fitted, ...point });
			expect(screen.left).toBeGreaterThanOrEqual(32);
			expect(screen.left).toBeLessThanOrEqual(768);
			expect(screen.top).toBeGreaterThanOrEqual(32);
			expect(screen.top).toBeLessThanOrEqual(468);
		}
	});
	it("limits singleton zoom and keeps the view when no valid points match", () => {
		expect(
			fitMapTileActors({ viewport, points: [{ worldX: NaN, worldY: 0 }], maximumScale: 2 })
		).toBe(viewport);
		const fitted = fitMapTileActors({
			viewport,
			points: [{ worldX: 50, worldY: 80 }],
			maximumScale: 2
		});
		expect(fitted.centerX).toBe(50);
		expect(fitted.centerY).toBe(80);
		expect(fitted.pixelsPerWorldUnit).toBe(2);
	});
});
