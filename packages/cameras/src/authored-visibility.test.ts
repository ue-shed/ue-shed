import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeReviewCaptureResponse, ReviewCaptureRequestCurrent } from "./review-schema.js";
import { mapCaptureVisibilityVariants } from "./map-capture-visibility.js";
import { MapCapturePlan } from "./map-tile-schema.js";
import { CameraFrameEvidence, legacyReviewRenderPolicy } from "./camera-render-schema.js";
const response = () =>
	Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
		JSON.parse(
			readFileSync(
				new URL(
					"../../protocol/contracts/cameras/review/v1/fixtures/capture-authored.json",
					import.meta.url
				),
				"utf8"
			)
		)
	);
describe("authored capture wire and persistence boundaries", () => {
	it("accepts actual native paired evidence and rejects missing authored evidence or policy", () => {
		const input = response();
		expect(Effect.runSync(decodeReviewCaptureResponse(input)).status).toBe("captured");
		const evidence = Schema.decodeUnknownSync(
			Schema.Struct({ authoredEvidence: CameraFrameEvidence })
		)(input).authoredEvidence;
		expect(() =>
			Effect.runSync(
				decodeReviewCaptureResponse({
					...input,
					authoredEvidence: {
						...evidence,
						policy: {
							...evidence.policy,
							visibility: {
								hide: [
									{
										label: "Different actor",
										locator: {
											kind: "actor_path",
											actorPath: "/Game/Fixture.Fixture:PersistentLevel.Other"
										}
									}
								],
								protect: []
							}
						}
					}
				})
			)
		).toThrow();
		const { authoredEvidence: _evidence, ...missingEvidence } = input;
		const { authoredVisibility: _policy, ...missingPolicy } = input;
		expect(() => Effect.runSync(decodeReviewCaptureResponse(missingEvidence))).toThrow();
		expect(() => Effect.runSync(decodeReviewCaptureResponse(missingPolicy))).toThrow();
		expect(() =>
			Effect.runSync(
				decodeReviewCaptureResponse({
					...input,
					contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 6 } }
				})
			)
		).toThrow();
	});
	it("does not allow unlabeled exclusions in a Pure render policy", () => {
		const input = response();
		const request = {
			contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 7 } },
			operationId: input.operationId,
			viewId: input.viewId,
			expectedMapPath: input.mapPath,
			subject: {
				kind: "actor_path",
				actorPath: "/Game/Fixture.Fixture:PersistentLevel.Floor"
			},
			viewpoint: { kind: "world_fixed", approvedPose: input.effectiveWorldPose },
			resolution: { width: 640, height: 360 },
			assessment: { method: "automatic" },
			clearCompanion: { status: "not_requested" },
			renderPolicy: legacyReviewRenderPolicy
		};
		expect(
			Schema.decodeUnknownSync(ReviewCaptureRequestCurrent)(request).contract.version.minor
		).toBe(7);
		expect(() =>
			Schema.decodeUnknownSync(ReviewCaptureRequestCurrent)({
				...request,
				renderPolicy: { ...legacyReviewRenderPolicy, visibility: { hide: [], protect: [] } }
			})
		).toThrow();
	});
	it("creates independent labeled map plans with shared exposure and explicit version negotiation", () => {
		const original = Schema.decodeUnknownSync(MapCapturePlan)(
			JSON.parse(
				readFileSync(
					new URL(
						"../../protocol/contracts/cameras/map-tile/v1/fixtures/plan-valid.json",
						import.meta.url
					),
					"utf8"
				)
			)
		);
		const plan = MapCapturePlan.make({
			...original,
			capture: {
				...original.capture,
				render: { ...original.capture.render, exposureEV100: 9 }
			}
		});
		const policy = {
			version: 1 as const,
			output: "natural_and_authored" as const,
			actors: {
				hide: [
					{
						label: "Column",
						locator: {
							kind: "actor_path" as const,
							actorPath: "/Game/Fixture.Fixture:PersistentLevel.Column"
						}
					}
				],
				protect: []
			}
		};
		const variants = mapCaptureVisibilityVariants(plan, policy);
		expect(variants.map((entry) => entry.variant)).toEqual(["pure", "authored"]);
		expect(variants[0]!.plan.capture.visibility).toBeUndefined();
		expect(variants[1]!.plan.capture.visibility).toEqual(policy.actors);
		expect(variants[1]!.plan.contract.version.minor).toBe(2);
		expect(plan.capture.visibility).toBeUndefined();
		expect(() =>
			MapCapturePlan.make({
				...variants[1]!.plan,
				contract: { name: "ue-shed-map-capture-plan", version: { major: 1, minor: 1 } }
			})
		).toThrow();
		const { exposureEV100: _exposure, ...automatic } = plan.capture.render;
		expect(() =>
			mapCaptureVisibilityVariants(
				{ ...plan, capture: { ...plan.capture, render: automatic } },
				policy
			)
		).toThrow("exposureEV100");
	});
});
