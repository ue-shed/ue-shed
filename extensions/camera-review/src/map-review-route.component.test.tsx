// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapReviewClientShape, MapReviewResult } from "./map-review-client.js";
import { MapReviewRoute } from "./map-review-route.js";

const empty = {
	reviewSet: {
		displayName: "Fixture Structure",
		mapPath: "/Game/Fixture/Cameras/L_CameraLoad",
		viewCount: 1
	},
	runs: [],
	status: "ready"
} satisfies MapReviewResult;

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
	worldSnapshots: () =>
		Stream.make({
			message: "Offline",
			recovery: "Open Unreal",
			status: "unavailable" as const
		})
} satisfies Pick<MapReviewClientShape, "connectWorld" | "focusActor" | "worldSnapshots">;

function renderRoute(client: MapReviewClientShape) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<MapReviewRoute client={client} />
		</EffectRuntimeProvider>
	));
}

describe("MapReviewRoute", () => {
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
		const client: MapReviewClientShape = {
			...offlineScout,
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
			capture: () =>
				Effect.sync(() => {
					captures += 1;
					return captured;
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
		expect(await screen.findByText("No visual history yet.")).toBeDefined();
		await user.click(screen.getByRole("button", { name: "CAPTURE SET" }));
		expect(await screen.findByText("PURE / ORDINARY WORLD")).toBeDefined();
		expect(screen.getByRole("region", { name: "Capture history" }).textContent).toContain(
			"completed"
		);
		expect(captures).toBe(1);
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
			capture: () => Effect.succeed(empty),
			load: () => Effect.succeed(empty),
			previewCandidate: () =>
				Effect.succeed({
					error: { message: "Preview omitted", recovery: "Not required" },
					status: "failed"
				})
		};
		const user = userEvent.setup();
		renderRoute(client);
		await screen.findByText("No visual history yet.");
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
});
