import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClient, type RemoteControlClientApi } from "@ue-shed/unreal-connection";
import { EditorWorldControl, EditorWorldControlLive } from "./editor-world-control.js";

function clientLayer(request: RemoteControlClientApi["request"]) {
	return Layer.succeed(RemoteControlClient, RemoteControlClient.of({ request }));
}

describe("EditorWorldControl", () => {
	it("negotiates the capability and opens an explicit map", async () => {
		const calls: string[] = [];
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const control = yield* EditorWorldControl;
				return yield* control.open({
					endpoint: "http://127.0.0.1:30010/",
					operationId: "test-open",
					targetMapPath: "/Game/Fixture/Cameras/L_CameraLoad"
				});
			}).pipe(
				Effect.provide(
					EditorWorldControlLive.pipe(
						Layer.provide(
							clientLayer((request) => {
								calls.push(request.functionName);
								if (request.functionName === "GetCapabilityManifest") {
									return Effect.succeed({
										capabilities: ["editor.world-control.v1"],
										producerKind: "unreal_editor",
										schemaVersion: 1,
										worldControlObjectPath: "/Script/Fixture.WorldControl"
									});
								}
								return Effect.succeed({
									after: {
										dirtyWorldPackages: [],
										mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
										playSessionActive: false
									},
									before: {
										dirtyWorldPackages: [],
										mapPath: "/Game/Fixture/Maps/L_Other",
										playSessionActive: false
									},
									contract: {
										name: "unreal-editor-world-control",
										version: { major: 1, minor: 0 }
									},
									operationId: "test-open",
									outcome: "opened",
									targetMapPath: "/Game/Fixture/Cameras/L_CameraLoad"
								});
							})
						)
					)
				)
			)
		);
		expect(calls).toEqual(["GetCapabilityManifest", "OpenMap"]);
		expect(result.outcome).toBe("opened");
	});
});
