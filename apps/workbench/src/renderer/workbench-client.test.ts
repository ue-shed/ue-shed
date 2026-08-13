import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { editorSessionStateFromResult, WorkbenchRendererError } from "./workbench-client.js";

it.effect("maps explicit editor-session availability into renderer state and typed failure", () =>
	Effect.gen(function* () {
		const session = {
			contract: {
				name: "unreal-editor-play-session" as const,
				version: { major: 1 as const, minor: 0 as const }
			},
			state: { status: "stopped" as const }
		};
		expect(yield* editorSessionStateFromResult({ session, status: "ready" })).toEqual(session);

		const error = yield* Effect.flip(
			editorSessionStateFromResult({
				error: {
					code: "transport_failure",
					endpoint: "http://127.0.0.1:30001",
					message: "HTTP request failed",
					operation: "editor.play_session.negotiate",
					recovery: "Launch Unreal Editor, then retry.",
					retrySafe: true
				},
				status: "unavailable"
			})
		);
		expect(error).toBeInstanceOf(WorkbenchRendererError);
		expect(error.operation).toBe("editor.play_session.negotiate");
		expect(error.recovery).toBe("Launch Unreal Editor, then retry.");
	})
);
