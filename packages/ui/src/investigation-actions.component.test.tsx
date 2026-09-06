// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EffectRuntimeProvider } from "./effect-solid.js";
import { InvestigationActions } from "./investigation-actions.js";

afterEach(cleanup);

it("restores presets, reports file failures and cancellation, and hides stale replay commands", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const opened = vi.fn();
	const [query, setQuery] = createSignal("before");
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InvestigationActions
				query={query()}
				revision={1}
				disabled={false}
				onOpen={opened}
				client={{
					save: () =>
						Effect.succeed({
							status: "saved",
							path: "/preset.json",
							rowCount: 0,
							replayCommand:
								"pnpm ue-shed investigations run '/project' --preset '/preset.json'"
						}),
					open: () =>
						Effect.succeed({
							status: "opened",
							path: "/preset.json",
							preset: "restored"
						}),
					export: (_, format) =>
						Effect.succeed(
							format === "json"
								? { status: "cancelled" }
								: {
										status: "failed",
										message: "Disk full.",
										recovery: "Choose another destination."
									}
						)
				}}
			/>
		</EffectRuntimeProvider>
	));
	try {
		fireEvent.click(view.getByRole("button", { name: "Save preset" }));
		await waitFor(() =>
			expect(view.getByRole("button", { name: "Copy CLI replay" })).toBeDefined()
		);
		setQuery("changed");
		expect(view.queryByRole("button", { name: "Copy CLI replay" })).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Open preset" }));
		await waitFor(() => expect(opened).toHaveBeenCalledWith("restored"));
		fireEvent.click(view.getByRole("button", { name: "Export JSON" }));
		await waitFor(() => expect(view.getByRole("status").textContent).toBe("Cancelled."));
		fireEvent.click(view.getByRole("button", { name: "Export CSV" }));
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toContain(
				"Disk full. Choose another destination."
			)
		);
	} finally {
		view.unmount();
		await runtime.dispose();
	}
});
