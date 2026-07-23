// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type {
	MapReviewCaptureResult,
	MapReviewAuthoringResult,
	MapReviewClientShape,
	MapReviewResult
} from "./map-review-client.js";
import { MapReviewRoute } from "./map-review-route.js";

const empty = {
	reviewSet: {
		displayName: "Fixture Structure",
		mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
		viewCount: 1,
		views: [
			{
				displayName: "Structure context",
				id: "structure-context",
				resolution: { height: 720, width: 1280 }
			}
		]
	},
	runs: [],
	status: "ready"
} satisfies MapReviewResult;

function completedCapture(review: Extract<MapReviewResult, { status: "ready" }>) {
	return {
		job: {
			completedAt: "2026-07-15T08:00:00.000Z",
			context: "editor",
			failedViews: 0,
			jobId: "run-001",
			progress: { completedViews: 1, totalViews: 1 },
			runId: "run-001",
			status: "completed",
			successfulViews: 1,
			viewIds: ["structure-context"]
		},
		review,
		status: "completed"
	} satisfies MapReviewCaptureResult;
}

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

const offlineScout = {
	connectWorld: () =>
		Effect.succeed({
			message: "Offline",
			recovery: "Open Unreal",
			status: "unavailable" as const
		}),
	focusActor: (actorId) => Effect.succeed({ actorId, status: "not_supported" as const }),
	worldObservations: () =>
		Stream.make({
			message: "Offline",
			recovery: "Open Unreal",
			status: "unavailable" as const
		})
} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldObservations">;

const unavailableDurableAuthoring = {
	authoringResume: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	authoringPatch: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	authoringReframe: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	discardAuthoring: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	previewAuthoringCandidate: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	approveAuthoring: () =>
		Effect.succeed({
			error: { message: "No saved session", recovery: "Select an actor" },
			status: "failed" as const
		}),
	liveFrames: Stream.empty,
	setLivePreviewFps: (fps) => Effect.succeed(fps)
} satisfies Pick<
	MapReviewClientShape,
	| "approveAuthoring"
	| "authoringPatch"
	| "authoringReframe"
	| "authoringResume"
	| "discardAuthoring"
	| "liveFrames"
	| "previewAuthoringCandidate"
	| "setLivePreviewFps"
>;

function renderRoute(client: MapReviewClientShape) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<MapReviewRoute client={client} />
		</EffectRuntimeProvider>
	));
}

