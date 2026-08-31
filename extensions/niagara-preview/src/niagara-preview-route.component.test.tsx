import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { NiagaraPreviewRunManifest, NiagaraSystemObjectPath } from "@ue-shed/niagara/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	NiagaraPreviewClientApi,
	NiagaraPreviewFrameResult
} from "./niagara-preview-client.js";
import { NiagaraPreviewClientError } from "./niagara-preview-client.js";
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

const fixtureSystem = NiagaraSystemObjectPath.make("/Game/FX/NS_Fixture.NS_Fixture");
const fixtureRunPath = "C:/Project/.ue-shed/niagara-preview/runs/run/manifest.json";

function makeClient(overrides?: Partial<NiagaraPreviewClientApi>): NiagaraPreviewClientApi {
	return {
		catalogue: () =>
			Effect.succeed({
				entries: [
					{ objectPath: fixtureSystem },
					{ objectPath: NiagaraSystemObjectPath.make("/Game/FX/NS_Second.NS_Second") }
				],
				status: "ready" as const
			}),
		frame: () =>
			Effect.succeed({
				bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
				status: "ready" as const
			}),
		run: () =>
			Effect.succeed({
				manifest,
				manifestPath: fixtureRunPath,
				status: "completed" as const
			}),
		...overrides
	};
}

describe("NiagaraPreviewRoute", () => {
	it("captures a run and reviews only manifest-owned frames", async () => {
		const selected: string[] = [];
		const client = makeClient({
			frame: (intent) => {
				selected.push(intent.relativePath);
				return Effect.succeed({
					bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
					status: "ready"
				});
			}
		});
		renderRoute(client);

		expect(screen.getByRole("heading", { name: "Niagara preview" })).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		expect(screen.getByText("Verified")).toBeDefined();
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
		renderRoute(makeClient());
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		await waitFor(() => expect(screen.getByAltText("Niagara preview frame 1")).toBeDefined(), {
			timeout: 1_500
		});
	});

	it("captures the system selected from the catalogue", async () => {
		const runs: string[] = [];
		renderRoute(
			makeClient({
				run: (intent) => {
					runs.push(intent.systemObjectPath);
					return Effect.succeed({
						manifest,
						manifestPath: fixtureRunPath,
						status: "completed"
					});
				}
			})
		);
		await screen.findByRole("button", { name: /NS_Fixture/ });
		fireEvent.click(screen.getByRole("button", { name: /NS_Second/ }));
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByText("Verified");
		expect(runs).toEqual(["/Game/FX/NS_Second.NS_Second"]);
	});

	it("surfaces catalogue failures with recovery guidance", async () => {
		renderRoute(
			makeClient({
				catalogue: () =>
					Effect.succeed({
						error: {
							message: "Project Index returned a page from a different generation.",
							recovery: "Refresh the Project Index, then retry."
						},
						status: "failed" as const
					})
			})
		);
		await screen.findByRole("alert");
		expect(
			screen.getByText("Project Index returned a page from a different generation.")
		).toBeDefined();
		expect(screen.getByText("Refresh the Project Index, then retry.")).toBeDefined();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeDefined();
	});

	it("renders catalogue transport failures as one readable sentence", async () => {
		renderRoute(
			makeClient({
				catalogue: () =>
					Effect.fail(
						new NiagaraPreviewClientError({
							cause: new Error(
								"Error invoking remote method 'niagara-preview:catalogue': Error: channel closed"
							),
							message: "The Niagara system catalogue request failed: channel closed",
							operation: "niagaraPreview.catalogue",
							recovery: "Restart Workbench and verify the selected project."
						})
					)
			})
		);
		await screen.findByRole("alert");
		expect(
			screen.getByText("The Niagara system catalogue request failed: channel closed")
		).toBeDefined();
		expect(
			screen.getByText("Restart Workbench and verify the selected project.")
		).toBeDefined();
		expect(screen.getByText("Technical details")).toBeDefined();
		expect(screen.queryByText(/Fail\(NiagaraPreview/)).toBeNull();
	});

	it("keeps run transport failures readable instead of dumping the cause", async () => {
		renderRoute(
			makeClient({
				run: () =>
					Effect.fail(
						new NiagaraPreviewClientError({
							cause: new Error(
								"Error invoking remote method 'niagara-preview:run': Error: renderer gone"
							),
							message: "The preview capture request failed: renderer gone",
							operation: "niagaraPreview.run",
							recovery: "Restart Workbench and verify the selected project."
						})
					)
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByRole("alert");
		expect(screen.getByText("The preview capture request failed: renderer gone")).toBeDefined();
		expect(
			screen.getByText("Restart Workbench and verify the selected project.")
		).toBeDefined();
		expect(screen.queryByText(/Fail\(NiagaraPreview/)).toBeNull();
		expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
	});

	it("keeps a manually typed path for engine content", async () => {
		const runs: string[] = [];
		renderRoute(
			makeClient({
				run: (intent) => {
					runs.push(intent.systemObjectPath);
					return Effect.succeed({
						manifest,
						manifestPath: fixtureRunPath,
						status: "completed"
					});
				}
			})
		);
		fireEvent.click(await screen.findByText("Use a path outside the project"));
		const input = await screen.findByLabelText("Niagara System object path");
		fireEvent.input(input, {
			target: {
				value: "/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"
			}
		});
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByText("Verified");
		expect(runs).toEqual([
			"/Niagara/DefaultAssets/Templates/Systems/SimpleExplosion.SimpleExplosion"
		]);
	});

	it("keeps the latest cached selection when an older on-demand read completes late", async () => {
		const pendingFrame = await runtime.runPromise(Deferred.make<NiagaraPreviewFrameResult>());
		const pendingFrameSettled = await runtime.runPromise(Deferred.make<void>());
		const readyFrame = {
			bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			status: "ready"
		} as const;
		renderRoute(
			makeClient({
				run: () =>
					Effect.succeed({
						manifest: onDemandManifest,
						manifestPath: fixtureRunPath,
						status: "completed"
					}),
				frame: ({ relativePath }) =>
					relativePath.endsWith("0000.png")
						? Effect.succeed(readyFrame)
						: Deferred.await(pendingFrame).pipe(
								Effect.uninterruptible,
								Effect.ensuring(Deferred.succeed(pendingFrameSettled, undefined))
							)
			})
		);

		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByAltText("Niagara preview frame 0");
		fireEvent.click(screen.getByRole("button", { name: "Pause preview" }));
		fireEvent.click(screen.getByRole("button", { name: "Show frame 1" }));
		await screen.findByText("Buffering 02");

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
		renderRoute(
			makeClient({
				run: () =>
					Effect.succeed({
						error: {
							code: "baker_camera_missing",
							message: "No valid saved Baker camera was available.",
							recovery: "Save a Baker camera on the Niagara System, then retry.",
							retrySafe: false,
							stage: "capture"
						},
						status: "failed" as const
					})
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Capture preview" }));
		await screen.findByRole("alert");
		expect(screen.getByText("Couldn’t capture this preview")).toBeDefined();
		expect(screen.getByText("No valid saved Baker camera was available.")).toBeDefined();
		expect(
			screen.getByText("Save a Baker camera on the Niagara System, then retry.")
		).toBeDefined();
		expect(screen.getByText("Check the cause below before capturing again.")).toBeDefined();
		expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
	});
});
