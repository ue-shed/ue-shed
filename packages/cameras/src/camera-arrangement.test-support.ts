import { Effect, Schema } from "effect";
import { CameraArrangement } from "./camera-arrangement.js";
import {
	decodeReviewSet,
	defaultNaturalOnlyVisibilityPolicy,
	VisibilityPolicyId
} from "./review-schema.js";
export function fixtureArrangement() {
	return Schema.decodeUnknownSync(CameraArrangement)({
		version: 1,
		id: "arrangement-a",
		revision: 0,
		projectName: "Fixture",
		mapPath: "/Game/Fixture",
		subject: { kind: "actor_path", actorPath: "/Game/Fixture.Fixture:PersistentLevel.Subject" },
		bounds: {
			center: { x: 0, y: 0, z: 100 },
			extent: { x: 100, y: 100, z: 100 },
			rotation: { pitch: 0, yaw: 0, roll: 0 }
		},
		settings: { fieldOfViewDegrees: 60, distanceScale: 1, heightOffset: 0, margin: 0.1 },
		cameras: Array.from({ length: 6 }, (_, index) => ({
			id: `camera-${index}`,
			viewId: `view-${index}`,
			displayName: `Camera ${index}`,
			yawDegrees: index * 60,
			overrides: {}
		})),
		retiredCameraIds: [],
		captureProfileId: "hd",
		visibilityPolicyId: "pure"
	});
}
export function fixtureSet() {
	return Effect.runSync(
		decodeReviewSet({
			contract: { name: "ue-shed-review-set", version: { major: 1, minor: 2 } },
			id: "fixture",
			displayName: "Fixture",
			project: { id: "fixture", mapPath: "/Game/Fixture" },
			captureProfiles: [
				{
					id: "hd",
					imageFormat: "png",
					renderProfile: "full_fidelity",
					resolution: { width: 1280, height: 720 },
					variantPolicy: "pure_only"
				}
			],
			visibilityPolicies: [
				{ ...defaultNaturalOnlyVisibilityPolicy(), id: VisibilityPolicyId.make("pure") }
			],
			views: []
		})
	);
}
