import { EditorPlaySessionLive } from "@ue-shed/engine";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ScenarioRunner, ScenarioRunnerLive } from "./scenario-runner.js";

const enabled = process.env.UE_SHED_RUN_UNREAL_INTEGRATION === "1";

describe.skipIf(!enabled)("real UE 5.7 Movement Gym", () => {
	it("executes Move, Jump, and Interact in PIE and restores input isolation", async () => {
		const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT ?? "http://127.0.0.1:30001";
		const remote = RemoteControlClientLive;
		const playSession = EditorPlaySessionLive.pipe(Layer.provide(remote));
		const runnerLayer = ScenarioRunnerLive.pipe(
			Layer.provide(Layer.merge(remote, playSession))
		);
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const runner = yield* ScenarioRunner;
				return yield* runner.run({ endpoint, evidenceLimit: 4 });
			}).pipe(Effect.provide(runnerLayer))
		);

		expect(["completed", "completed_with_divergence"]).toContain(result.status);
		expect(result.inputIsolation).toEqual({
			established: true,
			method: "slate_input_preprocessor",
			restored: true
		});
		expect(result.evidence.some((item) => item.markerId === "probe_cache_open")).toBe(true);
		expect(result.evidence.length).toBeLessThanOrEqual(4);
	}, 60_000);
});
