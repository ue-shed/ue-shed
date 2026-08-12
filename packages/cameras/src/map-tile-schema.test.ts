import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	MapCapturePlan,
	MapTileCaptureRequest,
	MapTileCaptureResponse,
	MapTilePyramidManifest,
	decodeMapTilePyramidManifest
} from "./map-tile-schema.js";

const fixturesRoot = join(
	process.cwd(),
	"packages/protocol/contracts/cameras/map-tile/v1/fixtures"
);

function fixture(name: string): unknown {
	return JSON.parse(readFileSync(join(fixturesRoot, name), "utf8")) as unknown;
}

describe("map tile contracts", () => {
	for (const [name, schema] of [
		["plan-valid.json", MapCapturePlan],
		["capture-request-valid.json", MapTileCaptureRequest],
		["capture-response-valid.json", MapTileCaptureResponse],
		["manifest-valid.json", MapTilePyramidManifest]
	] as const) {
		it(`round-trips ${name}`, () => {
			const input = fixture(name);
			const decoded = Schema.decodeUnknownSync(schema)(input);
			expect(Schema.encodeUnknownSync(schema)(decoded)).toEqual(input);
		});
	}

	it("rejects duplicate request tiles", () => {
		const input = fixture("capture-request-valid.json") as Record<string, unknown>;
		const tiles = input.tiles as ReadonlyArray<unknown>;
		expect(
			Schema.decodeUnknownResult(MapTileCaptureRequest)({
				...input,
				tiles: [...tiles, ...tiles]
			})._tag
		).toBe("Failure");
	});

	it("requires one scoped LOD distance scale for every pyramid level", () => {
		const input = structuredClone(fixture("plan-valid.json")) as {
			capture: { render: { lodDistanceScaleByZoom: number[] } };
		};
		input.capture.render.lodDistanceScaleByZoom = [1];
		expect(Schema.decodeUnknownResult(MapCapturePlan)(input)._tag).toBe("Failure");
	});

	it("rejects invalid grids and incomplete complete manifests", () => {
		for (const name of ["manifest-invalid-grid.json", "manifest-invalid-complete.json"]) {
			expect(Effect.runSyncExit(decodeMapTilePyramidManifest(fixture(name)))._tag).toBe(
				"Failure"
			);
		}
	});

	it("rejects tile artifacts that drift away from their grid address", () => {
		const input = structuredClone(fixture("manifest-valid.json")) as {
			tiles: Array<{ worldBounds: { minX: number } }>;
		};
		input.tiles[0]!.worldBounds.minX += 1;
		expect(Effect.runSyncExit(decodeMapTilePyramidManifest(input))._tag).toBe("Failure");
	});
});
