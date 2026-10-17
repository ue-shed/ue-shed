import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { CameraStreamStats } from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { configureCameras, getCameraStatus } from "./index.js";

const config = {
	activeCameraCount: 6,
	backgroundFps: 0.5,
	focusedFps: 4,
	captureBudgetPerTick: 1,
	focusedCameraIndex: 2,
	paused: false,
	pipelineMode: "full_pipeline" as const,
	renderProfile: "observation" as const,
	resolution: "640x360" as const,
	viewMode: "posed" as const
};
const stats = Object.fromEntries(
	Object.keys(CameraStreamStats.fields).map((key) => [key, key === "pipeConnected" ? true : 0])
);
describe("scoped editor ticking compatibility", () => {
	it("requires explicit native acknowledgement of the override", async () => {
		for (const supported of [false, true]) {
			const resultConfig = supported
				? { ...config, editorBackgroundTicking: "while_streaming" }
				: config;
			const operation = configureCameras("http://localhost:30117", {
				...config,
				editorBackgroundTicking: "while_streaming"
			}).pipe(
				Effect.provideService(RemoteControlClient, {
					request: (request) => {
						expect(
							JSON.parse(String(request.parameters.ConfigJson))
								.editorBackgroundTicking
						).toBe("while_streaming");
						return Effect.succeed({
							cameras: [],
							config: resultConfig,
							stats,
							pipeName: "fixture",
							schemaVersion: 1
						});
					}
				})
			);
			if (supported)
				expect((await Effect.runPromise(operation)).config.editorBackgroundTicking).toBe(
					"while_streaming"
				);
			else
				await expect(Effect.runPromise(operation)).rejects.toMatchObject({
					retrySafe: false,
					operation: "configure"
				});
		}
	});
});

describe("coded camera control failures", () => {
	const respond = (value: Schema.Json) =>
		Effect.provideService(RemoteControlClient, {
			request: () => Effect.succeed(value)
		});

	it("carries the plugin's code and prose instead of a decode error", async () => {
		const message = 'Actor "Door\\Left" is not loaded';
		await expect(
			Effect.runPromise(
				getCameraStatus("http://localhost:30117").pipe(
					respond({
						schemaVersion: 1,
						status: "failed",
						error: "no-renderable-world",
						message
					})
				)
			)
		).rejects.toMatchObject({ code: "no-renderable-world", message, retrySafe: true });
	});

	it("reads an older plugin's failure without status or message", async () => {
		await expect(
			Effect.runPromise(
				configureCameras("http://localhost:30117", config).pipe(
					respond({ schemaVersion: 1, error: "invalid-resolution" })
				)
			)
		).rejects.toMatchObject({
			code: "invalid-resolution",
			operation: "configure",
			retrySafe: false,
			nextStep: "fix_input"
		});
	});

	it("preserves an unfamiliar native cause without directing a blind retry", async () => {
		await expect(
			Effect.runPromise(
				getCameraStatus("http://localhost:30117").pipe(
					respond({ schemaVersion: 1, error: "future-native-failure" })
				)
			)
		).rejects.toMatchObject({
			code: "future-native-failure",
			retrySafe: false,
			nextStep: "escalate"
		});
	});

	it("reports a malformed plugin reply through the camera domain error", async () => {
		const error = await Effect.runPromise(
			getCameraStatus("http://localhost:30117").pipe(
				respond({ schemaVersion: 99, error: "no-renderable-world" }),
				Effect.flip
			)
		);
		expect(error).toMatchObject({
			_tag: "CameraControlError",
			operation: "status",
			retrySafe: false,
			nextStep: "escalate"
		});
		expect(error.code).toBeUndefined();
	});
});
