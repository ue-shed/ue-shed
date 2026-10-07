// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EffectRuntimeProvider } from "./effect-solid.js";
import { InvestigationActions } from "./investigation-actions.js";

afterEach(cleanup);

it("groups compact exports and presets, closes menus and keeps host actions available", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const exported = vi.fn();
	const saved = vi.fn();
	const opened = vi.fn();
	const user = userEvent.setup();
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InvestigationActions
				compact
				query="current filters"
				revision={1}
				disabled={false}
				onOpen={opened}
				client={{
					export: (query, format) => {
						exported(query, format);
						return Effect.succeed({ status: "saved", path: "/export", rowCount: 1 });
					},
					save: (query) => {
						saved(query);
						return Effect.succeed({ status: "saved", path: "/preset", rowCount: 0 });
					},
					open: () =>
						Effect.succeed({ status: "opened", path: "/preset", preset: "restored" })
				}}
			/>
		</EffectRuntimeProvider>
	));
	try {
		expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
		for (const format of ["CSV", "JSON"]) {
			await user.click(screen.getByRole("button", { name: "Export" }));
			await user.click(screen.getByRole("button", { name: format }));
			await waitFor(() =>
				expect(exported).toHaveBeenCalledWith("current filters", format.toLowerCase())
			);
			expect(screen.queryByRole("dialog", { name: "Export formats" })).toBeNull();
			await waitFor(() =>
				expect(screen.getByRole("status").textContent).toContain("1 matching result:")
			);
		}
		await user.click(screen.getByRole("button", { name: "Presets" }));
		await user.click(screen.getByRole("button", { name: "Save preset…" }));
		await waitFor(() => expect(saved).toHaveBeenCalledWith("current filters"));
		await waitFor(() =>
			expect(screen.getByRole("status").textContent).toContain("Saved preset")
		);
		expect(screen.queryByRole("dialog", { name: "Investigation presets" })).toBeNull();
		await user.click(screen.getByRole("button", { name: "Presets" }));
		await user.click(screen.getByRole("button", { name: "Open preset…" }));
		await waitFor(() => expect(opened).toHaveBeenCalledWith("restored"));
		expect(screen.queryByRole("dialog", { name: "Investigation presets" })).toBeNull();
	} finally {
		view.unmount();
		await runtime.dispose();
	}
});

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
		flush();
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
