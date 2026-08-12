// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { decodeMapCapturePlan } from "@ue-shed/cameras/map-tiles";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapCaptureClientShape, MapCaptureExecuteIntent } from "./map-capture-client.js";
import { MapCaptureRoute } from "./map-capture-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
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
		tilePixelSize: 256
	})
);

describe("MapCaptureRoute", () => {
	it("surfaces scoped atmosphere and per-level LOD settings in the capture intent", async () => {
		let captured: MapCaptureExecuteIntent | undefined;
		const client: MapCaptureClientShape = {
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
							{ columns: 1, rows: 1, tileWorldSize: 1024, unitsPerPixel: 4, zoom: 0 },
							{ columns: 2, rows: 2, tileWorldSize: 512, unitsPerPixel: 2, zoom: 1 }
						],
						snappedBounds: { maxX: 1024, maxY: 1024, minX: 0, minY: 0 }
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
					runs: [],
					status: "ready" as const,
					tileCount: 5
				}),
			openMap: () => Effect.die("not used")
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureRoute client={client} />
			</EffectRuntimeProvider>
		));

		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "CHOOSE PLAN" }));
		expect(await screen.findByText("fixture-overview")).toBeDefined();
		await user.click(screen.getByRole("combobox", { name: "Map capture target map" }));
		await user.type(screen.getByRole("searchbox", { name: "Search saved maps" }), "lighting");
		await user.click(screen.getByRole("option", { name: /Lighting Lab/ }));
		await user.click(screen.getByRole("checkbox", { name: "Fog" }));
		await user.click(screen.getByRole("checkbox", { name: "Volumetric fog" }));
		await user.selectOptions(
			screen.getByRole("combobox", { name: "LOD policy" }),
			"per_level_distance_scale"
		);
		const scales = screen.getAllByRole("spinbutton");
		fireEvent.input(scales[0]!, { target: { value: "4" } });
		fireEvent.input(scales[1]!, { target: { value: "1.5" } });
		await user.click(screen.getByRole("button", { name: "OPEN + CAPTURE" }));

		await waitFor(() => expect(captured).toBeDefined());
		expect(captured?.openMap).toBe(true);
		expect(captured?.plan.project.mapPath).toBe("/Game/Maps/L_Lighting");
		expect(captured?.plan.capture.render).toEqual({
			effects: { fog: false, volumetricFog: false },
			lodDistanceScaleByZoom: [4, 1.5],
			lodPolicy: "per_level_distance_scale",
			profile: "full_fidelity"
		});
	});
});
