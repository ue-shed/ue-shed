import { it } from "@effect/vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	EditorPlaySession,
	EditorPlaySessionError,
	EditorPlaySessionLive
} from "./editor-play-session.js";

const contract = { name: "unreal-editor-play-session", version: { major: 1, minor: 0 } } as const;

function layer(handle: Parameters<typeof makeRemoteControlClientTestLayer>[0]) {
	return EditorPlaySessionLive.pipe(Layer.provide(makeRemoteControlClientTestLayer(handle)));
}

it.effect("negotiates and observes a stopped editor", () =>
	Effect.gen(function* () {
		const session = yield* EditorPlaySession;
		const response = yield* session.status("http://editor/");
		expect(response.state).toEqual({ status: "stopped" });
	}).pipe(
		Effect.provide(
			layer((request) =>
				Effect.succeed(
					request.functionName === "GetCapabilityManifest"
						? {
								capabilities: ["editor.play-session.v1"],
								playSessionObjectPath: "/Script/Fixture.PlaySession",
								producerKind: "unreal_editor",
								schemaVersion: 1
							}
						: { contract, state: { status: "stopped" } }
				)
			)
		)
	)
);

it.effect("routes commands and preserves rejected outcomes as values", () =>
	Effect.gen(function* () {
		const session = yield* EditorPlaySession;
		const response = yield* session.pause("http://editor");
		expect(response).toMatchObject({
			command: "pause",
			outcome: "rejected",
			code: "invalid_state"
		});
	}).pipe(
		Effect.provide(
			layer((request) =>
				Effect.succeed(
					request.functionName === "GetCapabilityManifest"
						? {
								capabilities: ["editor.play-session.v1"],
								playSessionObjectPath: "/Script/Fixture.PlaySession",
								producerKind: "unreal_editor",
								schemaVersion: 1
							}
						: {
								code: "invalid_state",
								command: "pause",
								contract,
								message: "No session is active.",
								outcome: "rejected",
								recovery: "Start a session.",
								state: { status: "stopped" }
							}
				)
			)
		)
	)
);

it.effect("reports a typed error when the capability is absent", () =>
	Effect.gen(function* () {
		const session = yield* EditorPlaySession;
		const error = yield* session.status("http://editor").pipe(Effect.flip);
		expect(error).toBeInstanceOf(EditorPlaySessionError);
		expect(error.code).toBe("capability_unavailable");
	}).pipe(
		Effect.provide(
			layer(() =>
				Effect.succeed({
					capabilities: [],
					producerKind: "unreal_editor",
					schemaVersion: 1
				})
			)
		)
	)
);
