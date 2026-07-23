import { randomUUID } from "node:crypto";
import { readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteControlClient, RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { inspectReviewSelection, previewReviewCandidate } from "./review-authoring-live.js";
import { captureReviewSet } from "./review-capture.js";
import { generateFramingCandidates, realizationFramingDiagnostics } from "./review-framing.js";
import { captureReviewView } from "./review-live.js";
import {
	captureRunsRoot,
	loadReviewSet,
	ReviewRepositoryLive,
	type ReviewRepository
} from "./review-repository.js";
import { ReviewCaptureRequest, ReviewCaptureResponse, ReviewViewId } from "./review-schema.js";

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
