import { it } from "@effect/vitest";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { GameTextIndexRefresh } from "../packages/game-text/src/index-refresh.ts";
import { makeIndexRegressionFixture } from "../packages/game-text/src/index-refresh-regressions.test-support.ts";
import { refreshJoinedTarget } from "../packages/game-text/src/joined-target-reference.test-support.ts";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import { STARTER_CHECK_RULES } from "../packages/game-text/src/starter-rules.ts";
import { coveredMs, makeStageRecorder } from "./game-text-stage-timings.ts";

it("counts overlapping intervals once and adds separate ones", () => {
	const ms = (value: number) => BigInt(value * 1e6);
	expect(coveredMs([])).toBe(0);
	expect(
		coveredMs([
			[ms(10), ms(20)],
			[ms(0), ms(5)],
			[ms(15), ms(30)],
			[ms(18), ms(19)]
		])
	).toBe(25);
});

it.effect("summarizes span wall time and in-step stage attributes by name", () =>
	Effect.gen(function* () {
		const recorder = makeStageRecorder();
		const step = (stage: number) =>
			Effect.annotateCurrentSpan({ "step.stage_ms.read": stage, "step.lines": 3 }).pipe(
				Effect.withSpan("Step")
			);
		yield* Effect.all([step(2), step(5)], { concurrency: 2 }).pipe(
			Effect.withSpan("Run"),
			Effect.withTracer(recorder.tracer)
		);
		const counts = recorder.counts();
		expect(counts["stage.Step.count"]).toBe(2);
		expect(counts["stage.Run.count"]).toBe(1);
		// Only stage attributes are summed; other attributes stay out of the summary.
		expect(counts["stage.Step.step.stage_ms.read"]).toBe(7);
		expect(counts["stage.Step.step.lines"]).toBeUndefined();
		expect(counts["stage.Run.wallMs"]).toBeGreaterThanOrEqual(counts["stage.Step.wallMs"]!);
	})
);

it.live("records the join and quality scan stages of a real index build", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		const recorder = makeStageRecorder();
		yield* Effect.gen(function* () {
			const refresh = yield* GameTextIndexRefresh;
			const result = yield* refresh.refresh(fixture.request);
			yield* result.localizationQuality(STARTER_CHECK_RULES, { review: result.review.file });
		}).pipe(Effect.scoped, Effect.provide(fixture.layer()), Effect.withTracer(recorder.tracer));
		const counts = recorder.counts();
		for (const stage of ["inputs", "order", "lines", "query_places", "publish"])
			expect(counts[`stage.JoinedTarget.refresh.join.stage_ms.${stage}`]).toBeGreaterThan(0);
		for (const stage of ["prepare", "units", "order", "scan", "scan.check", "columns"])
			expect(
				counts[`stage.GameText.localizationQuality.game_text.quality.stage_ms.${stage}`]
			).toBeGreaterThanOrEqual(0);
		expect(counts["stage.PackageText.refresh.package-text.stage_ms.selection"]).toBeDefined();
		expect(counts["stage.GameTextIndex.openTarget.count"]).toBe(1);
	})
);

for (const fallback of [false, true]) {
	it.live(
		`includes reader setup${fallback ? " and incremental fallback" : ""} in full join stages`,
		() =>
			Effect.gen(function* () {
				const fixture = yield* makeIndexRegressionFixture();
				const changedTarget = fixture.addTarget("Changed");
				let now = 0;
				let delayedIncrementalRead = false;
				yield* Effect.acquireRelease(
					Effect.sync(() => vi.spyOn(performance, "now").mockImplementation(() => now)),
					(clock) => Effect.sync(() => clock.mockRestore())
				);
				const monitored = Layer.effect(
					SharedIndex,
					Effect.gen(function* () {
						const store = yield* SharedIndex;
						return SharedIndex.of({
							...store,
							open: () =>
								Effect.gen(function* () {
									const reader = yield* store.open();
									// Advance measured time without depending on a real sleep or runner speed.
									now += 50;
									return {
										...reader,
										layer: (name: string) => {
											if (name === "joined" && !delayedIncrementalRead) {
												delayedIncrementalRead = true;
												now += 70;
											}
											return reader.layer(name);
										}
									};
								})
						});
					})
				).pipe(
					Layer.provide(
						sharedIndexNodeLayer({
							cacheRoot: join(fixture.projectRoot, "stage-cache"),
							projectKey: "stages",
							targetKey: fixture.target.name
						})
					)
				);
				yield* Effect.gen(function* () {
					const input = { projectRoot: fixture.projectRoot, target: fixture.target };
					yield* Effect.gen(function* () {
						const writer = yield* (yield* SharedIndex).writer();
						yield* writer.intern("identity", [""]);
						yield* writer.publishIds(
							"seed",
							"seed",
							{
								columns: [
									{
										name: "seed",
										kind: "u32",
										load: async () => Uint32Array.of(0)
									}
								]
							},
							writer.manifest().generation
						);
					}).pipe(Effect.scoped);
					if (fallback)
						yield* refreshJoinedTarget({ ...input, force: true }).pipe(Effect.scoped);
					now = 0;
					delayedIncrementalRead = false;
					const recorder = makeStageRecorder();
					const result = yield* refreshJoinedTarget({
						...input,
						target: changedTarget
					}).pipe(Effect.scoped, Effect.withTracer(recorder.tracer));
					expect(result).toMatchObject({ rebuilt: true, strategy: "full" });
					if (fallback)
						expect(result).toMatchObject({
							incrementalFallback: "generation-target-review-or-absence"
						});
					const counts = recorder.counts();
					expect(delayedIncrementalRead).toBe(fallback);
					const expected = fallback ? 120 : 50;
					expect(counts["stage.JoinedTarget.refresh.join.stage_ms.inputs"]).toBe(
						expected
					);
					const total = Object.entries(counts)
						.filter(([key]) =>
							key.startsWith("stage.JoinedTarget.refresh.join.stage_ms.")
						)
						.reduce((sum, [, value]) => sum + value, 0);
					expect(total).toBe(expected);
				}).pipe(Effect.provide(monitored));
			}).pipe(Effect.scoped)
	);
}
