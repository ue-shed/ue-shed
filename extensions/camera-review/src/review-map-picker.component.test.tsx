import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { ReviewMapPicker } from "./review-map-picker.js";
import type { MapReviewMapOpenResult } from "./map-review-client.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

it("opens only on request and keeps the selection locked until a rejected operation completes", async () => {
	const completion = await Effect.runPromise(Deferred.make<MapReviewMapOpenResult>());
	const open = vi.fn(() => Deferred.await(completion));
	const onOpened = vi.fn();
	const [path, setPath] = createSignal("Content/Maps/Alpha.umap");
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ReviewMapPicker
				client={{ openMapInUnreal: open }}
				maps={[{ label: "Alpha", mapPath: path() }]}
				mapPath={path()}
				onMapPathChange={setPath}
				onOpened={onOpened}
			/>
		</EffectRuntimeProvider>
	));
	expect(open).not.toHaveBeenCalled();
	await userEvent.setup().click(screen.getByRole("button", { name: "Open in Unreal ↗" }));
	expect(open).toHaveBeenCalledWith("Content/Maps/Alpha.umap");
	expect(screen.getByRole<HTMLButtonElement>("combobox").disabled).toBe(true);
	expect(
		screen.getByRole<HTMLButtonElement>("button", { name: "Opening in Unreal…" }).disabled
	).toBe(true);
	await Effect.runPromise(
		Deferred.succeed(completion, {
			outcome: "failed",
			message: "Unsaved changes.",
			recovery: "Save the map in Unreal, then retry."
		})
	);
	expect((await screen.findByRole("alert")).textContent).toContain("Save the map in Unreal");
	expect(onOpened).not.toHaveBeenCalled();
	await waitFor(() =>
		expect(screen.getByRole<HTMLButtonElement>("combobox").disabled).toBe(false)
	);
});

it("keeps editor actions absent for an offline host", () => {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ReviewMapPicker client={{}} maps={[]} mapPath="" onMapPathChange={() => undefined} />
		</EffectRuntimeProvider>
	));
	expect(screen.queryByRole("button", { name: "Open in Unreal ↗" })).toBeNull();
});
