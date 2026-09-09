import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { CameraStreamStats } from "@ue-shed/protocol";
import { RemoteControlClient } from "@ue-shed/unreal-connection";
import { configureCameras } from "./index.js";

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
