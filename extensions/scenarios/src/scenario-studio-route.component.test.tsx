// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ScenarioStudioRoute } from "./scenario-studio-route.js";
import {
	movementGymRuns,
	movementGymScenario,
	ScenarioDocument,
	ScenarioRunHandle,
	scenarioWireContract
} from "@ue-shed/scenarios/browser";
import { ScenarioStudioClientError, type ScenarioStudioClient } from "./client.js";

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function renderRoute(client?: ScenarioStudioClient, showDemoGuide = false) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			{client === undefined ? (
				<ScenarioStudioRoute showDemoGuide={showDemoGuide} />
			) : (
				<ScenarioStudioRoute client={client} showDemoGuide={showDemoGuide} />
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

const customScenario = Schema.decodeUnknownSync(ScenarioDocument)({
	...movementGymScenario,
	id: "scenario_custom",
	title: "Custom patrol",
	mapPath: "/Game/Maps/L_Custom",
	durationMs: 1500,
	checkpoints: [
		{
			id: "custom_start",
			label: "Patrol start",
			atMs: 0,
			strategy: "restart_map",
			restoreOperation: "RestartPatrol"
		}
	],
	nonSeekableIntervals: [],
	tracks: [
		{
			kind: "evidence",
			id: "custom_track",
			label: "Patrol observations",
			observedAt: "gameplay_response",
			clips: [
				{
					kind: "evidence",
					id: "custom_marker",
					label: "Patrol snapshot",
					startMs: 500,
					evidenceType: "world_state",
					request: "CapturePatrol"
				}
			]
		}
	]
});

function expectCustomDocumentState() {
	expect(screen.getByText("Custom patrol")).toBeDefined();
	expect(screen.getByText("L_Custom")).toBeDefined();
	expect(
		within(screen.getByRole("complementary", { name: "Clip inspector" })).getByRole("heading", {
			name: "Patrol snapshot"
		})
	).toBeDefined();
	expect(screen.getByText("Start at Patrol start")).toBeDefined();
	expect(screen.getByText("0 saved")).toBeDefined();
	expect(screen.getByText("0 found")).toBeDefined();
	expect(screen.getByText("Run this scenario to collect results.")).toBeDefined();
	expect(screen.queryByText("Jump happened 120 ms late")).toBeNull();
	expect(screen.queryByText("Live result")).toBeNull();
}

describe("ScenarioStudioRoute", () => {
	it("restores a custom draft with its own selection, seek plan, and empty results", () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ScenarioStudioRoute
					initialDraft={{
						document: customScenario,
						savedPath: undefined,
						savedJson: undefined
					}}
				/>
			</EffectRuntimeProvider>
		));
		expectCustomDocumentState();
	});

	it("opening a custom document clears the previous run and recomputes seek guidance", async () => {
		const user = userEvent.setup();
		renderRoute(
			clientWith({
				saveDocument: () => Effect.succeed({ status: "cancelled" }),
				openDocument: () =>
					Effect.succeed({
						status: "completed",
						path: "C:/Drafts/custom.json",
						document: customScenario
					})
			})
		);
		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));
		await screen.findByText("Live result");
		await user.click(screen.getByRole("button", { name: "Open draft…" }));
		await screen.findByText("Custom patrol");
		expectCustomDocumentState();
		await user.click(screen.getByRole("button", { name: "Nudge later" }));
		expect(screen.getByText("Start at Patrol start, then play forward 00:00.60")).toBeDefined();
	});
	it("edits action timing and shows how input is replayed", async () => {
		const user = userEvent.setup();
		renderRoute();

		expect(screen.getByText("The Broken Bridge")).toBeDefined();
		expect(screen.getByText("Live input not blocked")).toBeDefined();
		expect(screen.getByText("Moved 120 ms earlier than the recorded take.")).toBeDefined();

		await user.click(screen.getByRole("button", { name: "Nudge later" }));

		expect(screen.getAllByText("00:02.96")).toHaveLength(2);
	});

	it("shows saved captures and run differences", async () => {
		renderRoute();

		expect(screen.getByText("Run results")).toBeDefined();
		expect(screen.getByText("Jump happened 120 ms late")).toBeDefined();
		expect(screen.getByText("2 found")).toBeDefined();
	});

	it("guides the showcase from live lanes to the same headless runner", async () => {
		const user = userEvent.setup();
		renderRoute(
			clientWith({
				saveDocument: (document) =>
					Effect.succeed({
						status: "completed",
						path: "C:/Drafts/movement.json",
						document
					})
			}),
			true
		);

		await screen.findByDisplayValue(liveHandle.endpoint);
		expect(screen.getByRole("region", { name: "Movement Gym demo guide" })).toBeDefined();
		expect(screen.getAllByText("Runs live")).toHaveLength(2);
		// Three preview-only lanes plus the current top-level PREVIEW ONLY runtime state.
		expect(screen.getAllByText("Preview only")).toHaveLength(4);
		expect(
			screen.getByText("Save the draft to generate its PowerShell replay command.")
		).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Save draft…" }));
		expect(
			await screen.findByText(
				`pnpm ue-shed scenarios run '${liveHandle.endpoint}' --document 'C:/Drafts/movement.json'`
			)
		).toBeDefined();

		const input = screen.getByLabelText("Remote Control endpoint");
		await user.clear(input);
		await user.type(input, "http://fixture:30123");

		expect(
			screen.getByText(
				"pnpm ue-shed scenarios run 'http://fixture:30123' --document 'C:/Drafts/movement.json'"
			)
		).toBeDefined();
		await user.click(screen.getByRole("button", { name: "Nudge later" }));
		expect(
			screen.getByText("Save the draft to generate its PowerShell replay command.")
		).toBeDefined();
	});

	it("replaces preview data with a live result through the host-neutral client", async () => {
		const user = userEvent.setup();
		const client = clientWith();
		renderRoute(client);

		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));

		expect(await screen.findByText("Live result")).toBeDefined();
		expect(screen.getByText("Structured PIE result")).toBeDefined();
	});

	it("renders live world-state evidence without inventing a camera capture", async () => {
		const user = userEvent.setup();
		const worldStateEvidence = movementGymRuns[0]?.evidence.find(
			(evidence) => evidence.type === "world_state"
		);
		const baselineRun = movementGymRuns[1];
		if (worldStateEvidence === undefined || baselineRun === undefined) {
			throw new Error("Movement Gym demo runs must contain baseline world-state evidence.");
		}
		const result = {
			...baselineRun,
			evidence: [worldStateEvidence],
			inputIsolation: {
				established: true,
				method: "slate_input_preprocessor" as const,
				restored: true
			}
		};
		renderRoute(
			clientWith({
				watch: () =>
					Stream.make({
						_tag: "Terminal" as const,
						contract: scenarioWireContract,
						result
					})
			}),
			true
		);

		await screen.findByDisplayValue(liveHandle.endpoint);
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));

		expect(await screen.findByText("Input restored")).toBeDefined();
		expect(screen.getByText("World state")).toBeDefined();
		expect(screen.getByText("world state")).toBeDefined();
		expect(screen.getByText(/recorded by the run/)).toBeDefined();
		expect(screen.queryByText("Player camera")).toBeNull();
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
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));

		expect(await screen.findByText("Run failed")).toBeDefined();
		expect(screen.getByText(/Enable UEShedScenarios and reconnect/)).toBeDefined();
		expect(screen.getByText("Live input not blocked")).toBeDefined();
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
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));

		expect(await screen.findByText("Waiting")).toBeDefined();
		expect(screen.getByText("00:04.10 game time")).toBeDefined();
		expect(screen.getByText("Isolation active")).toBeDefined();
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
		await user.click(screen.getByRole("button", { name: "Run in Unreal" }));
		await user.click(await screen.findByRole("button", { name: "Cancel run" }));

		const results = await screen.findByRole("region", { name: "Run results" });
		expect(within(results).getByText("Cancelled")).toBeDefined();
	});
});
