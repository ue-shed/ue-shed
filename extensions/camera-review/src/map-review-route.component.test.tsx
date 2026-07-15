// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { MapReviewRoute, type MapReviewClient, type MapReviewResult } from "./map-review-route.js";

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
		const client: MapReviewClient = {
			approveCandidate: async () => ({ candidateId: "context", status: "approved" }),
			authorFromSelection: async () => ({
				candidates: [],
				selection: {
					actorPath: "/Game/Fixture.Subject",
					displayName: "Subject",
					mapPath: "/Game/Fixture/Cameras/L_CameraLoad"
				},
				status: "ready",
				viewId: "structure-context"
			}),
			capture: async () => {
				captures += 1;
				return captured;
			},
			load: async () => empty,
			previewCandidate: async () => ({
				error: { message: "not used", recovery: "not used" },
				status: "failed"
			})
		};
		const user = userEvent.setup();
		render(() => <MapReviewRoute client={client} />);
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
		let approved: Parameters<MapReviewClient["approveCandidate"]>[0] | undefined;
		const client: MapReviewClient = {
			approveCandidate: async (intent) => {
				approved = intent;
				return { candidateId: intent.candidateId, status: "approved" };
			},
			authorFromSelection: async () => ({
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
						preview: { message: "Preview omitted in component test", status: "failed" }
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
			capture: async () => empty,
			load: async () => empty,
			previewCandidate: async () => ({
				error: { message: "Preview omitted", recovery: "Not required" },
				status: "failed"
			})
		};
		const user = userEvent.setup();
		render(() => <MapReviewRoute client={client} />);
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
