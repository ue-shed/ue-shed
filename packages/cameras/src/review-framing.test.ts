import { describe, expect, it } from "vitest";
import { Effect, Exit, Schema } from "effect";
import {
	approveFramingCandidate,
	applyCandidateOverrides,
	createAreaReviewView,
	createReviewViewFromCandidate,
	defaultFramingParameters,
	framingDriftDiagnostics,
	generateFramingCandidates,
	realizationFramingDiagnostics,
	realizeTargetRelativePose,
	reviseReviewView,
	targetRelativePoseFromWorldPose,
	targetRelativeViewpointFromWorldPose
} from "./review-framing.js";
import {
	ReviewSetId,
	CaptureProfileId,
	ReviewViewId,
	VisibilityPolicyId,
	decodeReviewSet as decodeReviewSetEffect,
	FramingParameters,
	type ReviewSubjectProjection
} from "./review-schema.js";

const decodeReviewSet = <Input>(input: Input) => Effect.runSync(decodeReviewSetEffect(input));

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
			"cardinal_orbit",
			"cardinal_orbit",
			"cardinal_orbit",
			"cardinal_orbit",
			"editor_view"
		]);
		expect(first.slice(0, 6).map((candidate) => candidate.id)).toEqual([
			"preset/context_three_quarter/1",
			"preset/facade_front/1",
			"preset/cardinal_orbit/1",
			"preset/cardinal_orbit/2",
			"preset/cardinal_orbit/3",
			"preset/cardinal_orbit/4"
		]);
		for (const candidate of first) {
			expect(Number.isFinite(candidate.approvedPose.location.x)).toBe(true);
			expect(candidate.recipe.subjectBounds).toEqual(selection.bounds);
		}
	});

	it("builds named presets from permissive arc and ring primitives", () => {
		const defaults = defaultFramingParameters();
		expect(defaults).toMatchObject({
			fieldOfViewDegrees: 60,
			groups: [
				{
					distanceScale: 1.8,
					elevation: 0.5,
					pattern: { count: 1, kind: "arc", yawOffsetDegrees: 42 }
				},
				{
					distanceScale: 1.25,
					elevation: 0.08,
					pattern: { count: 1, kind: "arc", yawOffsetDegrees: 0 }
				},
				{
					distanceScale: 1.45,
					elevation: 0.18,
					pattern: { count: 4, kind: "ring", ringOffsetDegrees: 90 }
				}
			],
			margin: 0.12
		});

		const parameters = FramingParameters.make({
			fieldOfViewDegrees: 75,
			groups: [
				{
					displayName: "Wide arc",
					distanceScale: 2,
					elevation: 0.25,
					enabled: true,
					id: defaults.groups[0]!.id,
					pattern: {
						count: 3,
						kind: "arc",
						spreadDegrees: 60,
						yawOffsetDegrees: 0
					}
				},
				{
					displayName: "Dense ring",
					distanceScale: 1.5,
					elevation: 0.1,
					enabled: true,
					id: defaults.groups[2]!.id,
					pattern: { count: 8, kind: "ring", ringOffsetDegrees: 22.5 }
				}
			],
			margin: 0.2
		});
		const candidates = generateFramingCandidates(
			{ ...selection, editorView: undefined },
			parameters
		);
		expect(candidates).toHaveLength(11);
		const locationYaw = (index: number) => {
			const location = candidates[index]!.approvedPose.location;
			return (
				(Math.atan2(
					location.y - selection.bounds.center.y,
					location.x - selection.bounds.center.x
				) *
					180) /
				Math.PI
			);
		};
		expect(locationYaw(0)).toBeCloseTo(-15, 8);
		expect(locationYaw(1)).toBeCloseTo(15, 8);
		expect(locationYaw(2)).toBeCloseTo(45, 8);
		expect(locationYaw(3)).toBeCloseTo(22.5, 8);
		expect(locationYaw(4)).toBeCloseTo(-22.5, 8);
	});

	it("does not impose a product camera cap", () => {
		const defaults = defaultFramingParameters();
		const parameters = FramingParameters.make({
			...defaults,
			groups: [
				{
					...defaults.groups[2]!,
					pattern: { count: 37, kind: "ring", ringOffsetDegrees: 0 }
				}
			]
		});
		expect(
			generateFramingCandidates({ ...selection, editorView: undefined }, parameters)
		).toHaveLength(37);
	});

	it("rejects invalid primitive counts and non-finite geometry at the boundary", () => {
		const defaults = defaultFramingParameters();
		const decode = Schema.decodeUnknownEffect(FramingParameters);
		const invalidCount = Effect.runSyncExit(
			decode({
				...defaults,
				groups: [
					{
						...defaults.groups[0],
						pattern: { count: 0, kind: "arc", spreadDegrees: 0, yawOffsetDegrees: 0 }
					}
				]
			})
		);
		const invalidDistance = Effect.runSyncExit(
			decode({
				...defaults,
				groups: [{ ...defaults.groups[0], distanceScale: Number.POSITIVE_INFINITY }]
			})
		);
		expect(Exit.isFailure(invalidCount)).toBe(true);
		expect(Exit.isFailure(invalidDistance)).toBe(true);
	});

	it("applies partial overrides to only one candidate", () => {
		const candidates = generateFramingCandidates({ ...selection, editorView: undefined });
		const target = candidates[2]!;
		const overridden = applyCandidateOverrides(target, {
			distanceScale: 2.2,
			fieldOfViewDegrees: 80,
			yawOffsetDegrees: 12
		});
		expect(overridden.id).toBe(target.id);
		expect(overridden.approvedPose).not.toEqual(target.approvedPose);
		expect(overridden.approvedPose.fieldOfViewDegrees).toBe(80);
		expect(overridden.recipe).toMatchObject({
			candidateOverrides: {
				distanceScale: 2.2,
				fieldOfViewDegrees: 80,
				yawOffsetDegrees: 12
			},
			version: 2
		});
		expect(candidates[3]).toEqual(
			generateFramingCandidates({ ...selection, editorView: undefined })[3]
		);
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
			framingRecipe: {
				kind: "preset",
				manualAdjustment: { reason: "Raised the view above the foreground edge." },
				preset: "context_three_quarter"
			},
			viewpoint: { approvedPose: manualPose, kind: "world_fixed" }
		});
		expect(approved.reviewSet.views[0]?.revision).toMatchObject({
			id: "structure-context-r2",
			number: 2,
			status: "numbered"
		});
	});

	it("derives a moved actor's target-relative effective pose without changing the durable pose", () => {
		const worldPose = selection.editorView!;
		const initialTarget = {
			location: { x: 100, y: 200, z: 300 },
			rotation: { pitch: 0, roll: 0, yaw: 90 }
		};
		const relativePose = targetRelativePoseFromWorldPose({
			targetTransform: initialTarget,
			worldPose
		});
		expect(
			targetRelativeViewpointFromWorldPose({ targetTransform: initialTarget, worldPose })
		).toMatchObject({ kind: "target_relative", relativePose, targetSnapshot: initialTarget });
		const movedTarget = {
			location: { x: 500, y: 600, z: 700 },
			rotation: { pitch: 0, roll: 0, yaw: 180 }
		};
		const realized = realizeTargetRelativePose({
			relativePose,
			targetTransform: movedTarget
		});
		expect(realized.location.x).toBeCloseTo(1600, 8);
		expect(realized.location.y).toBeCloseTo(1700, 8);
		expect(realized.location.z).toBeCloseTo(1100, 8);
		expect(realized.rotation.pitch).toBeCloseTo(-12, 8);
		expect(realized.rotation.yaw).toBeCloseTo(-128, 8);
		expect(realized.rotation.roll).toBeCloseTo(0, 8);
		expect(relativePose).toEqual(
			targetRelativePoseFromWorldPose({ targetTransform: initialTarget, worldPose })
		);
	});

	it("authors actor-following and fixed oriented-area Views as portable definitions", () => {
		const candidate = generateFramingCandidates(selection)[0]!;
		const targetTransform = {
			location: { x: 100, y: 200, z: 300 },
			rotation: { pitch: 0, roll: 0, yaw: 45 }
		};
		const following = createReviewViewFromCandidate({
			anchoring: { mode: "target_relative", targetTransform },
			candidate,
			captureProfileId: CaptureProfileId.make("fixture-hd"),
			displayName: "Following structure",
			purpose: "Retain composition as the actor moves",
			subject: {
				actorPath: selection.actorPath,
				kind: "actor_path"
			},
			tags: [],
			viewId: ReviewViewId.make("structure-follow"),
			visibilityPolicyId: VisibilityPolicyId.make("default-natural-only")
		});
		expect(following.viewpoint.kind).toBe("target_relative");
		if (following.viewpoint.kind !== "target_relative" || following.target.kind !== "actor")
			return;
		const initialRealization = realizeTargetRelativePose({
			relativePose: following.viewpoint.relativePose,
			targetTransform
		});
		expect(initialRealization.location.x).toBeCloseTo(candidate.approvedPose.location.x, 8);
		expect(initialRealization.location.y).toBeCloseTo(candidate.approvedPose.location.y, 8);
		expect(initialRealization.location.z).toBeCloseTo(candidate.approvedPose.location.z, 8);
		expect(initialRealization.rotation.pitch).toBeCloseTo(
			candidate.approvedPose.rotation.pitch,
			8
		);
		expect(initialRealization.rotation.yaw).toBeCloseTo(candidate.approvedPose.rotation.yaw, 8);
		expect(initialRealization.rotation.roll).toBeCloseTo(
			candidate.approvedPose.rotation.roll,
			8
		);

		const area = createAreaReviewView({
			approvedPose: candidate.approvedPose,
			bounds: selection.bounds,
			captureProfileId: CaptureProfileId.make("fixture-hd"),
			displayName: "Loading area",
			purpose: "Watch this place",
			tags: ["area"],
			viewId: ReviewViewId.make("loading-area"),
			visibilityPolicyId: VisibilityPolicyId.make("default-natural-only")
		});
		const base = reviewSet();
		const decoded = decodeReviewSet({ ...base, views: [following, area] });
		expect(decoded.views[1]).toMatchObject({
			target: { bounds: selection.bounds, kind: "oriented_box" },
			viewpoint: { kind: "world_fixed" }
		});

		const baseView = base.views[0]!;
		const revised = reviseReviewView({
			definition: {
				target: following.target,
				viewpoint: following.viewpoint
			},
			reviewSet: base,
			viewId: baseView.id
		});
		expect(revised.status).toBe("revised");
		if (revised.status !== "revised") return;
		expect(revised.reviewSet.views[0]?.revision).toMatchObject({
			id: "structure-context-r2",
			number: 2
		});
		const unchanged = reviseReviewView({
			definition: {
				target: following.target,
				viewpoint: following.viewpoint
			},
			reviewSet: revised.reviewSet,
			viewId: baseView.id
		});
		expect(unchanged.status).toBe("unchanged");
		if (unchanged.status === "view_not_found") return;
		expect(unchanged.reviewSet.views[0]?.revision.number).toBe(2);
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

	it("maps post-realization projection evidence to framing diagnostics", () => {
		const within: ReviewSubjectProjection = {
			margins: { bottom: 0.2, left: 0.2, right: 0.2, top: 0.2 },
			normalizedBounds: { maxX: 0.8, maxY: 0.8, minX: 0.2, minY: 0.2 },
			status: "projected",
			viewportStatus: "fully_within_viewport"
		};
		expect(
			realizationFramingDiagnostics({ projection: within, requestedMargin: 0.12 })
		).toMatchObject([{ code: "subject_framing_within_margin", severity: "info" }]);
		expect(
			realizationFramingDiagnostics({ projection: within, requestedMargin: 0.25 })
		).toMatchObject([{ code: "subject_margin_below_requested", severity: "warning" }]);
		expect(
			realizationFramingDiagnostics({
				projection: { ...within, viewportStatus: "partially_outside_viewport" },
				requestedMargin: 0.12
			})
		).toMatchObject([{ code: "subject_partially_outside_viewport", severity: "warning" }]);
		expect(
			realizationFramingDiagnostics({
				projection: { ...within, viewportStatus: "fully_outside_viewport" },
				requestedMargin: 0.12
			})
		).toMatchObject([{ code: "subject_fully_outside_viewport", severity: "warning" }]);
		expect(
			realizationFramingDiagnostics({
				projection: {
					code: "behind_camera",
					message: "Behind the transient capture camera.",
					status: "unprojectable"
				},
				requestedMargin: 0.12
			})
		).toMatchObject([{ code: "subject_behind_camera", severity: "warning" }]);
		expect(
			realizationFramingDiagnostics({
				projection: {
					code: "near_plane_crossing",
					message: "Crosses the transient capture near plane.",
					status: "unprojectable"
				},
				requestedMargin: 0.12
			})
		).toMatchObject([{ code: "subject_near_plane_crossing", severity: "warning" }]);
	});
});
