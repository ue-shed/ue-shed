import { describe, expect, it } from "vitest";
import { movementGymScenario } from "./demo.js";
import { makeScenarioElementId } from "./schema.js";
import {
	findScenarioClip,
	inspectScenarioTimeline,
	moveScenarioClip,
	planScenarioSeek
} from "./timeline.js";

describe("interactive scenario timeline", () => {
	it("moves semantic intent without changing its raw-input provenance", () => {
		const jumpId = makeScenarioElementId("action_jump");
		const result = moveScenarioClip({
			document: movementGymScenario,
			clipId: jumpId,
			startMs: 2740
		});

		expect(result.status).toBe("updated");
		if (result.status !== "updated") return;
		expect(findScenarioClip(result.document, jumpId)?.startMs).toBe(2740);
		expect(
			findScenarioClip(result.document, makeScenarioElementId("raw_face_bottom"))?.startMs
		).toBe(2910);
	});

	it("plans honest restore-and-replay seeking across physics", () => {
		const plan = planScenarioSeek({ document: movementGymScenario, targetMs: 4800 });
		expect(plan).toMatchObject({
			status: "restore_and_replay",
			replayDurationMs: 4800,
			crossesNonSeekable: true
		});
	});

	it("uses a later checkpoint after the non-seekable interval", () => {
		const plan = planScenarioSeek({ document: movementGymScenario, targetMs: 7800 });
		expect(plan).toMatchObject({
			status: "restore_and_replay",
			replayDurationMs: 1800,
			crossesNonSeekable: false
		});
	});

	it("ships a timeline with valid clip and keyframe bounds", () => {
		expect(inspectScenarioTimeline(movementGymScenario)).toEqual([]);
	});
});
