import { expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { StageClock } from "./stage-clock.js";
it("charges consecutive marks and added parts to their stages in first-mark order", () => {
    let now = 100;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
        const stages = new StageClock();
        now = 130;
        stages.mark("read");
        stages.add("scan.check", 4.25);
        now = 135.5;
        stages.mark("scan");
        now = 140;
        stages.mark("read");
        stages.add("scan.check", 1);
        expect(stages.attributes("step.stage_ms")).toEqual({
            "step.stage_ms.read": 34.5,
            "step.stage_ms.scan.check": 5.25,
            "step.stage_ms.scan": 5.5
        });
    }
    finally {
        clock.mockRestore();
    }
});
