// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ScenarioStudioRoute } from "./scenario-studio-route.js";
import { movementGymRuns } from "@ue-shed/scenarios";
import { ScenarioStudioClientError, type ScenarioStudioClient } from "./client.js";

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function renderRoute(client?: ScenarioStudioClient) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			{client === undefined ? (
				<ScenarioStudioRoute />
			) : (
				<ScenarioStudioRoute client={client} />
			)}
		</EffectRuntimeProvider>
	));
}

describe("ScenarioStudioRoute", () => {
	it("edits action timing and shows how input is replayed", async () => {
		const user = userEvent.setup();
		renderRoute();

		expect(screen.getByText("The Broken Bridge")).toBeDefined();
		expect(screen.getByText("LIVE INPUT NOT BLOCKED")).toBeDefined();
		expect(screen.getByText("Moved 120 ms earlier than the recorded take.")).toBeDefined();

		await user.click(screen.getByRole("button", { name: "Nudge later" }));

		expect(screen.getAllByText("00:02.96")).toHaveLength(2);
	});

	it("shows saved captures and run differences", async () => {
		renderRoute();

		expect(screen.getByText("RUN RESULTS")).toBeDefined();
		expect(screen.getByText("Jump happened 120 ms late")).toBeDefined();
		expect(screen.getByText("2 found")).toBeDefined();
	});

	it("replaces preview data with a live result through the host-neutral client", async () => {
		const user = userEvent.setup();
		const client: ScenarioStudioClient = {
			run: () => Effect.succeed(movementGymRuns[1]!)
		};
		renderRoute(client);

		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));

		expect(await screen.findByText("LIVE RESULT")).toBeDefined();
		expect(screen.getByText("Structured PIE result")).toBeDefined();
	});

	it("shows capability recovery without claiming live input was blocked", async () => {
		const user = userEvent.setup();
		const client: ScenarioStudioClient = {
			run: () =>
				Effect.fail(
					new ScenarioStudioClientError({
						cause: "capability_unavailable",
						message: "The selected editor does not advertise scenario execution.",
						operation: "scenario.run",
						recovery: "Enable UEShedScenarios and reconnect."
					})
				)
		};
		renderRoute(client);

		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));

		expect(await screen.findByText("RUN FAILED")).toBeDefined();
		expect(screen.getByText(/Enable UEShedScenarios and reconnect/)).toBeDefined();
		expect(screen.getByText("LIVE INPUT NOT BLOCKED")).toBeDefined();
	});
});
