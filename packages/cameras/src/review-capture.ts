import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { RemoteControlClientLive } from "@ue-shed/unreal-connection";
import { Effect, Schema } from "effect";
import { captureReviewView } from "./review-live.js";
import { ReviewRepository, captureRunsRoot, isPathWithin } from "./review-repository.js";
import {
	CaptureRunId,
	ArtifactId,
	ReviewCaptureRequest,
	decodeCaptureRun,
	type CaptureRun,
	type ReviewCaptureResponse,
	type ViewResult
} from "./review-schema.js";

export class ReviewCaptureRunError extends Schema.TaggedErrorClass<ReviewCaptureRunError>()(
	"ReviewCaptureRunError",
	{
		message: Schema.String,
		operation: Schema.Literals(["prepare", "capture", "finalize"]),
		recovery: Schema.String,
		runId: Schema.String
	}
) {}

export interface ReviewCapturePort {
	readonly capture: (
		request: SchemaReviewCaptureRequest
	) => Effect.Effect<ReviewCaptureResponse, unknown>;
}

type SchemaReviewCaptureRequest = typeof ReviewCaptureRequest.Type;

export interface CaptureReviewSetOptions {
	readonly endpoint: string;
	readonly projectRoot: string;
	readonly reviewSetPath: string;
}

interface CaptureReviewSetDependencies {
	readonly makeId: () => string;
	readonly now: () => string;
	readonly port?: ReviewCapturePort;
}

function sha256(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function captureReviewSet(
	options: CaptureReviewSetOptions,
	dependencies: CaptureReviewSetDependencies = {
		makeId: randomUUID,
		now: () => new Date().toISOString()
	}
): Effect.Effect<
	CaptureRun,
	ReviewCaptureRunError | import("./review-repository.js").ReviewStorageError,
	ReviewRepository
> {
	return Effect.gen(function* () {
		const repository = yield* ReviewRepository;
		const reviewSet = yield* repository.loadSet(options.reviewSetPath);
		const runId = CaptureRunId.make(dependencies.makeId());
		const startedAt = dependencies.now();
		const root = captureRunsRoot(options.projectRoot);
		const stagingRoot = join(root, `.staging-${runId}`);
		const finalRoot = join(root, runId);
		const unrealStagingRoot = resolve(options.projectRoot, "Saved", "UEShed", "ReviewStaging");
		const capturePort =
			dependencies.port ??
			({
				capture: (request) =>
					captureReviewView({ endpoint: options.endpoint, request }).pipe(
						Effect.provide(RemoteControlClientLive)
					)
			} satisfies ReviewCapturePort);

		yield* repository.prepareRun({ root, stagingRoot });

		const results: ViewResult[] = [];
		for (const view of reviewSet.views) {
			const profile = reviewSet.captureProfiles.find(
				(candidate) => candidate.id === view.captureProfileId
			);
			if (!profile) {
				results.push({
					code: "capture_profile_missing",
					message: `Review View ${view.id} references missing profile ${view.captureProfileId}`,
					recovery: "Add the profile to the Review Set or update the Review View.",
					retrySafe: false,
					status: "failed",
					viewId: view.id
				});
				continue;
			}
			const operationId = dependencies.makeId();
			const request = ReviewCaptureRequest.make({
				approvedPose: view.approvedPose,
				contract: {
					name: "ue-shed-review-capture",
					version: { major: 1, minor: 0 }
				},
				expectedMapPath: reviewSet.project.mapPath,
				operationId,
				resolution: profile.resolution,
				subject: view.subject,
				viewId: view.id
			});
			const response = yield* capturePort.capture(request).pipe(
				Effect.catch((cause) =>
					Effect.succeed({
						code: "capture_connection_failed",
						message: String(cause),
						operationId,
						recovery:
							"Verify the editor capability and Remote Control endpoint, then retry.",
						retrySafe: true,
						contract: {
							name: "ue-shed-review-capture" as const,
							version: { major: 1 as const, minor: 0 }
						},
						status: "failed" as const,
						viewId: view.id
					})
				)
			);
			if (response.status === "failed") {
				results.push({
					code: response.code,
					message: response.message,
					recovery: response.recovery,
					retrySafe: response.retrySafe,
					status: "failed",
					viewId: view.id
				});
				continue;
			}
			if (response.mapPackageDirtyAfter !== response.mapPackageDirtyBefore) {
				results.push({
					code: "map_package_dirty_state_changed",
					message: "Transient review capture changed the map package dirty state.",
					recovery:
						"Inspect the editor map before retrying; do not save tooling changes.",
					retrySafe: false,
					status: "failed",
					viewId: view.id
				});
				continue;
			}
			if (!isPathWithin(unrealStagingRoot, response.stagingPath)) {
				results.push({
					code: "capture_staging_path_rejected",
					message:
						"Unreal returned a capture path outside the project review staging root.",
					recovery: "Verify the connected project and editor capability version.",
					retrySafe: false,
					status: "failed",
					viewId: view.id
				});
				continue;
			}

			const relativePath = `views/${view.id}/pure.png`;
			const artifactPath = join(stagingRoot, ...relativePath.split("/"));
			const stored = yield* repository.storeArtifact({
				destinationPath: artifactPath,
				sourcePath: response.stagingPath
			});
			const artifact = {
				byteLength: stored.size,
				contentHash: sha256(stored.bytes),
				height: response.height,
				id: ArtifactId.make(`${runId}:${view.id}:pure`),
				mediaType: "image/png" as const,
				relativePath,
				variant: "pure" as const,
				width: response.width
			};
			const result = {
				artifact,
				captureDurationMs: response.captureDurationMs,
				resolvedActorPath: response.actorPath,
				status: "captured" as const,
				viewId: view.id
			};
			results.push(result);
			yield* repository.writeRunDocument({
				path: join(stagingRoot, "views", view.id, "result.json"),
				value: result
			});
		}

		const failures = results.filter((result) => result.status === "failed").length;
		const successes = results.length - failures;
		const run = yield* decodeCaptureRun({
			completedAt: dependencies.now(),
			contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 0 } },
			id: runId,
			project: reviewSet.project,
			results,
			reviewSetId: reviewSet.id,
			startedAt,
			status:
				failures === 0
					? "completed"
					: successes === 0
						? "failed"
						: "completed_with_failures"
		}).pipe(
			Effect.mapError(
				(cause) =>
					new ReviewCaptureRunError({
						message: String(cause),
						operation: "finalize",
						recovery: "Inspect the generated Capture Run values and retry.",
						runId
					})
			)
		);

		yield* repository.finalizeRun({ finalRoot, run, stagingRoot });
		return run;
	}).pipe(
		Effect.withSpan("camera.review.run.capture", {
			attributes: { "camera.review.set.path": options.reviewSetPath }
		})
	);
}
