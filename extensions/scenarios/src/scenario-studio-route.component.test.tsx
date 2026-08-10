// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ScenarioStudioRoute } from "./scenario-studio-route.js";

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function renderRoute() {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ScenarioStudioRoute />
		</EffectRuntimeProvider>
	));
}

describe("ScenarioStudioRoute", () => {
	it("edits action timing and shows how input is replayed", async () => {
		const user = userEvent.setup();
		renderRoute();

		expect(screen.getByText("The Broken Bridge")).toBeDefined();
		expect(screen.getByText("PLAYER INPUT OFF")).toBeDefined();
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
});
