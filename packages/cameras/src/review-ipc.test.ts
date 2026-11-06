import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { MapReviewCaptureIntent } from "./review-ipc.js";

describe("Map Review capture workflow contracts", () => {
	it("requires at least one selected Review View", () => {
		expect(Schema.decodeResult(MapReviewCaptureIntent)({ viewIds: [] })._tag).toBe("Failure");
		expect(Schema.decodeResult(MapReviewCaptureIntent)({ viewIds: ["view-1"] })._tag).toBe(
			"Success"
		);
	});
});
