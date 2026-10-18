import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { GameTextIndexSteps } from "./index-steps.js";
import { makeSyntheticHostFixture, withEventLoopGaps } from "./host-responsiveness.test-support.js";

/** Run alone through `pnpm test:game-text:responsiveness`, which `pnpm check` includes. Timer
 * gaps measure the whole process, so parallel test files would turn their load into failures.
 */
const enabled = process.env.UE_SHED_HOST_RESPONSIVENESS === "1";

/** Host work runs in 16 ms slices and locally stays under 100 ms. The budget leaves room for a
 * slower CI runner (about twice the local slice cost) and for a major GC pause in the same
 * stretch, while still failing on any unsliced pass over the inventory or the occurrences.
 */
const MAXIMUM_GAP_MS = 250;

const project = {
	inventory: 150_000,
	textPackages: 2_000,
	occurrencesPerPackage: 25,
	keys: 10_000
};

it.live.skipIf(!enabled)(
	"keeps the event loop responsive through cold and warm build-and-open refreshes",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeSyntheticHostFixture(project);
			const context = yield* Layer.build(fixture.layer);
			const service = yield* GameTextIndexRefresh.pipe(Effect.provide(context));
			const refresh = Effect.scoped(
				service.refresh(fixture.request).pipe(
					Effect.tap((result) =>
						Effect.gen(function* () {
							yield* result.search({ query: "", capability: "all", pageSize: 50 });
							// Summary reads stay asynchronous through the native engine.
							expect(
								(yield* result.query.summary()).searchable.textUnits
							).toBeGreaterThan(0);
						})
					)
				)
			);
			const cold = yield* withEventLoopGaps(refresh);
			expect(cold.value.packages.readPackages).toBe(fixture.textPackages);
			expect(cold.value.join.rebuilt).toBe(true);
			expect(cold.maxGapMs).toBeLessThan(MAXIMUM_GAP_MS);
			const warm = yield* withEventLoopGaps(refresh);
			yield* Effect.logInfo("Host event-loop gaps").pipe(
				Effect.annotateLogs({ coldMaxGapMs: cold.maxGapMs, warmMaxGapMs: warm.maxGapMs })
			);
			expect(warm.value.packages.readPackages).toBe(0);
			expect(warm.value.join.rebuilt).toBe(false);
			expect(warm.maxGapMs).toBeLessThan(MAXIMUM_GAP_MS);
		}),
	180_000
);

it.live.skipIf(!enabled)(
	"opens a built target without stalling the host while the worker prepares its query",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeSyntheticHostFixture(project);
			const context = yield* Layer.build(fixture.layer);
			const steps = yield* GameTextIndexSteps.pipe(Effect.provide(context));
			const selected = yield* steps.openProject(fixture.request);
			const imported = yield* steps.importTarget(selected, fixture.request);
			const indexed = yield* steps.refreshProject(fixture.request);
			const target = yield* steps.buildTarget(indexed, imported, {});
			const opened = yield* withEventLoopGaps(
				Effect.scoped(
					steps
						.openTarget(target)
						.pipe(
							Effect.tap((model) =>
								model.search({ query: "", capability: "all", pageSize: 50 })
							)
						)
				)
			);
			yield* Effect.logInfo("Open event-loop gap").pipe(
				Effect.annotateLogs({ openMaxGapMs: opened.maxGapMs })
			);
			expect(opened.maxGapMs).toBeLessThan(MAXIMUM_GAP_MS);
		}),
	180_000
);

it.live.skipIf(!enabled)(
	"runs a localization quality scan in its worker without stalling the host",
	() =>
		Effect.gen(function* () {
			const fixture = yield* makeSyntheticHostFixture(project);
			const context = yield* Layer.build(fixture.layer);
			const service = yield* GameTextIndexRefresh.pipe(Effect.provide(context));
			yield* Effect.scoped(
				Effect.gen(function* () {
					const result = yield* service.refresh(fixture.request);
					const scanned = yield* withEventLoopGaps(
						result
							.localizationQuality(undefined, { review: result.review.file })
							.pipe(
								Effect.tap((quality) =>
									Effect.sync(() => quality.findings.items([0, 1, 2]))
								)
							)
					);
					yield* Effect.logInfo("Quality scan event-loop gap").pipe(
						Effect.annotateLogs({
							scanMaxGapMs: scanned.maxGapMs,
							findings: scanned.value.findings.length
						})
					);
					expect(scanned.value.findings.length).toBeGreaterThan(0);
					expect(scanned.maxGapMs).toBeLessThan(MAXIMUM_GAP_MS);
				})
			);
		}),
	180_000
);
