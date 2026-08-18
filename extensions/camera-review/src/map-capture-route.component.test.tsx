// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { decodeMapCapturePlan } from "@ue-shed/cameras/map-tiles";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type {
	MapCaptureClientApi,
	MapCaptureExecuteIntent,
	MapCaptureProgressEvent,
	MapCaptureSaveIntent
} from "./map-capture-client.js";
import { MapCaptureRoute } from "./map-capture-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});
afterAll(() => runtime.dispose());

const plan = Effect.runSync(
	decodeMapCapturePlan({
		capture: {
			dataLayers: { mode: "unchanged" },
			orientation: { pitch: -90, roll: 0, yaw: 0 },
			render: {
				effects: { fog: true, volumetricFog: true },
				lodPolicy: "natural",
				profile: "full_fidelity"
			},
			z: 5000
		},
		contract: { name: "ue-shed-map-capture-plan", version: { major: 1, minor: 0 } },
		gutterPixels: 2,
		id: "fixture-overview",
		levels: { coarsestUnitsPerPixel: 4, count: 2 },
		output: { imageFormat: "png", publication: "local_immutable" },
		project: { id: "fixture", mapPath: "/Game/Fixture/Cameras/L_CameraLoad" },
		requestedBounds: { maxX: 1024, maxY: 1024, minX: 0, minY: 0 },
		tilePixelSize: 512
	})
);

