import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type { SequenceSection } from "@ue-shed/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SectionInspector } from "./section-inspector.js";
import { sequenceReadFixture } from "./sequence-fixture.test-support.js";

afterEach(cleanup);

describe("Sequencer section property rows", () => {
	it("keeps saved string, object, camera and settings evidence in compact rows", async () => {
		const base = sequenceReadFixture.sequence.root_tracks[0]?.sections[0];
		if (base === undefined) throw new Error("The fixture must have a section.");
		const section: SequenceSection = {
			...base,
			class_path: "/Script/MovieSceneTracks.MovieSceneStringSection",
			range: {
				lower: { kind: "inclusive", frame: 0 },
				upper: { kind: "exclusive", frame: 120 }
			},
			settings: { ...base.settings, row_index: 2 },
			numeric_channels: [],
			value_channels: [
				{
					value_type: "string",
					property_path: "Label",
					default_value: "default label",
					has_default_value: true,
					keys: [{ frame: 100, value: "世界 🌟" }]
				},
				{
					value_type: "object",
					property_path: "Mesh",
					property_class: "/Script/Engine.StaticMesh",
					default_value: null,
					keys: [{ frame: 24, value: { soft_path: "", hard_path: null } }]
				}
			],
			camera_cut: {
				binding: { guid: "camera", sequence_id: 42, resolve_parent_index: 1 },
				lock_previous_camera: false
			}
		};
		render(() => <SectionInspector section={section} />);
		const inspector = screen.getByRole("region", { name: "Section inspector" });
		expect(within(inspector).getByText("String")).toBeTruthy();
		expect(within(inspector).getByText("0 → 120").getAttribute("title")).toContain(
			"inclusive → exclusive"
		);
		const strings = within(inspector).getByRole("table", { name: "Label saved keys" });
		expect(within(strings).getAllByRole("row")[1]?.textContent).toBe('100 · "世界 🌟"');
		const objects = within(inspector).getByRole("table", { name: "Mesh saved keys" });
		expect(within(objects).getAllByRole("row")[1]?.textContent).toBe("24 · null object");
		const camera = within(inspector).getByRole("region", { name: "Camera binding" });
		expect(camera.textContent).toContain("Sequence ID: 42");
		expect(camera.textContent).toContain("Resolve parent index: 1");
		await userEvent.setup().click(within(inspector).getByText("Saved section settings"));
		expect(inspector.textContent).toContain("row index: 2");
		expect(inspector.textContent).toContain("Default enabled: true");
	});
});
