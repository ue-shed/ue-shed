import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchProjectState } from "../main/project-workspace-contract.js";
import type { ProjectChooserProps } from "./project-chooser.js";
import { ProjectChooser } from "./project-chooser.js";

const runtime = ManagedRuntime.make(Layer.empty);
const progress = {
	completed: 0,
	phase: "idle" as const,
	stage: "project_index" as const,
	total: 0
};
const failed: WorkbenchProjectState = {
	error: {
		message: "Native scan exceeded the output_limit budget.",
		recovery: "Retry after upgrading the saved-asset worker."
	},
	status: "failed"
};
const ready: WorkbenchProjectState = {
	project: {
		inputAtlas: "ready",
		mapCount: 2,
		packageCount: 12,
		projectName: "Fixture",
		projectRoot: "C:/Projects/Fixture"
	},
	status: "ready"
};

afterEach(cleanup);
afterAll(() => runtime.dispose());

function renderChooser(args: {
	readonly choose: ProjectChooserProps["client"]["chooseProject"];
	readonly current: WorkbenchProjectState;
	readonly onChosen?: () => void;
}) {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ProjectChooser
				client={{
					chooseProject: args.choose,
					project: () => Effect.succeed(args.current),
					projectProgress: () => Effect.succeed(progress)
				}}
				onChosen={args.onChosen ?? (() => undefined)}
			/>
		</EffectRuntimeProvider>
	));
}

describe("ProjectChooser", () => {
	it("keeps a failed selection visible after indexing closes", async () => {
		renderChooser({
			choose: () => Effect.succeed(failed),
			current: { status: "not_configured" }
		});

		await userEvent
			.setup()
			.click(await screen.findByRole("button", { name: "CHOOSE PROJECT…" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("output_limit");
		expect(alert.textContent).toContain("upgrading the saved-asset worker");
		expect(screen.getByRole("button", { name: "RETRY PROJECT…" })).toBeDefined();
		expect(screen.queryByText("Indexing the selected project")).toBeNull();

		window.dispatchEvent(new Event("focus"));
		await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
		expect(screen.getByRole("button", { name: "RETRY PROJECT…" })).toBeDefined();
	});

	it("clears the prior failure only after a retry starts", async () => {
		const completion = await Effect.runPromise(Deferred.make<WorkbenchProjectState>());
		renderChooser({
			choose: () => Deferred.await(completion),
			current: failed
		});

		expect(await screen.findByRole("alert")).toBeDefined();
		await userEvent.setup().click(screen.getByRole("button", { name: "RETRY PROJECT…" }));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			(screen.getByRole("button", { name: "INDEXING PROJECT…" }) as HTMLButtonElement)
				.disabled
		).toBe(true);

		await Effect.runPromise(Deferred.succeed(completion, { status: "cancelled" }));
		await waitFor(() =>
			expect(
				(screen.getByRole("button", { name: "CHOOSE PROJECT…" }) as HTMLButtonElement)
					.disabled
			).toBe(false)
		);
	});

	it("presents a cancelled selection as idle without a failure", async () => {
		renderChooser({
			choose: () => Effect.succeed({ status: "cancelled" }),
			current: { status: "cancelled" }
		});

		expect(
			(
				(await screen.findByRole("button", {
					name: "CHOOSE PROJECT…"
				})) as HTMLButtonElement
			).disabled
		).toBe(false);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows the ready project and notifies routes after selection", async () => {
		const onChosen = vi.fn();
		renderChooser({
			choose: () => Effect.succeed(ready),
			current: { status: "not_configured" },
			onChosen
		});

		await userEvent
			.setup()
			.click(await screen.findByRole("button", { name: "CHOOSE PROJECT…" }));

		const button = await screen.findByRole("button", { name: "Fixture" });
		expect(button.getAttribute("title")).toBe("C:/Projects/Fixture");
		expect(onChosen).toHaveBeenCalledOnce();
	});
});