describe("MapCaptureRoute", () => {
	it("streams the top-down editor camera into the framing stage", async () => {
		let previewedPlanId: string | undefined;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		const client: MapCaptureClientApi = {
			actors: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			choosePlan: () =>
				Effect.succeed({
					grid: {
						levels: [
							{
								columns: 1,
								rows: 1,
								tileWorldSize: 2048,
								unitsPerPixel: 4,
								zoom: 0
							}
						],
						snappedBounds: { maxX: 2048, maxY: 2048, minX: 0, minY: 0 }
					},
					maps: [],
					plan,
					projectRoot: "C:/Fixture",
					source: "opened" as const,
					status: "ready" as const,
					tileCount: 1
				}),
			liveFrames: Stream.empty,
			newPlan: () => Effect.die("not used"),
			openMap: () => Effect.die("not used"),
			preview: (current) =>
				Effect.sync(() => {
					previewedPlanId = current.id;
					return {
						bytes: new Uint8Array(64 * 64 * 4),
						cameraId: "map-camera",
						cameraIndex: 0,
						height: 64,
						previewContext: "editor_live" as const,
						status: "ready" as const,
						width: 64
					};
				}),
			progress: Stream.empty,
			savePlan: () => Effect.die("not used"),
			tile: () => Effect.die("not used")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureRoute client={client} />
			</EffectRuntimeProvider>
		));

		await userEvent.click(screen.getByRole("button", { name: "OPEN PLAN" }));
		expect(await screen.findByLabelText("Live top-down map framing preview")).toBeDefined();
		expect(previewedPlanId).toBe("fixture-overview");
		expect(screen.getByText("EDITOR LIVE")).toBeDefined();
		expect(screen.getByText("LIVE FRAMING · NOT CAPTURE OUTPUT")).toBeDefined();
	});

	it("surfaces scoped atmosphere and per-level LOD settings in the capture intent", async () => {
		let captured: MapCaptureExecuteIntent | undefined;
		const client: MapCaptureClientApi = {
			actors: () => Effect.die("not used"),
			capture: (intent) =>
				Effect.sync(() => {
					captured = intent;
					return {
						message: "Stopped after intent.",
						recovery: "Component assertion only.",
						status: "failed" as const
					};
				}),
			choosePlan: () =>
				Effect.succeed({
					grid: {
						levels: [
							{ columns: 1, rows: 1, tileWorldSize: 2048, unitsPerPixel: 4, zoom: 0 },
							{ columns: 2, rows: 2, tileWorldSize: 1024, unitsPerPixel: 2, zoom: 1 }
						],
						snappedBounds: { maxX: 2048, maxY: 2048, minX: 0, minY: 0 }
					},
					maps: [
						{
							label: "Camera Load",
							mapPath: "Content/Fixture/Cameras/L_CameraLoad.umap"
						},
						{ label: "Lighting Lab", mapPath: "Content/Maps/L_Lighting.umap" }
					],
					plan,
					planPath: "C:/Fixture/map-capture.json",
					projectRoot: "C:/Fixture",
					source: "opened" as const,
					status: "ready" as const,
					tileCount: 5
				}),
			newPlan: () => Effect.die("not used"),
			openMap: () => Effect.die("not used"),
			liveFrames: Stream.empty,
			preview: () => Effect.die("not used"),
			progress: Stream.empty,
			savePlan: () => Effect.die("not used"),
			tile: () => Effect.die("not used")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureRoute client={client} />
			</EffectRuntimeProvider>
		));

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "OPEN PLAN" }));
		expect(await screen.findByDisplayValue("fixture-overview")).toBeDefined();
		await user.click(screen.getByRole("combobox", { name: "Map capture target map" }));
		await user.type(screen.getByRole("searchbox", { name: "Search saved maps" }), "lighting");
		await user.click(screen.getByRole("option", { name: /Lighting Lab/ }));
		await user.click(screen.getByRole("checkbox", { name: "Fog" }));
		await user.click(screen.getByRole("checkbox", { name: "Volumetric fog" }));
		await user.selectOptions(
			screen.getByRole("combobox", { name: "LOD policy" }),
			"per_level_distance_scale"
		);
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Capture engine" }),
			"viewport_high_resolution"
		);
		expect(screen.getByText(/Renders one complete zoom/)).toBeDefined();
		fireEvent.input(screen.getByRole("spinbutton", { name: /Z0/ }), {
			target: { value: "4" }
		});
		fireEvent.input(screen.getByRole("spinbutton", { name: /Z1/ }), {
			target: { value: "1.5" }
		});
		await user.click(screen.getByRole("button", { name: "OPEN + CAPTURE" }));

		await waitFor(() => expect(captured).toBeDefined());
		expect(captured?.captureBackend).toBe("viewport_high_resolution");
		expect(captured?.openMap).toBe(true);
		expect(captured?.operationId).toMatch(/^map-capture-/);
		expect(captured?.plan.project.mapPath).toBe("/Game/Maps/L_Lighting");
		expect(captured?.plan.capture.render).toEqual({
			effects: { fog: false, volumetricFog: false },
			lodDistanceScaleByZoom: [4, 1.5],
			lodPolicy: "per_level_distance_scale",
			profile: "full_fidelity"
		});
	});

	it("creates, edits, validates, and saves a plan from the Map Capture path", async () => {
		let saved: MapCaptureSaveIntent | undefined;
		const client: MapCaptureClientApi = {
			actors: () => Effect.die("not used"),
			capture: () => Effect.die("not used"),
			choosePlan: () => Effect.die("not used"),
			newPlan: () =>
				Effect.succeed({
					grid: {
						levels: [
							{ columns: 1, rows: 1, tileWorldSize: 2048, unitsPerPixel: 4, zoom: 0 },
							{ columns: 2, rows: 2, tileWorldSize: 1024, unitsPerPixel: 2, zoom: 1 }
						],
						snappedBounds: { maxX: 2048, maxY: 2048, minX: 0, minY: 0 }
					},
					maps: [],
					plan,
					projectRoot: "C:/Fixture",
					source: "new" as const,
					status: "ready" as const,
					tileCount: 5
				}),
			openMap: () => Effect.die("not used"),
			liveFrames: Stream.empty,
			preview: () => Effect.die("not used"),
			progress: Stream.empty,
			savePlan: (intent) =>
				Effect.sync(() => {
					saved = intent;
					return {
						plan: intent.plan,
						planPath: "C:/Fixture/.ue-shed/map-capture/plans/city-overview.json",
						status: "saved" as const
					};
				}),
			tile: () => Effect.die("not used")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureRoute client={client} />
			</EffectRuntimeProvider>
		));

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "NEW PLAN" }));
		const planId = await screen.findByRole("textbox", { name: "PLAN ID" });
		await user.clear(planId);
		await user.type(planId, "city-overview");
		fireEvent.input(screen.getByRole("spinbutton", { name: "CENTER X" }), {
			target: { value: "2000" }
		});
		const centerY = screen.getByRole<HTMLInputElement>("spinbutton", { name: "CENTER Y" });
		await user.clear(centerY);
		expect(screen.queryByText("Every world bound must be a finite number.")).toBeNull();
		await user.tab();
		expect(centerY.valueAsNumber).toBe(512);
		await user.clear(centerY);
		await user.type(centerY, "0");
		fireEvent.change(screen.getByRole("spinbutton", { name: "SIZE · UU" }), {
			target: { value: "3000" }
		});
		expect(screen.getByText(/S 500 · N 3,500 · W -1,500 · E 1,500/)).toBeDefined();
		expect(screen.getByText("2,048 × 2,048 UU")).toBeDefined();
		fireEvent.change(screen.getByRole("spinbutton", { name: "TILE SIZE · PX" }), {
			target: { value: "2048" }
		});
		expect(screen.getByText("2,048 × 2,048 UU")).toBeDefined();
		expect(screen.getByText("2 × 2 TILES")).toBeDefined();
		expect(
			screen.getByRole<HTMLInputElement>("spinbutton", {
				name: "RESOLUTION · UU/PX"
			}).valueAsNumber
		).toBe(1);
		fireEvent.change(screen.getByRole("spinbutton", { name: "TILE SIZE · PX" }), {
			target: { value: "512" }
		});
		expect(screen.getByText("2 × 2 TILES")).toBeDefined();
		const baseGrid = screen.getByRole<HTMLInputElement>("spinbutton", {
			name: "BASE GRID · N × N"
		});
		fireEvent.change(baseGrid, {
			target: { value: "4" }
		});
		expect(baseGrid.valueAsNumber).toBe(4);
		expect(screen.getByText("4 × 4 TILES")).toBeDefined();
		expect(
			screen.getByRole<HTMLInputElement>("spinbutton", {
				name: "RESOLUTION · UU/PX"
			}).valueAsNumber
		).toBe(1.46484375);
		fireEvent.change(screen.getByRole("spinbutton", { name: "RESOLUTION · UU/PX" }), {
			target: { value: "0.5" }
		});
		expect(screen.getByText("12 × 12 TILES")).toBeDefined();
		expect(screen.getByText("256 × 256 UU")).toBeDefined();
		await user.selectOptions(
			screen.getByRole("combobox", { name: "Render profile" }),
			"seam_stable"
		);
		expect(screen.getByText(/Project lighting with fixed exposure/)).toBeDefined();
		expect(screen.getByRole("option", { name: "SCENE CAPTURE DEFAULTS" })).toBeDefined();
		await user.click(screen.getByRole("button", { name: "SAVE" }));

		await waitFor(() => expect(saved?.plan.id).toBe("city-overview"));
		expect(saved?.saveAs).toBe(false);
		expect(saved?.plan.tilePixelSize).toBe(512);
		expect(saved?.plan.levels.coarsestUnitsPerPixel).toBe(0.5);
		expect(saved?.plan.capture.render.profile).toBe("seam_stable");
		expect(saved?.plan.requestedBounds).toEqual({
			maxX: 3_500,
			maxY: 1_500,
			minX: 500,
			minY: -1_500
		});
		expect(await screen.findByText(/Saved portable plan/)).toBeDefined();
	});

	it("shows actual tile progress and locks capture controls while a run is active", async () => {
		let captured: MapCaptureExecuteIntent | undefined;
		const progressQueue = Effect.runSync(Queue.unbounded<MapCaptureProgressEvent>());
		const client: MapCaptureClientApi = {
			actors: () => Effect.die("not used"),
			capture: (intent) =>
				Effect.sync(() => {
					captured = intent;
				}).pipe(Effect.andThen(Effect.never)),
			choosePlan: () =>
				Effect.succeed({
					grid: {
						levels: [
							{ columns: 1, rows: 1, tileWorldSize: 2048, unitsPerPixel: 4, zoom: 0 },
							{ columns: 2, rows: 2, tileWorldSize: 1024, unitsPerPixel: 2, zoom: 1 }
						],
						snappedBounds: { maxX: 2048, maxY: 2048, minX: 0, minY: 0 }
					},
					maps: [],
					plan,
					projectRoot: "C:/Fixture",
					source: "opened" as const,
					status: "ready" as const,
					tileCount: 5
				}),
			newPlan: () => Effect.die("not used"),
			openMap: () => Effect.die("not used"),
			liveFrames: Stream.empty,
			preview: () => Effect.die("not used"),
			progress: Stream.fromQueue(progressQueue),
			savePlan: () => Effect.die("not used"),
			tile: () => Effect.die("not used")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureRoute client={client} />
			</EffectRuntimeProvider>
		));

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "OPEN PLAN" }));
		await screen.findByDisplayValue("fixture-overview");
		await user.click(screen.getByRole("button", { name: "OPEN + CAPTURE" }));
		await waitFor(() => expect(captured).toBeDefined());
		Queue.offerUnsafe(progressQueue, {
			failedTiles: 1,
			operationId: captured!.operationId,
			phase: "capturing",
			processedTiles: 4,
			totalTiles: 5
		});

		const progressbar = await screen.findByRole("progressbar", {
			name: "Map capture progress"
		});
		await waitFor(() => expect(progressbar.getAttribute("aria-valuenow")).toBe("4"));
		expect(screen.getByText("4 / 5 PROCESSED")).toBeDefined();
		expect(screen.getByText("3 CAPTURED")).toBeDefined();
		expect(screen.getByText("1 FAILED")).toBeDefined();
		expect(
			screen.getByRole<HTMLButtonElement>("button", { name: "OPEN + CAPTURE" }).disabled
		).toBe(true);
		expect(
			screen.getByRole<HTMLButtonElement>("button", { name: "OPEN TARGET MAP" }).disabled
		).toBe(true);
	});
});
