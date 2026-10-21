import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActorExplorer } from "./actor-explorer.js";
import type { ActorExplorerFilters, ActorExplorerItem } from "./actor-explorer-core.js";

// Give the real virtualizer a measurable JSDOM viewport.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const items: readonly ActorExplorerItem[] = [
	{
		key: "light",
		label: "Key light",
		classPath: "/Script/Engine.PointLight",
		packageName: "/Game/Actors/KeyLight",
		path: "/Game/Map.WorldLight"
	},
	{
		key: "mesh",
		label: "Ground mesh",
		classPath: "/Script/Engine.StaticMeshActor",
		packageName: "/Game/Actors/GroundMesh",
		path: "/Game/Map.WorldMesh"
	}
];

function mount() {
	const [filters, setFilters] = createSignal<ActorExplorerFilters>({
		classPaths: undefined,
		query: ""
	});
	return render(() => (
		<ActorExplorer
			items={items}
			filters={filters()}
			onFiltersChange={setFilters}
			onClassPathsChange={(classPaths) =>
				setFilters((current) => ({ ...current, classPaths }))
			}
			onSelect={() => undefined}
			selectedClassPath={undefined}
			selectedKey={undefined}
		/>
	));
}

it("filters actors and class options through one explorer query", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	await user.type(screen.getByRole("textbox", { name: "Find actor or class" }), "light");
	expect(screen.getByText("PointLight")).toBeDefined();
	expect(screen.getByRole("button", { name: /Key light/ })).toBeDefined();
	expect(screen.queryByText("StaticMeshActor")).toBeNull();
	expect(screen.queryByRole("button", { name: /Ground mesh/ })).toBeNull();
});

it("selects all actor classes by default and inverts the current subset", async () => {
	const user = userEvent.setup({ delay: null });
	mount();
	await user.click(screen.getByRole("button", { name: "Toggle actor class filters" }));
	const classes = screen.getByLabelText("Actor class filters");
	const light = within(classes).getByRole("button", { name: /PointLight/ });
	const mesh = within(classes).getByRole("button", { name: /StaticMeshActor/ });
	expect(light.getAttribute("aria-pressed")).toBe("true");
	expect(mesh.getAttribute("aria-pressed")).toBe("true");

	await user.click(light);
	expect(light.getAttribute("aria-pressed")).toBe("false");
	expect(mesh.getAttribute("aria-pressed")).toBe("true");
	expect(screen.queryByRole("button", { name: /Key light/ })).toBeNull();

	await user.click(screen.getByRole("button", { name: "INVERT" }));
	expect(light.getAttribute("aria-pressed")).toBe("true");
	expect(mesh.getAttribute("aria-pressed")).toBe("false");
	expect(screen.getByRole("button", { name: /Key light/ })).toBeDefined();
	expect(screen.queryByRole("button", { name: /Ground mesh/ })).toBeNull();
});
