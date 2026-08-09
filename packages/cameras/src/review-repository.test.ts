import { it } from "@effect/vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { bootstrapMapReviewSet } from "./review-bootstrap.js";
import {
	createReviewSetFromTemplate,
	listReviewSets,
	ReviewRepository,
	ReviewRepositoryLive
} from "./review-repository.js";
import { ReviewSelectionResponse } from "./review-schema.js";

const selection = Schema.decodeUnknownSync(ReviewSelectionResponse)({
	actorPath: "/Game/Maps/City.City:PersistentLevel.Building_0",
	bounds: {
		center: { x: 0, y: 0, z: 100 },
		extent: { x: 100, y: 100, z: 100 },
		rotation: { pitch: 0, roll: 0, yaw: 0 }
	},
	contract: { name: "ue-shed-review-selection", version: { major: 1, minor: 0 } },
	displayName: "Building",
	mapPath: "/Game/Maps/City",
	status: "selected"
});

function withProject<A, E, R>(use: (projectRoot: string) => Effect.Effect<A, E, R>) {
	return Effect.acquireUseRelease(
		Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-review-sets-"))),
		use,
		(projectRoot) => Effect.promise(() => rm(projectRoot, { force: true, recursive: true }))
	);
}

it.effect("discovers portable Review Sets beneath the project review root", () =>
	withProject((projectRoot) =>
		Effect.gen(function* () {
			if (selection.status !== "selected") return;
			const repository = yield* ReviewRepository;
			const bootstrap = bootstrapMapReviewSet({ projectRoot, selection });
			yield* repository.saveSet({
				path: bootstrap.reviewSetPath,
				reviewSet: bootstrap.reviewSet
			});

			const sets = yield* listReviewSets(projectRoot);

			expect(sets).toEqual([
				expect.objectContaining({
					displayName: "City Map Review",
					id: bootstrap.reviewSet.id,
					mapPath: selection.mapPath,
					viewCount: 0
				})
			]);
		}).pipe(Effect.provide(ReviewRepositoryLive))
	)
);

it.effect("creates an empty sibling set from durable capture settings", () =>
	withProject((projectRoot) =>
		Effect.gen(function* () {
			if (selection.status !== "selected") return;
			const repository = yield* ReviewRepository;
			const bootstrap = bootstrapMapReviewSet({ projectRoot, selection });
			yield* repository.saveSet({
				path: bootstrap.reviewSetPath,
				reviewSet: bootstrap.reviewSet
			});

			const created = yield* createReviewSetFromTemplate({
				displayName: "Lighting Review",
				projectRoot,
				templatePath: bootstrap.reviewSetPath
			});
			const document = yield* repository.loadSet(created.path);
			const sets = yield* repository.listSets(projectRoot);

			expect(created.id).toMatch(/^lighting-review-/u);
			expect(document).toMatchObject({
				captureProfiles: bootstrap.reviewSet.captureProfiles,
				displayName: "Lighting Review",
				project: bootstrap.reviewSet.project,
				views: [],
				visibilityPolicies: bootstrap.reviewSet.visibilityPolicies
			});
			expect(sets.map((reviewSet) => reviewSet.id)).toContain(created.id);
		}).pipe(Effect.provide(ReviewRepositoryLive))
	)
);
