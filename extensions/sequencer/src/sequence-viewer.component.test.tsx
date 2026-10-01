import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SequenceViewer, type ReadySequenceRead } from "./sequence-viewer.js";
import { ProjectSequenceSearch } from "./project-sequence-search.js";
import { sequenceReadFixture as read } from "./sequence-fixture.test-support.js";
import type { SequenceAssetSearchResult } from "./contract.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("shared Sequencer viewer", () => {
	it("renders summary, timeline selection and saved numeric evidence", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					initialRead={Effect.succeed(read)}
					opener={() => <span>Host opener</span>}
				/>
			</EffectRuntimeProvider>
		));
		const summary = await screen.findByRole("region", { name: "Sequence coverage" });
		await screen.findByRole("heading", { name: "LS" });
		expect(summary.textContent).toContain("Partial · 1");
		expect(summary.textContent).toContain("1 tracks · 0 bindings · 1 sections · 1 keys");
		expect(summary.textContent).toContain("24 fps");
		expect(summary.textContent).not.toContain("24/1 fps");
		expect(summary.textContent).toContain("0–48 frames · 2.0 s");
		expect(screen.getByRole("heading", { name: "Sequencer", level: 1 })).toBeTruthy();
		expect(screen.getByText("Read-only · no Unreal required")).toBeTruthy();
		expect(screen.getByText("Float · 1 key")).toBeTruthy();
		expect(
			screen.getByRole("img", { name: "Saved sequence tracks and sections" })
		).toBeTruthy();
		expect(
			within(
				screen.getByRole("img", { name: "Saved sequence tracks and sections" })
			).getByText("48")
		).toBeTruthy();
		const sections = screen.getByRole("list", { name: "Sections" });
		expect(within(sections).getByRole("listitem").textContent).toContain("Root · Intensity");
		await userEvent.setup().click(within(sections).getByRole("button", { name: "Section" }));
		const inspector = screen.getByRole("region", { name: "Section inspector" });
		expect(within(inspector).getByText("Float")).toBeTruthy();
		expect(within(inspector).getByText("0 → 48000")).toBeTruthy();
		expect(
			within(inspector).getByRole("table", { name: "FloatCurve saved keys" })
		).toBeTruthy();
		expect(within(inspector).getByText("0.75")).toBeTruthy();
		expect(within(inspector).getByText("Cubic")).toBeTruthy();
		expect(within(inspector).getByText("0.1 / 0.2")).toBeTruthy();
		expect(within(inspector).getByText("Saved section settings")).toBeTruthy();
	});

	it("shortens track labels and renders compact trackless bindings", async () => {
		const track = read.sequence.root_tracks[0];
		if (track === undefined) throw new Error("The fixture must have one root track.");
		const timelineRead: ReadySequenceRead = {
			...read,
			sequence: {
				...read.sequence,
				root_tracks: [
					track,
					...["Sub", "CinematicShot", "CameraCut"].map((name) => ({
						...track,
						object_path: `${track.object_path}.${name}`,
						class_path: `/Script/MovieSceneTracks.MovieScene${name}Track`,
						property_path: null,
						sections: []
					}))
				],
				bindings: [
					{
						id: "existing",
						name: "ExistingCamera",
						kind: "possessable",
						parent_id: null,
						possessed_object_class: null,
						object_template: null,
						object_template_class: null,
						tracks: []
					},
					{
						id: "spawned",
						name: "SpawnedCamera",
						kind: "spawnable",
						parent_id: null,
						possessed_object_class: null,
						object_template: null,
						object_template_class: null,
						tracks: []
					}
				]
			}
		};
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer initialRead={Effect.succeed(timelineRead)} opener={() => null} />
			</EffectRuntimeProvider>
		));
		await screen.findByRole("heading", { name: "LS" });
		expect(screen.getByText("Root · 4 tracks")).toBeTruthy();
		for (const name of ["Sub", "CinematicShot", "CameraCut"]) {
			const label = screen.getByText(name);
			expect(label.parentElement?.getAttribute("title")).toContain(`MovieScene${name}Track`);
		}
		const sections = screen.getByRole("list", { name: "Sections" });
		expect(
			within(sections)
				.getAllByRole("listitem")
				.map((item) => item.textContent)
				.join(" ")
		).toContain("Root · MovieSceneCameraCutTrack");
		for (const name of ["ExistingCamera", "SpawnedCamera"]) {
			const binding = within(sections).getByRole("group", { name });
			expect(binding.textContent).toContain("no tracks");
			expect(binding.querySelector("summary")).toBeNull();
			expect(binding.querySelector("button")).toBeNull();
		}
		await userEvent.setup().click(within(sections).getByRole("button", { name: "Section" }));
		expect(screen.getByText("Root · 4 tracks")).toBeTruthy();
	});

	it("formats fractional frame rates with the saved rational rate in a tooltip", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					initialRead={Effect.succeed({
						...read,
						sequence: {
							...read.sequence,
							display_rate: { numerator: 30000, denominator: 1001 }
						}
					})}
					opener={() => null}
				/>
			</EffectRuntimeProvider>
		));
		await screen.findByRole("heading", { name: "LS" });
		const rate = screen.getByText("29.97 fps · 0–60 frames · 2.0 s");
		expect(rate.getAttribute("title")).toBe("30000/1001 fps");
	});

	it("opens indexed evidence from the search, then keeps the search next to the title", async () => {
		const readSequence = vi.fn(() => Effect.succeed(read));
		const searchSequences = vi.fn(() =>
			Effect.succeed<SequenceAssetSearchResult>({
				status: "ready",
				projectName: "Fixture",
				matchCount: 1,
				assets: [
					{
						assetName: "LS",
						assetPath: "LS.uasset",
						className: "LevelSequence",
						packageName: "/Game/LS",
						relativePath: "Content/LS.uasset"
					}
				]
			})
		);
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					opener={(controls) => (
						<ProjectSequenceSearch
							controls={controls}
							searchSequences={searchSequences}
							readSequence={readSequence}
						/>
					)}
				/>
			</EffectRuntimeProvider>
		));
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: "Open LS from project index" }));
		await screen.findByRole("heading", { name: "LS" });
		expect(readSequence).toHaveBeenCalledWith("LS.uasset");
		expect(searchSequences).toHaveBeenCalledWith({ query: "" });
		const search = screen.getByLabelText("Search project Sequences");
		await user.type(search, "missing");
		await screen.findByRole("button", { name: "Open LS from project index" });
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("button", { name: "Open LS from project index" })).toBeNull();
	});

	it("asks for a project with host copy", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					opener={(controls) => (
						<ProjectSequenceSearch
							controls={controls}
							searchSequences={() => Effect.succeed({ status: "not_configured" })}
							readSequence={() => Effect.never}
							noProjectHint="Choose a project in this host."
						/>
					)}
				/>
			</EffectRuntimeProvider>
		));
		await screen.findByRole("heading", { name: "No project selected" });
		expect(screen.getByText(/Choose a project in this host/)).toBeTruthy();
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("preserves the timeline on cancellation and renders host failure actions", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					initialRead={Effect.succeed({ ...read, outcome: "complete" })}
					opener={(controls) => (
						<>
							<button
								onClick={() =>
									controls.open(Effect.succeed({ status: "cancelled" }))
								}
							>
								Cancel
							</button>
							<button
								onClick={() =>
									controls.open(
										Effect.succeed({
											status: "failed",
											reason: "unsupported_asset",
											message: "Unsupported package",
											recovery: "Choose an uncooked sequence."
										})
									)
								}
							>
								Reject
							</button>
						</>
					)}
					failureActions={() => <a href="/inspect">Inspect this file instead</a>}
				/>
			</EffectRuntimeProvider>
		));
		await screen.findByText("Fully decoded");
		await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
		await screen.findByText("Open cancelled.");
		expect(screen.getByText("Fully decoded")).toBeTruthy();
		await userEvent.setup().click(screen.getByRole("button", { name: "Reject" }));
		expect((await screen.findByRole("alert")).textContent).toContain(
			"Choose an uncooked sequence."
		);
		expect(screen.getByRole("link", { name: "Inspect this file instead" })).toBeTruthy();
	});

	it("shows host transport copy when the read Effect fails", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<SequenceViewer
					initialRead={Effect.fail("transport unavailable")}
					opener={() => null}
					transportFailureCopy={{
						title: "Host unavailable",
						message: "Request failed",
						recovery: "Retry host"
					}}
				/>
			</EffectRuntimeProvider>
		));
		expect((await screen.findByRole("alert")).textContent).toContain("Host unavailable");
		expect(screen.getByText("Retry host")).toBeTruthy();
	});
});
