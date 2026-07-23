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
import { captureReviewView } from "./review-live.js";
import {
	awaitReviewPreviewFrame,
	clearReviewPreviewSources,
	ensureReviewPreviewSources
} from "./review-preview-live.js";
import {
	captureRunsRoot,
	loadReviewSet,
	ReviewRepositoryLive,
	type ReviewRepository
} from "./review-repository.js";
import { ReviewCaptureRequest, ReviewCaptureResponse, ReviewViewId } from "./review-schema.js";
import { evaluateReviewCapturePolicy } from "./review-session-policy.js";

const runReviewRepository = <A, E>(effect: Effect.Effect<A, E, ReviewRepository>) =>
	Effect.runPromise(effect.pipe(Effect.provide(ReviewRepositoryLive)));

const endpoint = process.env.UE_SHED_REMOTE_CONTROL_ENDPOINT;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const projectRoot = join(repositoryRoot, "fixtures", "unreal-project");
const reviewSetPath = join(projectRoot, ".ue-shed", "review", "sets", "fixture-structure.json");
const subjectPath = "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject";
const reviewLibraryPath = "/Script/UEShedCamerasEditor.Default__UEShedCameraReviewLibrary";
const invalidCaptureRequestPath = join(
	repositoryRoot,
	"packages/protocol/contracts/cameras/review/v1/fixtures/invalid-capture-request-bad-fov.json"
);

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

describe.skipIf(!endpoint)("real Unreal Map Review capture", () => {
	it("captures one immutable Pure view without changing map dirty state", async () => {
		const run = await runReviewRepository(
			captureReviewSet({ endpoint: endpoint!, projectRoot, reviewSetPath })
		);
		try {
			expect(run.status).toBe("completed");
			expect(run.results).toHaveLength(1);
			const result = run.results[0]!;
			expect(result.status).toBe("captured");
			if (result.status !== "captured") return;
			expect(result.resolvedActorPath).toBe(
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject"
			);
			const bytes = await readFile(
				join(captureRunsRoot(projectRoot), run.id, result.artifact.relativePath)
			);
			expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
		} finally {
			await rm(join(captureRunsRoot(projectRoot), run.id), {
				force: true,
				recursive: true
			});
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
						viewId: ReviewViewId.make(candidate.id)
					})
				}).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(response.status).toBe("captured");
			if (response.status !== "captured") return;
			stagingPath = response.stagingPath;
			expect(response.contract.version.minor).toBe(1);
			expect(response.subjectProjection).toBeDefined();
			expect(response.subjectProjection).toMatchObject({ status: "unprojectable" });
			expect(response.mapPackageDirtyAfter).toBe(response.mapPackageDirtyBefore);
			const bytes = await readFile(response.stagingPath);
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

describe.skipIf(!endpoint)("real Unreal PIE live review previews", () => {
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

	it("registers posed preview sources, delivers BGRA frames, clears without dirt, and keeps overview healthy", async () => {
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

		try {
			await playCall("StartPlaySession");
			await waitForPlayStatus("running");

			const playState = (await playCall("GetPlaySessionState")) as {
				readonly state: Parameters<typeof evaluateReviewCapturePolicy>[0];
			};
			expect(evaluateReviewCapturePolicy(playState.state)).toMatchObject({
				code: "play_session_active",
				status: "blocked"
			});

			const sources = [
				{
					candidateId: "context_three_quarter",
					fieldOfViewDegrees: 60,
					height: 180,
					location: { x: 1200, y: -1400, z: 700 },
					rotation: { pitch: -18, roll: 0, yaw: 140 },
					width: 320
				},
				{
					candidateId: "facade_front",
					fieldOfViewDegrees: 55,
					height: 180,
					location: { x: 0, y: -1600, z: 450 },
					rotation: { pitch: -10, roll: 0, yaw: 90 },
					width: 320
				}
			] as const;

			const bindings = await Effect.runPromise(
				ensureReviewPreviewSources(endpoint!, sources, { previewFps: 5 }).pipe(
					Effect.provide(RemoteControlClientLive)
				)
			);
			expect(bindings).toHaveLength(2);
			expect(bindings.map((item) => item.candidateId).sort()).toEqual([
				"context_three_quarter",
				"facade_front"
			]);

			const statusWhileLive = await Effect.runPromise(
				getCameraStatus(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
			);
			expect(statusWhileLive.config.viewMode).toBe("posed");
			expect(statusWhileLive.cameras).toHaveLength(2);

			const liveFrames = await Effect.runPromise(
				Effect.gen(function* () {
					const first = yield* awaitReviewPreviewFrame({
						cameraIndex: bindings[0]!.index,
						latestFrames: feed.latestFrames,
						timeout: "12 seconds"
					});
					const second = yield* awaitReviewPreviewFrame({
						cameraIndex: bindings[1]!.index,
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
				clearReviewPreviewSources(endpoint!).pipe(Effect.provide(RemoteControlClientLive))
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
				awaitReviewPreviewFrame({
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
				awaitReviewPreviewFrame({
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
