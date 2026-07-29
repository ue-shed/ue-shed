import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	ReviewCapture,
	ReviewCaptureLive,
	reviewCapturePortLayer,
	reviewIdGeneratorLayer,
	type ReviewCapturePortShape
} from "./review-capture.js";
import {
	captureRunPath,
	captureRunsRoot,
	isPathWithin,
	listCaptureRuns,
	loadCaptureRun,
	loadReviewSet,
	ReviewRepository,
	ReviewRepositoryLive,
	saveReviewSet
} from "./review-repository.js";
import {
	CaptureProfileId,
	CaptureInvocation,
	CaptureInvocationId,
	ReviewSetId,
	ReviewViewId,
	VisibilityClassificationThresholds,
	VisibilityMeasurement,
	VisibilityResult,
	classifyVisibilityMeasurement,
	decodeCaptureRun,
	decodeReviewSet as decodeReviewSetEffect,
	reviewViewApprovedPose,
	type ReviewSet
} from "./review-schema.js";

const decodeReviewSet = (input: unknown) => Effect.runSync(decodeReviewSetEffect(input));

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
	);
});

function fixtureReviewSet(): ReviewSet {
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
		id: "fixture-structure",
		project: {
			id: "ue-shed-fixture",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		},
		views: [
			{
				approvedPose: {
					aspectRatio: "16:9",
					fieldOfViewDegrees: 60,
					location: { x: 1000, y: 1000, z: 600 },
					projection: "perspective",
					rotation: { pitch: -15, roll: 0, yaw: -135 }
				},
				captureProfileId: "fixture-hd",
				displayName: "Structure context",
				framingRecipe: { kind: "manual", version: 1 },
				id: "structure-context",
				purpose: "Track the fixture structure over time",
				subject: {
					actorPath:
						"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
					kind: "actor_path"
				},
				tags: ["fixture", "context"]
			}
		]
	});
}

function runCapture(
	options: {
		readonly invocation?: CaptureInvocation;
		readonly projectRoot: string;
		readonly reviewSetPath: string;
		readonly viewIds?: ReadonlyArray<ReviewViewId>;
	},
	port: ReviewCapturePortShape,
	makeId: () => string
) {
	return Effect.runPromise(
		Effect.flatMap(ReviewCapture, (service) =>
			service.captureSet({
				endpoint: "http://127.0.0.1:30001",
				projectRoot: options.projectRoot,
				reviewSetPath: options.reviewSetPath,
				...(options.invocation === undefined ? {} : { invocation: options.invocation }),
				...(options.viewIds ? { viewIds: options.viewIds } : {})
			})
		).pipe(
			Effect.provide(ReviewCaptureLive),
			Effect.provide(reviewCapturePortLayer(port)),
			Effect.provide(reviewIdGeneratorLayer(makeId)),
			Effect.provide(ReviewRepositoryLive)
		)
	);
}

