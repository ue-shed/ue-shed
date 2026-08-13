// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { decodeMapTilePyramidManifest } from "@ue-shed/cameras/map-tiles";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
	contract: { name: "unreal-saved-world" as const, version: { major: 1 as const, minor: 0 } },
	diagnostics: [],
	mapPath: "Content/Fixture/Cameras/L_CameraLoad.umap",
	sourceKind: "level" as const,
	actors: [
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Inside",
			classPath: "/Script/Engine.StaticMeshActor",
			label: "Inside",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			position: { location: { x: 128, y: 128, z: 0 }, status: "resolved" as const }
		},
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Outside",
			classPath: "/Script/Engine.PointLight",
			label: "Outside",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			position: { location: { x: 512, y: 512, z: 0 }, status: "resolved" as const }
		},
		{
			actorPath: "/Game/Fixture/Cameras/L_CameraLoad.Unresolved",
			classPath: "/Script/Engine.StaticMeshActor",
			label: "Unresolved",
			packageName: "/Game/Fixture/Cameras/L_CameraLoad",
			position: { status: "missing_root_component" as const }
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
			}
		);
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
		await userEvent.click(screen.getByRole("button", { name: "SAVED ACTORS OFF" }));
		expect(
			await screen.findByRole("complementary", {
				name: "Captured map saved actor explorer"
			})
		).toBeDefined();
		expect(loads).toBe(1);
		expect(screen.getByText("1 INSIDE CAPTURE")).toBeDefined();
		expect(screen.getByText("2 RESOLVED")).toBeDefined();
		expect(screen.getByText("3 SAVED")).toBeDefined();
		expect(screen.getByText("OUTSIDE CAPTURE")).toBeDefined();
		expect(screen.getByText("UNRESOLVED")).toBeDefined();

		const inside = screen.getByRole("button", { name: /Inside/ });
		await userEvent.click(inside);
		await waitFor(() => expect(inside.getAttribute("aria-pressed")).toBe("true"));

		await userEvent.click(screen.getByRole("button", { name: "SAVED ACTORS ON" }));
		expect(
			screen.queryByRole("complementary", { name: "Captured map saved actor explorer" })
		).toBeNull();
		expect(loads).toBe(1);
	});
});
