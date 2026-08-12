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

	it("rejects invalid grids and incomplete complete manifests", () => {
		for (const name of ["manifest-invalid-grid.json", "manifest-invalid-complete.json"]) {
			expect(Effect.runSyncExit(decodeMapTilePyramidManifest(fixture(name)))._tag).toBe(
				"Failure"
			);
		}
	});
});
