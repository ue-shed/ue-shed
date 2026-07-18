import type { EditorPlaySessionState } from "@ue-shed/protocol";
import { Schema } from "effect";

export const ReviewCaptureBlock = Schema.Struct({
	code: Schema.Literals([
		"play_session_active",
		"play_session_transition",
		"play_session_unavailable"
	]),
	message: Schema.String,
	recovery: Schema.String
});
export type ReviewCaptureBlock = Schema.Schema.Type<typeof ReviewCaptureBlock>;

export type ReviewCapturePolicyDecision =
	| { readonly status: "allowed"; readonly context: "editor" }
	| ({ readonly status: "blocked" } & ReviewCaptureBlock);

/** Durable Review Set evidence is editor-world-only until runtime capture is an explicit mode. */
export function evaluateReviewCapturePolicy(
	state: EditorPlaySessionState
): ReviewCapturePolicyDecision {
	if (state.status === "stopped") return { context: "editor", status: "allowed" };
	if (state.status === "starting" || state.status === "stopping") {
		return {
			code: "play_session_transition",
			message: `The ${state.mode === "play" ? "PIE" : "SIE"} session is ${state.status}.`,
			recovery:
				"Wait for the transition to finish, stop the session, then capture the Review Set.",
			status: "blocked"
		};
	}
	return {
		code: "play_session_active",
		message: `Durable capture is editor-world-only while ${state.mode === "play" ? "PIE" : "SIE"} is ${state.status}.`,
		recovery:
			"Stop the play session, then capture the Review Set. Live scouting remains available.",
		status: "blocked"
	};
}
