// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { decodeMapTilePyramidManifest } from "@ue-shed/cameras/map-tiles";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "../../../test-support/actor-explorer-layout.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapCaptureActorWorkspace } from "./map-capture-actor-workspace.js";

const runtime = ManagedRuntime.make(Layer.empty);
const manifest = Effect.runSync(
	decodeMapTilePyramidManifest(
		JSON.parse(
			readFileSync(
				resolve(
					process.cwd(),
					"packages/protocol/contracts/cameras/map-tile/v1/fixtures/manifest-valid.json"
				),
				"utf8"
			)
		)
	)
);
const world = {
	authority: { kind: "project_files" as const, mapPackage: manifest.project.mapPath },
	completeness: "complete" as const,
	contract: {
		name: "unreal-saved-world" as const,
		version: { major: 2 as const, minor: 0 as const }
	},
	diagnostics: [],
	mapPath: "Content/Fixture/Cameras/L_CameraLoad.umap",
	sourceKind: "level" as const,
	actors: [
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Inside",
			classPath: "/Script/Engine.StaticMeshActor",
			label: "Inside",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			transform: {
				location: { x: 128, y: 128, z: 0 },
				rotation: { w: 1, x: 0, y: 0, z: 0 },
				scale: { x: 1, y: 1, z: 1 },
				status: "resolved" as const
			}
		},
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Outside",
			classPath: "/Script/Engine.PointLight",
			label: "Outside",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			transform: {
				location: { x: 512, y: 512, z: 0 },
				rotation: { w: 1, x: 0, y: 0, z: 0 },
				scale: { x: 1, y: 1, z: 1 },
				status: "resolved" as const
			}
		},
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Unresolved",
			classPath: "/Script/Engine.StaticMeshActor",
			label: "Unresolved",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			transform: { status: "missing_root_component" as const }
		}
	],
	summary: {
		failedPackages: 0,
		partialPackages: 0,
		resolvedActors: 2,
		scannedPackages: 1
	}
};

describe("MapCaptureActorWorkspace", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				disconnect() {}
				observe() {}
				unobserve() {}
			}
		);
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			width: 900,
			height: 600,
			right: 900,
			bottom: 600,
			toJSON: () => ({})
		});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		vi.stubGlobal("URL", {
			createObjectURL: () => "blob:map-capture-tile",
			revokeObjectURL: () => undefined
		});
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	afterAll(() => runtime.dispose());

	it("loads saved actors on demand and links capture coverage to the shared explorer", async () => {
		let loads = 0;
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<MapCaptureActorWorkspace
					loadActors={() =>
						Effect.sync(() => {
							loads += 1;
							return { status: "ready" as const, world };
						})
					}
					loadTile={() => Effect.succeed(new Uint8Array([1, 2, 3]))}
					manifest={manifest}
				/>
			</EffectRuntimeProvider>
		));

		expect(loads).toBe(0);
		await userEvent.click(screen.getByRole("button", { name: "Saved actors off" }));
		expect(
			await screen.findByRole("complementary", {
				name: "Captured map saved actor explorer"
			})
		).toBeDefined();
		expect(loads).toBe(1);
		expect(screen.getByText("1 inside")).toBeDefined();
		expect(screen.getByText("2 resolved")).toBeDefined();
		expect(screen.getByText("3 saved")).toBeDefined();
		expect(screen.getByText("Outside capture")).toBeDefined();
		expect(screen.getAllByText("Unresolved").length).toBeGreaterThan(0);

		const fit = screen.getByRole("button", { name: "Fit filtered actors" });
		const search = screen.getByLabelText("Find captured map actor");
		fireEvent.input(search, { target: { value: "label:Outside" } });
		await userEvent.click(fit);
		const surface = screen.getByLabelText("Captured map tile surface");
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
		// The test surface is 900 by 600; its center must match the sole filtered actor.
		fireEvent.contextMenu(surface, { clientX: 450, clientY: 300 });
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("X=512.00 Y=512.00"));
		fireEvent.input(search, { target: { value: "does-not-exist" } });
		expect(fit.hasAttribute("disabled")).toBe(true);
		fireEvent.input(search, { target: { value: "" } });

		const inside = screen.getByRole("button", { name: /Inside/ });
		await userEvent.click(inside);
		await waitFor(() => expect(inside.getAttribute("aria-pressed")).toBe("true"));

		await userEvent.click(screen.getByRole("button", { name: "Saved actors on" }));
		expect(
			screen.queryByRole("complementary", { name: "Captured map saved actor explorer" })
		).toBeNull();
		expect(loads).toBe(1);
	});
});
