import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { SequenceReadResult } from "../shared/saved-review-contract.js";
import type { SavedReviewClient } from "./saved-review-client.js";
import { SequenceViewer } from "./sequence-viewer.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());
const result: Extract<SequenceReadResult, { status: "ready" }> = {
	status: "ready",
	assetPath: "C:/Project/LS.uasset",
	outcome: "partial",
	diagnostics: [],
	sequence: {
		schema_version: 4,
		object_path: "/Game/LS.LS",
		movie_scene_path: "/Game/LS.LS:MovieScene",
		tick_resolution: { numerator: 24000, denominator: 1 },
		display_rate: { numerator: 24, denominator: 1 },
		playback_range: {
			lower: { kind: "inclusive", frame: 0 },
			upper: { kind: "exclusive", frame: 48000 }
		},
		bindings: [],
		root_tracks: [
			{
				object_path: "/Game/LS.LS:MovieScene.Track",
				class_path: "/Script/MovieSceneTracks.MovieSceneFloatTrack",
				content: "numeric",
				property_path: "Intensity",
				sections: [
					{
						object_path: "/Game/LS.LS:MovieScene.Track.Section",
						class_path: "/Script/MovieSceneTracks.MovieSceneFloatSection",
						range: {
							lower: { kind: "inclusive", frame: 0 },
							upper: { kind: "exclusive", frame: 48000 }
						},
						sequence_path: null,
						shot_display_name: null,
						text_keys: [],
						numeric_channels: [
							{
								property_path: "FloatCurve",
								enabled: true,
								default_value: 0.5,
								tick_resolution: { numerator: 24000, denominator: 1 },
								show_curve: true,
								pre_extrapolation: 0,
								post_extrapolation: 0,
								keys: [
									{
										frame: 12000,
										value: 0.75,
										interpolation: 2,
										tangent_mode: 0,
										tangent_weight_mode: 0,
										arrive_tangent: 0.1,
										leave_tangent: 0.2,
										arrive_tangent_weight: 0,
										leave_tangent_weight: 0
									}
								]
							}
						]
					}
				]
			}
		],
		references: [
			{
				owner_path: "/Game/LS.LS",
				owner_class_path: "/Script/LevelSequence.LevelSequence",
				property_path: "Sequence",
				target_path: "/Game/Child.Child",
				scope: "external",
				kind: "soft_object"
			}
		],
		reference_coverage_gaps: [],
		coverage_gaps: [
			{
				object_path: "/Game/LS.LS",
				property_path: "OtherTrack",
				reason: "unsupported_track_content"
			}
		]
	}
};
function setup(overrides: Partial<SavedReviewClient> = {}) {
	const client: SavedReviewClient = {
		readSequence: vi.fn(() => Effect.succeed(result)),
		chooseSequence: () => Effect.succeed({ status: "cancelled" }),
		inventory: () =>
			Effect.succeed({
				status: "ready",
				generation: 1,
				assets: [
					{
						assetPath: "C:/Project/Child.uasset",
						packageName: "/Game/Child",
						kind: "level_sequence"
					}
				]
			}),
		...overrides
	};
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<SequenceViewer
				client={client}
				blueprintClient={{ readBlueprint: () => Effect.succeed({ status: "cancelled" }) }}
				onOpen={vi.fn()}
			/>
		</EffectRuntimeProvider>
	));
	return client;
}
async function open() {
	const user = userEvent.setup();
	await user.type(screen.getByLabelText("Sequence asset path"), "C:/Project/LS.uasset");
	await user.click(screen.getByRole("button", { name: "Open sequence" }));
	await screen.findByText("Partial saved evidence");
	return user;
}
describe("saved sequence review", () => {
	it("opens a timeline, inspects key/tangent evidence and keeps incomplete comparisons visible", async () => {
		setup();
		const user = await open();
		expect(
			screen.getByRole("img", { name: "Saved sequence tracks and sections" })
		).toBeTruthy();
		await user.click(screen.getByRole("button", { name: /^Section$/ }));
		const inspector = screen.getByRole("region", { name: "Section inspector" });
		expect(within(inspector).getByText("0.75")).toBeTruthy();
		expect(within(inspector).getByText("Cubic")).toBeTruthy();
		await user.click(screen.getByText("Compare saved versions"));
		await user.type(screen.getByLabelText("Baseline asset path"), "C:/Baseline/LS.uasset");
		await user.click(screen.getByRole("button", { name: "Compare baseline" }));
		expect((await screen.findByText(/No changes in decoded evidence/)).textContent).toContain(
			"Coverage is incomplete"
		);
	});
	it("follows an external sequence through the explicit project inventory", async () => {
		const client = setup();
		const user = await open();
		await user.click(screen.getByText("References · 1"));
		await user.click(screen.getByRole("button", { name: "Load project references" }));
		await user.click(await screen.findByRole("button", { name: "Open saved asset" }));
		await waitFor(() =>
			expect(client.readSequence).toHaveBeenCalledWith("C:/Project/Child.uasset")
		);
	});
	it("preserves the current timeline when the file picker is cancelled", async () => {
		setup();
		const user = await open();
		await user.click(screen.getByRole("button", { name: "Choose file" }));
		expect(await screen.findByText("Open cancelled.")).toBeTruthy();
		expect(screen.getByText("Partial saved evidence")).toBeTruthy();
	});
	it("shows read failures with recovery", async () => {
		setup({
			readSequence: () =>
				Effect.succeed({
					status: "failed",
					message: "Unsupported package",
					recovery: "Choose an uncooked sequence."
				})
		});
		const user = userEvent.setup();
		await user.type(screen.getByLabelText("Sequence asset path"), "bad.uasset");
		await user.click(screen.getByRole("button", { name: "Open sequence" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Choose an uncooked sequence"
		);
	});
});
