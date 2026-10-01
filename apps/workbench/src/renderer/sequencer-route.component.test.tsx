import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import * as extension from "@ue-shed/extension-sequencer";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sequenceReadFixture as read } from "../../../../extensions/sequencer/src/sequence-fixture.test-support.js";
import type { SavedReviewClient } from "./saved-review-client.js";
import { WorkbenchRendererError } from "./workbench-client.js";
import { createSequencerRoute } from "./sequencer-route.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

function setup(overrides: Partial<SavedReviewClient> = {}, initialAssetPath?: string) {
	const client: SavedReviewClient = {
		readSequence: vi.fn(() => Effect.succeed(read)),
		inventory: () =>
			Effect.succeed({
				status: "ready",
				generation: 1,
				projectName: "Fixture",
				assets: [
					{
						assetPath: "Child.uasset",
						packageName: "/Game/Child",
						kind: "level_sequence"
					}
				]
			}),
		...overrides
	};
	const Route = createSequencerRoute(extension, {
		reviewClient: client,
		client: { readBlueprint: () => Effect.succeed({ status: "cancelled" }) }
	});
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Route initialAssetPath={initialAssetPath} />
		</EffectRuntimeProvider>
	));
	return { client, view };
}

describe("Workbench Sequencer route", () => {
	it("turns navigation into one read and composes saved references and comparisons", async () => {
		const { client } = setup({}, "LS.uasset");
		await screen.findByRole("heading", { name: "LS" });
		expect(client.readSequence).toHaveBeenCalledTimes(1);
		expect(client.readSequence).toHaveBeenCalledWith("LS.uasset");
		expect(screen.getByRole("region", { name: "Saved references and changes" })).toBeTruthy();
		const user = userEvent.setup();
		await user.click(screen.getByText("Compare saved versions"));
		await user.type(screen.getByLabelText("Baseline asset path"), "Baseline.uasset");
		await user.click(screen.getByRole("button", { name: "Compare baseline" }));
		expect((await screen.findByText(/No changes in decoded evidence/)).textContent).toContain(
			"Coverage is incomplete"
		);
		expect(client.readSequence).toHaveBeenCalledWith("Baseline.uasset");
	});

	it("searches the scanned inventory and follows an external sequence reference", async () => {
		const { client } = setup();
		const user = userEvent.setup();
		await user.click(
			await screen.findByRole("button", { name: "Open Child from project index" })
		);
		await screen.findByRole("heading", { name: "LS" });
		expect(client.readSequence).toHaveBeenCalledWith("Child.uasset");
		await user.click(screen.getByText("References · 1"));
		await user.click(screen.getByRole("button", { name: "Load project references" }));
		await user.click(await screen.findByRole("button", { name: "Open saved asset" }));
		await waitFor(() => expect(client.readSequence).toHaveBeenCalledTimes(2));
	});

	it("shows project-selection copy and preserves real inventory failures", async () => {
		const { view } = setup({
			inventory: () =>
				Effect.succeed({
					status: "not_configured",
					message: "Select a project",
					recovery: "Choose a project"
				})
		});
		await screen.findByRole("heading", { name: "No project selected" });
		expect(
			screen.getByText(/Choose a project in the sidebar to search its Level Sequences/)
		).toBeTruthy();
		view.unmount();
		setup({
			inventory: () =>
				Effect.succeed({
					status: "failed",
					message: "Index unavailable",
					recovery: "Refresh the project index"
				})
		});
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Refresh the project index"
		);
	});

	it("shows the native transport recovery", async () => {
		setup(
			{
				readSequence: () =>
					Effect.fail(
						new WorkbenchRendererError({
							cause: "IPC unavailable",
							operation: "readSequence",
							recovery: "Retry"
						})
					)
			},
			"LS.uasset"
		);
		expect((await screen.findByRole("alert")).textContent).toContain(
			"configured uasset executable"
		);
	});
});
