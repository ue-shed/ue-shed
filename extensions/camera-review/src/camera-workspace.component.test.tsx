// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import {
	cameraAuthoringPanelState,
	applyCameraArrangementCommand,
	ArrangementCameraId,
	CameraBridgeSnapshot,
	resolveArrangementCamera
} from "@ue-shed/cameras";
import type {
	CameraWorkspaceRequest,
	CameraWorkspaceResult
} from "@ue-shed/cameras/review-contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@testing-library/user-event";
import {
	fixtureArrangement,
	fixtureSet
} from "../../../packages/cameras/src/camera-arrangement.test-support.js";
import { CameraWorkspace } from "./camera-workspace.js";

afterEach(cleanup);
describe("camera workspace", () => {
	it("reviews a conflict and submits an explicit recovery choice by keyboard", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const arrangement = fixtureArrangement();
		const panel = cameraAuthoringPanelState(
			{ version: 1, arrangement, reviewSet: fixtureSet(), outcomes: [] },
			ArrangementCameraId.make("camera-0"),
			{ draftPath: "draft", approvalPath: "views" }
		);
		const native = CameraBridgeSnapshot.make({
			version: 1,
			status: "ready",
			message: "",
			sessionId: arrangement.id,
			cameraId: ArrangementCameraId.make("camera-0"),
			producerId: "fixture",
			revision: 0,
			sequence: 1,
			pending: true,
			piloting: false,
			saveRequested: false,
			pose: { ...resolveArrangementCamera(arrangement, "camera-0"), fieldOfViewDegrees: 55 }
		});
		const proposal = {
			version: 1 as const,
			expectedRevision: 0,
			native,
			saved: [
				{ id: native.cameraId, pose: resolveArrangementCamera(arrangement, "camera-0") }
			]
		};
		const requests: CameraWorkspaceRequest[] = [];
		let reviewed = false;
		const approved = vi.fn();
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<CameraWorkspace
					onApproved={approved}
					onChooseReviewSet={() => undefined}
					client={{
						liveFrames: Stream.empty,
						cameraWorkspace: (request) =>
							Effect.sync(() => {
								requests.push(request);
								if (request.kind === "inspect_recovery") reviewed = true;
								return {
									panel,
									sets: [],
									error: "Native and host edits overlap.",
									recovery: reviewed ? proposal : null
								};
							})
					}}
				/>
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: "Inspect pending camera edits" })
		);
		const keep = await screen.findByRole("button", { name: "Keep saved draft" });
		expect(screen.getByText(/saved FOV 60°/).textContent).toContain("Unreal FOV 55");
		expect(requests.some((request) => request.kind === "resolve_recovery")).toBe(false);
		keep.focus();
		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(requests).toContainEqual({ kind: "resolve_recovery", proposal, choice: "saved" })
		);
		expect(approved).not.toHaveBeenCalled();
		await runtime.dispose();
	});
	it("submits first-set creation and keeps a failed create visible across background refreshes", async () => {
		const runtime = ManagedRuntime.make(Layer.empty);
		const requests: CameraWorkspaceRequest[] = [];
		const opened = vi.fn();
		let failCreate = true;
		let polls = 0;
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<CameraWorkspace
					onApproved={() => undefined}
					onOpened={opened}
					onChooseReviewSet={() => undefined}
					client={{
						liveFrames: Stream.empty,
						cameraWorkspace: (request) =>
							Effect.sync(() => {
								requests.push(request);
								if (request.kind === "state") polls++;
								return {
									sets: [],
									error:
										request.kind === "open" && failCreate
											? "Select one actor in Unreal first."
											: null,
									panel:
										request.kind === "open" && !failCreate
											? cameraAuthoringPanelState(
													{
														arrangement: fixtureArrangement(),
														reviewSet: fixtureSet(),
														version: 1,
														outcomes: []
													},
													ArrangementCameraId.make("camera-0"),
													{ draftPath: "draft", approvalPath: "views" }
												)
											: null
								};
							})
					}}
				/>
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "New camera set" }));
		await user.type(screen.getByRole("textbox", { name: "Set name" }), "First cameras");
		await user.selectOptions(screen.getByRole("combobox", { name: "Camera preset" }), "Orbit");
		await user.click(screen.getByRole("button", { name: "Create from Unreal selection" }));
		await screen.findByRole("alert");
		expect(requests).toContainEqual({
			kind: "open",
			name: "First cameras",
			layout: {
				kind: "orbit",
				count: 8,
				startDegrees: 0,
				spanDegrees: 360,
				orientation: "world"
			}
		});
		const priorPolls = polls;
		await waitFor(() => expect(polls).toBeGreaterThan(priorPolls), { timeout: 2500 });
		expect(screen.getByRole("alert").textContent).toContain("Select one actor");
		failCreate = false;
		await user.click(screen.getByRole("button", { name: "Create from Unreal selection" }));
		await waitFor(() => expect(opened).toHaveBeenCalledOnce());
		expect(screen.queryByRole("alert")).toBeNull();
		cleanup();
		await runtime.dispose();
	});
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
