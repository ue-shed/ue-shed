import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createMapTileGrid, mapTileKeyId, mapTileWorldBounds } from "./map-tile-pyramid.js";
import {
	createMapTileSource,
	MapTileSource,
	planMapTileSources,
	type MapTileSourceLayoutOptions
} from "./map-tile-source.js";

function value<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}

const grid = createMapTileGrid({
	requestedBounds: { minX: -51200, minY: -51200, maxX: 51200, maxY: 51200 },
	tilePixelSize: 1024,
	coarsestUnitsPerPixel: 100,
	levelCount: 6
});
const options: MapTileSourceLayoutOptions = {
	captureZ: 100000,
	gutterPixels: 16,
	zoom: 5,
	tilesPerSourceSide: 4,
	limits: { maximumDimension: 8192, maximumDecodedBytes: 128 * 1024 * 1024 }
};

describe("caller-owned map source planning", () => {
	it("keeps invalid grid schema issues behind a classified source error", () => {
		const result = planMapTileSources({ grid: { ...grid, levels: [] }, options });
		if (!Result.isFailure(result)) throw new Error("Expected invalid grid input");
		expect(result.failure.code).toBe("invalid_grid");
		expect(Schema.isSchemaError(result.failure.cause)).toBe(true);
		expect(String(result.failure.cause)).toContain("levels");
		expect(result.failure.message).toBe("The map tile grid is invalid.");
	});

	it("captures a stable planning snapshot for lazy consumers", () => {
		const mutable = { ...options, limits: { ...options.limits } };
		const supplied = { ...grid, origin: { ...grid.origin }, levels: [...grid.levels] };
		const layout = value(planMapTileSources({ grid: supplied, options: mutable }));
		mutable.gutterPixels = 0;
		mutable.tilesPerSourceSide = 1;
		mutable.limits.maximumDimension = 16;
		supplied.origin.x = 0;
		supplied.levels.length = 0;
		const first = layout.sources[Symbol.iterator]().next().value;
		expect(layout.sourceCount).toBe(64);
		expect(first?.size).toEqual({ width: 4128, height: 4128 });
	});
	it("groups six-level leaves into 64 sources without rendering or prescribing parent levels", () => {
		const layout = value(planMapTileSources({ grid, options }));
		expect(layout.sourceCount).toBe(64);
		expect(layout.tileCount).toBe(1024);
		const sources = [...layout.sources];
		expect(sources).toHaveLength(64);
		expect(sources.every(Schema.is(MapTileSource))).toBe(true);
		expect(
			sources.every((source) => source.size.width === 4128 && source.size.height === 4128)
		).toBe(true);
		expect(sources[0]?.decodedBytes).toBe(4128 * 4128 * 4);
		const keys = sources.flatMap((source) =>
			source.crops.map((crop) => mapTileKeyId(crop.key))
		);
		expect(new Set(keys).size).toBe(1024);
		expect(keys.every((key) => key.startsWith("5/"))).toBe(true);
		expect(keys).toContain("5/0/0");
		expect(keys).toContain("5/31/31");
		expect([...layout.sources].map((source) => source.block)).toEqual(
			sources.map((source) => source.block)
		);
	});

	it("retains 1K tiles as an explicit source choice and independently plans any requested zoom", () => {
		const tiles = value(
			planMapTileSources({ grid, options: { ...options, tilesPerSourceSide: 1 } })
		);
		expect(tiles.sourceCount).toBe(1024);
		const first = tiles.sources[Symbol.iterator]().next().value;
		expect(first).toMatchObject({
			size: { width: 1056, height: 1056 },
			crops: [{ rect: { left: 16, top: 16, width: 1024, height: 1024 } }]
		});
		const overview = value(planMapTileSources({ grid, options: { ...options, zoom: 0 } }));
		expect(overview.sourceCount).toBe(1);
		expect(overview.tileCount).toBe(1);
		expect([...overview.sources][0]?.size).toEqual({ width: 1056, height: 1056 });
	});

	it("keeps rectangular edge blocks at the exact grid resolution and camera orientation", () => {
		const rectangular = createMapTileGrid({
			requestedBounds: { minX: -700, minY: -900, maxX: 1100, maxY: 1600 },
			tilePixelSize: 256,
			coarsestUnitsPerPixel: 4,
			levelCount: 2
		});
		const layout = value(
			planMapTileSources({ grid: rectangular, options: { ...options, zoom: 1 } })
		);
		expect(layout.sourceCount).toBe(2);
		const sources = [...layout.sources];
		expect(sources.map((source) => source.size)).toEqual([
			{ width: 1056, height: 1056 },
			{ width: 544, height: 1056 }
		]);
		for (const source of sources) {
			if (source.camera.projection.kind !== "orthographic")
				throw new Error("Expected orthographic camera.");
			expect(source.camera.projection.width / source.size.width).toBe(2);
			for (const crop of source.crops) {
				const bounds = mapTileWorldBounds(rectangular, crop.key);
				expect(crop.worldBounds).toEqual(bounds);
				expect(
					source.camera.location.x +
						(source.size.height / 2 - crop.rect.top - crop.rect.height / 2) * 2
				).toBe((bounds.minX + bounds.maxX) / 2);
				expect(
					source.camera.location.y +
						(crop.rect.left + crop.rect.width / 2 - source.size.width / 2) * 2
				).toBe((bounds.minY + bounds.maxY) / 2);
			}
		}
	});

	it("plans an explicit subregion for caller-selected capture or retry", () => {
		const { zoom: _zoom, tilesPerSourceSide: _side, ...settings } = options;
		const source = value(
			createMapTileSource({
				grid,
				settings,
				block: { firstTile: { zoom: 5, row: 7, column: 9 }, rows: 2, columns: 3 }
			})
		);
		expect(source.size).toEqual({ width: 3104, height: 2080 });
		expect(source.crops.map((crop) => mapTileKeyId(crop.key))).toEqual([
			"5/7/9",
			"5/7/10",
			"5/7/11",
			"5/8/9",
			"5/8/10",
			"5/8/11"
		]);
		expect(
			createMapTileSource({
				grid,
				settings,
				block: { firstTile: { zoom: 5, row: 31, column: 31 }, rows: 2, columns: 1 }
			})
		).toMatchObject({ _tag: "Failure", failure: { code: "invalid_source" } });
	});

	it("rejects dimension and memory overflow including outer gutters without silently reducing detail", () => {
		for (const limits of [
			{ maximumDimension: 4096, maximumDecodedBytes: 128 * 1024 * 1024 },
			{ maximumDimension: 8192, maximumDecodedBytes: 4128 * 4128 * 4 - 1 }
		]) {
			expect(planMapTileSources({ grid, options: { ...options, limits } })).toMatchObject({
				_tag: "Failure",
				failure: { code: "source_limit_exceeded" }
			});
		}
		const maximum = {
			...options,
			tilesPerSourceSide: 16,
			limits: { maximumDimension: 16384, maximumDecodedBytes: 2 ** 30 }
		};
		expect(planMapTileSources({ grid, options: maximum })).toMatchObject({
			_tag: "Failure",
			failure: { code: "source_limit_exceeded" }
		});
		expect(
			value(planMapTileSources({ grid, options: { ...maximum, gutterPixels: 0 } }))
				.sourceCount
		).toBe(4);
	});

	it("returns typed failures for invalid grids, unavailable levels and invalid options", () => {
		expect(
			planMapTileSources({
				grid: { ...grid, origin: { ...grid.origin, x: grid.origin.x + 1 } },
				options
			})
		).toMatchObject({ _tag: "Failure", failure: { code: "invalid_grid" } });
		for (const invalid of [
			{ ...options, zoom: 6 },
			{ ...options, tilesPerSourceSide: 0 },
			{ ...options, captureZ: Infinity }
		]) {
			expect(planMapTileSources({ grid, options: invalid })).toMatchObject({
				_tag: "Failure",
				failure: { code: "invalid_source" }
			});
		}
	});
});