describe("MapReviewRoute", () => {
	it("offers first-run authoring when a configured project has no Review Set", async () => {
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed({ status: "setup_required" }),
			previewCandidate: () => Effect.die("not used")
		};

		renderRoute(client);
		expect(await screen.findByRole("button", { name: "REFRAME SELECTED ACTOR" })).toBeDefined();
		expect(screen.getByText("Select an actor, then reframe")).toBeDefined();
	});

	it("establishes the first durable capture and exposes it in history", async () => {
		const captured = {
			...empty,
			runs: [
				{
					completedAt: "2026-07-15T08:00:00.000Z",
					failedViews: 0,
					id: "run-001",
					status: "completed" as const,
					successfulViews: 1
				}
			]
		};
		let captures = 0;
		let captureViewIds: ReadonlyArray<string> = [];
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.succeed({ candidateId: "context", status: "approved" }),
			authorFromSelection: () =>
				Effect.succeed({
					candidates: [],
					selection: {
						actorPath: "/Game/Fixture.Subject",
						displayName: "Subject",
						mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
					},
					status: "ready",
					viewId: "structure-context"
				}),
			capture: (intent) =>
				Effect.sync(() => {
					captures += 1;
					captureViewIds = intent.viewIds;
					return completedCapture(captured);
				}),
			load: () => Effect.succeed(empty),
			previewCandidate: () =>
				Effect.succeed({
					error: { message: "not used", recovery: "not used" },
					status: "failed"
				})
		};
		const user = userEvent.setup();
		renderRoute(client);
		expect(
			await screen.findByText("No captures yet. Use Capture Set when you want PNG evidence.")
		).toBeDefined();
		await user.click(screen.getByRole("button", { name: "CAPTURE SET" }));
		expect(screen.getByRole("dialog", { name: "Capture review set" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "REVIEW CAPTURE PLAN →" }));
		expect(screen.getByText("Structure context")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "CAPTURE 1 VIEW" }));
		expect(await screen.findByText("Capture finished")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "DONE" }));
		expect(await screen.findByText("PURE / ORDINARY WORLD")).toBeDefined();
		expect(screen.getByRole("region", { name: "Capture history" }).textContent).toContain(
			"completed"
		);
		expect(captures).toBe(1);
		expect(captureViewIds).toEqual(["structure-context"]);
	});

	it("generates, adjusts, and approves a framing candidate through the public client", async () => {
		const pose = {
			aspectRatio: "16:9" as const,
			fieldOfViewDegrees: 60,
			location: { x: 1000, y: -1000, z: 700 },
			projection: "perspective" as const,
			rotation: { pitch: -15, roll: 0, yaw: 135 }
		};
		let approved: Parameters<MapReviewClientShape["approveCandidate"]>[0] | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: (intent) =>
				Effect.sync(() => {
					approved = intent;
					return { candidateId: intent.candidateId, status: "approved" };
				}),
			authorFromSelection: () =>
				Effect.succeed({
					candidates: [
						{
							diagnostics: [
								{
									code: "bounds_snapshot",
									message: "Generated from bounds",
									severity: "info"
								}
							],
							displayName: "Context three-quarter",
							id: "context-three-quarter",
							pose,
							preset: "context_three_quarter",
							preview: {
								message: "Preview omitted in component test",
								status: "failed"
							}
						}
					],
					selection: {
						actorPath: "/Game/Fixture.Subject",
						displayName: "Review Subject",
						mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
					},
					status: "ready",
					viewId: "structure-context"
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewCandidate: () =>
				Effect.succeed({
					error: { message: "Preview omitted", recovery: "Not required" },
					status: "failed"
				})
		};
		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("No captures yet. Use Capture Set when you want PNG evidence.");
		await user.click(screen.getByRole("button", { name: "REFRAME SELECTED ACTOR" }));
		expect(await screen.findByText("Review Subject")).toBeDefined();
		const z = screen.getByRole("spinbutton", { name: "Z" });
		await user.clear(z);
		await user.type(z, "725");
		await user.type(
			screen.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" }),
			"Lift above foreground"
		);
		await user.click(screen.getByRole("button", { name: "KEEP VIEW" }));
		expect(await screen.findByText("APPROVED + SAVED")).toBeDefined();
		expect(approved).toMatchObject({
			candidateId: "context-three-quarter",
			candidatePose: pose,
			manualPose: { location: { z: 725 } },
			manualReason: "Lift above foreground",
			sourceActorPath: "/Game/Fixture.Subject",
			viewId: "structure-context"
		});
	});

	it("resumes durable intent, regenerates previews, and requires explicit Reframe for stale evidence", async () => {
		const pose = {
			aspectRatio: "16:9" as const,
			fieldOfViewDegrees: 60,
			location: { x: 1000, y: -1000, z: 725 },
			projection: "perspective" as const,
			rotation: { pitch: -15, roll: 0, yaw: 135 }
		};
		const subject = {
			actorPath: "/Game/Fixture.Subject",
			displayName: "Recovered Review Subject",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		};
		const recovered: MapReviewAuthoringResult = {
			candidates: [
				{
					diagnostics: [
						{
							code: "subject_margin_below_requested",
							message: "The subject is below the requested framing margin.",
							severity: "warning"
						}
					],
					displayName: "Recovered framing",
					id: "recovered-candidate",
					pose,
					preset: "context_three_quarter",
					preview: { status: "pending" }
				},
				{
					diagnostics: [],
					displayName: "Discarded framing",
					id: "discarded-candidate",
					pose,
					preset: "facade_front",
					preview: { status: "pending" }
				}
			],
			selection: subject,
			session: {
				candidates: [],
				contract: {
					name: "ue-shed-review-authoring-session",
					version: { major: 1, minor: 0 }
				},
				createdAt: "2026-07-20T00:00:00.000Z",
				diagnostics: [],
				discardedCandidateIds: ["discarded-candidate"],
				draftPose: pose,
				id: "recovered-session",
				lifecycle: "stale",
				manualReason: "Recovered art direction note",
				realizations: [],
				reviewSet: {
					id: "fixture-review-set",
					mapPath: subject.mapPath,
					path: "C:/Fixture/.ue-shed/review/sets/fixture.json"
				},
				selectedCandidateId: "recovered-candidate",
				subject: {
					actorPath: subject.actorPath,
					bounds: {
						center: { x: 0, y: 0, z: 0 },
						extent: { x: 1, y: 1, z: 1 },
						rotation: { pitch: 0, roll: 0, yaw: 0 }
					},
					displayName: subject.displayName,
					mapPath: subject.mapPath
				},
				updatedAt: "2026-07-20T00:00:01.000Z",
				viewId: "structure-context"
			} as never,
			sessionId: "recovered-session",
			status: "ready",
			viewId: "structure-context"
		};
		let reframeCount = 0;
		const regeneratedPreviews: Array<{
			readonly candidateId: string;
			readonly sessionId: string;
		}> = [];
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			authoringResume: () => Effect.succeed(recovered),
			authoringReframe: () =>
				Effect.sync(() => {
					reframeCount += 1;
					return recovered;
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewAuthoringCandidate: (intent) =>
				Effect.sync(() => {
					regeneratedPreviews.push(intent);
					return {
						error: {
							message: "Preview unavailable in component test",
							recovery: "Reframe"
						},
						status: "failed" as const
					};
				}),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("Recovered Review Subject");
		expect(
			(screen.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" }) as HTMLInputElement)
				.value
		).toBe("Recovered art direction note");
		expect(screen.queryByText("Discarded framing")).toBeNull();
		expect(screen.getByRole("status").textContent).toMatch(
			/below the requested framing margin/i
		);
		expect(
			(screen.getByRole("button", { name: "KEEP VIEW" }) as HTMLButtonElement).disabled
		).toBe(true);
		await waitFor(() =>
			expect(regeneratedPreviews).toEqual([
				{ candidateId: "recovered-candidate", sessionId: "recovered-session" },
				{ candidateId: "discarded-candidate", sessionId: "recovered-session" }
			])
		);
		await user.click(screen.getByRole("button", { name: "REFRAME SELECTED ACTOR" }));
		await waitFor(() => expect(reframeCount).toBe(1));
	});

	it("keeps cached tile previews when selecting another candidate", async () => {
		const poseA = {
			aspectRatio: "16:9" as const,
			fieldOfViewDegrees: 60,
			location: { x: 1000, y: -1000, z: 725 },
			projection: "perspective" as const,
			rotation: { pitch: -15, roll: 0, yaw: 135 }
		};
		const poseB = {
			...poseA,
			location: { x: 0, y: -1200, z: 400 },
			rotation: { pitch: -10, roll: 0, yaw: 90 }
		};
		const subject = {
			actorPath: "/Game/Fixture.Subject",
			displayName: "Review Subject",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		};
		const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const ready: MapReviewAuthoringResult = {
			candidates: [
				{
					diagnostics: [],
					displayName: "Context three-quarter",
					id: "context-three-quarter",
					pose: poseA,
					preset: "context_three_quarter",
					preview: {
						bytes: pngBytes,
						height: 180,
						status: "ready",
						width: 320
					}
				},
				{
					diagnostics: [],
					displayName: "Facade front",
					id: "facade-front",
					pose: poseB,
					preset: "facade_front",
					preview: {
						bytes: pngBytes,
						height: 180,
						status: "ready",
						width: 320
					}
				}
			],
			selection: subject,
			session: {
				candidates: [],
				contract: {
					name: "ue-shed-review-authoring-session",
					version: { major: 1, minor: 0 }
				},
				createdAt: "2026-07-20T00:00:00.000Z",
				diagnostics: [],
				discardedCandidateIds: [],
				draftPose: poseA,
				id: "session-select",
				lifecycle: "active",
				manualReason: "",
				realizations: [],
				reviewSet: {
					id: "fixture-review-set",
					mapPath: subject.mapPath,
					path: "C:/Fixture/.ue-shed/review/sets/fixture.json"
				},
				selectedCandidateId: "context-three-quarter",
				subject: {
					actorPath: subject.actorPath,
					bounds: {
						center: { x: 0, y: 0, z: 0 },
						extent: { x: 1, y: 1, z: 1 },
						rotation: { pitch: 0, roll: 0, yaw: 0 }
					},
					displayName: subject.displayName,
					mapPath: subject.mapPath
				},
				updatedAt: "2026-07-20T00:00:01.000Z",
				viewId: "structure-context"
			} as never,
			sessionId: "session-select",
			status: "ready",
			viewId: "structure-context"
		};
		const previewCalls: Array<{
			readonly candidateId: string;
			readonly sessionId: string;
		}> = [];
		let patchCount = 0;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			authoringResume: () => Effect.succeed(ready),
			authoringPatch: (intent) =>
				Effect.sync(() => {
					patchCount += 1;
					const session = ready.session;
					if (!session) throw new Error("expected durable authoring session");
					return {
						...ready,
						session: {
							...session,
							selectedCandidateId: intent.patch.selectedCandidateId
						}
					} satisfies MapReviewAuthoringResult;
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewAuthoringCandidate: (intent) =>
				Effect.sync(() => {
					previewCalls.push(intent);
					return {
						bytes: pngBytes,
						height: 180,
						pixelFormat: "png" as const,
						status: "ready" as const,
						width: 320
					};
				}),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("Review Subject");
		await waitFor(() => expect(previewCalls.length).toBe(2));
		const afterHydrate = previewCalls.length;
		await user.click(screen.getByRole("button", { name: "Select Facade front" }));
		await waitFor(() => expect(patchCount).toBe(1));
		expect(previewCalls.length).toBe(afterHydrate);
	});
});
