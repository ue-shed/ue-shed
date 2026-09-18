import { makeWorkbenchEditorHandoffTestLayer } from "../services/editor-handoff.js";
import { it } from "@effect/vitest";
import { EditorPlaySessionError, makeEditorPlaySessionTestLayer } from "@ue-shed/engine";
import { Effect, Exit, Layer } from "effect";
import { expect } from "vitest";
import { ElectronIpcTest, makeElectronIpcTestLayer } from "../adapters/electron-ipc.js";
import { makeWorkbenchUnrealConnectionLayer } from "../services/unreal-connection.js";
import { register } from "./editor-session.js";
import { EditorPlaySessionId } from "@ue-shed/protocol";

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

it.effect(
	"hands off explicit Play, Simulate, and Show Unreal without focusing for other commands",
	() =>
		Effect.gen(function* () {
			const calls: string[] = [];
			const ipc = yield* Effect.provide(
				Effect.gen(function* () {
					yield* register;
					return yield* ElectronIpcTest;
				}),
				Layer.mergeAll(
					makeElectronIpcTestLayer(),
					makeWorkbenchUnrealConnectionLayer(endpoint),
					makeWorkbenchEditorHandoffTestLayer((target) =>
						Effect.sync(() => {
							calls.push(target);
							return { endpoint: target, message: null };
						})
					),
					makeEditorPlaySessionTestLayer({
						status: () =>
							Effect.succeed({
								contract: {
									name: "unreal-editor-play-session",
									version: { major: 1, minor: 0 }
								},
								state: { status: "stopped" }
							}),
						start: () => Effect.die("unused"),
						stop: () => Effect.die("unused"),
						pause: () => Effect.die("unused"),
						resume: () => Effect.die("unused"),
						execute: (_target, command) =>
							Effect.succeed({
								contract: {
									name: "unreal-editor-play-session",
									version: { major: 1, minor: 0 }
								},
								command,
								outcome: "accepted",
								state: {
									status: "running",
									mode: "play",
									sessionId: EditorPlaySessionId.make("session")
								}
							})
					})
				)
			);
			for (const command of ["start_play", "start_simulate"])
				yield* ipc.invoke("editor-session:execute", command);
			yield* ipc.invoke("editor-window:activate");
			expect(calls).toEqual([endpoint, endpoint, endpoint]);
			for (const command of ["pause", "resume", "stop"])
				yield* ipc.invoke("editor-session:execute", command);
			yield* ipc.invoke("editor-session:status").pipe(Effect.exit);
			expect(calls).toHaveLength(3);
		}).pipe(Effect.scoped)
);

it.effect("returns unavailable status without rejecting while command failures remain errors", () =>
	Effect.gen(function* () {
		const ipc = yield* Effect.provide(
			Effect.gen(function* () {
				yield* register;
				return yield* ElectronIpcTest;
			}),
			Layer.mergeAll(
				makeWorkbenchEditorHandoffTestLayer(),
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
