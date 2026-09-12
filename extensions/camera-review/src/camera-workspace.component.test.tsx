// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import {
	cameraAuthoringPanelState,
	applyCameraArrangementCommand,
	ArrangementCameraId
} from "@ue-shed/cameras";
import type {
	CameraWorkspaceRequest,
	CameraWorkspaceResult
} from "@ue-shed/cameras/review-contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	fixtureArrangement,
	fixtureSet
} from "../../../packages/cameras/src/camera-arrangement.test-support.js";
import { CameraWorkspace } from "./camera-workspace.js";

afterEach(cleanup);
describe("camera workspace", () => {
	it("loads one set, scopes edits, preserves the canvas, and saves all its views", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		let arrangement = fixtureArrangement();
		arrangement = {
			...arrangement,
			visibility: {
				hide: [
					{
						label: "Column",
						locator: {
							kind: "actor_path",
							actorPath: "/Game/Fixture.Fixture:PersistentLevel.Column"
						}
					}
				],
				protect: []
			}
		};
		const requests: CameraWorkspaceRequest[] = [];
		let opened = false;
		let saved = 0;
		let published = 0;
		const result = (): CameraWorkspaceResult => ({
			savedViews: published
				? [{ id: arrangement.cameras[0]!.viewId, revision: published }]
				: [],
			panel: opened
				? cameraAuthoringPanelState(
						{ arrangement, reviewSet: fixtureSet(), version: 1, outcomes: [] },
						ArrangementCameraId.make("camera-0"),
						{ draftPath: "draft", approvalPath: "views" }
					)
				: null,
			sets: [{ id: arrangement.id, name: "Assembly", actorPath: "Subject", cameras: 6 }],
			error: null
		});
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<CameraWorkspace
					onApproved={() => saved++}
					onChooseReviewSet={() => undefined}
					client={{
						liveFrames: Stream.empty,
						cameraWorkspace: (request) =>
							Effect.sync(() => {
								requests.push(structuredClone(request));
								if (request.kind === "action" && request.action.kind === "approve")
									published++;
								if (request.kind === "open") opened = true;
								if (request.kind === "action" && request.action.kind === "command")
									arrangement = applyCameraArrangementCommand(
										arrangement,
										request.action.command
									);
								return result();
							})
					}}
				/>
			</EffectRuntimeProvider>
		));
		fireEvent.click(await screen.findByRole("button", { name: /Assembly/ }));
		const canvas = await screen.findByLabelText("Active camera preview");
		fireEvent.change(screen.getByLabelText("FOV"), { target: { value: "45" } });
		await waitFor(() => expect(arrangement.settings.fieldOfViewDegrees).toBe(45));
		fireEvent.click(screen.getByRole("button", { name: "This camera" }));
		fireEvent.change(screen.getByLabelText("FOV"), { target: { value: "32" } });
		await waitFor(() => expect(arrangement.cameras[0]?.overrides.fieldOfViewDegrees).toBe(32));
		expect(arrangement.cameras[1]?.overrides.fieldOfViewDegrees).toBeUndefined();
		expect(screen.getByLabelText("Active camera preview")).toBe(canvas);
		fireEvent.click(screen.getByRole("button", { name: "Visibility" }));
		expect(screen.getByText("Column")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Remove Column" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Framing" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset FOV" }));
		await waitFor(() =>
			expect(arrangement.cameras[0]?.overrides.fieldOfViewDegrees).toBeUndefined()
		);
		fireEvent.click(screen.getByRole("button", { name: "Capture" }));
		fireEvent.change(screen.getByLabelText("Exposure"), { target: { value: "fixed_ev100" } });
		await waitFor(() => expect(arrangement.renderPolicy?.exposure.mode).toBe("fixed_ev100"));
		fireEvent.change(screen.getByLabelText("EV100"), { target: { value: "8.5" } });
		await waitFor(() =>
			expect(arrangement.renderPolicy?.exposure).toMatchObject({
				mode: "fixed_ev100",
				ev100: 8.5
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Save views" }));
		await waitFor(() => expect(saved).toBe(1));
		expect(requests.at(-1)).toMatchObject({
			kind: "action",
			action: { kind: "approve", cameraIds: arrangement.cameras.map((camera) => camera.id) }
		});
		published++;
		await waitFor(() => expect(saved).toBe(2), { timeout: 2500 });
		cleanup();
		await runtime.dispose();
	});
});
