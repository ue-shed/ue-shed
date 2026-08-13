import { createMapTileGrid, mapTileChildren } from "@ue-shed/cameras";
import { describe, expect, it } from "vitest";
import {
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