describe("Map Review contracts", () => {
	it("keeps domain identities branded and validates a complete Review Set", () => {
		const reviewSet = fixtureReviewSet();
		expect(ReviewSetId.make(reviewSet.id)).toBe("fixture-structure");
		expect(ReviewViewId.make(reviewSet.views[0]!.id)).toBe("structure-context");
		expect(CaptureProfileId.make(reviewSet.captureProfiles[0]!.id)).toBe("fixture-hd");
		const view = reviewSet.views[0]!;
		const approvedPose = reviewViewApprovedPose(view);
		if (approvedPose === undefined) throw new Error("Fixture must be world-fixed");
		expect(() =>
			decodeReviewSet({
				...reviewSet,
				views: [
					{
						...view,
						viewpoint: {
							approvedPose: {
								...approvedPose,
								fieldOfViewDegrees: 200
							},
							kind: "world_fixed" as const
						}
					}
				]
			})
		).toThrow();
	});

	it("persists and loads a Review Set through an atomic document boundary", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-review-set-"));
		temporaryDirectories.push(root);
		const path = join(root, "sets", "fixture.json");
		const reviewSet = fixtureReviewSet();
		await Effect.runPromise(
			saveReviewSet({ path, reviewSet }).pipe(Effect.provide(ReviewRepositoryLive))
		);
		await expect(
			Effect.runPromise(loadReviewSet(path).pipe(Effect.provide(ReviewRepositoryLive)))
		).resolves.toEqual(reviewSet);
	});

	it("migrates legacy Review Sets and preserves explicit unversioned result provenance", () => {
		const reviewSet = fixtureReviewSet();
		expect(reviewSet.contract.version).toEqual({ major: 1, minor: 1 });
		expect(reviewSet.views[0]).toMatchObject({
			id: "structure-context",
			target: { kind: "actor" },
			viewpoint: { kind: "world_fixed" },
			visibilityPolicyId: "default-natural-only"
		});
		const legacyRun = Effect.runSync(
			decodeCaptureRun({
				completedAt: "2026-07-28T00:00:01.000Z",
				contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 0 } },
				id: "legacy-run",
				project: reviewSet.project,
				results: [
					{
						artifact: {
							byteLength: 4,
							contentHash:
								"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							height: 1,
							id: "legacy-run:structure-context:pure",
							mediaType: "image/png",
							relativePath: "views/structure-context/pure.png",
							variant: "pure",
							width: 1
						},
						captureDurationMs: 1,
						resolvedActorPath:
							reviewSet.views[0]!.target.kind === "actor"
								? reviewSet.views[0]!.target.subject.actorPath
								: "/Game/Invalid",
						status: "captured",
						viewId: "structure-context"
					}
				],
				reviewSetId: reviewSet.id,
				startedAt: "2026-07-28T00:00:00.000Z",
				status: "completed"
			})
		);
		expect(legacyRun.results[0]).toMatchObject({
			viewRevision: { status: "legacy_unversioned" },
			visibility: { status: "not_assessed" }
		});

		const classifiedRun = Effect.runSync(
			decodeCaptureRun({
				completedAt: "2026-07-28T00:00:01.000Z",
				contract: { name: "ue-shed-capture-run", version: { major: 1, minor: 2 } },
				id: "classified-run",
				invocation: {
					cause: { type: "manual" },
					id: "classified-invocation",
					reviewSetId: reviewSet.id
				},
				project: reviewSet.project,
				results: [
					{
						artifacts: [
							{
								byteLength: 4,
								contentHash:
									"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
								height: 1,
								id: "classified-run:structure-context:pure",
								mediaType: "image/png",
								relativePath: "views/structure-context/pure.png",
								variant: "pure",
								width: 1
							}
						],
						captureDurationMs: 1,
						realization: {
							resolvedActorPath:
								reviewSet.views[0]!.target.kind === "actor"
									? reviewSet.views[0]!.target.subject.actorPath
									: "/Game/Invalid",
							status: "legacy_not_recorded"
						},
						status: "captured",
						viewId: "structure-context",
						viewRevision: reviewSet.views[0]!.revision,
						visibility: {
							assessmentDurationMs: 1,
							classification: "partial",
							limitations: ["Legacy engine classification."],
							method: { method: "ray_samples", version: 1 },
							occluders: [],
							sampleCount: 9,
							status: "assessed",
							visibleFraction: 0.66
						}
					}
				],
				reviewSetId: reviewSet.id,
				startedAt: "2026-07-28T00:00:00.000Z",
				status: "completed"
			})
		);
		expect(classifiedRun.contract.version).toEqual({ major: 1, minor: 4 });
		expect(classifiedRun.results[0]).toMatchObject({
			visibility: {
				legacyInterpretation: {
					classification: "partial",
					source: "capture_run_pre_1_3"
				},
				status: "assessed",
				visibleFraction: 0.66
			}
		});
	});

	it("rejects cross-policy combinations that would hide state without a Clear capture", () => {
		const reviewSet = fixtureReviewSet();
		const view = reviewSet.views[0]!;
		expect(() =>
			decodeReviewSet({
				...reviewSet,
				views: [
					{
						...view,
						visibilityOverrides: {
							hideInClear: [
								{
									actorPath:
										"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewOccluder",
									kind: "actor_path"
								}
							],
							neverHide: []
						}
					}
				]
			})
		).toThrow(/Natural-only policy/);
	});

	it("requires bounded quantitative evidence before visibility can be assessed", () => {
		expect(() =>
			Schema.decodeUnknownSync(VisibilityResult)({
				assessmentDurationMs: 1,
				limitations: [],
				method: { method: "ray_samples", version: 1 },
				occluders: [],
				sampleCount: 9,
				status: "assessed"
			})
		).toThrow(/visibleFraction/);
		expect(() =>
			Schema.decodeUnknownSync(VisibilityResult)({
				assessmentDurationMs: 1,
				limitations: [],
				method: { method: "ray_samples", version: 1 },
				occluders: [],
				sampleCount: 9,
				status: "assessed",
				visibleFraction: 1.2
			})
		).toThrow();
	});

	it("classifies raw engine measurements only when a consumer asks", () => {
		const measurement = Schema.decodeUnknownSync(VisibilityMeasurement)({
			assessmentDurationMs: 1,
			limitations: ["Collision rays are diagnostic."],
			method: { method: "ray_samples", version: 1 },
			occluders: [],
			sampleCount: 9,
			status: "assessed",
			visibleFraction: 0.66
		});
		const thresholds = VisibilityClassificationThresholds.make({
			blockedAtOrBelow: 0.25,
			clearAtOrAbove: 0.75
		});
		expect(
			classifyVisibilityMeasurement({
				measurement,
				projection: {
					margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
					normalizedBounds: { maxX: 0.9, maxY: 0.9, minX: 0.1, minY: 0.1 },
					status: "projected",
					viewportStatus: "fully_within_viewport"
				},
				thresholds
			})
		).toBe("partial");
		expect(
			classifyVisibilityMeasurement({
				measurement,
				projection: {
					code: "behind_camera",
					message: "The subject is behind the camera.",
					status: "unprojectable"
				},
				thresholds
			})
		).toBe("not_visible");
	});
});

