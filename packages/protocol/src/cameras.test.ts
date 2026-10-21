import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
	decodeCameraScheduleConfig as decodeCameraScheduleConfigEffect,
	decodeCameraStatus as decodeCameraStatusEffect,
	CameraStreamStats
} from "./cameras.js";

const decodeCameraScheduleConfig = <Input>(input: Input) =>
	Effect.runSync(decodeCameraScheduleConfigEffect(input));
const decodeCameraStatus = <Input>(input: Input) => Effect.runSync(decodeCameraStatusEffect(input));

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
	it("makes background ticking opt-in and rejects unknown policies", () => {
		expect(decodeCameraScheduleConfig(config).editorBackgroundTicking).toBeUndefined();
		expect(
			decodeCameraScheduleConfig({ ...config, editorBackgroundTicking: "while_streaming" })
				.editorBackgroundTicking
		).toBe("while_streaming");
		expect(() =>
			decodeCameraScheduleConfig({ ...config, editorBackgroundTicking: "always" })
		).toThrow();
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

	it("accepts only declared pipeline and render modes", () => {
		for (const pipelineMode of ["full_pipeline", "render_only", "schedule_only"] as const) {
			expect(decodeCameraScheduleConfig({ ...config, pipelineMode }).pipelineMode).toBe(
				pipelineMode
			);
		}
		expect(() =>
			decodeCameraScheduleConfig({ ...config, pipelineMode: "readback_sometimes" })
		).toThrow();
		expect(decodeCameraScheduleConfig({ ...config, viewMode: "posed" }).viewMode).toBe("posed");
		expect(() =>
			decodeCameraScheduleConfig({ ...config, renderProfile: "cinematic-ish" })
		).toThrow();
	});

	it("preserves scheduler telemetry and reports editor previews only when the feed shows them", () => {
		const base = {
			cameras: [],
			config,
			pipeName: "test-pipe",
			schemaVersion: 1,
			stats: {
				...Object.fromEntries(
					Object.keys(CameraStreamStats.fields).map((key) => [
						key,
						key === "pipeConnected" ? false : 0
					])
				),
				cadenceIntervalsSkipped: 4,
				camerasDue: 24,
				experimentRenderedCaptures: 20,
				experimentScheduledCaptures: 24,
				schedulerTicks: 16
			}
		};
		const status = decodeCameraStatus(base);
		expect(status.editorPreviews).toBeUndefined();
		expect(status.stats).toMatchObject({
			cadenceIntervalsSkipped: 4,
			camerasDue: 24,
			experimentRenderedCaptures: 20,
			experimentScheduledCaptures: 24,
			schedulerTicks: 16
		});
		expect(
			decodeCameraStatus({ ...base, editorPreviews: { revealedChildActors: 3 } })
				.editorPreviews
		).toEqual({ revealedChildActors: 3 });
		expect(() =>
			decodeCameraStatus({ ...base, editorPreviews: { revealedChildActors: -1 } })
		).toThrow();
	});
});
