// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import type { SavedWorld } from "@ue-shed/protocol";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MapReviewClientShape } from "./map-review-client.js";
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
		contract: { name: "unreal-saved-world", version: { major: 1, minor: 0 } },
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
				position: { location: { x: 100, y: 200, z: 300 }, status: "resolved" }
			},
			{
				actorPath: `${mapPackage}.${mapPath.includes("DemoArena") ? "ArenaMesh" : "WorldMesh"}`,
				classPath: "/Script/Engine.StaticMeshActor",
				label: "Ground mesh",
				packageName: "/Game/Actors/GroundMesh",
				position: { location: { x: 400, y: 500, z: 600 }, status: "resolved" }
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

HTMLCanvasElement.prototype.getContext = (() =>
	({
		arc: () => undefined,
		beginPath: () => undefined,
		clearRect: () => undefined,
		fill: () => undefined,
		fillStyle: "",
		lineWidth: 1,
		moveTo: () => undefined,
		setTransform: () => undefined,
		stroke: () => undefined,
		strokeStyle: ""
	}) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;

function renderScout() {
	const client = {
		readSavedWorld: (mapPath: string) => Effect.succeed(savedWorld(mapPath)),
		savedWorldMaps: () => Effect.succeed(maps)
	} satisfies Pick<MapReviewClientShape, "readSavedWorld" | "savedWorldMaps">;
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<SavedWorldScout client={client} />
		</EffectRuntimeProvider>
	));
}

describe("SavedWorldScout", () => {
	it("keeps the map picker aligned with the map that finished loading", async () => {
		const user = userEvent.setup();
		renderScout();

		const picker = (await screen.findByRole("combobox", {
			name: "Saved map"
		})) as HTMLSelectElement;
		await user.selectOptions(picker, "Content/Demo/DemoArena.umap");

		await screen.findByText("/Game/Demo/DemoArena");
		await waitFor(() =>
			expect(
				(screen.getByRole("combobox", { name: "Saved map" }) as HTMLSelectElement).value
			).toBe("Content/Demo/DemoArena.umap")
		);
	});

	it("filters saved actor classes in a bounded list instead of rendering an unscoped chip wall", async () => {
		const user = userEvent.setup();
		renderScout();

		await screen.findByText("PointLight");
		const filter = screen.getByRole("textbox", { name: "Filter saved actor classes" });
		await user.type(filter, "light");

		expect(screen.getByText("PointLight")).toBeDefined();
		expect(screen.queryByText("StaticMeshActor")).toBeNull();
	});
});
