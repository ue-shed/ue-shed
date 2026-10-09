import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Exit, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { EditorHandoffNotice } from "../shared/editor-handoff.js";
import { EditorSessionTransport } from "./editor-session-transport.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

it("offers Show Unreal and retains focus feedback independently of session status", async () => {
	const endpoint = "http://127.0.0.1:30001";
	let sendNotice = (_notice: EditorHandoffNotice) => {};
	const subscribed = vi.fn();
	const activate = vi.fn(() => Effect.succeed({ endpoint, message: null }));
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<EditorSessionTransport
				client={{
					activateEditorWindow: activate,
					editorHandoffs: Stream.callback<EditorHandoffNotice>((queue) =>
						Effect.sync(() => {
							sendNotice = (notice) => {
								Queue.offerUnsafe(queue, notice);
							};
							subscribed();
						})
					),
					editorSessionStatuses: Stream.make(
						Exit.succeed({
							contract: {
								name: "unreal-editor-play-session",
								version: { major: 1, minor: 0 }
							},
							state: { status: "stopped" }
						} as const)
					),
					unrealConnectionSettings: () => Effect.succeed({ endpoint, port: 30001 }),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () => Effect.die("unused"),
					editorResponsiveness: () => Effect.die("unused"),
					setEditorResponsiveness: () => Effect.die("unused")
				}}
			/>
		</EffectRuntimeProvider>
	));
	const button = screen.getByRole<HTMLButtonElement>("button", { name: "Show Unreal ↗" });
	await waitFor(() => expect(button.disabled).toBe(false));
	await waitFor(() => expect(subscribed).toHaveBeenCalledOnce());
	sendNotice({ endpoint: "http://127.0.0.1:31001", message: "Old editor failed" });
	sendNotice({ endpoint, message: "Windows did not activate the editor window." });
	expect((await screen.findByRole("status")).textContent).toContain("Windows did not activate");
	expect(screen.queryByText("Old editor failed")).toBeNull();
	await userEvent.setup().click(button);
	expect(activate).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
});

it("turns Unreal responsiveness off from the target settings and shows its state", async () => {
	const endpoint = "http://127.0.0.1:30001";
	const setEditorResponsiveness = vi.fn((enabled: boolean) =>
		Effect.succeed({
			enabled,
			state: enabled ? ("active" as const) : ("off" as const),
			detail: enabled ? "Kept responsive." : "Unreal's own background setting applies."
		})
	);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<EditorSessionTransport
				client={{
					activateEditorWindow: () => Effect.die("unused"),
					editorHandoffs: Stream.empty,
					editorSessionStatuses: Stream.empty,
					unrealConnectionSettings: () => Effect.succeed({ endpoint, port: 30001 }),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () => Effect.die("unused"),
					editorResponsiveness: () =>
						Effect.succeed({
							enabled: true,
							state: "active",
							detail: "Kept responsive."
						}),
					setEditorResponsiveness
				}}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	await user.click(await screen.findByLabelText("Change Unreal target port"));
	const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", {
		name: "Keep Unreal responsive while Workbench is in front"
	});
	await waitFor(() => expect(checkbox.checked).toBe(true));
	expect(screen.getByText("Kept responsive.")).toBeTruthy();
	await user.click(checkbox);
	expect(setEditorResponsiveness).toHaveBeenCalledWith(false);
	await waitFor(() => expect(checkbox.checked).toBe(false));
	expect(screen.getByText("Unreal's own background setting applies.")).toBeTruthy();
});

it("keeps a pending responsiveness change usable when the settings are reopened", async () => {
	const endpoint = "http://127.0.0.1:30001";
	let saved = true;
	let settle = () => {};
	const settings = (enabled: boolean) => ({
		enabled,
		state: enabled ? ("active" as const) : ("off" as const),
		detail: enabled ? "Kept responsive." : "Unreal's own background setting applies."
	});
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<EditorSessionTransport
				client={{
					activateEditorWindow: () => Effect.die("unused"),
					editorHandoffs: Stream.empty,
					editorSessionStatuses: Stream.empty,
					unrealConnectionSettings: () => Effect.succeed({ endpoint, port: 30001 }),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () => Effect.die("unused"),
					editorResponsiveness: () => Effect.sync(() => settings(saved)),
					setEditorResponsiveness: (enabled) =>
						Effect.promise(
							() =>
								new Promise<ReturnType<typeof settings>>((resolve) => {
									settle = () => {
										saved = enabled;
										resolve(settings(enabled));
									};
								})
						)
				}}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup();
	const summary = await screen.findByLabelText("Change Unreal target port");
	await user.click(summary);
	const checkbox = await screen.findByRole<HTMLInputElement>("checkbox", {
		name: "Keep Unreal responsive while Workbench is in front"
	});
	await waitFor(() => expect(checkbox.checked).toBe(true));
	await user.click(checkbox);
	await waitFor(() => expect(checkbox.disabled).toBe(true));
	// Close and reopen the settings while the change is still in flight.
	await user.click(summary);
	await user.click(summary);
	settle();
	await waitFor(() => expect(checkbox.disabled).toBe(false));
	expect(checkbox.checked).toBe(false);
	await user.click(summary);
	await user.click(summary);
	await waitFor(() =>
		expect(screen.getByText("Unreal's own background setting applies.")).toBeTruthy()
	);
	expect(checkbox.checked).toBe(false);
	expect(checkbox.disabled).toBe(false);
});
