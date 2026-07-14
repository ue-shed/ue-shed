import { describe, expect, it } from "vitest";
import { decodeCameraScheduleConfig, decodeCameraStatus } from "./cameras.js";

const config = {
	activeCameraCount: 8,
	backgroundFps: 15,
	captureBudgetPerTick: 8,
	focusedCameraIndex: 0,
	focusedFps: 30,
	paused: false,
	pipelineMode: "full_pipeline",
	renderProfile: "full_fidelity",
	resolution: "640x360",
	viewMode: "actor_pov"
} as const;

describe("camera schedule contract", () => {
	it("accepts a supported capture resolution", () => {
		expect(decodeCameraScheduleConfig(config)).toEqual(config);
	});

	it("rejects arbitrary capture dimensions", () => {
		expect(() => decodeCameraScheduleConfig({ ...config, resolution: "500x500" })).toThrow();
	});

	it("accepts the declared stress envelope and rejects a thirty-third camera", () => {
		expect(
			decodeCameraScheduleConfig({
				...config,
				activeCameraCount: 32,
				captureBudgetPerTick: 32,
				focusedCameraIndex: 31,
				resolution: "2560x1440"
			})
		).toMatchObject({ activeCameraCount: 32, resolution: "2560x1440" });
		expect(() => decodeCameraScheduleConfig({ ...config, activeCameraCount: 33 })).toThrow();
	});

	it("rejects unknown render profiles", () => {
		expect(() =>
			decodeCameraScheduleConfig({ ...config, renderProfile: "cinematic-ish" })
		).toThrow();
	});

	it("accepts only declared pipeline isolation modes", () => {
		for (const pipelineMode of ["full_pipeline", "render_only", "schedule_only"] as const) {
			expect(decodeCameraScheduleConfig({ ...config, pipelineMode }).pipelineMode).toBe(
				pipelineMode
			);
		}
		expect(() =>
			decodeCameraScheduleConfig({ ...config, pipelineMode: "readback_sometimes" })
		).toThrow();
	});

	it("decodes scheduler and batch telemetry from Unreal status", () => {
		const status = decodeCameraStatus({
			cameras: [],
			config,
			pipeName: "test-pipe",
			schemaVersion: 1,
			stats: {
				bytesSent: 1024,
				captureBatchesSubmitted: 10,
				cadenceIntervalsSkipped: 4,
				camerasDue: 24,
				capturesRequested: 20,
				experimentBytesSent: 512,
				experimentCadenceIntervalsSkipped: 4,
				experimentElapsedMs: 2_000,
				experimentFramesDelivered: 18,
				experimentReadbackDrops: 1,
				experimentReadbackResourcesCreated: 2,
				experimentReadbacksEnqueued: 20,
				experimentRenderedCaptures: 20,
				experimentRevision: 3,
				experimentSchedulerTicks: 16,
				experimentScheduledCaptures: 24,
				experimentTransportReplacements: 2,
				framesDelivered: 20,
				lastCaptureBatchSize: 2,
				lastCaptureBatchSubmissionMs: 0.2,
				maxCaptureBatchSize: 8,
				maxCaptureBatchSubmissionMs: 1.1,
				maxCaptureLatenessMs: 12,
				pipeConnected: true,
				readbackDrops: 0,
				readbackResourcesCreated: 16,
				schedulerTicks: 16,
				totalCaptureBatchSubmissionMs: 3,
				totalCaptureLatenessMs: 48,
				transportReplacements: 0
			}
		});

		expect(status.stats).toMatchObject({
			cadenceIntervalsSkipped: 4,
			camerasDue: 24,
			experimentRenderedCaptures: 20,
			experimentScheduledCaptures: 24,
			schedulerTicks: 16
		});
	});
});
