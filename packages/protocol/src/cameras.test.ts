import { describe, expect, it } from "vitest";
import { decodeCameraScheduleConfig } from "./cameras.js";

const config = {
	activeCameraCount: 8,
	backgroundFps: 15,
	captureBudgetPerTick: 8,
	focusedCameraIndex: 0,
	focusedFps: 30,
	paused: false,
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
});
