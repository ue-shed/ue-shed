// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { Deck } from "@deck.gl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PointMapCanvas, type PointMapController, type PointMapViewState } from "./point-map.js";
import { PointMapDeckCanvas } from "./point-map-deck.js";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
	configurable: true,
	value: () => ({
		arc: () => undefined,
		beginPath: () => undefined,
		clearRect: () => undefined,
		fill: () => undefined,
		fillStyle: "",
		lineTo: () => undefined,
		lineWidth: 1,
		moveTo: () => undefined,
		setTransform: () => undefined,
		stroke: () => undefined,
		strokeStyle: ""
	})
});

const points = [
	{ className: "PointLight", key: "light", x: 0, y: 0 },
	{ className: "StaticMeshActor", key: "mesh", x: 10_000, y: 10_000 }
] as const;

interface MapProbe {
	readonly controllers: Array<PointMapController | undefined>;
	readonly views: Array<PointMapViewState>;
}

function probe(): MapProbe {
	return { controllers: [], views: [] };
}

const renderers = {
	deck: (map: MapProbe) =>
		render(() => (
			<PointMapDeckCanvas
				ariaLabel="Test map"
				onController={(controller) => {
					map.controllers.push(controller);
				}}
				onSelect={() => undefined}
				onViewChange={(view) => {
					map.views.push(view);
				}}
				points={points}
				selectedKey={undefined}
			/>
		)),
	canvas: (map: MapProbe) =>
		render(() => (
			<PointMapCanvas
				ariaLabel="Test map"
				onController={(controller) => {
					map.controllers.push(controller);
				}}
				onSelect={() => undefined}
				onViewChange={(view) => {
					map.views.push(view);
				}}
				points={points}
				selectedKey={undefined}
			/>
		))
} as const;

describe("point map controllers", () => {
	// SavedWorldScout and the WebGL fallback treat both controllers as one PointMapController.
	it.each(["deck", "canvas"] as const)(
		"%s controller focuses, zooms and resets through the shared controller contract",
		async (renderer) => {
			const map = probe();
			renderers[renderer](map);
			await waitFor(() => expect(map.views.length).toBeGreaterThan(0));
			if (renderer === "deck") {
				expect(screen.getByTestId("point-map-deck-root").dataset.renderer).toBe("deck.gl");
			}
			const controller = map.controllers.findLast((entry) => entry !== undefined);
			expect(controller).toBeDefined();
			if (controller === undefined) return;

			controller.focusKey("mesh");
			await waitFor(() =>
				expect(map.views.at(-1)?.viewport).toMatchObject({
					centerX: 10_000,
					centerY: 10_000
				})
			);
			controller.setZoomFactor(2);
			await waitFor(() => expect(map.views.at(-1)?.zoomFactor).toBeCloseTo(2));
			controller.resetView();
			await waitFor(() => expect(map.views.at(-1)?.zoomFactor).toBeCloseTo(1));
		}
	);

	it("forwards the Canvas fallback controller for focus, zoom and reset", async () => {
		// Deliver the public renderer failure during Deck initialization.
		vi.spyOn(Deck.prototype, "setProps").mockImplementationOnce((props) => {
			props.onError?.(new Error("WebGL unavailable"));
		});
		const map = probe();
		renderers.deck(map);
		const deckController = map.controllers.find((entry) => entry !== undefined);
		await waitFor(() =>
			expect(screen.getByTestId("point-map-deck-root").dataset.renderer).toBe(
				"canvas-fallback"
			)
		);
		const controller = map.controllers.findLast((entry) => entry !== undefined);
		expect(controller).toBeDefined();
		expect(controller).not.toBe(deckController);
		if (controller === undefined) return;

		controller.focusKey("mesh");
		await waitFor(() =>
			expect(map.views.at(-1)?.viewport).toMatchObject({ centerX: 10_000, centerY: 10_000 })
		);
		controller.setZoomFactor(2);
		await waitFor(() => expect(map.views.at(-1)?.zoomFactor).toBeCloseTo(2));
		controller.resetView();
		await waitFor(() => expect(map.views.at(-1)?.zoomFactor).toBeCloseTo(1));
	});
});
