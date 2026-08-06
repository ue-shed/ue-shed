import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeReviewSet, VisibilityPolicyId, type ReviewSet } from "./review-schema.js";
import {
	applyVisibilityPolicyToViews,
	inspectReviewVisibilityPolicies,
	replaceViewVisibilityPolicy
} from "./review-visibility-policy.js";

function fixtureReviewSet(): ReviewSet {
	return Effect.runSync(
		decodeReviewSet({
			captureProfiles: [
				{
					id: "fixture-hd",
					imageFormat: "png",
					renderProfile: "full_fidelity",
					resolution: { height: 720, width: 1280 },
					variantPolicy: "pure_only"
				}
			],
			contract: { name: "ue-shed-review-set", version: { major: 1, minor: 1 } },
			displayName: "Policy fixture",
			id: "policy-fixture",
			project: { id: "fixture", mapPath: "/Game/Fixture/L_Policy" },
			views: ["view-a", "view-b"].map((id) => ({
				captureProfileId: "fixture-hd",
				displayName: id,
				framingRecipe: { kind: "manual", version: 1 },
				id,
				purpose: "Policy operation test",
				revision: { id: `${id}-r1`, number: 1, status: "numbered" },
				tags: [],
				target: {
					kind: "actor",
					subject: { actorPath: `/Game/Fixture/L_Policy.${id}`, kind: "actor_path" }
				},
				viewpoint: {
					approvedPose: {
						aspectRatio: "16:9",
						fieldOfViewDegrees: 60,
						location: { x: 1, y: 2, z: 3 },
						projection: "perspective",
						rotation: { pitch: 0, roll: 0, yaw: 0 }
					},
					kind: "world_fixed"
				},
				visibilityPolicyId: "natural"
			})),
			visibilityPolicies: [
				{
					assessment: { method: "automatic" },
					id: "natural",
					name: "Natural",
					onLowVisibility: { action: "record" },
					output: { mode: "natural_only" }
				}
			]
		})
	);
}

describe("Review Visibility Policy operations", () => {
	it("creates an immutable replacement and reassigns only one View", async () => {
		const original = fixtureReviewSet();
		const updated = await Effect.runPromise(
			replaceViewVisibilityPolicy({
				policy: {
					assessment: { method: "depth_compare" },
					id: VisibilityPolicyId.make("clear-v2"),
					name: "Clear v2",
					onLowVisibility: { action: "warn", threshold: 0.5 },
					output: {
						clearStrategy: { type: "isolate_target" },
						mode: "natural_and_clear"
					}
				},
				reviewSet: original,
				viewId: original.views[0]!.id
			})
		);

		expect(original.visibilityPolicies).toHaveLength(1);
		expect(updated.visibilityPolicies.map((policy) => policy.id)).toEqual([
			"natural",
			"clear-v2"
		]);
		expect(updated.views.map((view) => view.visibilityPolicyId)).toEqual([
			"clear-v2",
			"natural"
		]);
	});

	it("applies an existing preset only to the explicitly selected Views", async () => {
		const original = fixtureReviewSet();
		const withReplacement = await Effect.runPromise(
			replaceViewVisibilityPolicy({
				policy: {
					assessment: { method: "automatic" },
					id: VisibilityPolicyId.make("record-clear"),
					name: "Record Clear",
					onLowVisibility: { action: "record" },
					output: {
						clearStrategy: { type: "isolate_target" },
						mode: "natural_and_clear"
					}
				},
				reviewSet: original,
				viewId: original.views[0]!.id
			})
		);
		const updated = await Effect.runPromise(
			applyVisibilityPolicyToViews({
				policyId: VisibilityPolicyId.make("record-clear"),
				reviewSet: withReplacement,
				viewIds: [original.views[1]!.id]
			})
		);

		expect(updated.views.map((view) => view.visibilityPolicyId)).toEqual([
			"record-clear",
			"record-clear"
		]);
		expect(inspectReviewVisibilityPolicies(updated).policies[1]!.assignedViewIds).toEqual([
			"view-a",
			"view-b"
		]);
	});

	it("rejects invalid cross-policy assignments without mutating the source", async () => {
		const original = fixtureReviewSet();
		await expect(
			Effect.runPromise(
				replaceViewVisibilityPolicy({
					policy: {
						assessment: { method: "automatic" },
						id: VisibilityPolicyId.make("explicit-clear"),
						name: "Explicit Clear",
						onLowVisibility: { action: "record" },
						output: {
							clearStrategy: { type: "hide_explicit" },
							mode: "natural_and_clear"
						}
					},
					reviewSet: original,
					viewId: original.views[0]!.id
				})
			)
		).rejects.toMatchObject({ code: "invalid_assignment" });
		expect(original.visibilityPolicies).toHaveLength(1);
		expect(original.views[0]!.visibilityPolicyId).toBe("natural");
	});

	it("rejects policy ID reuse and duplicate bulk selections", async () => {
		const original = fixtureReviewSet();
		await expect(
			Effect.runPromise(
				replaceViewVisibilityPolicy({
					policy: original.visibilityPolicies[0]!,
					reviewSet: original,
					viewId: original.views[0]!.id
				})
			)
		).rejects.toMatchObject({ code: "policy_id_conflict" });
		await expect(
			Effect.runPromise(
				applyVisibilityPolicyToViews({
					policyId: original.visibilityPolicies[0]!.id,
					reviewSet: original,
					viewIds: [original.views[0]!.id, original.views[0]!.id]
				})
			)
		).rejects.toMatchObject({ code: "duplicate_view" });
	});
});
