import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	MapCapturePlan,
	MapTileCaptureRequest,
	MapTileCaptureOperation,
	MapTileCaptureResponse,
	MapTilePyramidManifest,
	decodeMapTilePyramidManifest
} from "./map-tile-schema.js";

const JsonRecord = Schema.Record(Schema.String, Schema.Json);
const JsonArray = Schema.Array(Schema.Json);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord);
const decodeJsonArray = Schema.decodeUnknownSync(JsonArray);
const decodeMapTileCaptureRequestResult = Schema.decodeUnknownResult(MapTileCaptureRequest);
const decodeMapCapturePlanResult = Schema.decodeUnknownResult(MapCapturePlan);
const decodeMapCapturePlan = Schema.decodeUnknownSync(MapCapturePlan);
const fixturesRoot = join(
	process.cwd(),
	"packages/protocol/contracts/cameras/map-tile/v1/fixtures"
);

function fixture(name: string): Schema.Json {
	return decodeJson(JSON.parse(readFileSync(join(fixturesRoot, name), "utf8")));
}

describe("map tile contracts", () => {
	for (const [name, schema] of [
		["plan-valid.json", MapCapturePlan],
		["capture-request-valid.json", MapTileCaptureRequest],
		["capture-request-lit-valid.json", MapTileCaptureRequest],
		["capture-operation-running-valid.json", MapTileCaptureOperation],
		["capture-operation-finished-valid.json", MapTileCaptureOperation],
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
		const input = decodeJsonRecord(fixture("capture-request-valid.json"));
		const tiles = decodeJsonArray(input.tiles);
		expect(
			decodeMapTileCaptureRequestResult({
				...input,
				tiles: [...tiles, ...tiles]
			})._tag
		).toBe("Failure");
	});

	it("requires one scoped LOD distance scale for every pyramid level", () => {
		// SAFETY: plan-valid.json is schema-decoded in the baseline test before this mutation.
		const input = structuredClone(fixture("plan-valid.json")) as {
			capture: { render: { lodDistanceScaleByZoom: number[] } };
		};
		input.capture.render.lodDistanceScaleByZoom = [1];
		expect(decodeMapCapturePlanResult(input)._tag).toBe("Failure");
	});

	it.each(["seam_stable", "scene_capture_defaults"])("accepts renderer profile %s", (profile) => {
		// SAFETY: plan-valid.json is schema-decoded in the baseline test before this mutation.
		const input = structuredClone(fixture("plan-valid.json")) as {
			capture: { render: { profile: string } };
		};
		input.capture.render.profile = profile;
		expect(decodeMapCapturePlan(input).capture.render.profile).toBe(profile);
	});

	it("rejects invalid grids and incomplete complete manifests", () => {
		for (const name of ["manifest-invalid-grid.json", "manifest-invalid-complete.json"]) {
			expect(Effect.runSyncExit(decodeMapTilePyramidManifest(fixture(name)))._tag).toBe(
				"Failure"
			);
		}
	});

	it("rejects tile artifacts that drift away from their grid address", () => {
		// SAFETY: manifest-valid.json is schema-decoded in the baseline test before this mutation.
		const input = structuredClone(fixture("manifest-valid.json")) as {
			tiles: Array<{ worldBounds: { minX: number } }>;
		};
		input.tiles[0]!.worldBounds.minX += 1;
		expect(Effect.runSyncExit(decodeMapTilePyramidManifest(input))._tag).toBe("Failure");
	});
});
