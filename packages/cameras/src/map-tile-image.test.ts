import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { cropMapTileImage, deriveMapTileParent, type MapTileImage } from "./map-tile-image.js";

function value<A, E>(result: Result.Result<A, E>): A {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
}
function image(pixels: readonly number[], width = 2, height = 2): MapTileImage {
	return { format: "rgba8_srgb", width, height, pixels: Uint8Array.from(pixels) };
}
function solid(rgba: readonly number[]): MapTileImage {
	return image([...rgba, ...rgba, ...rgba, ...rgba]);
}

describe("map tile pixels", () => {
	it("classifies invalid pixel input while retaining the failing schema field", () => {
		const result = cropMapTileImage(image([], 0, 2), {
			left: 0,
			top: 0,
			width: 1,
			height: 1
		});
		if (!Result.isFailure(result)) throw new Error("Expected invalid image input");
		expect(result.failure.code).toBe("invalid_image");
		expect(Schema.isSchemaError(result.failure.cause)).toBe(true);
		expect(String(result.failure.cause)).toContain("width");
		expect(result.failure.message).toBe("The map tile image buffer or dimensions are invalid.");
	});

	it("crops every RGBA byte across rows and offset views without sharing source storage", () => {
		const buffer = new Uint8Array(80);
		const pixels = buffer.subarray(7, 71);
		pixels.set(Array.from({ length: 64 }, (_, i) => i));
		const source = { format: "rgba8_srgb" as const, width: 4, height: 4, pixels };
		const crop = value(cropMapTileImage(source, { left: 1, top: 1, width: 2, height: 2 }));
		expect([...crop.pixels]).toEqual([
			20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41, 42, 43
		]);
		pixels.fill(0);
		expect(crop.pixels[0]).toBe(20);
	});

	it("places each child in mapTileChildren order", () => {
		const parent = value(
			deriveMapTileParent([
				solid([255, 0, 0, 255]),
				solid([0, 255, 0, 255]),
				solid([0, 0, 255, 255]),
				solid([255, 255, 255, 255])
			])
		);
		expect([...parent.pixels]).toEqual([
			255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255
		]);
	});

	it("averages sRGB in linear light rather than darkening high-contrast detail", () => {
		const checker = image([0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
		const parent = value(deriveMapTileParent([checker, checker, checker, checker]));
		expect([...parent.pixels]).toEqual(
			Array.from({ length: 4 }, () => [188, 188, 188, 255]).flat()
		);
	});

	it("weights color by alpha and excludes hidden transparent colors", () => {
		const mixed = image([255, 0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0, 255, 0, 0]);
		const transparent = solid([200, 100, 50, 0]);
		const parent = value(deriveMapTileParent([mixed, transparent, transparent, mixed]));
		expect([...parent.pixels]).toEqual([
			255, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 128
		]);
	});

	it("rejects malformed payloads and out-of-bounds crops before allocating output", () => {
		const valid = solid([20, 40, 60, 255]);
		expect(
			cropMapTileImage(
				{ ...valid, pixels: new Uint8Array(15) },
				{ left: 0, top: 0, width: 1, height: 1 }
			)
		).toMatchObject({ _tag: "Failure", failure: { code: "invalid_image" } });
		for (const rect of [
			{ left: 1, top: 0, width: 2, height: 1 },
			{ left: 0, top: -1, width: 1, height: 1 }
		]) {
			expect(cropMapTileImage(valid, rect)).toMatchObject({
				_tag: "Failure",
				failure: { code: "invalid_crop" }
			});
		}
	});

	it("rejects unequal or odd children without modifying their pixels", () => {
		const valid = solid([20, 40, 60, 255]);
		const odd = image(Array(36).fill(0), 3, 3);
		expect(deriveMapTileParent([valid, odd, valid, valid])).toMatchObject({
			_tag: "Failure",
			failure: { code: "invalid_children" }
		});
		expect(deriveMapTileParent([odd, odd, odd, odd])).toMatchObject({
			_tag: "Failure",
			failure: { code: "invalid_children" }
		});
		expect(valid.pixels[0]).toBe(20);
	});
});
