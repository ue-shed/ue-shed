import { randomUUID } from "node:crypto";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RemoteControlClient, RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { previewReviewCandidate } from "./review-authoring-live.js";
import { generateFramingCandidates } from "./review-framing.js";
import { captureReviewView } from "./review-live.js";
import {
	CaptureProfile,
	CaptureProfileId,
	ReviewCaptureOperationId,
	ReviewViewId,
	decodeReviewSubjectInspectionResponse,
	type ApprovedPose
} from "./review-schema.js";
import {
	CameraRenderer,
	cameraRendererLayer,
	readCameraFrameArtifact,
	renderCamera
} from "./camera-render.js";
import {
	CameraFrameOperationId,
	CameraRenderSessionId,
	cameraRenderContract,
	type AbsoluteCamera,
	type CameraRenderSessionRequest
} from "./camera-render-schema.js";

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const projectRoot = process.env.UE_SHED_RENDER_FIXTURE_ROOT;
const mapPath = "/Game/Fixture/Cameras/L_CameraLoad";
const layer = cameraRendererLayer(endpoint ?? "http://127.0.0.1:30121").pipe(
	Layer.provide(RemoteControlClientLive)
);

function request(kind: "scene_capture" | "editor_viewport"): CameraRenderSessionRequest {
	return {
		contract: cameraRenderContract,
		sessionId: CameraRenderSessionId.make(randomUUID()),
		expectedMapPath: mapPath,
		expectedProjectName: "UEShedFixture",
		leaseMs: 120000,
		maximumFrames: 8,
		policy: {
			renderer:
				kind === "scene_capture"
					? {
							kind,
							profile: "full_fidelity",
							lodDistanceScale: 1,
							fog: true,
							volumetricFog: true
						}
					: {
							kind,
							strategy: "high_resolution_screenshot",
							profile: "lit",
							vignette: "project",
							fog: true,
							volumetricFog: true
						},
			exposure: { mode: "fixed_ev100", ev100: 8, compensation: "project" },
			settling: { minimumFrames: 4, timeoutMs: 120000 },
			time: "live_editor",
			preparation: { geometry: { mode: "preserve_loading" }, dataLayers: [] }
		}
	};
}

async function actorCall(functionName: string, parameters: Schema.JsonObject) {
	const response = await fetch(`${endpoint}/remote/object/call`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			objectPath: "/Script/UnrealEd.Default__EditorActorSubsystem",
			functionName,
			generateTransaction: false,
			parameters
		})
	});
	expect(response.ok).toBe(true);
	return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
		await response.json()
	);
}
function reviewRequest(
	kind: "scene_capture" | "editor_viewport",
	actorPath: string,
	pose: ApprovedPose,
	width = 320
) {
	return {
		contract: { name: "ue-shed-review-capture", version: { major: 1, minor: 6 } } as const,
		operationId: ReviewCaptureOperationId.make(randomUUID()),
		viewId: ReviewViewId.make("independent-fixture-camera"),
		expectedMapPath: mapPath,
		subject: { kind: "actor_path" as const, actorPath },
		viewpoint: { kind: "world_fixed" as const, approvedPose: pose },
		assessment: { method: "automatic" as const },
		clearCompanion: { status: "not_requested" as const },
		resolution: { width, height: (width * 9) / 16 },
		renderPolicy: request(kind).policy
	};
}

