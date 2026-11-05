import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MapReviewCaptureIntent } from "./review-ipc.js";

const decodeMapReviewCaptureIntent = Schema.decodeUnknownResult(MapReviewCaptureIntent);

describe("Map Review capture workflow contracts", () => {
	it("requires at least one selected Review View", () => {
		expect(decodeMapReviewCaptureIntent({ viewIds: [] })._tag).toBe("Failure");
		expect(decodeMapReviewCaptureIntent({ viewIds: ["view-1"] })._tag).toBe("Success");
	});
});
