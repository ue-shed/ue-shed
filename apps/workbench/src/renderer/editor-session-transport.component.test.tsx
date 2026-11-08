import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Exit, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { EditorHandoffNotice } from "../shared/editor-handoff.js";
import { EditorPlaySessionId } from "@ue-shed/protocol";
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
					activateEditorWindow: Effect.suspend(activate),
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
					unrealConnectionSettings: Effect.sync(() => ({ endpoint, port: 30001 })),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () => Effect.die("unused"),
					editorResponsiveness: Effect.suspend(() => Effect.die("unused")),
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

it("keeps a pending responsiveness change usable when the settings are reopened", async () => {
	const endpoint = "http://127.0.0.1:30001";
	let saved = true;
	const changes: boolean[] = [];
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
					activateEditorWindow: Effect.suspend(() => Effect.die("unused")),
					editorHandoffs: Stream.empty,
					editorSessionStatuses: Stream.empty,
					unrealConnectionSettings: Effect.sync(() => ({ endpoint, port: 30001 })),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () => Effect.die("unused"),
					editorResponsiveness: Effect.sync(() => settings(saved)),
					setEditorResponsiveness: (enabled) =>
						Effect.promise(
							() =>
								new Promise<ReturnType<typeof settings>>((resolve) => {
									changes.push(enabled);
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
	expect(screen.getByText("Kept responsive.")).toBeTruthy();
	await user.click(checkbox);
	await waitFor(() => expect(checkbox.disabled).toBe(true));
	expect(changes).toEqual([false]);
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

it("L11.4 drops status samples started before a settled command", async () => {
	const stale = await Effect.runPromise(Deferred.make<void>());
	const contract = {
		name: "unreal-editor-play-session" as const,
		version: { major: 1 as const, minor: 0 as const }
	};
	const running = {
		contract,
		state: {
			status: "running" as const,
			mode: "play" as const,
			sessionId: EditorPlaySessionId.make("pie")
		}
	};
	let subscriptions = 0;
	const statuses = Stream.unwrap(
		Effect.sync(() =>
			++subscriptions === 1
				? Stream.concat(
						Stream.succeed(Exit.succeed(running)),
						Stream.fromEffect(
							Deferred.await(stale).pipe(Effect.as(Exit.succeed(running)))
						)
					)
				: Stream.fromEffect(Effect.never)
		)
	);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<EditorSessionTransport
				client={{
					editorSessionStatuses: statuses,
					unrealConnectionSettings: Effect.succeed({
						endpoint: "http://127.0.0.1:30001",
						port: 30001
					}),
					setUnrealConnectionPort: () => Effect.die("unused"),
					executeEditorSessionCommand: () =>
						Effect.succeed({
							contract,
							command: "pause",
							outcome: "accepted",
							state: { ...running.state, status: "paused" }
						}),
					editorHandoffs: Stream.fromEffect(Effect.never),
					activateEditorWindow: Effect.die("unused"),
					editorResponsiveness: Effect.die("unused"),
					setEditorResponsiveness: () => Effect.die("unused")
				}}
			/>
		</EffectRuntimeProvider>
	));
	const user = userEvent.setup({ delay: null });
	await user.click(await screen.findByRole("button", { name: "Pause" }));
	await screen.findByText(/Play.*paused/u);
	await Effect.runPromise(Deferred.succeed(stale, undefined));
	await new Promise<void>((resolve) => queueMicrotask(resolve));
	await waitFor(() => expect(screen.getByText(/Play.*paused/u)).toBeDefined());
});
