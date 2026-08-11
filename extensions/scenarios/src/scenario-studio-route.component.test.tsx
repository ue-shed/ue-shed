// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ScenarioStudioRoute } from "./scenario-studio-route.js";
import { movementGymRuns, ScenarioRunHandle, scenarioWireContract } from "@ue-shed/scenarios";
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

const liveHandle = ScenarioRunHandle.make({
	endpoint: "http://127.0.0.1:30010",
	evidenceLimit: 8,
	objectPath: "/Script/Fixture.Scenarios",
	pieSessionId: "pie-session-1",
	runId: "run-live-1",
	scenarioId: "scenario_movement-gym_014"
});

function clientWith(overrides: Partial<ScenarioStudioClient> = {}): ScenarioStudioClient {
	return {
		cancel: () => Effect.succeed({ ...movementGymRuns[1]!, status: "cancelled" as const }),
		settings: () => Effect.succeed({ endpoint: liveHandle.endpoint }),
		start: () => Effect.succeed(liveHandle),
		watch: () =>
			Stream.make({
				_tag: "Terminal" as const,
				contract: scenarioWireContract,
				result: movementGymRuns[1]!
			}),
		...overrides
	};
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
		const client = clientWith();
		renderRoute(client);

		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));

		expect(await screen.findByText("LIVE RESULT")).toBeDefined();
		expect(screen.getByText("Structured PIE result")).toBeDefined();
	});

	it("shows capability recovery without claiming live input was blocked", async () => {
		const user = userEvent.setup();
		const client = clientWith({
			start: () =>
				Effect.fail(
					new ScenarioStudioClientError({
						cause: "capability_unavailable",
						message: "The selected editor does not advertise scenario execution.",
						operation: "scenario.run",
						recovery: "Enable UEShedScenarios and reconnect."
					})
				)
		});
		renderRoute(client);

		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));

		expect(await screen.findByText("RUN FAILED")).toBeDefined();
		expect(screen.getByText(/Enable UEShedScenarios and reconnect/)).toBeDefined();
		expect(screen.getByText("LIVE INPUT NOT BLOCKED")).toBeDefined();
	});

	it("uses the selected endpoint and exposes the producer waiting state", async () => {
		const user = userEvent.setup();
		let selectedEndpoint = "";
		const client = clientWith({
			start: ({ endpoint }) => {
				selectedEndpoint = endpoint;
				return Effect.succeed({ ...liveHandle, endpoint });
			},
			watch: () =>
				Stream.make({
					_tag: "Active" as const,
					contract: scenarioWireContract,
					gameTimeMs: 4100,
					pieSessionId: liveHandle.pieSessionId,
					runId: liveHandle.runId,
					state: "waiting" as const
				})
		});
		renderRoute(client);

		const input = await screen.findByLabelText("Remote Control endpoint");
		await user.clear(input);
		await user.type(input, "http://fixture:30123");
		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));

		expect(await screen.findByText("WAITING")).toBeDefined();
		expect(screen.getByText("00:04.10 game time")).toBeDefined();
		expect(screen.getByText("ISOLATION ACTIVE")).toBeDefined();
		expect(selectedEndpoint).toBe("http://fixture:30123");
	});

	it("cancels an accepted live run and displays its terminal result", async () => {
		const user = userEvent.setup();
		const cancelled = { ...movementGymRuns[1]!, status: "cancelled" as const };
		const client = clientWith({
			cancel: () => Effect.succeed(cancelled),
			watch: () =>
				Stream.make({
					_tag: "Active" as const,
					contract: scenarioWireContract,
					gameTimeMs: 900,
					pieSessionId: liveHandle.pieSessionId,
					runId: liveHandle.runId,
					state: "running" as const
				})
		});
		renderRoute(client);

		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "RUN IN UNREAL" }));
		await user.click(await screen.findByRole("button", { name: "CANCEL RUN" }));

		expect(await screen.findByText("CANCELLED")).toBeDefined();
	});
});
