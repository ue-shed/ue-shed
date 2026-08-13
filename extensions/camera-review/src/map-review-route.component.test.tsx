// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import {
	bootstrapMapReviewSet,
	defaultFramingParameters,
	generateFramingCandidates,
	ReviewAuthoringSession,
	ReviewAuthoringSessionId,
	ReviewSetId,
	ReviewSubjectActorPath,
	ReviewViewId
} from "@ue-shed/cameras";
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
		id: "fixture-review-set",
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
	createReviewSet: () => Effect.die("not used"),
	connectWorld: () =>
		Effect.succeed({
			message: "Offline",
			recovery: "Open Unreal",
			status: "unavailable" as const
		}),
	focusActor: (actorId) => Effect.succeed({ actorId, status: "not_supported" as const }),
	reviewSetLibrary: () =>
		Effect.succeed({
			activeReviewSetId: "fixture-review-set",
			sets: [
				{
					displayName: "Fixture Structure",
					id: "fixture-review-set",
					mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
					viewCount: 1
				}
			],
			status: "ready" as const
		}),
	selectReviewSet: () => Effect.die("not used"),
	worldObservations: () =>
		Stream.make({
			message: "Offline",
			recovery: "Open Unreal",
			status: "unavailable" as const
		})
} satisfies Pick<
	MapReviewClientShape,
	| "connectWorld"
	| "createReviewSet"
	| "focusActor"
	| "reviewSetLibrary"
	| "selectReviewSet"
	| "worldObservations"
