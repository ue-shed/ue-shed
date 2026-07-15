import { describe, expect, it } from "vitest";
import {
	approveFramingCandidate,
	framingDriftDiagnostics,
	generateFramingCandidates
} from "./review-framing.js";
import { ReviewSetId, ReviewViewId, decodeReviewSet } from "./review-schema.js";

const selection = {
	actorPath: "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
	bounds: {
		center: { x: 0, y: 0, z: 250 },
		extent: { x: 600, y: 450, z: 250 },
		rotation: { pitch: 0, roll: 0, yaw: 15 }
	},
	displayName: "Review Subject",
	editorView: {
		aspectRatio: "16:9" as const,
		fieldOfViewDegrees: 72,
		location: { x: 1200, y: -900, z: 700 },
		projection: "perspective" as const,
		rotation: { pitch: -12, roll: 0, yaw: 142 }
	},
	mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
};

function reviewSet() {
	return decodeReviewSet({
		captureProfiles: [
			{
				id: "fixture-hd",
				imageFormat: "png",
				renderProfile: "full_fidelity",
				resolution: { height: 720, width: 1280 },
				variantPolicy: "pure_only"
			}
		],
		contract: { name: "ue-shed-review-set", version: { major: 1, minor: 0 } },
		displayName: "Fixture structure",
		id: ReviewSetId.make("fixture-structure"),
		project: { id: "ue-shed-fixture", mapPath: selection.mapPath },
		views: [
			{
				approvedPose: selection.editorView,
				captureProfileId: "fixture-hd",
				displayName: "Structure context",
				framingRecipe: { kind: "manual", version: 1 },
				id: ReviewViewId.make("structure-context"),
				purpose: "Track fixture structure",
				subject: { actorPath: selection.actorPath, kind: "actor_path" },
				tags: ["fixture"]
			}
		]
	});
}

describe("spatial framing", () => {
	it("generates deterministic presets plus the current editor view", () => {
		const first = generateFramingCandidates(selection);
		const second = generateFramingCandidates(selection);
		expect(first).toEqual(second);
		expect(first.map((candidate) => candidate.recipe.preset)).toEqual([
			"context_three_quarter",
			"facade_front",
			"cardinal_north",
			"cardinal_east",
			"cardinal_south",
			"cardinal_west",
			"editor_view"
		]);
		for (const candidate of first) {
			expect(Number.isFinite(candidate.approvedPose.location.x)).toBe(true);
			expect(candidate.recipe.subjectBounds).toEqual(selection.bounds);
		}
	});

	it("persists preset lineage and an explicit manual adjustment", () => {
		const candidate = generateFramingCandidates(selection)[0]!;
		const manualPose = {
			...candidate.approvedPose,
			location: {
				...candidate.approvedPose.location,
				z: candidate.approvedPose.location.z + 25
			}
		};
		const approved = approveFramingCandidate({
			candidate,
			manualPose,
			manualReason: "Raised the view above the foreground edge.",
			reviewSet: reviewSet(),
			viewId: ReviewViewId.make("structure-context")
		});
		expect(approved.status).toBe("approved");
		if (approved.status !== "approved") return;
		expect(approved.reviewSet.views[0]).toMatchObject({
			approvedPose: manualPose,
			framingRecipe: {
				kind: "preset",
				manualAdjustment: { reason: "Raised the view above the foreground edge." },
				preset: "context_three_quarter"
			}
		});
	});

	it("warns on bounds drift without moving the approved pose", () => {
		expect(
			framingDriftDiagnostics({
				approvedBounds: selection.bounds,
				currentBounds: {
					...selection.bounds,
					extent: { ...selection.bounds.extent, x: selection.bounds.extent.x + 50 }
				}
			})
		).toMatchObject([{ code: "subject_bounds_changed", severity: "warning" }]);
	});
});