describe.skipIf(!endpoint || !projectRoot)(
	"shared camera rendering in the generic editor fixture",
	() => {
		it.each(["scene_capture", "editor_viewport"] as const)(
			"keeps the approved camera after actual actor movement and removal (%s)",
			async (kind) => {
				const spawned = await actorCall("SpawnActorFromClass", {
					ActorClass: "/Script/Engine.StaticMeshActor",
					Location: { X: 0, Y: 0, Z: 150 },
					Rotation: { Pitch: 0, Yaw: 0, Roll: 0 },
					bTransient: true
				});
				const actorPath = Schema.decodeUnknownSync(Schema.String)(spawned.ReturnValue);
				const pose: ApprovedPose = {
					aspectRatio: "16:9",
					projection: "perspective",
					location: { x: 1000, y: 1000, z: 900 },
					rotation: { pitch: -30, yaw: -135, roll: 0 },
					fieldOfViewDegrees: 60
				};
				let removed = false;
				try {
					for (const stage of ["original", "moved", "removed"] as const) {
						if (stage === "moved")
							await actorCall("SetActorTransform", {
								InActor: actorPath,
								InWorldTransform: {
									Translation: { X: 800, Y: 900, Z: 100 },
									Rotation: { X: 0, Y: 0, Z: 0, W: 1 },
									Scale3D: { X: 1, Y: 1, Z: 1 }
								}
							});
						if (stage === "removed") {
							expect(
								(await actorCall("DestroyActor", { ActorToDestroy: actorPath }))
									.ReturnValue
							).toBe(true);
							removed = true;
						}
						const result = await Effect.runPromise(
							captureReviewView({
								endpoint: endpoint!,
								request: reviewRequest(kind, actorPath, pose)
							}).pipe(Effect.provide(RemoteControlClientLive))
						);
						expect(result.status).toBe("captured");
						if (result.status !== "captured" || !("effectiveWorldPose" in result))
							throw new Error(JSON.stringify(result));
						expect(result.effectiveWorldPose).toEqual(pose);
						expect(result.resolvedSubject.kind).toBe(
							stage === "removed" ? "unresolved_actor" : "actor_path"
						);
					}
					const fixed = reviewRequest(kind, actorPath, pose);
					const relative = await Effect.runPromise(
						captureReviewView({
							endpoint: endpoint!,
							request: {
								...fixed,
								viewpoint: {
									kind: "target_relative",
									relativePose: pose,
									targetSnapshot: {
										location: { x: 0, y: 0, z: 150 },
										rotation: { pitch: 0, yaw: 0, roll: 0 }
									}
								}
							}
						}).pipe(Effect.provide(RemoteControlClientLive))
					);
					expect(relative).toMatchObject({ status: "failed", code: "subject_not_found" });
				} finally {
					if (!removed) await actorCall("DestroyActor", { ActorToDestroy: actorPath });
				}
			},
			180000
		);
		it.each(["scene_capture", "editor_viewport"] as const)(
			"uses the same resolved policy for an authoring preview and final Review capture (%s)",
			async (kind) => {
				const actorPath = `${mapPath}.L_CameraLoad:PersistentLevel.ReviewSubject`;
				const selection = await Effect.runPromise(
					Effect.flatMap(RemoteControlClient, (client) =>
						client.request({
							endpoint: endpoint!,
							objectPath:
								"/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary",
							functionName: "InspectReviewSubject",
							parameters: { ActorPath: actorPath }
						})
					).pipe(
						Effect.flatMap(decodeReviewSubjectInspectionResponse),
						Effect.provide(RemoteControlClientLive)
					)
				);
				if (selection.status !== "selected") throw new Error(JSON.stringify(selection));
				const candidate = generateFramingCandidates(selection)[0];
				if (!candidate) throw new Error("Fixture did not produce a framing candidate.");
				const profile = CaptureProfile.make({
					id: CaptureProfileId.make("fixture-preview"),
					renderProfile: "full_fidelity",
					imageFormat: "png",
					resolution: { width: 320, height: 180 },
					renderPolicy: request(kind).policy
				});
				const preview = await Effect.runPromise(
					previewReviewCandidate({
						endpoint: endpoint!,
						candidate,
						mapPath,
						profile,
						subject: { kind: "actor_path", actorPath }
					}).pipe(Effect.provide(RemoteControlClientLive))
				);
				const final = await Effect.runPromise(
					captureReviewView({
						endpoint: endpoint!,
						request: reviewRequest(kind, actorPath, candidate.approvedPose, 640)
					}).pipe(Effect.provide(RemoteControlClientLive))
				);
				if (final.status !== "captured" || !("renderEvidence" in final))
					throw new Error(JSON.stringify(final));
				expect(preview.renderEvidence?.policy).toEqual(final.renderEvidence?.policy);
				expect(preview.renderEvidence?.camera).toEqual(final.renderEvidence?.camera);
				expect(preview.renderEvidence?.size).toEqual({ width: 320, height: 180 });
				expect(final.renderEvidence?.size).toEqual({ width: 640, height: 360 });
			},
			180000
		);
		it("rejects cross-client contention and releases a cancelled session", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const renderer = yield* CameraRenderer;
					const opened = yield* Deferred.make<void>();
					const fiber = yield* Effect.scoped(
						Effect.gen(function* () {
							yield* renderer.open(request("editor_viewport"));
							yield* Deferred.succeed(opened, undefined);
							yield* Effect.never;
						})
					).pipe(Effect.forkChild);
					yield* Deferred.await(opened);
					const contender = yield* Effect.exit(
						Effect.scoped(renderer.open(request("scene_capture")))
					);
					expect(Exit.isFailure(contender)).toBe(true);
					yield* Fiber.interrupt(fiber);
					expect(yield* renderer.preflight(request("scene_capture"))).toEqual({
						status: "ready",
						issues: []
					});
				}).pipe(Effect.provide(layer))
			);
		}, 180000);
		it.each(["scene_capture", "editor_viewport"] as const)(
			"captures a fixed Review camera with unavailable provenance through %s",
			async (kind) => {
				const pose = {
					aspectRatio: "16:9" as const,
					projection: "perspective" as const,
					location: { x: 1000, y: 1000, z: 900 },
					rotation: { pitch: -30, yaw: -135, roll: 0 },
					fieldOfViewDegrees: 60
				};
				const response = await Effect.runPromise(
					captureReviewView({
						endpoint: endpoint!,
						request: {
							contract: {
								name: "ue-shed-review-capture",
								version: { major: 1, minor: 6 }
							},
							operationId: ReviewCaptureOperationId.make(randomUUID()),
							viewId: ReviewViewId.make("independent-fixture-camera"),
							expectedMapPath: mapPath,
							subject: {
								kind: "actor_path",
								actorPath: `${mapPath}.L_CameraLoad:PersistentLevel.RemovedSubject`
							},
							viewpoint: { kind: "world_fixed", approvedPose: pose },
							assessment: { method: "automatic" },
							clearCompanion: { status: "not_requested" },
							resolution: { width: 320, height: 180 },
							renderPolicy: request(kind).policy
						}
					}).pipe(Effect.provide(RemoteControlClientLive))
				);
				expect(response.status).toBe("captured");
				if (response.status !== "captured" || !("renderEvidence" in response))
					throw new Error(JSON.stringify(response));
				expect(response.effectiveWorldPose).toEqual(pose);
				expect(response.resolvedSubject.kind).toBe("unresolved_actor");
				expect(response.visibility.status).toBe("not_assessed");
				expect(response.renderEvidence?.policy).toEqual(request(kind).policy);
			},
			180000
		);
		it.each(["scene_capture", "editor_viewport"] as const)(
			"renders both projections through %s and releases ownership",
			async (kind) => {
				for (const projection of [
					{ kind: "perspective", horizontalFieldOfView: 60 },
					{ kind: "orthographic", width: 2400 }
				] as const) {
					const session = request(kind);
					const camera: AbsoluteCamera = {
						location: { x: 1000, y: 1000, z: 900 },
						rotation: { pitch: -30, yaw: -135, roll: 0 },
						projection
					};
					const frame = await Effect.runPromise(
						renderCamera({
							session,
							frame: {
								contract: cameraRenderContract,
								sessionId: session.sessionId,
								operationId: CameraFrameOperationId.make(randomUUID()),
								camera,
								size: { width: 320, height: 180 }
							}
						}).pipe(Effect.provide(layer))
					);
					expect(frame.evidence.camera).toEqual(camera);
					expect(frame.evidence.policy).toEqual(session.policy);
					expect(frame.evidence.exposureEV100).toBe(8);
					const image = await Effect.runPromise(
						readCameraFrameArtifact({ projectRoot: projectRoot!, frame })
					);
					expect(image.bytes.length).toBe(frame.artifact.bytes);
					expect(image.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
					const readiness = await Effect.runPromise(
						Effect.flatMap(CameraRenderer, (renderer) =>
							renderer.preflight(request(kind))
						).pipe(Effect.provide(layer))
					);
					expect(readiness).toEqual({ status: "ready", issues: [] });
				}
			},
			300000
		);
	}
);