>;

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
	it("debounces framing edits into one durable regeneration patch", async () => {
		const parameters = defaultFramingParameters();
		const selection = {
			actorPath:
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
			bounds: {
				center: { x: 0, y: 0, z: 250 },
				extent: { x: 600, y: 450, z: 250 },
				rotation: { pitch: 0, roll: 0, yaw: 15 }
			},
			displayName: "Review Subject",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
		};
		const candidates = generateFramingCandidates(selection);
		const durable = ReviewAuthoringSession.make({
			candidateOverrides: [],
			candidates,
			contract: {
				name: "ue-shed-review-authoring-session",
				version: { major: 1, minor: 0 }
			},
			createdAt: "2026-08-06T00:00:00.000Z",
			diagnostics: [],
			discardedCandidateIds: [],
			framingParameters: parameters,
			id: ReviewAuthoringSessionId.make("framing-session"),
			lifecycle: "active",
			realizations: [],
			reviewSet: {
				id: ReviewSetId.make("fixture-review-set"),
				mapPath: selection.mapPath,
				path: "C:/Fixture/.ue-shed/review/sets/fixture.json"
			},
			selectedCandidateId: candidates[0]?.id,
			subject: {
				actorPath: ReviewSubjectActorPath.make(selection.actorPath),
				bounds: selection.bounds,
				displayName: selection.displayName,
				mapPath: selection.mapPath
			},
			updatedAt: "2026-08-06T00:00:00.000Z",
			viewId: ReviewViewId.make("structure-context")
		});
		const ready: MapReviewAuthoringResult = {
			candidates: candidates.map((candidate) => ({
				diagnostics: candidate.diagnostics,
				displayName: candidate.displayName,
				id: candidate.id,
				pose: candidate.approvedPose,
				preset: candidate.recipe.preset,
				preview: { status: "pending" }
			})),
			selection: {
				actorPath: selection.actorPath,
				displayName: selection.displayName,
				mapPath: selection.mapPath
			},
			session: durable,
			sessionId: durable.id,
			status: "ready",
			viewId: durable.viewId
		};
		const patches: Array<Parameters<MapReviewClientShape["authoringPatch"]>[0]> = [];
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			authoringResume: () => Effect.succeed(ready),
			authoringPatch: (intent) =>
				Effect.sync(() => {
					patches.push(intent);
					return ready;
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewAuthoringCandidate: () =>
				Effect.succeed({
					error: { message: "No preview", recovery: "Continue" },
					status: "failed"
				}),
			previewCandidate: () => Effect.die("not used")
		};
		renderRoute(client);
		await screen.findByText("Review Subject");
		await userEvent.setup().click(screen.getByText("VIEW PRESETS + RIG"));
		const count = screen.getByRole("spinbutton", {
			name: "Context three-quarter exact camera count"
		});
		fireEvent.input(count, { target: { value: "2" } });
		fireEvent.input(
			screen.getByRole("spinbutton", {
				name: "Context three-quarter exact camera count"
			}),
			{ target: { value: "3" } }
		);
		await waitFor(() => expect(patches).toHaveLength(1), { timeout: 1_500 });
		expect(patches[0]?.patch.framingParameters?.groups[0]?.pattern.count).toBe(3);

		const xScrubber = screen.getByRole("button", { name: "Drag X to adjust" });
		fireEvent.pointerDown(xScrubber, { button: 0, clientX: 10, pointerId: 11 });
		fireEvent.pointerMove(xScrubber, { clientX: 15, pointerId: 11 });
		fireEvent.pointerMove(xScrubber, { clientX: 22, pointerId: 11 });
		expect(patches).toHaveLength(1);
		fireEvent.pointerUp(xScrubber, { clientX: 22, pointerId: 11 });
		await waitFor(() => expect(patches).toHaveLength(2));
		expect(patches[1]?.patch.draftPose?.location.x).toBeCloseTo(
			(candidates[0]?.approvedPose.location.x ?? 0) + 12,
			5
		);
	});

	it("offers first-run authoring and can reopen a discovered Review Set", async () => {
		let selectedReviewSetId: string | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed({ status: "setup_required" }),
			previewCandidate: () => Effect.die("not used"),
			reviewSetLibrary: () =>
				Effect.succeed({
					sets: [
						{
							displayName: "Fixture Structure",
							id: "fixture-review-set",
							mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							viewCount: 1
						}
					],
					status: "ready"
				}),
			selectReviewSet: ({ reviewSetId }) =>
				Effect.sync(() => {
					selectedReviewSetId = reviewSetId;
					return empty;
				})
		};

		renderRoute(client);
		expect(
			await screen.findByRole("button", { name: "ADD SELECTED ACTOR AS VIEW" })
		).toBeDefined();
		expect(screen.getByText("Select an actor, then reframe")).toBeDefined();

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "REVIEW SETS" }));
		await user.click(await screen.findByRole("button", { name: "OPEN SET" }));
		expect(selectedReviewSetId).toBe("fixture-review-set");
		expect(await screen.findByText("Fixture Structure")).toBeDefined();
	});

	it("switches between saved Review Sets by stable identity", async () => {
		const lighting = {
			...empty,
			reviewSet: {
				...empty.reviewSet,
				displayName: "Lighting review",
				id: "lighting-review",
				viewCount: 0,
				views: []
			}
		} satisfies MapReviewResult;
		let selectedReviewSetId: string | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewCandidate: () => Effect.die("not used"),
			reviewSetLibrary: () =>
				Effect.succeed({
					activeReviewSetId: "fixture-review-set",
					sets: [
						{
							displayName: "Fixture Structure",
							id: "fixture-review-set",
							mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							viewCount: 1
						},
						{
							displayName: "Lighting review",
							id: "lighting-review",
							mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							viewCount: 0
						}
					],
					status: "ready"
				}),
			selectReviewSet: ({ reviewSetId }) =>
				Effect.sync(() => {
					selectedReviewSetId = reviewSetId;
					return lighting;
				})
		};

		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("Fixture Structure");
		await user.click(screen.getByRole("button", { name: "REVIEW SETS" }));
		expect(await screen.findByRole("dialog", { name: "Review Set library" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "OPEN SET" }));

		expect(selectedReviewSetId).toBe("lighting-review");
		expect(await screen.findByText("Lighting review")).toBeDefined();
		expect(screen.queryByRole("dialog", { name: "Review Set library" })).toBeNull();
	});

	it("creates and opens an empty sibling Review Set", async () => {
		const created = {
			...empty,
			reviewSet: {
				...empty.reviewSet,
				displayName: "Facade pass",
				id: "facade-pass",
				viewCount: 0,
				views: []
			}
		} satisfies MapReviewResult;
		let createdName: string | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			createReviewSet: ({ displayName }) =>
				Effect.sync(() => {
					createdName = displayName;
					return created;
				}),
			load: () => Effect.succeed(empty),
			previewCandidate: () => Effect.die("not used")
		};

		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("Fixture Structure");
		await user.click(screen.getByRole("button", { name: "REVIEW SETS" }));
		await user.type(
			await screen.findByRole("textbox", { name: "New Review Set name" }),
			"Facade pass"
		);
		await user.click(screen.getByRole("button", { name: "CREATE + OPEN" }));

		expect(createdName).toBe("Facade pass");
		expect(await screen.findByText("Facade pass")).toBeDefined();
		expect(screen.queryByRole("dialog", { name: "Review Set library" })).toBeNull();
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
		expect(screen.getAllByText("Structure context").length).toBeGreaterThan(0);
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

	it("keeps Natural primary and exposes matched Clear evidence with a permanent label", async () => {
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => "blob:review-artifact"
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: () => undefined
		});
		const paired = {
			...empty,
			runs: [
				{
					capture: {
						artifacts: [
							{
								bytes: new Uint8Array([1]),
								height: 720,
								variant: "pure",
								width: 1280
							},
							{
								bytes: new Uint8Array([2]),
								height: 720,
								variant: "clear",
								width: 1280
							}
						],
						cause: { type: "external_automation", correlationId: "build-42" },
						clearCompanion: {
							interventions: [
								{
									target: {
										actorPath: "/Game/Fixture.Blocker",
										kind: "actor_path"
									},
									type: "hide_actor_components"
								}
							],
							restoration: {
								method: "transient_capture_component_lists",
								status: "restored"
							},
							status: "captured",
							strategy: "hide_explicit"
						},
						viewId: "structure-context",
						viewName: "Structure context",
						visibility: {
							assessmentDurationMs: 4,
							limitations: ["Translucent pixels may not write depth."],
							method: { method: "depth_compare", version: 1 },
							occluders: [],
							sampleCount: 4096,
							status: "assessed",
							visibleFraction: 0.42
						}
					},
					completedAt: "2026-07-15T08:00:00.000Z",
					failedViews: 0,
					id: "run-paired",
					status: "completed",
					successfulViews: 1
				}
			],
			status: "ready"
		} as unknown as MapReviewResult;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(paired),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);
		expect(await screen.findByText("NATURAL / ORDINARY WORLD")).toBeDefined();
		expect(screen.getByText("42% · depth compare")).toBeDefined();
		expect(screen.getByText("restored")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "CLEAR · MODIFIED VISIBILITY" }));
		expect(screen.getAllByText("CLEAR / MODIFIED VISIBILITY")).toHaveLength(1);
		expect(screen.getByAltText(/Clear capture with modified visibility/)).toBeDefined();
	});

	it("groups several Views by subject and walks one View across run revisions", async () => {
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => "blob:review-history"
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: () => undefined
		});
		const capture = (viewId: string, viewName: string, revision: number) => ({
			artifacts: [
				{
					bytes: new Uint8Array([revision]),
					height: 720,
					variant: "pure" as const,
					width: 1280
				}
			],
			cause: { type: "manual" as const },
			clearCompanion: { status: "not_requested" as const },
			viewId,
			viewName,
			viewRevision: {
				id: `${viewId}-r${revision}`,
				number: revision,
				status: "numbered" as const
			},
			visibility: {
				reason: "Not assessed in component test",
				status: "not_assessed" as const
			}
		});
		const history = {
			...empty,
			reviewSet: {
				...empty.reviewSet,
				viewCount: 2,
				views: [
					{
						actorPath: "/Game/Fixture.Subject",
						displayName: "Structure context",
						id: "structure-context",
						resolution: { height: 720, width: 1280 },
						revision: { id: "structure-context-r2", number: 2 },
						subjectLabel: "Fixture subject",
						viewpoint: "world_fixed"
					},
					{
						actorPath: "/Game/Fixture.Subject",
						displayName: "Detail angle",
						id: "detail-angle",
						resolution: { height: 720, width: 1280 },
						revision: { id: "detail-angle-r1", number: 1 },
						subjectLabel: "Fixture subject",
						viewpoint: "target_relative"
					}
				]
			},
			runs: [
				{
					captures: [
						capture("structure-context", "Structure context", 2),
						capture("detail-angle", "Detail angle", 1)
					],
					completedAt: "2026-07-16T08:00:00.000Z",
					failedViews: 0,
					failures: [],
					id: "run-new",
					status: "completed",
					successfulViews: 2
				},
				{
					captures: [capture("structure-context", "Structure context", 1)],
					completedAt: "2026-07-15T08:00:00.000Z",
					failedViews: 0,
					failures: [],
					id: "run-old",
					status: "completed",
					successfulViews: 1
				}
			],
			status: "ready"
		} as unknown as MapReviewResult;
		let authoringIntent: Parameters<MapReviewClientShape["authorFromSelection"]>[0] | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: (intent) =>
				Effect.sync(() => {
					authoringIntent = intent;
					return {
						error: {
							message: "Stopped after intent",
							recovery: "Component assertion only"
						},
						status: "failed" as const
					};
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(history),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);
		const views = await screen.findByRole("region", { name: "Review views" });
		expect(views.textContent).toContain("ACTORS IN THIS REVIEW SET");
		expect(views.textContent).toContain("Fixture subject");
		expect(screen.getByRole("region", { name: "Fixture subject views" }).textContent).toContain(
			"2 VIEWS"
		);
		expect(views.textContent).toContain("Structure context");
		expect(views.textContent).toContain("Detail angle");
		expect(screen.getByText("r2 · current")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "COMPARE PREVIOUS RUN" }));
		expect(screen.getByAltText("Previous run capture of Structure context")).toBeDefined();
		expect(screen.getByText("PREVIOUS RUN / NATURAL")).toBeDefined();

		await user.click(screen.getByRole("button", { name: /Detail angle/ }));
		const timeline = screen.getByRole("region", { name: "Capture history" });
		expect(timeline.textContent).toContain("captured");
		expect(timeline.textContent).toContain("not in run");
		await user.click(screen.getByRole("button", { name: "REVISE SELECTED VIEW" }));
		await user.click(screen.getByRole("button", { name: "REVISE VIEW FROM SELECTED ACTOR" }));
		expect(authoringIntent).toEqual({
			destination: { kind: "revise_view", viewId: "detail-angle" }
		});
	});

	it("explains map mismatches and can start authoring from the selected map", async () => {
		const intents: Array<Parameters<MapReviewClientShape["authorFromSelection"]>[0]> = [];
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: (intent) =>
				Effect.sync(() => {
					intents.push(intent);
					if (intent.reviewSetMode === "selection_map") {
						return {
							error: {
								message: "Stopped after recovery intent",
								recovery: "Component assertion only"
							},
							status: "failed" as const
						};
					}
					return {
						recovery: "Open a Review Set for the selected map, or start its first set.",
						reviewSet: {
							displayName: "Fixture Structure",
							id: "fixture-review-set",
							mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
							viewCount: 1
						},
						selection: {
							actorPath: "/Game/Hex/L_Hex.L_Hex:PersistentLevel.Subject",
							displayName: "Hex Subject",
							mapPath: "/Game/Hex/L_Hex"
						},
						status: "map_mismatch" as const
					};
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);

		await user.click(await screen.findByRole("button", { name: "ADD SELECTED ACTOR AS VIEW" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("REVIEW SET IS FOR ANOTHER MAP");
		expect(alert.textContent).toContain("/Game/Fixture/Cameras/L_CameraLoad");
		expect(alert.textContent).toContain("/Game/Hex/L_Hex");

		await user.click(screen.getByRole("button", { name: "START SET FOR SELECTED MAP" }));
		await waitFor(() =>
			expect(intents).toEqual([
				{ destination: { kind: "append_view" } },
				{
					destination: { kind: "append_view" },
					reviewSetMode: "selection_map"
				}
			])
		);
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
		let authoringIntent: Parameters<MapReviewClientShape["authorFromSelection"]>[0] | undefined;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: (intent) =>
				Effect.sync(() => {
					approved = intent;
					return { candidateId: intent.candidateId, status: "approved" };
				}),
			authorFromSelection: (intent) =>
				Effect.sync(() => {
					authoringIntent = intent;
					return {
						candidates: [
							{
								diagnostics: [
									{
										code: "subject_margin_below_requested",
										message:
											"The subject margin is below the requested target.",
										severity: "warning"
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
					};
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
		await user.click(screen.getByRole("button", { name: "ADD SELECTED ACTOR AS VIEW" }));
		expect(await screen.findByText("Review Subject")).toBeDefined();
		const zScrubber = screen.getByRole("button", { name: "Drag Z to adjust" });
		fireEvent.pointerDown(zScrubber, { button: 0, clientX: 10, pointerId: 7 });
		fireEvent.pointerMove(zScrubber, { clientX: 35, pointerId: 7 });
		fireEvent.pointerUp(zScrubber, { clientX: 35, pointerId: 7 });
		expect((screen.getByRole("spinbutton", { name: "Z" }) as HTMLInputElement).value).toBe(
			"725"
		);
		await user.type(
			screen.getByRole("textbox", { name: "MANUAL ADJUSTMENT NOTE" }),
			"Lift above foreground"
		);
		const keepView = screen.getByRole("button", { name: "KEEP VIEW" });
		expect((keepView as HTMLButtonElement).disabled).toBe(false);
		await user.click(keepView);
		expect(await screen.findByText("VIEW SAVED")).toBeDefined();
		expect(authoringIntent).toEqual({ destination: { kind: "append_view" } });
		expect(approved).toMatchObject({
			candidateId: "context-three-quarter",
			candidatePose: pose,
			manualPose: { location: { z: 725 } },
			manualReason: "Lift above foreground",
			sourceActorPath: "/Game/Fixture.Subject",
			viewId: "structure-context"
		});
	});

	it("keeps every remaining durable candidate for an actor after discards", async () => {
		const selection = {
			actorPath: "/Game/Fixture.Subject",
			bounds: {
				center: { x: 0, y: 0, z: 0 },
				extent: { x: 100, y: 100, z: 100 },
				rotation: { pitch: 0, roll: 0, yaw: 0 }
			},
			contract: {
				name: "ue-shed-review-selection" as const,
				version: { major: 1 as const, minor: 0 }
			},
			displayName: "Review Subject",
			mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
			status: "selected" as const
		};
		const candidates = generateFramingCandidates(selection).slice(0, 2);
		const [firstCandidate, secondCandidate] = candidates;
		if (firstCandidate === undefined || secondCandidate === undefined) {
			throw new Error("Expected two framing candidates for the batch authoring fixture.");
		}
		const bootstrap = bootstrapMapReviewSet({ projectRoot: "C:/Fixture", selection });
		const durable = ReviewAuthoringSession.make({
			candidates,
			contract: {
				name: "ue-shed-review-authoring-session",
				version: { major: 1, minor: 0 }
			},
			createdAt: "2026-08-12T00:00:00.000Z",
			diagnostics: [],
			discardedCandidateIds: [],
			draftPose: firstCandidate.approvedPose,
			id: ReviewAuthoringSessionId.make("batch-session"),
			lifecycle: "active",
			pendingReviewSet: bootstrap.reviewSet,
			realizations: [],
			reviewSet: {
				id: bootstrap.reviewSet.id,
				mapPath: selection.mapPath,
				path: bootstrap.reviewSetPath
			},
			selectedCandidateId: firstCandidate.id,
			subject: {
				actorPath: ReviewSubjectActorPath.make(selection.actorPath),
				bounds: selection.bounds,
				displayName: selection.displayName,
				mapPath: selection.mapPath
			},
			updatedAt: "2026-08-12T00:00:00.000Z",
			viewId: ReviewViewId.make("review-subject")
		});
		let discardedCandidateIds: ReadonlyArray<string> = [];
		let approvedSessionId: string | undefined;
		const ready: MapReviewAuthoringResult = {
			candidates: candidates.map((candidate) => ({
				diagnostics: candidate.diagnostics,
				displayName: candidate.displayName,
				id: candidate.id,
				pose: candidate.approvedPose,
				preset: candidate.recipe.preset,
				preview: { message: "Preview omitted", status: "failed" }
			})),
			selection: {
				actorPath: selection.actorPath,
				displayName: selection.displayName,
				mapPath: selection.mapPath
			},
			session: durable,
			sessionId: "batch-session",
			status: "ready",
			viewId: "review-subject"
		};
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveAuthoring: ({ sessionId }) =>
				Effect.sync(() => {
					approvedSessionId = sessionId;
					return { candidateId: firstCandidate.id, status: "approved" as const };
				}),
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			authoringResume: () => Effect.succeed(ready),
			authoringPatch: (intent) =>
				Effect.sync(() => {
					discardedCandidateIds = intent.patch.discardedCandidateIds;
					return {
						...ready,
						session: { ...durable, ...intent.patch }
					} satisfies MapReviewAuthoringResult;
				}),
			capture: () => Effect.die("not used"),
			load: () => Effect.succeed(empty),
			previewAuthoringCandidate: () =>
				Effect.succeed({
					error: { message: "Preview omitted", recovery: "Not required" },
					status: "failed"
				}),
			previewCandidate: () => Effect.die("not used")
		};
		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("Review Subject");
		expect(screen.getByRole("button", { name: "KEEP 2 VIEWS" })).toBeDefined();
		await user.click(screen.getAllByRole("button", { name: "DISCARD" })[1]!);
		await waitFor(() => expect(discardedCandidateIds).toEqual([secondCandidate.id]));
		expect(
			screen.queryByRole("button", { name: `Select ${secondCandidate.displayName}` })
		).toBeNull();
		await user.click(screen.getByRole("button", { name: "KEEP 1 VIEW" }));
		expect(await screen.findByText("VIEW SAVED")).toBeDefined();
		expect(approvedSessionId).toBe("batch-session");
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
		let objectUrlCount = 0;
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => `blob:authoring-preview-${++objectUrlCount}`
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: () => undefined
		});
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
		const patches: Array<Parameters<MapReviewClientShape["authoringPatch"]>[0]["patch"]> = [];
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
					patches.push(intent.patch);
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
		const objectUrlsAfterHydrate = objectUrlCount;
		await user.click(screen.getByRole("button", { name: "Select Facade front" }));
		await waitFor(() => expect(patchCount).toBe(1));
		expect(previewCalls.length).toBe(afterHydrate);
		expect(objectUrlCount).toBe(objectUrlsAfterHydrate);

		fireEvent.input(screen.getByRole("spinbutton", { name: "YAW OFFSET" }), {
			target: { value: "12" }
		});
		await waitFor(() => expect(patchCount).toBe(2));
		await waitFor(() => expect(previewCalls.length).toBe(afterHydrate + 1));
		expect(previewCalls.at(-1)?.candidateId).toBe("facade-front");
		expect(patches.at(-1)?.candidateOverrides).toBeDefined();
		expect(patches.at(-1)?.framingParameters).toBeUndefined();
	});

	it("promotes cached PNG previews when the live camera capability connects", async () => {
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: () => "blob:png-fallback"
		});
		Object.defineProperty(URL, "revokeObjectURL", {
			configurable: true,
			value: () => undefined
		});
		const pose = {
			aspectRatio: "16:9" as const,
			fieldOfViewDegrees: 60,
			location: { x: 1000, y: -1000, z: 725 },
			projection: "perspective" as const,
			rotation: { pitch: -15, roll: 0, yaw: 135 }
		};
		const ready: MapReviewAuthoringResult = {
			candidates: [
				{
					diagnostics: [],
					displayName: "Live candidate",
					id: "live-candidate",
					pose,
					preset: "context_three_quarter",
					preview: { status: "pending" }
				}
			],
			selection: {
				actorPath: "/Game/Fixture.Subject",
				displayName: "Live Review Subject",
				mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
			},
			session: {
				discardedCandidateIds: [],
				id: "live-session",
				lifecycle: "active",
				selectedCandidateId: "live-candidate"
			} as never,
			sessionId: "live-session",
			status: "ready",
			viewId: "live-view"
		};
		let previewCalls = 0;
		const client: MapReviewClientShape = {
			...offlineScout,
			...unavailableDurableAuthoring,
			approveCandidate: () => Effect.die("not used"),
			authorFromSelection: () => Effect.die("not used"),
			authoringResume: () => Effect.succeed(ready),
			capture: () => Effect.die("not used"),
			livePreviewAvailable: () => Effect.succeed(true),
			load: () => Effect.succeed(empty),
			previewAuthoringCandidate: () =>
				Effect.sync(() => {
					previewCalls += 1;
					return previewCalls === 1
						? {
								bytes: new Uint8Array([137, 80, 78, 71]),
								height: 180,
								pixelFormat: "png" as const,
								status: "ready" as const,
								width: 320
							}
						: {
								bytes: new Uint8Array(320 * 180 * 4),
								cameraIndex: 0,
								height: 180,
								pixelFormat: "bgra8" as const,
								previewContext: "editor_live" as const,
								status: "ready" as const,
								width: 320
							};
				}),
			previewCandidate: () => Effect.die("not used")
		};

		renderRoute(client);

		expect(await screen.findByText("EDITOR LIVE 5 FPS")).toBeDefined();
		expect(previewCalls).toBe(2);
		expect(screen.queryByText("PNG FALLBACK")).toBeNull();
	});
});
