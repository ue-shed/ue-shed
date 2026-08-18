import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect } from "vitest";
import { makeRemoteControlClientTestLayer } from "@ue-shed/unreal-connection";
import { EditorConnection, EditorConnectionLive } from "./editor-connection.js";

const manifest = {
	capabilities: ["editor.play-session.v1"],
	producerKind: "unreal_editor" as const,
	projectName: "Fixture",
	schemaVersion: 1 as const
};

it.effect("connects to a matching editor through the capability manifest", () =>
	Effect.gen(function* () {
		const connection = yield* EditorConnection;
		expect(
			yield* connection.connect({
				endpoint: "http://127.0.0.1:30001/",
				expectedProjectName: "Fixture"
			})
		).toEqual(manifest);
	}).pipe(
		Effect.provide(
			EditorConnectionLive.pipe(
				Layer.provide(makeRemoteControlClientTestLayer(() => Effect.succeed(manifest)))
			)
		)
	)
);

it.effect("rejects a reachable editor for another project", () =>
	Effect.gen(function* () {
		const connection = yield* EditorConnection;
		const error = yield* Effect.flip(
			connection.connect({
				endpoint: "http://127.0.0.1:30001",
				expectedProjectName: "AnotherProject"
			})
		);
		expect(error.code).toBe("project_mismatch");
	}).pipe(
		Effect.provide(
			EditorConnectionLive.pipe(
				Layer.provide(makeRemoteControlClientTestLayer(() => Effect.succeed(manifest)))
			)
		)
	)
);

it.effect("does not retry a non-retryable readiness mismatch", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make(0);
		const layer = EditorConnectionLive.pipe(
			Layer.provide(
				makeRemoteControlClientTestLayer(() =>
					Ref.updateAndGet(requests, (count) => count + 1).pipe(Effect.as(manifest))
				)
			)
		);
		const error = yield* Effect.flip(
			Effect.flatMap(EditorConnection, (connection) =>
				connection.waitUntilReady({
					endpoint: "http://127.0.0.1:30001",
					expectedProjectName: "AnotherProject",
					pollInterval: "1 millis",
					timeout: "1 second"
				})
			).pipe(Effect.provide(layer))
		);
		expect(error.code).toBe("project_mismatch");
		expect(yield* Ref.get(requests)).toBe(1);
	})
);
