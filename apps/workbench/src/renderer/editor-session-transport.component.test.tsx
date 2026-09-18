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
					executeEditorSessionCommand: () => Effect.die("unused")
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
