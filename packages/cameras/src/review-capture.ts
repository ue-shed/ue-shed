import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Data, Effect } from "effect";
import { captureReviewView } from "./review-live.js";
import { captureRunsRoot, isPathWithin, loadReviewSet } from "./review-repository.js";
import {
	CaptureRunId,
	ArtifactId,
	ReviewCaptureRequest,
	decodeCaptureRun,
	type CaptureRun,
	type ReviewCaptureResponse,
	type ViewResult
} from "./review-schema.js";

export class ReviewCaptureRunError extends Data.TaggedError("ReviewCaptureRunError")<{
	readonly message: string;
	readonly operation: "prepare" | "capture" | "finalize";
	readonly recovery: string;
	readonly runId: string;
}> {}

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

async function durableJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const handle = await open(path, "wx");
	try {
		await handle.writeFile(`${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
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
	ReviewCaptureRunError | import("./review-repository.js").ReviewStorageError
> {
	return Effect.gen(function* () {
		const reviewSet = yield* loadReviewSet(options.reviewSetPath);
		const runId = CaptureRunId.make(dependencies.makeId());
		const startedAt = dependencies.now();
		const root = captureRunsRoot(options.projectRoot);
		const stagingRoot = join(root, `.staging-${runId}`);
		const finalRoot = join(root, runId);
		const unrealStagingRoot = resolve(options.projectRoot, "Saved", "UEShed", "ReviewStaging");
		const capturePort =
			dependencies.port ??
			({
				capture: (request) => captureReviewView({ endpoint: options.endpoint, request })
			} satisfies ReviewCapturePort);

		yield* Effect.tryPromise({
			try: async () => {
				await mkdir(root, { recursive: true });
				await mkdir(stagingRoot);
			},
			catch: (cause) =>
				new ReviewCaptureRunError({
					message: String(cause),
					operation: "prepare",
					recovery: "Check that the project review directory is writable.",
					runId
				})
		});

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
				Effect.catchAll((cause) =>
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
			const artifact = yield* Effect.tryPromise({
				try: async () => {
					await mkdir(dirname(artifactPath), { recursive: true });
					await copyFile(response.stagingPath, artifactPath);
					const bytes = await readFile(artifactPath);
					const file = await stat(artifactPath);
					await unlink(response.stagingPath).catch(() => undefined);
					return {
						byteLength: file.size,
						contentHash: sha256(bytes),
						height: response.height,
						id: ArtifactId.make(`${runId}:${view.id}:pure`),
						mediaType: "image/png" as const,
						relativePath,
						variant: "pure" as const,
						width: response.width
					};
				},
				catch: (cause) =>
					new ReviewCaptureRunError({
						message: String(cause),
						operation: "capture",
						recovery: "Check staging and evidence directory permissions, then retry.",
						runId
					})
			});
			const result = {
				artifact,
				captureDurationMs: response.captureDurationMs,
				resolvedActorPath: response.actorPath,
				status: "captured" as const,
				viewId: view.id
			};
			results.push(result);
			yield* Effect.tryPromise({
				try: () => durableJson(join(stagingRoot, "views", view.id, "result.json"), result),
				catch: (cause) =>
					new ReviewCaptureRunError({
						message: String(cause),
						operation: "capture",
						recovery: "Check the evidence directory and retry the run.",
						runId
					})
			});
		}

		const failures = results.filter((result) => result.status === "failed").length;
		const successes = results.length - failures;
		const run = decodeCaptureRun({
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
		});

		yield* Effect.tryPromise({
			try: async () => {
				await durableJson(join(stagingRoot, "run.json"), run);
				await rename(stagingRoot, finalRoot);
			},
			catch: (cause) =>
				new ReviewCaptureRunError({
					message: String(cause),
					operation: "finalize",
					recovery: `Inspect ${relative(root, stagingRoot)} and retry finalization safely.`,
					runId
				})
		});
		return run;
	}).pipe(
		Effect.withSpan("camera.review.run.capture", {
			attributes: { "camera.review.set.path": options.reviewSetPath }
		})
	);
}
