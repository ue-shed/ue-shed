// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import type { SavedWorld } from "@ue-shed/protocol";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapReviewClientApi } from "./map-review-client.js";
import { SavedWorldScout } from "./saved-world-scout.js";

const maps = [
	{ label: "New World", mapPath: "Content/NewWorld.umap" },
	{ label: "Demo Arena", mapPath: "Content/Demo/DemoArena.umap" }
] as const;

function savedWorld(mapPath: string): SavedWorld {
	const mapPackage =
		mapPath === "Content/Demo/DemoArena.umap" ? "/Game/Demo/DemoArena" : "/Game/NewWorld";
	return {
		authority: { kind: "project_files", mapPackage },
		completeness: "complete",
		contract: { name: "unreal-saved-world", version: { major: 2, minor: 0 } },
		diagnostics: [],
		externalActorRoot: "Content/__ExternalActors__",
		mapPath,
		sourceKind: "world_partition",
		actors: [
			{
				actorPath: `${mapPackage}.${mapPath.includes("DemoArena") ? "ArenaLight" : "WorldLight"}`,
				classPath: "/Script/Engine.PointLight",
				label: "Key light",
				packageName: "/Game/Actors/KeyLight",
				transform: {
					location: { x: 100, y: 200, z: 300 },
					rotation: { w: 1, x: 0, y: 0, z: 0 },
					scale: { x: 1, y: 1, z: 1 },
					status: "resolved"
				}
			},
			{
				actorPath: `${mapPackage}.${mapPath.includes("DemoArena") ? "ArenaMesh" : "WorldMesh"}`,
				classPath: "/Script/Engine.StaticMeshActor",
				label: "Ground mesh",
				packageName: "/Game/Actors/GroundMesh",
				transform: {
					location: { x: 400, y: 500, z: 600 },
					rotation: { w: 1, x: 0, y: 0, z: 0 },
					scale: { x: 1, y: 1, z: 1 },
					status: "resolved"
				}
			}
		],
		summary: {
			failedPackages: 0,
			partialPackages: 0,
			resolvedActors: 2,
			scannedPackages: 1
		}
	};
}

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

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

function renderScout() {
	const client = {
		readSavedWorld: (mapPath: string) => Effect.succeed(savedWorld(mapPath)),
		savedWorldMaps: () => Effect.succeed(maps)
	} satisfies Pick<MapReviewClientApi, "readSavedWorld" | "savedWorldMaps">;
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<SavedWorldScout client={client} />
		</EffectRuntimeProvider>
	));
}

describe("SavedWorldScout", () => {
	it("shows package progress while the saved map is still reading", async () => {
		const client = {
			readSavedWorld: () => Effect.never,
			savedWorldMaps: () => Effect.succeed(maps),
			savedWorldProgress: () =>
				Effect.succeed({
					actorsFound: 0,
					phase: "scanning" as const,
					processedPackages: 12,
					totalPackages: 40
				})
		} satisfies Pick<
			MapReviewClientApi,
			"readSavedWorld" | "savedWorldMaps" | "savedWorldProgress"
		>;
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SavedWorldScout client={client} />
			</EffectRuntimeProvider>
		));

		expect(await screen.findByRole("progressbar")).toBeDefined();
		expect(await screen.findByText("12 / 40 packages")).toBeDefined();
		expect(screen.getByRole("heading", { name: "Reading saved map…" })).toBeDefined();
	});

	it("keeps the map picker aligned with the map that finished loading", async () => {
		const user = userEvent.setup();
		renderScout();

		const picker = await screen.findByRole("combobox", { name: "Saved map" });
		await user.click(picker);
		await user.type(screen.getByRole("searchbox", { name: "Search saved maps" }), "arena");
		await user.click(screen.getByRole("option", { name: /Demo Arena/ }));

		await screen.findByText("/Game/Demo/DemoArena");
		await waitFor(() => expect(picker.textContent).toContain("Content/Demo/DemoArena.umap"));
	});

	it("filters saved actors and classes through one bounded explorer", async () => {
		const user = userEvent.setup();
		renderScout();

		await screen.findByText("PointLight");
		const filter = screen.getByRole("textbox", { name: "Find saved actor" });
		await user.type(filter, "light");

		expect(screen.getByText("PointLight")).toBeDefined();
		expect(screen.queryByText("StaticMeshActor")).toBeNull();
	});

	it("keeps actor classes selected by default and can invert the selection", async () => {
		const user = userEvent.setup();
		renderScout();

		await screen.findByText("PointLight");
		await user.click(screen.getByRole("button", { name: "Toggle actor class filters" }));
		const classFilters = screen.getByLabelText("Actor class filters");
		const light = within(classFilters).getByRole("button", { name: /PointLight/ });
		const mesh = within(classFilters).getByRole("button", { name: /StaticMeshActor/ });
		expect(light!.getAttribute("aria-pressed")).toBe("true");
		expect(mesh!.getAttribute("aria-pressed")).toBe("true");

		await user.click(light!);
		expect(light!.getAttribute("aria-pressed")).toBe("false");
		expect(mesh!.getAttribute("aria-pressed")).toBe("true");

		await user.click(screen.getByRole("button", { name: "INVERT" }));
		expect(light!.getAttribute("aria-pressed")).toBe("true");
		expect(mesh!.getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps an outliner selection in sync with the saved actor inspector", async () => {
		const user = userEvent.setup();
		renderScout();

		const actor = await screen.findByRole("button", { name: /Ground mesh/ });
		await user.click(actor);

		expect(screen.getByRole("heading", { name: "Ground mesh" })).toBeDefined();
		expect(actor.getAttribute("aria-pressed")).toBe("true");
	});
});
