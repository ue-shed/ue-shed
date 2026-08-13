import { randomUUID } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteControlClient, RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CameraFeed, cameraFeedLayer, configureCameras, getCameraStatus } from "./index.js";
import type { CameraStatus } from "@ue-shed/protocol";
import { inspectReviewSelection, previewReviewCandidate } from "./review-authoring-live.js";
import { captureReviewSet } from "./review-capture.js";
import { generateFramingCandidates, realizationFramingDiagnostics } from "./review-framing.js";
import { captureReviewView, getReviewAssessmentCapabilities } from "./review-live.js";
import { MapCapturePlanId } from "./map-tile-schema.js";
import {
	awaitProvisionedCameraFrame,
	clearProvisionedCameras,
	ensureProvisionedCameras
} from "./provisioned-cameras-live.js";
import {
	captureRunsRoot,
	loadReviewSet,
	ReviewRepositoryLive,
	type ReviewRepository
} from "./review-repository.js";
import {
	FramingCandidateId,
	ReviewCaptureRequest,
	ReviewCaptureRequestCurrent,
	ReviewCaptureResponse,
	ReviewViewId
} from "./review-schema.js";
import { evaluateReviewCapturePolicy } from "./review-session-policy.js";

const runReviewRepository = <A, E>(effect: Effect.Effect<A, E, ReviewRepository>) =>
	Effect.runPromise(effect.pipe(Effect.provide(ReviewRepositoryLive)));

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = join(repositoryRoot, "fixtures", "unreal-project");
const reviewSetPath = join(projectRoot, ".ue-shed", "review", "sets", "fixture-structure.json");
const subjectPath = "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject";
const translucentSubjectPath =
	"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewTranslucentSubject";
const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";
const invalidCaptureRequestPath = join(
	repositoryRoot,
	"packages/protocol/contracts/cameras/review/v1/fixtures/invalid-capture-request-bad-fov.json"
);

type NaturalCaptureRequestInput = Omit<
	typeof ReviewCaptureRequestCurrent.Type,
	"clearCompanion" | "contract"
>;

function naturalCaptureRequest(request: NaturalCaptureRequestInput) {
	return ReviewCaptureRequestCurrent.make({
		...request,
		clearCompanion: { status: "not_requested" },
		contract: {
			name: "ue-shed-review-capture",
			version: { major: 1, minor: 4 }
		}
	});
}

function pureStagingPath(
	response: Extract<ReviewCaptureResponse, { readonly status: "captured" }>
) {
	if (!("stagedArtifacts" in response)) return response.stagingPath;
	const artifact = response.stagedArtifacts.find((candidate) => candidate.variant === "pure");
	if (artifact === undefined)
		throw new Error("The editor response omitted staged Pure evidence.");
	return artifact.stagingPath;
}

async function editorActorCall(
	functionName: string,
	parameters: Readonly<Record<string, unknown>>
): Promise<void> {
	const response = await fetch(`${endpoint}/remote/object/call`, {
		body: JSON.stringify({
			functionName,
			generateTransaction: false,
			objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
			parameters
		}),
		headers: { "content-type": "application/json" },
		method: "PUT",
		signal: AbortSignal.timeout(10_000)
	});
	expect(response.ok).toBe(true);
}

