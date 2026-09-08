import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureReviewSet, runSuccessfulCli, parseRecord } from "./cli-process.test-support.js";

describe("ue-shed Review authoring CLI process", () => {
	it("validates the portable fixture Review Set and lists empty local history", async () => {
		const validation = parseRecord(
			runSuccessfulCli(["review", "sets", "validate", fixtureReviewSet])
		);
		expect(validation).toMatchObject({
			id: "fixture-structure",
			profiles: 1,
			status: "valid",
			views: 1
		});

		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-history-"));
		try {
			expect(parseRecord(runSuccessfulCli(["review", "history", projectRoot]))).toEqual({
				runs: []
			});
		} finally {
			await rm(projectRoot, { force: true, recursive: true });
		}
	}, 30_000);

	it("inspects, replaces, and explicitly applies Visibility Policies", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-policies-"));
		try {
			const reviewSetPath = join(root, "review-set.json");
			const policyPath = join(root, "policy.json");
			await copyFile(fixtureReviewSet, reviewSetPath);
			await writeFile(
				policyPath,
				JSON.stringify({
					assessment: { method: "depth_compare" },
					id: "fixture-clear-v2",
					name: "Fixture Clear v2",
					onLowVisibility: { action: "warn", threshold: 0.5 },
					output: {
						clearStrategy: { type: "isolate_target" },
						mode: "natural_and_clear"
					}
				}),
				"utf8"
			);

			const before = parseRecord(
				runSuccessfulCli(["review", "policies", "list", reviewSetPath])
			);
			expect(before.policies).toEqual([
				expect.objectContaining({
					assignedViewIds: ["structure-context"],
					policy: expect.objectContaining({ id: "default-natural-only" })
				})
			]);

			const replaced = parseRecord(
				runSuccessfulCli([
					"review",
					"policies",
					"replace",
					reviewSetPath,
					"structure-context",
					policyPath
				])
			);
			expect(replaced).toMatchObject({
				policyId: "fixture-clear-v2",
				status: "replaced",
				viewId: "structure-context"
			});

			const applied = parseRecord(
				runSuccessfulCli([
					"review",
					"policies",
					"apply",
					reviewSetPath,
					"default-natural-only",
					"structure-context"
				])
			);
			expect(applied).toMatchObject({
				policyId: "default-natural-only",
				status: "applied",
				viewIds: ["structure-context"]
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	}, 30_000);

	it("authors and revises a fixed area View with immutable revision identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-views-"));
		try {
			const reviewSetPath = join(root, "review-set.json");
			const viewPath = join(root, "area-view.json");
			await copyFile(fixtureReviewSet, reviewSetPath);
			const areaView = {
				captureProfileId: "fixture-hd",
				displayName: "Loading area",
				framingDiagnostics: [
					{ code: "bounds_snapshot", message: "Portable area", severity: "info" }
				],
				framingRecipe: { kind: "manual", version: 1 },
				id: "loading-area",
				purpose: "Review the loading area",
				revision: { id: "loading-area-r1", number: 1, status: "numbered" },
				tags: ["area"],
				target: {
					bounds: {
						center: { x: 0, y: 0, z: 200 },
						extent: { x: 600, y: 400, z: 200 },
						rotation: { pitch: 0, roll: 0, yaw: 30 }
					},
					kind: "oriented_box"
				},
				viewpoint: {
					approvedPose: {
						aspectRatio: "16:9",
						fieldOfViewDegrees: 60,
						location: { x: 1500, y: -1500, z: 900 },
						projection: "perspective",
						rotation: { pitch: -18, roll: 0, yaw: 135 }
					},
					kind: "world_fixed"
				},
				visibilityPolicyId: "default-natural-only"
			};
			await writeFile(viewPath, JSON.stringify(areaView), "utf8");
			expect(
				parseRecord(runSuccessfulCli(["review", "views", "put", reviewSetPath, viewPath]))
			).toMatchObject({
				revision: { id: "loading-area-r1", number: 1 },
				status: "created",
				viewId: "loading-area"
			});

			areaView.viewpoint.approvedPose.location.x = 1750;
			await writeFile(viewPath, JSON.stringify(areaView), "utf8");
			expect(
				parseRecord(runSuccessfulCli(["review", "views", "put", reviewSetPath, viewPath]))
			).toMatchObject({
				revision: { id: "loading-area-r2", number: 2 },
				status: "revised",
				viewId: "loading-area"
			});
			// SAFETY: the CLI just persisted this Review Set fixture and the assertion reads owned fields.
			const persisted = JSON.parse(await readFile(reviewSetPath, "utf8")) as {
				views: Array<{ id: string; revision: { id: string; number: number } }>;
			};
			expect(persisted.views.find((view) => view.id === "loading-area")?.revision).toEqual({
				id: "loading-area-r2",
				number: 2,
				status: "numbered"
			});
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
