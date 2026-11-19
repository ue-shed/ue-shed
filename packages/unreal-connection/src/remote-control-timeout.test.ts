import { Duration } from "effect";
import { describe, expect, it } from "vitest";

import { remoteControlTimeout } from "./remote-control-client.js";

const millis = (duration: Duration.Duration) => Duration.toMillis(duration);

describe("remoteControlTimeout", () => {
	it("uses the call's own timeout, else the host default", () => {
		expect(millis(remoteControlTimeout({}, { defaultTimeout: "10 seconds" }))).toBe(10_000);
		expect(
			millis(
				remoteControlTimeout({ timeout: "30 seconds" }, { defaultTimeout: "10 seconds" })
			)
		).toBe(30_000);
	});

	it("lets the host raise a library's per-call timeout with a floor", () => {
		const settings = { defaultTimeout: "10 seconds", minimumTimeout: "3 minutes" } as const;
		expect(millis(remoteControlTimeout({ timeout: "30 seconds" }, settings))).toBe(180_000);
		expect(millis(remoteControlTimeout({}, settings))).toBe(180_000);
		// A floor never shortens a longer call.
		expect(millis(remoteControlTimeout({ timeout: "10 minutes" }, settings))).toBe(600_000);
	});

	it("gives an operation override the last word, below the floor too", () => {
		const settings = {
			defaultTimeout: "10 seconds",
			minimumTimeout: "3 minutes",
			operationTimeouts: {
				"camera.render.close": "5 seconds",
				"camera.render.capture": "5 minutes"
			}
		} as const;
		expect(
			millis(
				remoteControlTimeout(
					{ operation: "camera.render.capture", timeout: "30 seconds" },
					settings
				)
			)
		).toBe(300_000);
		expect(millis(remoteControlTimeout({ operation: "camera.render.close" }, settings))).toBe(
			5_000
		);
		expect(millis(remoteControlTimeout({ operation: "other" }, settings))).toBe(180_000);
	});
});
