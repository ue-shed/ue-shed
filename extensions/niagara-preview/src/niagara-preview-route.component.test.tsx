import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { NiagaraPreviewRunManifest } from "@ue-shed/niagara/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	NiagaraPreviewClientApi,
	NiagaraPreviewFrameResult
} from "./niagara-preview-client.js";
import { NiagaraPreviewRoute } from "./niagara-preview-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

const manifest = Schema.decodeUnknownSync(NiagaraPreviewRunManifest)({
	alphaPolicy: "scene_opacity_or_emissive_coverage_v1",
	artifacts: [
		{
			bytes: 8,
			height: 512,
			index: 0,
			maximumRgb: 0.9,
			mimeType: "image/png",
			nonTransparentPixelFraction: 0.4,
			relativePath: "frames/frame_0000.png",
			sha256: `sha256:${"0".repeat(64)}`,
			timeSeconds: 0,
			width: 512
		},
		{
			bytes: 9,
			height: 512,
			index: 1,
			maximumRgb: 1,
			mimeType: "image/png",
			nonTransparentPixelFraction: 0.75,
			relativePath: "frames/frame_0001.png",
			sha256: `sha256:${"1".repeat(64)}`,
			timeSeconds: 0.5,
			width: 512
		}
	],
	camera: {
		aspectRatio: 1,
		fieldOfViewDegrees: 45,
		location: { x: 0, y: 0, z: 100 },
		orthoWidth: 0,
		projection: "perspective",
		rotation: { pitch: 0, roll: 0, yaw: 0 },
		usesCustomAspectRatio: false
	},
	colorSpace: "srgb",
	contract: { name: "ue-shed-niagara-preview-run", version: { major: 1, minor: 0 } },
	diagnostics: [],
	effectiveSettings: {
		captureMode: "component_only",
		durationSeconds: 1,
		frameCount: 2,
		frameIntervalSeconds: 0.5,
		height: 512,
		playbackFramesPerSecond: 2,
		simulationFramesPerSecond: 60,
		startSeconds: 0,
		width: 512
	},
	generatedAtUtc: "2026-08-20T00:00:00.000Z",
	producer: {
		engineVersion: "5.7.0",
		receiptContract: {
			name: "ue-shed-niagara-preview-receipt",
			version: { major: 1, minor: 0 }
		}
	},
	requestedSettings: {},
	runId: "123e4567-e89b-42d3-a456-426614174000",
	status: "complete",
	systemObjectPath: "/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"
});

const onDemandManifest = Schema.decodeUnknownSync(NiagaraPreviewRunManifest)({
	...manifest,
	artifacts: manifest.artifacts.map((artifact) => ({
		...artifact,
		bytes: 40 * 1024 * 1024
	}))
});

beforeAll(() => {
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		value: vi.fn(() => "blob:niagara-frame")
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		value: vi.fn()
	});
});

function renderRoute(client: NiagaraPreviewClientApi) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<NiagaraPreviewRoute client={client} />
		</EffectRuntimeProvider>
	));
}

describe("NiagaraPreviewRoute", () => {
	it("captures a run and reviews only manifest-owned frames", async () => {
		const selected: string[] = [];
		const client: NiagaraPreviewClientApi = {
			run: () =>
				Effect.succeed({
					manifest,
					manifestPath: "C:/Project/.ue-shed/niagara-preview/runs/run/manifest.json",
					status: "completed"
				}),
			frame: (intent) => {
				selected.push(intent.relativePath);
				return Effect.succeed({
					bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
					status: "ready"
				});
			}
		};
		renderRoute(client);

		expect(screen.getByRole("heading", { name: "Proof, outside the editor." })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		expect(screen.getByText("● VERIFIED")).toBeDefined();
		expect(screen.getByText("512 × 512")).toBeDefined();
		expect(selected).toEqual(["frames/frame_0000.png", "frames/frame_0001.png"]);
		expect(screen.getByRole("button", { name: "Pause preview" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));

		fireEvent.click(screen.getByRole("button", { name: "Show frame 1" }));
		await screen.findByAltText("Niagara preview frame 1");
		expect(selected).toEqual(["frames/frame_0000.png", "frames/frame_0001.png"]);
		fireEvent.click(screen.getByRole("button", { name: "Restart preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		expect(screen.getByRole("button", { name: "Pause preview" })).toBeDefined();
	});

	it("plays the captured effect on a loop", async () => {
		const client: NiagaraPreviewClientApi = {
			run: () =>
				Effect.succeed({
					manifest,
					manifestPath: "C:/Project/.ue-shed/niagara-preview/runs/run/manifest.json",
					status: "completed"
				}),
			frame: () =>
				Effect.succeed({
					bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
					status: "ready"
				})
		};
		renderRoute(client);
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		await waitFor(() => expect(screen.getByAltText("Niagara preview frame 1")).toBeDefined(), {
			timeout: 1_500
		});
	});

	it("keeps the latest cached selection when an older on-demand read completes late", async () => {
		const pendingFrame = await runtime.runPromise(Deferred.make<NiagaraPreviewFrameResult>());
		const pendingFrameSettled = await runtime.runPromise(Deferred.make<void>());
		const readyFrame = {
			bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			status: "ready"
		} as const;
		const client: NiagaraPreviewClientApi = {
			run: () =>
				Effect.succeed({
					manifest: onDemandManifest,
					manifestPath: "C:/Project/.ue-shed/niagara-preview/runs/run/manifest.json",
					status: "completed"
				}),
			frame: ({ relativePath }) =>
				relativePath.endsWith("0000.png")
					? Effect.succeed(readyFrame)
					: Deferred.await(pendingFrame).pipe(
							Effect.uninterruptible,
							Effect.ensuring(Deferred.succeed(pendingFrameSettled, undefined))
						)
		};
		renderRoute(client);

		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
		fireEvent.click(screen.getByRole("button", { name: "Show frame 1" }));
		await screen.findByText("BUFFERING 02");

		fireEvent.click(screen.getByRole("button", { name: "Show frame 0" }));
		expect(screen.getByAltText("Niagara preview frame 0")).toBeDefined();
		expect(screen.queryByText("BUFFERING 02")).toBeNull();

		await runtime.runPromise(Deferred.succeed(pendingFrame, readyFrame));
		await runtime.runPromise(Deferred.await(pendingFrameSettled));
		await runtime.runPromise(Effect.yieldNow);
		expect(screen.getByAltText("Niagara preview frame 0")).toBeDefined();
		expect(screen.queryByAltText("Niagara preview frame 1")).toBeNull();
	});

	it("keeps typed producer recovery visible", async () => {
		const client: NiagaraPreviewClientApi = {
			run: () =>
				Effect.succeed({
					error: {
						code: "baker_camera_missing",
						message: "No valid saved Baker camera was available.",
						recovery: "Save a Baker camera on the Niagara System, then retry.",
						retrySafe: false,
						stage: "capture"
					},
					status: "failed"
				}),
			frame: () => Effect.die("frame should not be requested")
		};
		renderRoute(client);
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByRole("alert");
		expect(screen.getByText("No valid saved Baker camera was available.")).toBeDefined();
		expect(
			screen.getByText("Save a Baker camera on the Niagara System, then retry.")
		).toBeDefined();
	});
});
