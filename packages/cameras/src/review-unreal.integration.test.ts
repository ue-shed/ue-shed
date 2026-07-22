import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteControlClient, RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { inspectReviewSelection, previewReviewCandidate } from "./review-authoring-live.js";
import { captureReviewSet } from "./review-capture.js";
import { generateFramingCandidates } from "./review-framing.js";
import {
	captureRunsRoot,
	loadReviewSet,
	ReviewRepositoryLive,
	type ReviewRepository
} from "./review-repository.js";
import { ReviewCaptureResponse } from "./review-schema.js";

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
		} finally {
			await editorActorCall("SelectNothing", {});
		}
	});
});
