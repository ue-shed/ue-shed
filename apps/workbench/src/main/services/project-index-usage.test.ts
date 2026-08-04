import { it } from "@effect/vitest";
import {
	makeProjectIndexTestLayer,
	ProjectIdentity,
	ProjectIndex,
	ProjectIndexGeneration,
	ProjectIndexRefreshEvent,
	ProjectIndexRefreshFailed,
	type ProjectIndexSummary
} from "@ue-shed/unreal-assets";
import { Effect, Ref, Stream } from "effect";
import { expect } from "vitest";

const summary: ProjectIndexSummary = {
	changedPackages: 4,
	completeness: "complete",
	diagnostics: [],
	generation: ProjectIndexGeneration.make(2),
	mapCount: 1,
	packageCount: 12,
	projectId: ProjectIdentity.make("fixture-project"),
	removedPackages: 0
};

it.effect("supports Workbench selection progress and an explicit retry without UI arguments", () =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0);
		const layer = makeProjectIndexTestLayer({
			rebuild: () => Stream.die("unused"),
			refresh: (target) =>
				Stream.unwrap(
					Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
						Effect.map((attempt) => {
							expect(target).toEqual({ projectRoot: "C:/Fixture" });
							if (attempt === 0) {
								return Stream.fail(
									new ProjectIndexRefreshFailed({
										message: "The worker reached its output limit.",
										recovery: "Upgrade the paired worker, then retry.",
										retrySafe: true
									})
								);
							}
							return Stream.fromIterable([
								ProjectIndexRefreshEvent.cases.Started.make({
									operation: "refresh"
								}),
								ProjectIndexRefreshEvent.cases.Progress.make({
									completedPackages: 6,
									phase: "reading_headers",
									totalPackages: 12
								}),
								ProjectIndexRefreshEvent.cases.Completed.make({ summary })
							]);
						})
					)
				),
			query: () => Effect.die("unused"),
			status: () => Effect.succeed({ status: "absent" })
		});

		const select = Effect.gen(function* () {
			const index = yield* ProjectIndex;
			return yield* Stream.runCollect(index.refresh({ projectRoot: "C:/Fixture" }));
		}).pipe(Effect.provide(layer));

		const failure = yield* select.pipe(Effect.flip);
		expect(failure.message).toContain("output limit");
		expect(failure.recovery).toContain("retry");

		const retryEvents = Array.from(yield* select);
		expect(retryEvents.map((event) => event._tag)).toEqual([
			"Started",
			"Progress",
			"Completed"
		]);
		expect(yield* Ref.get(attempts)).toBe(2);
	})
);
