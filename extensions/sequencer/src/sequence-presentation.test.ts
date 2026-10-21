import { expect, it } from "vitest";
import { frameRateLabel, frameRateTooltip, playbackLabel } from "./sequence-presentation.js";
import { sequenceReadFixture } from "./sequence-fixture.test-support.js";

it("formats fractional frame rates and playback with the saved rational display rate", () => {
	const sequence = {
		...sequenceReadFixture.sequence,
		display_rate: { numerator: 30000, denominator: 1001 }
	};
	expect(frameRateLabel(sequence.display_rate)).toBe("29.97 fps");
	expect(frameRateTooltip(sequence.display_rate)).toBe("30000/1001 fps");
	expect(frameRateTooltip({ numerator: 24, denominator: 1 })).toBeUndefined();
	expect(frameRateTooltip(null)).toBeUndefined();
	expect(playbackLabel(sequence)).toBe("0–60 frames · 2.0 s");
});