describe.skipIf(!endpoint)("real Unreal target and area capture", () => {
	it("reports optional assessment capabilities without choosing consumer policy", async () => {
		const capabilities = await Effect.runPromise(
			getReviewAssessmentCapabilities(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
		);
		expect(capabilities.contract).toEqual({
			name: "ue-shed-review-assessment-capabilities",
			version: { major: 1, minor: 0 }
		});
		expect(capabilities.depthCompareMaximumResolution).toEqual({ height: 180, width: 320 });
		expect(capabilities.methods).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					effectiveMethod: { method: "depth_compare", version: 1 },
					requestedMethod: "automatic",
					status: "supported"
				}),
				expect.objectContaining({
					effectiveMethod: { method: "ray_samples", version: 1 },
					requestedMethod: "ray_samples",
					status: "supported"
				}),
				expect.objectContaining({
					requestedMethod: "subject_mask",
					status: "unsupported"
				})
			])
		);
	});

	it("records bounded depth-assessment cost across supported capture resolutions", async () => {
		const stagingPaths: string[] = [];
		try {
			for (const resolution of [
				{ height: 360, width: 640 },
				{ height: 1_080, width: 1_920 }
			]) {
				const response = await Effect.runPromise(
					captureReviewView({
						endpoint: endpoint!,
						request: naturalCaptureRequest({
							assessment: { method: "automatic" },
							expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							operationId: randomUUID(),
							resolution,
							subject: { actorPath: subjectPath, kind: "actor_path" },
							viewId: ReviewViewId.make(`depth-cost-${resolution.width}`),
							viewpoint: {
								approvedPose: {
									aspectRatio: "16:9",
									fieldOfViewDegrees: 60,
									location: { x: -1000, y: 0, z: 600 },
									projection: "perspective",
									rotation: { pitch: -25, roll: 0, yaw: 0 }
								},
								kind: "world_fixed"
							}
						})
					}).pipe(Effect.provide(RemoteControlClientLive))
				);
				expect(response.status).toBe("captured");
				if (response.status !== "captured" || !("resolvedSubject" in response)) continue;
				stagingPaths.push(pureStagingPath(response));
				expect(response.visibility).toMatchObject({
					method: { method: "depth_compare", version: 1 },
					status: "assessed"
				});
				if (response.visibility.status !== "assessed") continue;
				expect(response.visibility.assessmentDurationMs).toBeGreaterThanOrEqual(0);
				expect(response.visibility.sampleCount).toBeGreaterThan(0);
				expect(response.visibility.sampleCount).toBeLessThanOrEqual(320 * 180);
			}
		} finally {
			await Promise.all(stagingPaths.map((path) => unlink(path).catch(() => undefined)));
		}
	});

	it("realizes target-relative actors and fixed oriented areas with visibility evidence", async () => {
		const stagingPaths: string[] = [];
		try {
			const relative = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "ray_samples", samplePreset: "standard" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-follow"),
						viewpoint: {
							kind: "target_relative",
							relativePose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 60,
								location: { x: 1000, y: 1000, z: 460 },
								projection: "perspective",
								rotation: { pitch: -15, roll: 0, yaw: -135 }
							},
							targetSnapshot: {
								location: { x: 0, y: 0, z: 140 },
								rotation: { pitch: 0, roll: 0, yaw: 0 }
							}
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(relative.status).toBe("captured");
			if (relative.status !== "captured" || !("resolvedSubject" in relative)) return;
			stagingPaths.push(pureStagingPath(relative));
			expect(relative.effectiveWorldPose.location).toEqual({ x: 1000, y: 1000, z: 600 });
			expect(relative.resolvedSubject).toMatchObject({
				actorPath: subjectPath,
				kind: "actor_path",
				transform: { location: { x: 0, y: 0, z: 140 } }
			});
			expect(relative.visibility).toMatchObject({
				method: { method: "ray_samples", version: 1 },
				sampleCount: 9,
				status: "assessed"
			});
			expect(relative.visibility).not.toHaveProperty("classification");

			const depth = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-depth"),
						viewpoint: {
							approvedPose: relative.effectiveWorldPose,
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(depth.status).toBe("captured");
			if (depth.status !== "captured" || !("resolvedSubject" in depth)) return;
			stagingPaths.push(pureStagingPath(depth));
			expect(depth.visibility).toMatchObject({
				method: { method: "depth_compare", version: 1 },
				status: "assessed"
			});
			if (depth.visibility.status === "assessed") {
				expect(depth.visibility.sampleCount).toBeGreaterThan(0);
				expect(depth.visibility.sampleCount).toBeLessThan(320 * 180);
				expect(depth.visibility.visibleFraction).toBeGreaterThan(0.75);
				expect(depth.visibility.visibleFraction).toBeLessThan(0.9);
			}
			expect(depth.visibility).not.toHaveProperty("classification");

			const unoccludedDepth = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-depth-unoccluded"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 60,
								location: { x: -1000, y: 0, z: 600 },
								projection: "perspective",
								rotation: { pitch: -25, roll: 0, yaw: 0 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(unoccludedDepth.status).toBe("captured");
			if (unoccludedDepth.status !== "captured" || !("resolvedSubject" in unoccludedDepth)) {
				return;
			}
			stagingPaths.push(pureStagingPath(unoccludedDepth));
			expect(unoccludedDepth.visibility).toMatchObject({
				method: { method: "depth_compare", version: 1 },
				status: "assessed"
			});
			if (unoccludedDepth.visibility.status === "assessed") {
				expect(unoccludedDepth.visibility.sampleCount).toBeGreaterThan(0);
				expect(unoccludedDepth.visibility.sampleCount).toBeLessThan(320 * 180);
				expect(unoccludedDepth.visibility.visibleFraction).toBeGreaterThan(0.9);
				expect(unoccludedDepth.visibility.visibleFraction).toBeLessThanOrEqual(1);
			}
			expect(unoccludedDepth.visibility).not.toHaveProperty("classification");

			const fullyOccludedDepth = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-depth-fully-occluded"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 35,
								location: { x: 600, y: -400, z: 180 },
								projection: "perspective",
								rotation: { pitch: -3, roll: 0, yaw: 146.3 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(fullyOccludedDepth.status).toBe("captured");
			if (
				fullyOccludedDepth.status !== "captured" ||
				!("resolvedSubject" in fullyOccludedDepth)
			) {
				return;
			}
			stagingPaths.push(pureStagingPath(fullyOccludedDepth));
			expect(fullyOccludedDepth.visibility).toMatchObject({
				method: { method: "depth_compare", version: 1 },
				status: "assessed"
			});
			if (fullyOccludedDepth.visibility.status === "assessed") {
				expect(fullyOccludedDepth.visibility.sampleCount).toBeGreaterThan(0);
				expect(fullyOccludedDepth.visibility.sampleCount).toBeLessThan(320 * 180);
				expect(fullyOccludedDepth.visibility.visibleFraction).toBeLessThanOrEqual(0.01);
			}
			expect(fullyOccludedDepth.visibility).not.toHaveProperty("classification");

			const areaBounds = {
				center: { x: 0, y: 0, z: 212 },
				extent: { x: 393.75, y: 168, z: 252 },
				rotation: { pitch: 0, roll: 0, yaw: 25 }
			};
			const area = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { bounds: areaBounds, kind: "oriented_bounds" },
						viewId: ReviewViewId.make("loading-area"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 60,
								location: { x: 1000, y: 1000, z: 600 },
								projection: "perspective",
								rotation: { pitch: -15, roll: 0, yaw: -135 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(area.status).toBe("captured");
			if (area.status !== "captured" || !("resolvedSubject" in area)) return;
			stagingPaths.push(pureStagingPath(area));
			expect(area.resolvedSubject).toEqual({ bounds: areaBounds, kind: "oriented_bounds" });
			expect(area.subjectProjection.status).toBe("projected");
			expect(area.visibility).toMatchObject({
				status: "not_assessed"
			});
			expect(area.mapPackageDirtyAfter).toBe(area.mapPackageDirtyBefore);
		} finally {
			await Promise.all(stagingPaths.map((path) => unlink(path).catch(() => undefined)));
		}
	});

	it("does not fabricate current visibility evidence for an unprojectable subject", async () => {
		let stagingPath: string | undefined;
		try {
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-depth-unprojectable"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 60,
								location: { x: 0, y: 0, z: 140 },
								projection: "perspective",
								rotation: { pitch: 0, roll: 0, yaw: 0 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured" || !("resolvedSubject" in response)) return;
			stagingPath = pureStagingPath(response);
			expect(response.subjectProjection).toMatchObject({
				code: "behind_camera",
				status: "unprojectable"
			});
			expect(response.visibility).toMatchObject({ status: "not_assessed" });
			expect(response.visibility).not.toHaveProperty("visibleFraction");
		} finally {
			if (stagingPath !== undefined) await unlink(stagingPath).catch(() => undefined);
		}
	});

	it("fails a missing current subject before visibility assessment", async () => {
		const response = await Effect.runPromise(
			captureReviewView({
				endpoint: endpoint!,
				request: naturalCaptureRequest({
					assessment: { method: "automatic" },
					expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
					operationId: randomUUID(),
					resolution: { height: 360, width: 640 },
					subject: {
						actorPath:
							"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.MissingReviewSubject",
						kind: "actor_path"
					},
					viewId: ReviewViewId.make("missing-review-subject"),
					viewpoint: {
						approvedPose: {
							aspectRatio: "16:9",
							fieldOfViewDegrees: 60,
							location: { x: 1000, y: 1000, z: 600 },
							projection: "perspective",
							rotation: { pitch: -15, roll: 0, yaw: -135 }
						},
						kind: "world_fixed"
					}
				})
			}).pipe(Effect.provide(RemoteControlClientLive))
		);
		expect(response).toMatchObject({
			code: "subject_not_found",
			status: "failed"
		});
		expect(response).not.toHaveProperty("visibility");
	});

	it("does not fabricate current visibility evidence for an offscreen subject", async () => {
		let stagingPath: string | undefined;
		try {
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: subjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("structure-depth-offscreen"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 5,
								location: { x: -1000, y: 0, z: 600 },
								projection: "perspective",
								rotation: { pitch: -25, roll: 0, yaw: 30 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured" || !("resolvedSubject" in response)) return;
			stagingPath = pureStagingPath(response);
			expect(response.subjectProjection).toMatchObject({
				status: "projected",
				viewportStatus: "fully_outside_viewport"
			});
			expect(response.visibility).toMatchObject({ status: "not_assessed" });
			expect(response.visibility).not.toHaveProperty("visibleFraction");
		} finally {
			if (stagingPath !== undefined) await unlink(stagingPath).catch(() => undefined);
		}
	});

	it("reports unavailable depth evidence for a translucent subject", async () => {
		let stagingPath: string | undefined;
		try {
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: naturalCaptureRequest({
						assessment: { method: "automatic" },
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: { actorPath: translucentSubjectPath, kind: "actor_path" },
						viewId: ReviewViewId.make("translucent-subject-depth"),
						viewpoint: {
							approvedPose: {
								aspectRatio: "16:9",
								fieldOfViewDegrees: 60,
								location: { x: -1000, y: -1600, z: 600 },
								projection: "perspective",
								rotation: { pitch: -25, roll: 0, yaw: 0 }
							},
							kind: "world_fixed"
						}
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured" || !("resolvedSubject" in response)) return;
			stagingPath = pureStagingPath(response);
			expect(response.subjectProjection).toMatchObject({ status: "projected" });
			expect(response.visibility).toMatchObject({
				failure: { code: "subject_depth_unavailable", retrySafe: false },
				status: "assessment_failed"
			});
			expect(response.visibility).not.toHaveProperty("visibleFraction");
		} finally {
			if (stagingPath !== undefined) await unlink(stagingPath).catch(() => undefined);
		}
	});
});

describe.skipIf(!endpoint)("real Unreal Map Review capture", () => {
	it("captures one immutable Pure view without changing map dirty state", async () => {
		const run = await runReviewRepository(
			captureReviewSet({ endpoint: endpoint!, projectRoot, reviewSetPath })
		);
		try {
			expect(run.status).toBe("completed");
			expect(run.contract.version).toEqual({ major: 1, minor: 4 });
			expect(run.results).toHaveLength(1);
			const result = run.results[0]!;
			expect(result.status).toBe("captured");
			if (result.status !== "captured") return;
			expect(result.visibility).not.toHaveProperty("classification");
			expect(result.realization.status).toBe("resolved");
			if (result.realization.status !== "resolved") return;
			expect(result.realization.resolvedSubject).toMatchObject({
				kind: "actor_path",
				actorPath:
					"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject"
			});
			const bytes = await readFile(
				join(captureRunsRoot(projectRoot), run.id, result.artifacts[0]!.relativePath)
			);
			expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		} finally {
			await rm(join(captureRunsRoot(projectRoot), run.id), {
				force: true,
				recursive: true
			});
		}
	});

	it("keeps Pure when an optional Clear companion succeeds or fails", async () => {
		const stagingPaths: string[] = [];
		const makeRequest = (args: {
			readonly operationId: string;
			readonly clearCompanion: (typeof ReviewCaptureRequestCurrent.Type)["clearCompanion"];
		}) =>
			ReviewCaptureRequestCurrent.make({
				assessment: { method: "automatic" },
				clearCompanion: args.clearCompanion,
				contract: {
					name: "ue-shed-review-capture",
					version: { major: 1, minor: 4 }
				},
				expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
				operationId: args.operationId,
				resolution: { height: 360, width: 640 },
				subject: { actorPath: subjectPath, kind: "actor_path" },
				viewId: ReviewViewId.make(`clear-${args.operationId}`),
				viewpoint: {
					approvedPose: {
						aspectRatio: "16:9",
						fieldOfViewDegrees: 60,
						location: { x: 1000, y: 1000, z: 600 },
						projection: "perspective",
						rotation: { pitch: -15, roll: 0, yaw: -135 }
					},
					kind: "world_fixed"
				}
			});
		try {
			const explicit = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: makeRequest({
						clearCompanion: {
							actors: [
								"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewOccluder"
							],
							status: "requested",
							strategy: "hide_explicit"
						},
						operationId: randomUUID()
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(explicit.status).toBe("captured");
			if (explicit.status !== "captured" || !("stagedArtifacts" in explicit)) return;
			stagingPaths.push(...explicit.stagedArtifacts.map((artifact) => artifact.stagingPath));
			expect(explicit.clearCompanion).toMatchObject({
				interventions: [
					{
						target: { actorPath: expect.stringContaining("ReviewOccluder") },
						type: "hide_actor_components"
					}
				],
				restoration: { status: "restored" },
				status: "captured",
				strategy: "hide_explicit"
			});
			const explicitImages = await Promise.all(
				explicit.stagedArtifacts.map(async (artifact) => ({
					bytes: await readFile(artifact.stagingPath),
					variant: artifact.variant
				}))
			);
			const pure = explicitImages.find((artifact) => artifact.variant === "pure")?.bytes;
			const clear = explicitImages.find((artifact) => artifact.variant === "clear")?.bytes;
			expect(pure).toBeDefined();
			expect(clear).toBeDefined();
			expect(pure).not.toEqual(clear);
			expect(explicit.mapPackageDirtyAfter).toBe(explicit.mapPackageDirtyBefore);

			const isolated = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: makeRequest({
						clearCompanion: {
							status: "requested",
							strategy: "isolate_target"
						},
						operationId: randomUUID()
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(isolated.status).toBe("captured");
			if (isolated.status !== "captured" || !("stagedArtifacts" in isolated)) return;
			stagingPaths.push(...isolated.stagedArtifacts.map((artifact) => artifact.stagingPath));
			expect(isolated.clearCompanion).toMatchObject({
				interventions: [
					{
						subject: { actorPath: subjectPath },
						type: "show_only_subject_components"
					}
				],
				restoration: { status: "restored" },
				status: "captured",
				strategy: "isolate_target"
			});
			expect(isolated.mapPackageDirtyAfter).toBe(isolated.mapPackageDirtyBefore);

			const missing = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: makeRequest({
						clearCompanion: {
							actors: [
								"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.MissingClearActor"
							],
							status: "requested",
							strategy: "hide_explicit"
						},
						operationId: randomUUID()
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(missing.status).toBe("captured");
			if (missing.status !== "captured" || !("stagedArtifacts" in missing)) return;
			stagingPaths.push(...missing.stagedArtifacts.map((artifact) => artifact.stagingPath));
			expect(missing.stagedArtifacts).toEqual([expect.objectContaining({ variant: "pure" })]);
			expect(missing.clearCompanion).toMatchObject({
				failure: { code: "clear_actor_not_found", retrySafe: true },
				restoration: { status: "restored" },
				status: "failed"
			});
			expect(missing.mapPackageDirtyAfter).toBe(missing.mapPackageDirtyBefore);
		} finally {
			await Promise.all(stagingPaths.map((path) => unlink(path).catch(() => undefined)));
		}
	});

	it("serializes invalid capture requests as contract-shaped failures", async () => {
		const request = JSON.parse(await readFile(invalidCaptureRequestPath, "utf8")) as unknown;
		const payload = await Effect.runPromise(
			Effect.flatMap(RemoteControlClient, (client) =>
				client.request({
					endpoint: endpoint!,
					functionName: "CaptureReviewView",
					objectPath: reviewLibraryPath,
					operation: "camera.review.capture.contract",
					parameters: { RequestJson: JSON.stringify(request) }
				})
			).pipe(Effect.provide(RemoteControlClientLive))
		);
		const decoded = Schema.decodeUnknownSync(ReviewCaptureResponse)(payload);
		expect(decoded).toMatchObject({
			code: "invalid_pose",
			status: "failed"
		});
	});

	it("inspects the selected subject and renders a generated candidate transiently", async () => {
		await editorActorCall("SetActorSelectionState", {
			Actor: subjectPath,
			bShouldBeSelected: true
		});
		try {
			const selection = await Effect.runPromise(
				inspectReviewSelection(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(selection.status).toBe("selected");
			if (selection.status !== "selected") return;
			expect(selection).toMatchObject({
				actorPath: subjectPath,
				bounds: { center: { z: 212 }, extent: { x: 393.75, y: 168, z: 252 } },
				mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
			});
			const candidates = generateFramingCandidates(selection);
			expect(candidates.length).toBeGreaterThanOrEqual(6);
			const reviewSet = await runReviewRepository(loadReviewSet(reviewSetPath));
			const preview = await Effect.runPromise(
				previewReviewCandidate({
					candidate: candidates[0]!,
					endpoint: endpoint!,
					mapPath: selection.mapPath,
					profile: {
						...reviewSet.captureProfiles[0]!,
						resolution: { height: 360, width: 640 }
					},
					subject: {
						actorPath: selection.actorPath,
						displayName: selection.displayName
					}
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect({ height: preview.height, width: preview.width }).toEqual({
				height: 360,
				width: 640
			});
			expect([...preview.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(preview.projection.status).toBe("projected");
			if (preview.projection.status !== "projected") return;
			expect(Number.isFinite(preview.projection.normalizedBounds.minX)).toBe(true);
			expect(Number.isFinite(preview.projection.normalizedBounds.maxY)).toBe(true);
			expect(preview.projection.viewportStatus).toBe("fully_within_viewport");
			expect(
				realizationFramingDiagnostics({
					projection: preview.projection,
					requestedMargin: candidates[0]!.recipe.margin
				}).some((diagnostic) => diagnostic.severity === "warning")
			).toBe(false);
		} finally {
			await editorActorCall("SelectNothing", {});
		}
	});

	it("returns truthful unprojectable evidence for a deliberately poor pose", async () => {
		await editorActorCall("SetActorSelectionState", {
			Actor: subjectPath,
			bShouldBeSelected: true
		});
		let stagingPath: string | undefined;
		try {
			const selection = await Effect.runPromise(
				inspectReviewSelection(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(selection.status).toBe("selected");
			if (selection.status !== "selected") return;
			const candidate = generateFramingCandidates(selection)[0]!;
			const response = await Effect.runPromise(
				captureReviewView({
					endpoint: endpoint!,
					request: ReviewCaptureRequest.make({
						approvedPose: {
							...candidate.approvedPose,
							location: {
								x: selection.bounds.center.x,
								y: selection.bounds.center.y,
								z: selection.bounds.center.z
							},
							rotation: { pitch: 0, roll: 0, yaw: 0 }
						},
						contract: {
							name: "ue-shed-review-capture",
							version: { major: 1, minor: 1 }
						},
						expectedMapPath: selection.mapPath,
						operationId: randomUUID(),
						resolution: { height: 360, width: 640 },
						subject: {
							actorPath: selection.actorPath,
							diagnosticLabel: selection.displayName,
							kind: "actor_path"
						},
						viewId: ReviewViewId.make("deliberately-poor-pose")
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured") return;
			stagingPath = pureStagingPath(response);
			expect(response.contract.version.minor).toBe(1);
			expect(response.subjectProjection).toBeDefined();
			expect(response.subjectProjection).toMatchObject({ status: "unprojectable" });
			expect(response.mapPackageDirtyAfter).toBe(response.mapPackageDirtyBefore);
			const bytes = await readFile(pureStagingPath(response));
			expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
			expect(
				realizationFramingDiagnostics({
					projection: response.subjectProjection!,
					requestedMargin: candidate.recipe.margin
				})[0]?.severity
			).toBe("warning");
		} finally {
			if (stagingPath !== undefined) await unlink(stagingPath).catch(() => undefined);
			await editorActorCall("SelectNothing", {});
		}
	});
});

describe.skipIf(!endpoint)("real Unreal provisioned cameras", () => {
	const playSessionPath = "/Script/UEShedCoreEditor.Default__UEShedEditorPlaySessionLibrary";
	const scopes: Scope.Closeable[] = [];

	afterEach(async () => {
		await Promise.all(
			scopes
				.splice(0)
				.map((scope) => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))
		);
	});

	async function playCall(functionName: string): Promise<unknown> {
		return Effect.runPromise(
			Effect.flatMap(RemoteControlClient, (client) =>
				client.request({
					endpoint: endpoint!,
					functionName,
					objectPath: playSessionPath,
					operation: `camera.review.preview.${functionName}`,
					parameters: {},
					timeout: "15 seconds"
				})
			).pipe(Effect.provide(RemoteControlClientLive))
		);
	}

	async function waitForPlayStatus(status: "stopped" | "running"): Promise<void> {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			const response = (await playCall("GetPlaySessionState")) as {
				readonly state?: { readonly status?: string };
			};
			if (response.state?.status === status) return;
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		throw new Error(`Play session did not reach ${status}`);
	}

	it("streams a map-correlated orthographic editor frame", async () => {
		const initial = (await playCall("GetPlaySessionState")) as {
			readonly state?: { readonly status?: string };
		};
		if (initial.state?.status !== "stopped") {
			await playCall("StopPlaySession");
			await waitForPlayStatus("stopped");
		}

		const scope = await Effect.runPromise(Scope.make());
		scopes.push(scope);
		const feedContext = await Effect.runPromise(
			Layer.buildWithScope(cameraFeedLayer({ capacity: 4 }), scope)
		);
		const feed = Context.get(feedContext, CameraFeed);

		try {
			const bindings = await Effect.runPromise(
				ensureProvisionedCameras(
					endpoint!,
					[
						{
							correlation: {
								mapCapturePlanId: MapCapturePlanId.make("fixture-overview"),
								type: "map_capture_plan"
							},
							height: 360,
							location: { x: 0, y: 0, z: 5000 },
							projection: {
								orthoWidth: (4096 * 16) / 9,
								type: "orthographic"
							},
							rotation: { pitch: -90, roll: 0, yaw: 0 },
							width: 640
						}
					],
					{
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						previewFps: 5
					}
				).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(bindings).toHaveLength(1);
			expect(bindings[0]).toMatchObject({
				correlation: {
					mapCapturePlanId: "fixture-overview",
					type: "map_capture_plan"
				},
				height: 360,
				previewContext: "editor_live",
				width: 640
			});
			const frame = await Effect.runPromise(
				awaitProvisionedCameraFrame({
					cameraIndex: bindings[0]!.index,
					expectedCameraId: bindings[0]!.cameraId,
					latestFrames: feed.latestFrames,
					timeout: "12 seconds"
				})
			);
			expect(frame.pixels.byteLength).toBe(640 * 360 * 4);
		} finally {
			await Effect.runPromise(
				clearProvisionedCameras(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
		}
	});

	it("streams editor and play worlds, clears without dirt, and keeps overview healthy", async () => {
		const initial = (await playCall("GetPlaySessionState")) as {
			readonly state?: { readonly status?: string };
		};
		if (initial.state?.status !== "stopped") {
			await playCall("StopPlaySession");
			await waitForPlayStatus("stopped");
		}

		const scope = await Effect.runPromise(Scope.make());
		scopes.push(scope);
		const feedContext = await Effect.runPromise(
			Layer.buildWithScope(cameraFeedLayer({ capacity: 16 }), scope)
		);
		const feed = Context.get(feedContext, CameraFeed);
		const sources = [
			{
				correlation: {
					candidateId: FramingCandidateId.make("context_three_quarter"),
					type: "framing_candidate" as const
				},
				height: 180,
				location: { x: 1200, y: -1400, z: 700 },
				projection: { fieldOfViewDegrees: 60, type: "perspective" as const },
				rotation: { pitch: -18, roll: 0, yaw: 140 },
				width: 320
			},
			{
				correlation: {
					candidateId: FramingCandidateId.make("facade_front"),
					type: "framing_candidate" as const
				},
				height: 180,
				location: { x: 0, y: -1600, z: 450 },
				projection: { fieldOfViewDegrees: 55, type: "perspective" as const },
				rotation: { pitch: -10, roll: 0, yaw: 90 },
				width: 320
			}
		] as const;

		try {
			const editorBindings = await Effect.runPromise(
				ensureProvisionedCameras(endpoint!, sources, {
					expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
					previewFps: 5
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(editorBindings.map((binding) => binding.previewContext)).toEqual([
				"editor_live",
				"editor_live"
			]);
			const editorFrame = await Effect.runPromise(
				awaitProvisionedCameraFrame({
					cameraIndex: editorBindings[0]!.index,
					expectedCameraId: editorBindings[0]!.cameraId,
					latestFrames: feed.latestFrames,
					timeout: "12 seconds"
				})
			);
			expect(editorFrame.pixels.byteLength).toBe(320 * 180 * 4);
			const adjustedEditorBindings = await Effect.runPromise(
				ensureProvisionedCameras(
					endpoint!,
					[{ ...sources[0], location: { ...sources[0].location, x: 1300 } }, sources[1]],
					{
						expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
						previewFps: 5
					}
				).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(adjustedEditorBindings[0]?.cameraId).not.toBe(editorBindings[0]?.cameraId);
			expect(adjustedEditorBindings[1]?.cameraId).toBe(editorBindings[1]?.cameraId);
			const adjustedEditorFrame = await Effect.runPromise(
				awaitProvisionedCameraFrame({
					cameraIndex: adjustedEditorBindings[0]!.index,
					expectedCameraId: adjustedEditorBindings[0]!.cameraId,
					latestFrames: feed.latestFrames,
					timeout: "12 seconds"
				})
			);
			expect(adjustedEditorFrame.pixels.byteLength).toBe(320 * 180 * 4);
			await Effect.runPromise(
				clearProvisionedCameras(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);

			await playCall("StartPlaySession");
			await waitForPlayStatus("running");

			const playState = (await playCall("GetPlaySessionState")) as {
				readonly state: Parameters<typeof evaluateReviewCapturePolicy>[0];
			};
			expect(evaluateReviewCapturePolicy(playState.state)).toMatchObject({
				code: "play_session_active",
				status: "blocked"
			});

			const bindings = await Effect.runPromise(
				ensureProvisionedCameras(endpoint!, sources, {
					expectedMapPath: "/Game/Fixture/Cameras/L_CameraLoad",
					previewFps: 5
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(bindings).toHaveLength(2);
			expect(bindings.every((binding) => binding.previewContext === "play_live")).toBe(true);
			expect(
				bindings
					.map((item) =>
						item.correlation.type === "framing_candidate"
							? item.correlation.candidateId
							: undefined
					)
					.sort()
			).toEqual(["context_three_quarter", "facade_front"]);

			const statusWhileLive = await Effect.runPromise(
				getCameraStatus(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(statusWhileLive.config.viewMode).toBe("posed");
			expect(statusWhileLive.cameras).toHaveLength(2);

			const liveFrames = await Effect.runPromise(
				Effect.gen(function* () {
					const first = yield* awaitProvisionedCameraFrame({
						cameraIndex: bindings[0]!.index,
						expectedCameraId: bindings[0]!.cameraId,
						latestFrames: feed.latestFrames,
						timeout: "12 seconds"
					});
					const second = yield* awaitProvisionedCameraFrame({
						cameraIndex: bindings[1]!.index,
						expectedCameraId: bindings[1]!.cameraId,
						latestFrames: feed.latestFrames,
						timeout: "12 seconds"
					});
					return [first, second] as const;
				})
			);
			for (const frame of liveFrames) {
				expect(frame.width).toBe(320);
				expect(frame.height).toBe(180);
				expect(frame.pixels.byteLength).toBe(320 * 180 * 4);
			}

			await Effect.runPromise(
				clearProvisionedCameras(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);

			const clearedDeadline = Date.now() + 10_000;
			let overviewStatus: CameraStatus | undefined;
			while (Date.now() < clearedDeadline) {
				overviewStatus = await Effect.runPromise(
					getCameraStatus(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
				);
				if (
					overviewStatus.cameras.length > 0 &&
					overviewStatus.cameras.every((camera) => camera.candidateId === undefined)
				) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			expect(overviewStatus).toBeDefined();
			expect(overviewStatus!.cameras.length).toBeGreaterThan(0);

			const overview = await Effect.runPromise(
				configureCameras(endpoint!, {
					activeCameraCount: Math.min(8, overviewStatus!.cameras.length),
					backgroundFps: 2,
					captureBudgetPerTick: 2,
					focusedCameraIndex: 0,
					focusedFps: 8,
					paused: false,
					pipelineMode: "full_pipeline",
					renderProfile: "observation",
					resolution: "320x180",
					viewMode: "overview"
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(overview.config.viewMode).toBe("overview");

			const overviewFrame = await Effect.runPromise(
				awaitProvisionedCameraFrame({
					cameraIndex: overview.cameras[0]!.index,
					latestFrames: feed.latestFrames,
					timeout: "12 seconds"
				})
			);
			expect(overviewFrame.pixels.byteLength).toBeGreaterThan(0);

			const actorPov = await Effect.runPromise(
				configureCameras(endpoint!, {
					activeCameraCount: overview.config.activeCameraCount,
					backgroundFps: overview.config.backgroundFps,
					captureBudgetPerTick: overview.config.captureBudgetPerTick,
					focusedCameraIndex: overview.config.focusedCameraIndex,
					focusedFps: overview.config.focusedFps,
					paused: overview.config.paused,
					pipelineMode: overview.config.pipelineMode,
					renderProfile: overview.config.renderProfile,
					resolution: overview.config.resolution,
					viewMode: "actor_pov"
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(actorPov.config.viewMode).toBe("actor_pov");
			const actorPovFrame = await Effect.runPromise(
				awaitProvisionedCameraFrame({
					cameraIndex: actorPov.cameras[0]!.index,
					latestFrames: feed.latestFrames,
					timeout: "12 seconds"
				})
			);
			expect(actorPovFrame.pixels.byteLength).toBeGreaterThan(0);
		} finally {
			await playCall("StopPlaySession").catch(() => undefined);
			await waitForPlayStatus("stopped").catch(() => undefined);
		}
	}, 120_000);
});
