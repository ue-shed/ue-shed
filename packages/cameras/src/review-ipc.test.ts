import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MapReviewCaptureIntent } from "./review-ipc.js";
const decodeMapReviewCaptureIntentResult = Schema.decodeResult(MapReviewCaptureIntent);

describe("Map Review capture workflow contracts", () => {
	it("requires at least one selected Review View", () => {
		expect(decodeMapReviewCaptureIntentResult({ viewIds: [] })._tag).toBe("Failure");
		expect(decodeMapReviewCaptureIntentResult({ viewIds: ["view-1"] })._tag).toBe("Success");
	});
});
