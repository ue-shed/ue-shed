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
					launchProject: (mode) => Effect.succeed({ mode, status: "launched" }),
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
			.click(await screen.findByRole("button", { name: "Choose project…" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("output_limit");
		expect(alert.textContent).toContain("upgrading the saved-asset worker");
		expect(screen.getByRole("button", { name: "Retry project…" })).toBeDefined();
		expect(screen.queryByText("Indexing the selected project")).toBeNull();

		window.dispatchEvent(new Event("focus"));
		await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
		expect(screen.getByRole("button", { name: "Retry project…" })).toBeDefined();
	});

	it("clears the prior failure only after a retry starts", async () => {
		const completion = await Effect.runPromise(Deferred.make<WorkbenchProjectState>());
		renderChooser({
			choose: () => Deferred.await(completion),
			current: failed
		});

		expect(await screen.findByRole("alert")).toBeDefined();
		await userEvent.setup().click(screen.getByRole("button", { name: "Retry project…" }));

		expect(screen.queryByRole("alert")).toBeNull();
		expect(
			screen.getByRole<HTMLButtonElement>("button", { name: "Indexing project…" }).disabled
		).toBe(true);

		await Effect.runPromise(Deferred.succeed(completion, { status: "cancelled" }));
		await waitFor(() =>
			expect(
				screen.getByRole<HTMLButtonElement>("button", { name: "Choose project…" }).disabled
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
				await screen.findByRole<HTMLButtonElement>("button", {
					name: "Choose project…"
				})
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
			.click(await screen.findByRole("button", { name: "Choose project…" }));

		const button = await screen.findByRole("button", { name: "Fixture" });
		expect(button.getAttribute("title")).toBe("C:/Projects/Fixture");
		expect(onChosen).toHaveBeenCalledOnce();
	});

	it("keeps project selection offline and offers explicit launch modes", async () => {
		renderChooser({ choose: () => Effect.succeed(ready), current: ready });

		expect(await screen.findByText("Offline")).toBeDefined();
		await userEvent.setup().click(screen.getByText("Launch ▾"));
		expect(screen.getByRole("button", { name: /With plugin suite/ })).toBeDefined();
		expect(screen.getByRole("button", { name: /Plain editor/ })).toBeDefined();
	});

	it("launches the full plugin experience without changing the selected project", async () => {
		const launchProject = vi.fn((mode: "ue_shed" | "normal") =>
			Effect.succeed({ mode, status: "launched" as const })
		);
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<ProjectChooser
					client={{
						chooseProject: () => Effect.succeed(ready),
						launchProject,
						project: () => Effect.succeed(ready),
						projectProgress: () => Effect.succeed(progress)
					}}
					onChosen={() => undefined}
				/>
			</EffectRuntimeProvider>
		));

		await userEvent.setup().click(await screen.findByText("Launch ▾"));
		await userEvent.setup().click(screen.getByRole("button", { name: /With plugin suite/ }));

		await waitFor(() => expect(launchProject).toHaveBeenCalledWith("ue_shed"));
		expect((await screen.findByRole("status")).textContent).toContain("UE Shed plugin suite");
		expect(screen.getByRole("button", { name: "Fixture" })).toBeDefined();
	});
});
