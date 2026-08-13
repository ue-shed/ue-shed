import { it } from "@effect/vitest";
import { EditorPlaySessionError, makeEditorPlaySessionTestLayer } from "@ue-shed/engine-discovery";
import { Effect, Exit, Layer } from "effect";
import { expect } from "vitest";
import { ElectronIpcTest, makeElectronIpcTestLayer } from "../adapters/electron-ipc.js";
import { makeWorkbenchUnrealConnectionLayer } from "../services/unreal-connection.js";
import { register } from "./editor-session.js";

const endpoint = "http://127.0.0.1:30001";
const unavailable = new EditorPlaySessionError({
	code: "transport_failure",
	endpoint,
	message: "HTTP request failed",
	operation: "editor.play_session.negotiate",
	recovery: "Confirm that Unreal Editor and Remote Control are reachable, then retry.",
	retrySafe: true
});

const editorSession = makeEditorPlaySessionTestLayer({
	execute: () => Effect.fail(unavailable),
	pause: () => Effect.fail(unavailable),
	resume: () => Effect.fail(unavailable),
	start: () => Effect.fail(unavailable),
	status: () => Effect.fail(unavailable),
	stop: () => Effect.fail(unavailable)
});

it.effect("returns unavailable status without rejecting while command failures remain errors", () =>
	Effect.gen(function* () {
		const ipc = yield* Effect.provide(
			Effect.gen(function* () {
				yield* register;
				return yield* ElectronIpcTest;
			}),
			Layer.mergeAll(
				makeElectronIpcTestLayer(),
				editorSession,
				makeWorkbenchUnrealConnectionLayer(endpoint)
			)
		);

		expect(yield* ipc.invoke("editor-session:status")).toEqual({
			error: {
				code: "transport_failure",
				endpoint,
				message: "HTTP request failed",
				operation: "editor.play_session.negotiate",
				recovery:
					"Confirm that Unreal Editor and Remote Control are reachable, then retry.",
				retrySafe: true
			},
			status: "unavailable"
		});

		const command = yield* ipc.invoke("editor-session:execute", "start_play").pipe(Effect.exit);
		expect(Exit.isFailure(command)).toBe(true);
	}).pipe(Effect.scoped)
);