describe("durable capture loop", () => {
	it("captures only the approved views selected by the plan", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-subset-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		const reviewSet = fixtureReviewSet();
		const second = {
			...reviewSet.views[0]!,
			displayName: "Structure detail",
			id: ReviewViewId.make("structure-detail")
		};
		await Effect.runPromise(
			saveReviewSet({
				path: reviewSetPath,
				reviewSet: { ...reviewSet, views: [...reviewSet.views, second] }
			}).pipe(Effect.provide(ReviewRepositoryLive))
		);
		const requested: string[] = [];
		const port: ReviewCapturePortShape = {
			capture: (request) => {
				requested.push(request.viewId);
				return Effect.succeed({
					code: "fixture_failure",
					contract: request.contract,
					message: "Expected fixture failure",
					operationId: request.operationId,
					recovery: "No recovery required",
					retrySafe: false,
					status: "failed",
					viewId: request.viewId
				});
			}
		};
		const ids = ["run-subset", "invocation-subset", "operation-subset"];
		const run = await runCapture(
			{
				projectRoot,
				reviewSetPath,
				viewIds: [ReviewViewId.make("structure-detail")]
			},
			port,
			() => ids.shift()!
		);
		expect(requested).toEqual(["structure-detail"]);
		expect(run.results).toHaveLength(1);
	});

	it("sends target-relative actors and fixed oriented areas through capture contract v1.2", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-targets-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		const base = fixtureReviewSet();
		const fixed = base.views[0]!;
		if (fixed.target.kind !== "actor" || fixed.viewpoint.kind !== "world_fixed") {
			throw new Error("Fixture must be an actor/world-fixed View");
		}
		const following = {
			...fixed,
			id: ReviewViewId.make("structure-follow"),
			revision: {
				id: "structure-follow-r1",
				number: 1,
				status: "numbered" as const
			},
			viewpoint: {
				kind: "target_relative" as const,
				relativePose: {
					...fixed.viewpoint.approvedPose,
					location: { x: -900, y: 0, z: 300 }
				},
				targetSnapshot: {
					location: { x: 100, y: 200, z: 300 },
					rotation: { pitch: 0, roll: 0, yaw: 45 }
				}
			}
		};
		const area = {
			...fixed,
			id: ReviewViewId.make("loading-area"),
			revision: {
				id: "loading-area-r1",
				number: 1,
				status: "numbered" as const
			},
			target: {
				bounds: {
					center: { x: 0, y: 0, z: 200 },
					extent: { x: 600, y: 400, z: 200 },
					rotation: { pitch: 0, roll: 0, yaw: 30 }
				},
				kind: "oriented_box" as const
			}
		};
		await Effect.runPromise(
			saveReviewSet({
				path: reviewSetPath,
				reviewSet: decodeReviewSet({ ...base, views: [following, area] })
			}).pipe(Effect.provide(ReviewRepositoryLive))
		);
		const requests: Parameters<ReviewCapturePortShape["capture"]>[0][] = [];
		const port: ReviewCapturePortShape = {
			capture: (request) => {
				requests.push(request);
				return Effect.succeed({
					code: "fixture_stop",
					contract: request.contract,
					message: "Request recorded",
					operationId: request.operationId,
					recovery: "No recovery required",
					retrySafe: false,
					status: "failed",
					viewId: request.viewId
				});
			}
		};
		const ids = ["run-targets", "invocation-targets", "operation-relative", "operation-area"];
		await runCapture({ projectRoot, reviewSetPath }, port, () => ids.shift()!);
		expect(requests).toMatchObject([
			{
				contract: { version: { major: 1, minor: 4 } },
				subject: { kind: "actor_path" },
				viewpoint: { kind: "target_relative" }
			},
			{
				contract: { version: { major: 1, minor: 4 } },
				subject: {
					bounds: { rotation: { yaw: 30 } },
					kind: "oriented_bounds"
				},
				viewpoint: { kind: "world_fixed" }
			}
		]);
	});

	it("records distinct external attempts that share one correlation ID", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-external-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const port: ReviewCapturePortShape = {
			capture: (request) =>
				Effect.succeed({
					code: "fixture_failure",
					contract: request.contract,
					message: "Expected fixture failure",
					operationId: request.operationId,
					recovery: "No recovery required",
					retrySafe: false,
					status: "failed",
					viewId: request.viewId
				})
		};
		const reviewSet = fixtureReviewSet();
		const invocation = (id: string) =>
			CaptureInvocation.make({
				cause: { correlationId: "daily-fixture", type: "external_automation" },
				id: CaptureInvocationId.make(id),
				reviewSetId: reviewSet.id
			});
		const firstIds = ["run-daily-1", "operation-daily-1"];
		const first = await runCapture(
			{ invocation: invocation("invoke-daily-1"), projectRoot, reviewSetPath },
			port,
			() => firstIds.shift()!
		);
		const secondIds = ["run-daily-2", "operation-daily-2"];
		const second = await runCapture(
			{ invocation: invocation("invoke-daily-2"), projectRoot, reviewSetPath },
			port,
			() => secondIds.shift()!
		);
		expect(first.id).not.toBe(second.id);
		expect(first.invocation).toMatchObject({
			cause: { correlationId: "daily-fixture", type: "external_automation" }
		});
		expect(second.invocation).toMatchObject({
			cause: { correlationId: "daily-fixture", type: "external_automation" }
		});
	});

	it("promotes a validated Unreal staging image into an immutable run and history", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-run-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, ".ue-shed", "review", "sets", "fixture.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
		const port: ReviewCapturePortShape = {
			capture: (request) =>
				Effect.tryPromise({
					try: async () => {
						const stagingPath = join(
							projectRoot,
							"Saved",
							"UEShed",
							"ReviewStaging",
							request.operationId,
							request.viewId,
							"pure.png"
						);
						await mkdir(dirname(stagingPath), { recursive: true });
						await writeFile(stagingPath, png);
						return {
							captureDurationMs: 12.5,
							clearCompanion: { status: "not_requested" as const },
							contract: request.contract,
							effectiveWorldPose:
								request.viewpoint.kind === "world_fixed"
									? request.viewpoint.approvedPose
									: request.viewpoint.relativePose,
							height: request.resolution.height,
							mapPackageDirtyAfter: false,
							mapPackageDirtyBefore: false,
							mapPath: request.expectedMapPath,
							operationId: request.operationId,
							resolvedSubject:
								request.subject.kind === "actor_path"
									? {
											...request.subject,
											transform: {
												location: { x: 0, y: 0, z: 0 },
												rotation: { pitch: 0, roll: 0, yaw: 0 }
											}
										}
									: request.subject,
							stagedArtifacts: [{ stagingPath, variant: "pure" as const }],
							status: "captured" as const,
							subjectProjection: {
								margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
								normalizedBounds: {
									maxX: 0.9,
									maxY: 0.9,
									minX: 0.1,
									minY: 0.1
								},
								status: "projected" as const,
								viewportStatus: "fully_within_viewport" as const
							},
							viewId: request.viewId,
							visibility: {
								assessmentDurationMs: 0.25,
								limitations: [
									"Collision rays are diagnostic and may differ from rendered visibility."
								],
								method: { method: "ray_samples" as const, version: 1 },
								occluders: [],
								sampleCount: 9,
								status: "assessed" as const,
								visibleFraction: 0.66
							},
							width: request.resolution.width
						};
					},
					catch: (cause) => cause
				})
		};
		const ids = ["run-001", "invocation-001", "operation-001"];

		const run = await runCapture({ projectRoot, reviewSetPath }, port, () => ids.shift()!);

		expect(run.status).toBe("completed");
		expect(run.id).toBe("run-001");
		expect(run.contract.version).toEqual({ major: 1, minor: 4 });
		const persisted = await Effect.runPromise(
			loadCaptureRun(captureRunPath(projectRoot, run.id)).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		expect(persisted).toEqual(run);
		const artifactPath = join(
			projectRoot,
			".ue-shed",
			"review",
			"runs",
			run.id,
			"views",
			"structure-context",
			"pure.png"
		);
		expect(new Uint8Array(await readFile(artifactPath))).toEqual(png);
		expect(run.results[0]).toMatchObject({
			artifacts: [
				{
					contentHash: `sha256:${createHash("sha256").update(png).digest("hex")}`,
					relativePath: "views/structure-context/pure.png"
				}
			],
			realization: {
				status: "resolved",
				viewpoint: { kind: "world_fixed" }
			},
			status: "captured",
			visibility: {
				method: { method: "ray_samples", version: 1 },
				status: "assessed",
				visibleFraction: 0.66
			}
		});
		expect(run.results[0]).not.toHaveProperty("visibility.classification");
		await expect(
			Effect.runPromise(
				listCaptureRuns(projectRoot).pipe(Effect.provide(ReviewRepositoryLive))
			)
		).resolves.toMatchObject([
			{ failedViews: 0, id: "run-001", status: "completed", successfulViews: 1 }
		]);
	});

	it("stores an optional Clear companion and keeps Pure on a typed Clear failure", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-clear-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		const base = fixtureReviewSet();
		const view = base.views[0]!;
		const reviewSet = decodeReviewSet({
			...base,
			visibilityPolicies: [
				{
					assessment: { method: "automatic" },
					id: "explicit-clear",
					name: "Explicit Clear",
					onLowVisibility: { action: "record" },
					output: {
						clearStrategy: { type: "hide_explicit" },
						mode: "natural_and_clear"
					}
				}
			],
			views: [
				{
					...view,
					visibilityOverrides: {
						hideInClear: [
							{
								actorPath:
									"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewOccluder",
								kind: "actor_path"
							}
						],
						neverHide: []
					},
					visibilityPolicyId: "explicit-clear"
				}
			]
		});
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		let failClear = false;
		const port: ReviewCapturePortShape = {
			capture: (request) =>
				Effect.tryPromise({
					try: async () => {
						const directory = join(
							projectRoot,
							"Saved",
							"UEShed",
							"ReviewStaging",
							request.operationId,
							request.viewId
						);
						const purePath = join(directory, "pure.png");
						await mkdir(directory, { recursive: true });
						await writeFile(purePath, png);
						const stagedArtifacts: Array<{
							readonly stagingPath: string;
							readonly variant: "pure" | "clear";
						}> = [{ stagingPath: purePath, variant: "pure" }];
						const clearCompanion = failClear
							? {
									failure: {
										code: "clear_actor_not_found",
										message: "The requested Clear actor is missing.",
										recovery: "Update the explicit Clear actor list.",
										retrySafe: true
									},
									interventions: [],
									restoration: {
										method: "transient_capture_component_lists" as const,
										status: "restored" as const
									},
									status: "failed" as const,
									strategy: "hide_explicit" as const
								}
							: {
									interventions: [
										{
											target: {
												actorPath:
													"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewOccluder",
												kind: "actor_path" as const
											},
											type: "hide_actor_components" as const
										}
									],
									restoration: {
										method: "transient_capture_component_lists" as const,
										status: "restored" as const
									},
									status: "captured" as const,
									strategy: "hide_explicit" as const
								};
						if (!failClear) {
							const clearPath = join(directory, "clear.png");
							await writeFile(clearPath, new Uint8Array([...png, 1]));
							stagedArtifacts.push({
								stagingPath: clearPath,
								variant: "clear" as const
							});
						}
						return {
							captureDurationMs: 2,
							clearCompanion,
							contract: request.contract,
							effectiveWorldPose:
								request.viewpoint.kind === "world_fixed"
									? request.viewpoint.approvedPose
									: request.viewpoint.relativePose,
							height: request.resolution.height,
							mapPackageDirtyAfter: false,
							mapPackageDirtyBefore: false,
							mapPath: request.expectedMapPath,
							operationId: request.operationId,
							resolvedSubject: {
								...request.subject,
								transform: {
									location: { x: 0, y: 0, z: 0 },
									rotation: { pitch: 0, roll: 0, yaw: 0 }
								}
							},
							stagedArtifacts,
							status: "captured" as const,
							subjectProjection: {
								margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
								normalizedBounds: { maxX: 0.9, maxY: 0.9, minX: 0.1, minY: 0.1 },
								status: "projected" as const,
								viewportStatus: "fully_within_viewport" as const
							},
							viewId: request.viewId,
							visibility: {
								reason: "Fixture does not assess visibility.",
								status: "not_assessed" as const
							},
							width: request.resolution.width
						};
					},
					catch: (cause) => cause
				})
		};

		const firstIds = ["run-clear", "invocation-clear", "operation-clear"];
		const first = await runCapture(
			{ projectRoot, reviewSetPath },
			port,
			() => firstIds.shift()!
		);
		expect(first.status).toBe("completed");
		expect(first.results[0]).toMatchObject({
			artifacts: expect.arrayContaining([
				expect.objectContaining({ variant: "pure" }),
				expect.objectContaining({ variant: "clear" })
			]),
			clearCompanion: { restoration: { status: "restored" }, status: "captured" },
			visibilityOverrides: {
				hideInClear: [
					expect.objectContaining({
						actorPath: expect.stringContaining("ReviewOccluder")
					})
				]
			},
			visibilityPolicy: {
				id: "explicit-clear",
				output: { clearStrategy: { type: "hide_explicit" }, mode: "natural_and_clear" }
			}
		});

		failClear = true;
		const secondIds = ["run-clear-failed", "invocation-clear-failed", "operation-clear-failed"];
		const second = await runCapture(
			{ projectRoot, reviewSetPath },
			port,
			() => secondIds.shift()!
		);
		expect(second.status).toBe("completed_with_failures");
		expect(second.results[0]).toMatchObject({
			artifacts: [expect.objectContaining({ variant: "pure" })],
			clearCompanion: {
				failure: { code: "clear_actor_not_found" },
				status: "failed"
			}
		});
	});

	it("rejects staging paths outside the project and finalizes an honest failed run", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-reject-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const outside = join(dirname(projectRoot), "outside.png");
		const port: ReviewCapturePortShape = {
			capture: (request) =>
				Effect.succeed({
					captureDurationMs: 1,
					contract: request.contract,
					effectiveWorldPose:
						request.viewpoint.kind === "world_fixed"
							? request.viewpoint.approvedPose
							: request.viewpoint.relativePose,
					height: 720,
					mapPackageDirtyAfter: false,
					mapPackageDirtyBefore: false,
					mapPath: request.expectedMapPath,
					operationId: request.operationId,
					resolvedSubject:
						request.subject.kind === "actor_path"
							? {
									...request.subject,
									transform: {
										location: { x: 0, y: 0, z: 0 },
										rotation: { pitch: 0, roll: 0, yaw: 0 }
									}
								}
							: request.subject,
					clearCompanion: { status: "not_requested" as const },
					stagedArtifacts: [{ stagingPath: outside, variant: "pure" as const }],
					status: "captured",
					subjectProjection: {
						margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
						normalizedBounds: { maxX: 0.9, maxY: 0.9, minX: 0.1, minY: 0.1 },
						status: "projected",
						viewportStatus: "fully_within_viewport"
					},
					viewId: request.viewId,
					visibility: {
						reason: "Fake capture does not assess visibility.",
						status: "not_assessed"
					},
					width: 1280
				})
		};
		const ids = ["run-rejected", "invocation-rejected", "operation-rejected"];
		const run = await runCapture({ projectRoot, reviewSetPath }, port, () => ids.shift()!);
		expect(run.status).toBe("failed");
		expect(run.results[0]).toMatchObject({
			code: "capture_staging_path_rejected",
			status: "failed"
		});
	});

	it("discards staging directories when capture fails before promotion", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-cleanup-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const port: ReviewCapturePortShape = {
			capture: () => Effect.die(new Error("capture boom"))
		};
		const ids = ["run-cleanup", "invocation-cleanup", "operation-cleanup"];
		await expect(
			runCapture({ projectRoot, reviewSetPath }, port, () => ids.shift()!)
		).rejects.toThrow(/capture boom/);
		await expect(
			access(join(captureRunsRoot(projectRoot), ".staging-run-cleanup"))
		).rejects.toThrow();
	});

	it("finishes promotion before observing interruption", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-review-promotion-"));
		temporaryDirectories.push(projectRoot);
		const reviewSetPath = join(projectRoot, "set.json");
		await Effect.runPromise(
			saveReviewSet({ path: reviewSetPath, reviewSet: fixtureReviewSet() }).pipe(
				Effect.provide(ReviewRepositoryLive)
			)
		);
		const png = new Uint8Array([137, 80, 78, 71]);
		const port: ReviewCapturePortShape = {
			capture: (request) =>
				Effect.tryPromise({
					try: async () => {
						const stagingPath = join(
							projectRoot,
							"Saved",
							"UEShed",
							"ReviewStaging",
							request.operationId,
							"pure.png"
						);
						await mkdir(dirname(stagingPath), { recursive: true });
						await writeFile(stagingPath, png);
						return {
							captureDurationMs: 1,
							clearCompanion: { status: "not_requested" as const },
							contract: request.contract,
							effectiveWorldPose:
								request.viewpoint.kind === "world_fixed"
									? request.viewpoint.approvedPose
									: request.viewpoint.relativePose,
							height: 1,
							mapPackageDirtyAfter: false,
							mapPackageDirtyBefore: false,
							mapPath: request.expectedMapPath,
							operationId: request.operationId,
							resolvedSubject:
								request.subject.kind === "actor_path"
									? {
											...request.subject,
											transform: {
												location: { x: 0, y: 0, z: 0 },
												rotation: { pitch: 0, roll: 0, yaw: 0 }
											}
										}
									: request.subject,
							stagedArtifacts: [{ stagingPath, variant: "pure" as const }],
							status: "captured" as const,
							subjectProjection: {
								margins: { bottom: 0.1, left: 0.1, right: 0.1, top: 0.1 },
								normalizedBounds: {
									maxX: 0.9,
									maxY: 0.9,
									minX: 0.1,
									minY: 0.1
								},
								status: "projected" as const,
								viewportStatus: "fully_within_viewport" as const
							},
							viewId: request.viewId,
							visibility: {
								reason: "Fake capture does not assess visibility.",
								status: "not_assessed" as const
							},
							width: 1
						};
					},
					catch: (cause) => cause
				})
		};
		const repository = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* ReviewRepository;
			}).pipe(Effect.provide(ReviewRepositoryLive))
		);
		const promotionStarted = await Effect.runPromise(Deferred.make<void>());
		const releasePromotion = await Effect.runPromise(Deferred.make<void>());
		const gatedRepository = ReviewRepository.of({
			...repository,
			finalizeRun: (args) =>
				Effect.gen(function* () {
					yield* Deferred.succeed(promotionStarted, undefined);
					yield* Deferred.await(releasePromotion);
					yield* repository.finalizeRun(args);
				})
		});
		const ids = ["run-promotion", "invocation-promotion", "operation-promotion"];
		const makeId = () => {
			const id = ids.shift();
			if (!id) throw new Error("Promotion test exhausted its deterministic IDs");
			return id;
		};
		const capture = Effect.flatMap(ReviewCapture, (service) =>
			service.captureSet({
				endpoint: "unused",
				projectRoot,
				reviewSetPath
			})
		).pipe(
			Effect.provide(ReviewCaptureLive),
			Effect.provide(reviewCapturePortLayer(port)),
			Effect.provide(reviewIdGeneratorLayer(makeId)),
			Effect.provide(Layer.succeed(ReviewRepository, gatedRepository))
		);
		const captureFiber = Effect.runFork(capture);
		await Effect.runPromise(Deferred.await(promotionStarted));
		const interruptFiber = Effect.runFork(Fiber.interrupt(captureFiber));
		await Effect.runPromise(Deferred.succeed(releasePromotion, undefined));
		await Effect.runPromise(Fiber.await(interruptFiber));
		await Effect.runPromise(Fiber.await(captureFiber));

		await expect(access(captureRunPath(projectRoot, "run-promotion"))).resolves.toBeUndefined();
		await expect(
			access(join(captureRunsRoot(projectRoot), ".staging-run-promotion"))
		).rejects.toThrow();
	});
});

describe("review staging path validation", () => {
	it("accepts nested project paths and rejects escapes", () => {
		const root = "C:\\Projects\\Fixture";
		expect(isPathWithin(root, join(root, "Saved", "UEShed", "a.png"))).toBe(true);
		expect(isPathWithin(root, join(root, "..", "elsewhere.png"))).toBe(false);
	});
});
