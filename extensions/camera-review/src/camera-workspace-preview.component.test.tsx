// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import {
	ArrangementCameraId,
	cameraAuthoringPanelState,
	ProvisionedCameraBinding,
	type CameraFrame
} from "@ue-shed/cameras";
import { Effect, Schema, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { expect, it, vi } from "vitest";
import {
	fixtureArrangement,
	fixtureSet
} from "../../../packages/cameras/src/camera-arrangement.test-support.js";
import { CameraWorkspace } from "./camera-workspace.js";

it("displays only frames belonging to the provisioned active camera", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const frames = await Effect.runPromise(Queue.unbounded<CameraFrame>());
	const draw = vi.fn();
	// SAFETY: This canvas test double implements the only context method used by the preview.
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		putImageData: draw
	} as never);
	vi.stubGlobal(
		"ImageData",
		class {
			constructor(
				public data: Uint8ClampedArray,
				public width: number,
				public height: number
			) {}
		}
	);
	const panel = cameraAuthoringPanelState(
		{ version: 1, arrangement: fixtureArrangement(), reviewSet: fixtureSet(), outcomes: [] },
		ArrangementCameraId.make("camera-0"),
		{ draftPath: "draft", approvalPath: "views" }
	);
	const preview = Schema.decodeUnknownSync(ProvisionedCameraBinding)({
		cameraId: "expected-camera",
		correlation: { type: "framing_candidate", candidateId: "camera-0" },
		index: 0,
		width: 960,
		height: 540,
		previewContext: "editor_live"
	});
	try {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<CameraWorkspace
					onApproved={() => {}}
					onChooseReviewSet={() => {}}
					client={{
						liveFrames: Stream.fromQueue(frames),
						cameraWorkspace: () =>
							Effect.succeed({ panel, preview, sets: [], error: null })
					}}
				/>
			</EffectRuntimeProvider>
		));
		await screen.findByLabelText("Active camera preview");
		await Effect.runPromise(
			Queue.offer(frames, {
				cameraId: "unrelated-camera",
				cameraIndex: 0,
				producerId: "different-editor",
				sessionId: "different-session",
				captureMonotonicMs: 1,
				receivedMonotonicMs: 1,
				readbackDrops: 0,
				readbackLatencyMs: 0,
				transportReplacements: 0,
				sequence: 1n,
				worldSeconds: 0,
				width: 1,
				height: 1,
				pixels: new Uint8Array([255, 0, 0, 255])
			})
		);
		// FIFO delivery: reaching the matching frame proves the preceding foreign frame was consumed.
		await Effect.runPromise(
			Queue.offer(frames, {
				cameraId: "expected-camera",
				cameraIndex: 0,
				producerId: "editor",
				sessionId: "session",
				captureMonotonicMs: 2,
				receivedMonotonicMs: 2,
				readbackDrops: 0,
				readbackLatencyMs: 0,
				transportReplacements: 0,
				sequence: 2n,
				worldSeconds: 0,
				width: 1,
				height: 1,
				pixels: new Uint8Array([0, 255, 0, 255])
			})
		);
		await waitFor(() => expect(draw).toHaveBeenCalledTimes(1));
		expect(draw.mock.calls[0]?.[0].data).toEqual(new Uint8ClampedArray([0, 255, 0, 255]));
	} finally {
		cleanup();
		await runtime.dispose();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
});
