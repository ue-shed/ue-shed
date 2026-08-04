import { it } from "@effect/vitest";
import {
	makeProjectIndexTestLayer,
	ProjectIdentity,
	ProjectIndex,
	ProjectIndexGeneration,
	ProjectIndexQuery,
	ProjectIndexRefreshEvent,
	type ProjectIndexPage,
	type ProjectIndexSummary
} from "@ue-shed/unreal-assets";
import { Effect, Stream } from "effect";
import { expect } from "vitest";

const projectId = ProjectIdentity.make("fixture-project");
const generation = ProjectIndexGeneration.make(1);
const summary: ProjectIndexSummary = {
	changedPackages: 12,
	completeness: "complete",
	diagnostics: [],
	generation,
	mapCount: 1,
	packageCount: 12,
	projectId,
	removedPackages: 0
};
const page: ProjectIndexPage = {
	generation,
	items: [
		{ kind: "map", mapPath: "Content/Maps/L_Fixture.umap", packageName: "/Game/Maps/L_Fixture" }
	],
	projectId
};

it.effect("supports a headless CLI refresh followed by a generation-bound query", () => {
	const layer = makeProjectIndexTestLayer({
		rebuild: () => Stream.die("unused"),
		refresh: () =>
			Stream.fromIterable([
				ProjectIndexRefreshEvent.cases.Started.make({ operation: "refresh" }),
				ProjectIndexRefreshEvent.cases.Progress.make({
					completedPackages: 12,
					phase: "committing",
					totalPackages: 12
				}),
				ProjectIndexRefreshEvent.cases.Completed.make({ summary })
			]),
		query: (request) => {
			expect(request._tag).toBe("Maps");
			expect(request.expectedGeneration).toBe(generation);
			expect(request.limit).toBe(50);
			return Effect.succeed(page);
		},
		status: () => Effect.succeed({ status: "ready", summary })
	});

	return Effect.gen(function* () {
		const index = yield* ProjectIndex;
		const events = yield* Stream.runCollect(index.refresh({ projectRoot: "C:/Fixture" }));
		const completed = Array.from(events).find((event) => event._tag === "Completed");
		if (completed === undefined) return yield* Effect.die("refresh did not complete");
		const result = yield* index.query(
			ProjectIndexQuery.cases.Maps.make({
				expectedGeneration: completed.summary.generation,
				limit: 50,
				projectId: completed.summary.projectId
			})
		);

		expect(result.items).toEqual(page.items);
	}).pipe(Effect.provide(layer));
});
