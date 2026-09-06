// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	defaultFramingParameters,
	FramingCandidateId,
	type FramingCandidateOverride
} from "@ue-shed/cameras/browser";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { FramingSettings } from "./framing-settings.js";

afterEach(cleanup);

describe("FramingSettings", () => {
	it("treats 1-24 as guidance while accepting an exact larger rig", async () => {
		const [parameters, setParameters] = createSignal(defaultFramingParameters());
		const [overrides, setOverrides] = createSignal<readonly FramingCandidateOverride[]>([]);
		render(() => (
			<FramingSettings
				parameters={parameters()}
				candidateOverrides={overrides()}
				selectedCandidate={{
					displayName: "Context three-quarter",
					id: "preset/context_three_quarter/1",
					preset: "context_three_quarter"
				}}
				onParametersChange={setParameters}
				onCandidateOverridesChange={setOverrides}
			/>
		));
		const user = userEvent.setup();
		await user.click(screen.getByText("VIEW PRESETS + RIG"));
		const exact = screen.getByRole("spinbutton", {
			name: "Context three-quarter exact camera count"
		});
		fireEvent.input(exact, { target: { value: "30" } });
		expect(parameters().groups[0]?.pattern.count).toBe(30);
		expect(screen.getByRole("status").textContent).toContain("Large rigs are valid");
	});

	it("stores only an opted-in selected-candidate override", async () => {
		const [parameters, setParameters] = createSignal(defaultFramingParameters());
		const [overrides, setOverrides] = createSignal<readonly FramingCandidateOverride[]>([]);
		render(() => (
			<FramingSettings
				parameters={parameters()}
				candidateOverrides={overrides()}
				selectedCandidate={{
					displayName: "Context three-quarter",
					id: "preset/context_three_quarter/1",
					preset: "context_three_quarter"
				}}
				onParametersChange={setParameters}
				onCandidateOverridesChange={setOverrides}
			/>
		));
		const yaw = screen.getByRole("spinbutton", { name: "YAW OFFSET" });
		fireEvent.input(yaw, { target: { value: "12" } });
		expect(overrides()).toEqual([
			{
				candidateId: FramingCandidateId.make("preset/context_three_quarter/1"),
				overrides: { yawOffsetDegrees: 12 }
			}
		]);
		fireEvent.input(yaw, { target: { value: "" } });
		expect(overrides()).toEqual([]);
	});

	it("scrubs an inherited per-view offset from the preset value", () => {
		const [parameters, setParameters] = createSignal(defaultFramingParameters());
		const [overrides, setOverrides] = createSignal<readonly FramingCandidateOverride[]>([]);
		render(() => (
			<FramingSettings
				parameters={parameters()}
				candidateOverrides={overrides()}
				selectedCandidate={{
					displayName: "Context three-quarter",
					id: "preset/context_three_quarter/1",
					preset: "context_three_quarter"
				}}
				onParametersChange={setParameters}
				onCandidateOverridesChange={setOverrides}
			/>
		));
		const yaw = screen.getByRole("button", { name: "Drag YAW OFFSET to adjust" });
		fireEvent.pointerDown(yaw, { button: 0, clientX: 10, pointerId: 3 });
		fireEvent.pointerMove(yaw, { clientX: 18, pointerId: 3 });
		fireEvent.pointerUp(yaw, { clientX: 18, pointerId: 3 });
		expect(overrides()).toEqual([
			{
				candidateId: FramingCandidateId.make("preset/context_three_quarter/1"),
				overrides: { yawOffsetDegrees: 44 }
			}
		]);
	});
});
