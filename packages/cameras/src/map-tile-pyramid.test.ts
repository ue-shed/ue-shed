import { describe, expect, it } from "vitest";
import {
	chooseMapTileLevel,
	createMapTileGrid,
	mapTileChildren,
	mapTileKeyId,
	mapTileParent,
	mapTileRelativePath,
	mapTileWorldBounds,
	resolveAvailableMapTiles,
	selectMapTiles,
	visibleMapTiles,
	worldToMapTile
} from "./map-tile-pyramid.js";

const grid = createMapTileGrid({
	coarsestUnitsPerPixel: 4,
	levelCount: 3,
	requestedBounds: { minX: -1_500, minY: -600, maxX: 1_100, maxY: 1_500 },
	tilePixelSize: 256
});

describe("map tile grid", () => {
	it("snaps non-square negative bounds once and doubles each level", () => {
		expect(grid.origin).toEqual({ x: 2_048, y: -1_024 });
		expect(grid.snappedBounds).toEqual({
			minX: -2_048,
			minY: -1_024,
			maxX: 2_048,
			maxY: 2_048
		});
		expect(grid.levels).toEqual([
			{ zoom: 0, unitsPerPixel: 4, tileWorldSize: 1_024, rows: 4, columns: 3 },
			{ zoom: 1, unitsPerPixel: 2, tileWorldSize: 512, rows: 8, columns: 6 },
			{ zoom: 2, unitsPerPixel: 1, tileWorldSize: 256, rows: 16, columns: 12 }
		]);
	});

	it("maps every parent to four exactly aligned children", () => {
		for (const level of grid.levels.slice(0, -1)) {
			for (let row = 0; row < level.rows; row += 1) {
				for (let column = 0; column < level.columns; column += 1) {
					const parent = { zoom: level.zoom, row, column };
					const parentBounds = mapTileWorldBounds(grid, parent);
					const children = mapTileChildren(parent);
					expect(children.map(mapTileParent)).toEqual([parent, parent, parent, parent]);
					const childBounds = children.map((child) => mapTileWorldBounds(grid, child));
					expect(Math.min(...childBounds.map((bounds) => bounds.minX))).toBe(
						parentBounds.minX
					);
					expect(Math.max(...childBounds.map((bounds) => bounds.maxX))).toBe(
						parentBounds.maxX
					);
					expect(Math.min(...childBounds.map((bounds) => bounds.minY))).toBe(
						parentBounds.minY
					);
					expect(Math.max(...childBounds.map((bounds) => bounds.maxY))).toBe(
						parentBounds.maxY
					);
				}
			}
		}
	});

	it("round-trips tile centers and clamps inclusive outer edges", () => {
		for (const level of grid.levels) {
			for (let row = 0; row < level.rows; row += 1) {
				for (let column = 0; column < level.columns; column += 1) {
					const key = { zoom: level.zoom, row, column };
					const bounds = mapTileWorldBounds(grid, key);
					expect(
						worldToMapTile(grid, level.zoom, {
							x: (bounds.minX + bounds.maxX) / 2,
							y: (bounds.minY + bounds.maxY) / 2
						})
					).toEqual(key);
				}
			}
		}
		expect(worldToMapTile(grid, 2, { x: 2_048, y: -1_024 })).toEqual({
			zoom: 2,
			row: 0,
			column: 0
		});
		expect(worldToMapTile(grid, 2, { x: -2_048, y: 2_048 })).toEqual({
			zoom: 2,
			row: 15,
			column: 11
		});
		expect(worldToMapTile(grid, 0, { x: -2_049, y: 0 })).toBeUndefined();
	});

	it("uses deterministic address names", () => {
		expect(mapTileRelativePath({ zoom: 2, row: 7, column: 11 })).toBe("Z02/R007_C011.png");
	});
});

describe("map tile selection", () => {
	it("selects visible edge-clamped tiles and a one-tile prefetch ring", () => {
		const viewport = { minX: 1_600, minY: -2_000, maxX: 2_500, maxY: -500 };
		expect(visibleMapTiles(grid, 1, viewport)).toEqual([
			{ zoom: 1, row: 0, column: 0 },
			{ zoom: 1, row: 0, column: 1 }
		]);
		const selection = selectMapTiles({
			grid,
			viewportBounds: viewport,
			screenPixelsPerWorldUnit: 0.5
		});
		expect(selection.level).toBe(1);
		expect(selection.prefetch.map(mapTileKeyId)).toEqual(["1/0/2", "1/1/0", "1/1/1", "1/1/2"]);
		expect(selection.ancestors).toEqual([{ zoom: 0, row: 0, column: 0 }]);
	});

	it("holds levels through hysteresis and changes after the exit threshold", () => {
		expect(
			chooseMapTileLevel({
				currentLevel: 1,
				grid,
				hysteresisLevels: 0.2,
				screenPixelsPerWorldUnit: 2 ** 1.65 / 4
			})
		).toBe(1);
		expect(
			chooseMapTileLevel({
				currentLevel: 1,
				grid,
				hysteresisLevels: 0.2,
				screenPixelsPerWorldUnit: 2 ** 1.71 / 4
			})
		).toBe(2);
	});

	it("uses available ancestors without blanking missing detail", () => {
		const desired = [
			{ zoom: 2, row: 0, column: 0 },
			{ zoom: 2, row: 0, column: 1 },
			{ zoom: 2, row: 3, column: 3 }
		];
		const resolved = resolveAvailableMapTiles({
			available: new Set(["1/0/0", "0/0/0"]),
			desired
		});
		expect(resolved.render.map(mapTileKeyId)).toEqual(["1/0/0", "0/0/0"]);
		expect(resolved.missing).toEqual([]);
	});

	it("reports a true blank only when no ancestor exists", () => {
		const desired = [{ zoom: 2, row: 10, column: 8 }];
		expect(resolveAvailableMapTiles({ available: new Set(), desired })).toEqual({
			missing: desired,
			render: []
		});
	});

	it("caps cache recommendations without changing spatial selection", () => {
		const selection = selectMapTiles({
			grid,
			maximumCacheEntries: 2,
			screenPixelsPerWorldUnit: 1,
			viewportBounds: grid.snappedBounds
		});
		expect(selection.visible.length).toBeGreaterThan(2);
		expect(selection.recommendedCacheEntries).toBe(2);
	});
});
