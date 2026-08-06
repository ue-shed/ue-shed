// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	defaultFramingParameters,
	FramingCandidateId,
	type FramingCandidateOverride
} from "@ue-shed/cameras";
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
				selectedCandidateId="preset/context_three_quarter/1"
				onParametersChange={setParameters}
				onCandidateOverridesChange={setOverrides}
			/>
		));
		const user = userEvent.setup();
		await user.click(screen.getByText("FRAMING"));
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
				selectedCandidateId="preset/context_three_quarter/1"
				onParametersChange={setParameters}
				onCandidateOverridesChange={setOverrides}
			/>
		));
		const user = userEvent.setup();
		await user.click(screen.getByText("FRAMING"));
		await user.click(screen.getByRole("checkbox", { name: "Per-view override" }));
		const yaw = screen.getByRole("spinbutton", { name: "YAW DELTA" });
		fireEvent.input(yaw, { target: { value: "12" } });
		expect(overrides()).toEqual([
			{
				candidateId: FramingCandidateId.make("preset/context_three_quarter/1"),
				overrides: { yawOffsetDegrees: 12 }
			}
		]);
	});
});
