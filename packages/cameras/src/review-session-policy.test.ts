import { describe, expect, it } from "vitest";
import { EditorPlaySessionId } from "@ue-shed/protocol";
import { evaluateReviewCapturePolicy } from "./review-session-policy.js";

describe("review capture session policy", () => {
	it("allows durable evidence from the editor world", () => {
		expect(evaluateReviewCapturePolicy({ status: "stopped" })).toEqual({
			context: "editor",
			status: "allowed"
		});
	});

	it("blocks running and paused play worlds", () => {
		for (const status of ["running", "paused"] as const) {
			expect(
				evaluateReviewCapturePolicy({
					mode: "play",
					sessionId: EditorPlaySessionId.make("session-1"),
					status
				})
			).toMatchObject({ code: "play_session_active", status: "blocked" });
		}
	});

	it("distinguishes session transitions", () => {
		expect(
			evaluateReviewCapturePolicy({
				mode: "simulate",
				sessionId: EditorPlaySessionId.make("session-2"),
				status: "stopping"
			})
		).toMatchObject({ code: "play_session_transition", status: "blocked" });
	});
});
