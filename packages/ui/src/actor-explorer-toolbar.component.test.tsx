// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActorExplorer } from "./actor-explorer.js";
import { writeActorFilterPreset } from "./actor-explorer-utilities.js";
import { ActorExplorerUtilities } from "./actor-explorer-toolbar.js";
import { EffectRuntimeProvider } from "./effect-solid.js";
import { readActorFilterPresets } from "./actor-explorer-utilities.js";
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value)
	});
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const filters = { query: "label:sun", classPaths: ["Light"] };
function mount(onFiltersChange = vi.fn()) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ActorExplorerUtilities
				filters={filters}
				onFiltersChange={onFiltersChange}
				selected={{
					key: "sun",
					label: "Sun",
					classPath: "Light",
					path: "/Game/Map.Sun",
					packageName: undefined,
					actorGuid: "guid",
					location: { x: 1, y: 2, z: 3 }
				}}
				disabled={false}
				presetsEnabled
				singleClass={false}
			/>
		</EffectRuntimeProvider>
	));
}
async function openPresets() {
	const details = screen.getByText("Filter presets").parentElement;
	if (!(details instanceof HTMLDetailsElement)) throw new Error("Expected preset details");
	details.open = true;
	fireEvent(details, new Event("toggle"));
	await new Promise((resolve) => setTimeout(resolve, 0));
}
it("saves a preset and applies it after remounting", async () => {
	const first = mount();
	await openPresets();
	fireEvent.input(screen.getByLabelText("Actor filter preset name"), {
		target: { value: "Lighting" }
	});
	fireEvent.click(screen.getByRole("button", { name: "Save preset" }));
	await screen.findByText("Preset saved on this device.");
	first.unmount();
	const apply = vi.fn();
	mount(apply);
	await openPresets();
	await screen.findByRole("option", { name: "Lighting" });
	fireEvent.change(screen.getByLabelText("Saved actor filter preset"), {
		target: { value: "Lighting" }
	});
	expect(apply).toHaveBeenCalledWith(filters);
	fireEvent.click(screen.getByRole("button", { name: "Delete preset" }));
	await screen.findByText("Preset deleted.");
	expect(await Effect.runPromise(readActorFilterPresets(localStorage))).toEqual([]);
});
it("copies selected details and offers selectable fallback when clipboard fails", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Copy GUID" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("guid"));
	writeText.mockRejectedValue(new Error("denied"));
	fireEvent.click(screen.getByRole("button", { name: "Copy coordinates" }));
	await screen.findByText("Clipboard unavailable. Copy the value below.");
	const input = screen.getByLabelText("Actor detail to copy");
	if (!(input instanceof HTMLInputElement)) throw new Error("Expected copy input");
	expect(input.value).toBe("X=1 Y=2 Z=3");
});

it("applies presets through both search and class callbacks in the shared explorer", async () => {
	await Effect.runPromise(writeActorFilterPreset(localStorage, "Lighting", filters));
	const query = vi.fn();
	const classes = vi.fn();
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ActorExplorer
				utilities
				filters={{ query: "", classPaths: undefined }}
				items={[]}
				selectedKey={undefined}
				selectedClassPath={undefined}
				onSelect={() => undefined}
				onFiltersChange={query}
				onClassPathsChange={classes}
			/>
		</EffectRuntimeProvider>
	));
	await openPresets();
	await screen.findByRole("option", { name: "Lighting" });
	fireEvent.change(screen.getByLabelText("Saved actor filter preset"), {
		target: { value: "Lighting" }
	});
	expect(query).toHaveBeenCalledWith(filters);
	expect(classes).toHaveBeenCalledWith(["Light"]);
});
