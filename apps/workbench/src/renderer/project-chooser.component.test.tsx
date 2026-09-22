import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchProjectState } from "../shared/project-workspace-contract.js";
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
	readonly openRecent?: ProjectChooserProps["client"]["openRecentProject"];
	readonly onChosen?: () => void;
	readonly project?: ProjectChooserProps["client"]["project"];
	readonly recent?: readonly { readonly projectName: string; readonly projectRoot: string }[];
	readonly launch?: ProjectChooserProps["client"]["launchProject"];
}) {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ProjectChooser
				client={{
					chooseProject: args.choose,
					launchProject:
						args.launch ?? ((mode) => Effect.succeed({ mode, status: "launched" })),
					openRecentProject:
						args.openRecent ?? (() => Effect.succeed({ status: "cancelled" })),
					project: args.project ?? (() => Effect.succeed(args.current)),
					projectProgress: () => Effect.succeed(progress),
					recentProjects: () => Effect.succeed(args.recent ?? [])
				}}
				onChosen={args.onChosen ?? (() => undefined)}
			/>
		</EffectRuntimeProvider>
	));
}

describe("ProjectChooser", () => {
	it("shows launch recovery outside the footer and closes the launch menu", async () => {
		const user = userEvent.setup();
		renderChooser({
			current: ready,
			choose: () => Effect.succeed(ready),
			launch: () =>
				Effect.succeed({
					status: "failed",
					message:
						"Your project's compiled modules don't match the selected Unreal engine.",
					recovery:
						"Close Unreal and build the project's Editor target, then launch again.",
					details: "Engine build ID: technical-only"
				})
		});
		await user.click(await screen.findByText("Launch ▾"));
		await user.click(screen.getByRole("button", { name: /With plugin suite/ }));
		const dialog = await screen.findByRole("dialog", { name: "Unreal couldn’t start" });
		expect(dialog.textContent).toContain("What to do next");
		expect(dialog.textContent).toContain("build the project's Editor target");
		expect(dialog.closest("aside")).toBeNull();
		expect(screen.queryByRole("button", { name: /With plugin suite/ })).toBeNull();
		const details = dialog.querySelector("details")!;
		expect(details.open).toBe(false);
		await user.click(screen.getByText("Technical details"));
		expect(details.open).toBe(true);
		dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByText("Launch ▾")).toBeDefined();
	});
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
		const user = userEvent.setup();
		const summary = screen.getByText("Launch ▾");
		await user.click(summary);
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("button", { name: /With plugin suite/ })).toBeDefined();
		expect(screen.getByRole("button", { name: /Plain editor/ })).toBeDefined();
		await user.click(screen.getByText("Offline"));
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		await user.click(summary);
		await user.keyboard("{Escape}");
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(summary);
	});

	it("offers recent projects and switches without reopening the directory picker", async () => {
		const onChosen = vi.fn();
		const otherProject: WorkbenchProjectState = {
			project: {
				inputAtlas: "deferred",
				mapCount: 1,
				packageCount: 8,
				projectName: "OtherProject",
				projectRoot: "D:/Projects/OtherProject"
			},
			status: "ready"
		};
		const openRecent = vi.fn(() => Effect.succeed(otherProject));
		renderChooser({
			choose: () => Effect.succeed({ status: "cancelled" }),
			current: ready,
			onChosen,
			openRecent,
			recent: [ready.project, otherProject.project]
		});

		const user = userEvent.setup();
		const recentSummary = await screen.findByLabelText("Recent projects");
		await user.click(recentSummary);
		expect(recentSummary.getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByText("Stored only on this device")).toBeDefined();
		expect(
			screen.getByRole<HTMLButtonElement>("button", {
				name: "Open recent project Fixture"
			}).disabled
		).toBe(true);
		await user.click(screen.getByText("Offline"));
		expect(recentSummary.getAttribute("aria-expanded")).toBe("false");
		await user.click(recentSummary);
		await user.click(screen.getByRole("button", { name: "Open recent project OtherProject" }));

		await waitFor(() => expect(openRecent).toHaveBeenCalledWith("D:/Projects/OtherProject"));
		expect(await screen.findByRole("button", { name: "OtherProject" })).toBeDefined();
		expect(onChosen).toHaveBeenCalledOnce();
	});

	it("ignores an older project refresh after a recent selection completes", async () => {
		const staleRefresh = await Effect.runPromise(Deferred.make<WorkbenchProjectState>());
		const otherProject: WorkbenchProjectState = {
			project: {
				inputAtlas: "deferred",
				mapCount: 1,
				packageCount: 8,
				projectName: "OtherProject",
				projectRoot: "D:/Projects/OtherProject"
			},
			status: "ready"
		};
		renderChooser({
			choose: () => Effect.succeed({ status: "cancelled" }),
			current: ready,
			openRecent: () => Effect.succeed(otherProject),
			project: () => Deferred.await(staleRefresh).pipe(Effect.uninterruptible),
			recent: [ready.project, otherProject.project]
		});

		await userEvent.setup().click(await screen.findByLabelText("Recent projects"));
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Open recent project OtherProject" }));
		expect(await screen.findByRole("button", { name: "OtherProject" })).toBeDefined();

		await Effect.runPromise(Deferred.succeed(staleRefresh, ready));
		await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

		expect(screen.getByRole("button", { name: "OtherProject" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Fixture" })).toBeNull();
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
						openRecentProject: () => Effect.succeed(ready),
						project: () => Effect.succeed(ready),
						projectProgress: () => Effect.succeed(progress),
						recentProjects: () => Effect.succeed([])
					}}
					onChosen={() => undefined}
				/>
			</EffectRuntimeProvider>
		));

		await userEvent.setup().click(await screen.findByText("Launch ▾"));
		await userEvent.setup().click(screen.getByRole("button", { name: /With plugin suite/ }));

		await waitFor(() => expect(launchProject).toHaveBeenCalledWith("ue_shed"));
		expect((await screen.findByRole("status")).textContent).toContain("UE Shed plugin suite");
		await userEvent
			.setup()
			.click(screen.getByRole("button", { name: "Dismiss launch notice" }));
		expect(screen.queryByRole("status")).toBeNull();
		expect(screen.getByRole("button", { name: "Fixture" })).toBeDefined();
	});
});
