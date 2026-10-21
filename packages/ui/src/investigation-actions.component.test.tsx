// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime } from "effect";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { EffectRuntimeProvider } from "./effect-solid.js";
import { InvestigationActions } from "./investigation-actions.js";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

it("blocks compact export and preset actions while a project operation is running", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const [blocked, setBlocked] = createSignal(false);
	const opened = vi.fn();
	const user = userEvent.setup();
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InvestigationActions
				compact
				query="text"
				revision={1}
				disabled={false}
				blocked={blocked()}
				onOpen={opened}
				client={{
					export: () => Effect.succeed({ status: "cancelled" }),
					save: () => Effect.succeed({ status: "cancelled" }),
					open: () =>
						Effect.succeed({ status: "opened", path: "preset.json", preset: "text" })
				}}
			/>
		</EffectRuntimeProvider>
	));
	try {
		await user.click(view.getByRole("button", { name: "Presets" }));
		setBlocked(true);
		flush();
		expect(view.getByRole("button", { name: "Export" })).toHaveProperty("disabled", true);
		expect(view.getByRole("button", { name: "Presets" })).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: "Save preset…" })).toHaveProperty(
			"disabled",
			true
		);
		expect(screen.getByRole("button", { name: "Open preset…" })).toHaveProperty(
			"disabled",
			true
		);
		await user.click(screen.getByRole("button", { name: "Open preset…" }));
		expect(opened).not.toHaveBeenCalled();
	} finally {
		view.unmount();
		await runtime.dispose();
	}
});

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
				expect(screen.getByRole("status").textContent).toBe("Exported 1 row: /export")
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
			expect(view.getByRole("alert").textContent).toBe(
				"Disk full. Choose another destination."
			)
		);
		expect(view.getByRole("status").textContent).toBe("");
	} finally {
		view.unmount();
		await runtime.dispose();
	}
});

it("keeps compact results and disabled reasons out of the toolbar flow", async () => {
	const runtime = ManagedRuntime.make(Layer.empty);
	const [disabled, setDisabled] = createSignal(true);
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InvestigationActions
				compact
				query="text"
				revision={1}
				disabled={disabled()}
				disabledReason="Wait for the search to finish before exporting."
				onOpen={() => undefined}
				client={{
					export: () =>
						Effect.succeed({
							status: "failed",
							message: "Disk full.",
							recovery: "Choose another destination."
						}),
					save: () =>
						Effect.succeed({
							status: "saved",
							path: "/preset.json",
							rowCount: 0,
							replayCommand: "pnpm ue-shed investigations run"
						}),
					open: () => Effect.succeed({ status: "cancelled" })
				}}
			/>
		</EffectRuntimeProvider>
	));
	try {
		const panel = view.getByRole("region", { name: "Investigation files" });
		const tools = panel.firstElementChild;
		expect(view.queryByRole("note")).toBeNull();
		expect(panel.textContent).not.toContain("Wait for the search");
		const exporter = view.getByRole("button", { name: "Export" });
		const anchor = exporter.parentElement;
		if (!anchor) throw new Error("The export tool has no hover anchor.");
		await user.hover(anchor);
		vi.advanceTimersByTime(300);
		expect((await screen.findByRole("tooltip")).textContent).toContain("Wait for the search");
		await user.unhover(anchor);

		setDisabled(false);
		flush();
		await user.click(exporter);
		await user.click(screen.getByRole("button", { name: "CSV" }));
		const failure = await view.findByRole("alert");
		expect(failure.textContent).toBe("Disk full. Choose another destination.");
		// Results share one slot after the tools; nothing is inserted before them.
		expect(panel.firstElementChild).toBe(tools);
		expect(panel.children).toHaveLength(2);

		await user.click(view.getByRole("button", { name: "Presets" }));
		await user.click(screen.getByRole("button", { name: "Save preset…" }));
		await waitFor(() =>
			expect(view.getByRole("status").textContent).toBe("Saved preset: /preset.json")
		);
		expect(view.queryByRole("alert")).toBeNull();
		expect(panel.children).toHaveLength(2);
		await user.click(view.getByRole("button", { name: "Presets" }));
		expect(screen.getByRole("button", { name: "Copy CLI replay" })).toBeDefined();
		expect(screen.getByText("pnpm ue-shed investigations run")).toBeDefined();
	} finally {
		view.unmount();
		await runtime.dispose();
	}
});
