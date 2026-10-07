// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Button, EffectRuntimeProvider } from "@ue-shed/ui";
import {
	textCorpusQuery,
	localizationFocusPage,
	type WorkbenchOperationRequest,
	type WorkbenchOperationResult,
	type WorkbenchOperationState,
	type WorkbenchOperationProgress,
	type WorkbenchOperationPlan,
	type WorkbenchOperationFilesRequest
} from "@ue-shed/game-text/browser";
import { Deferred, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { createSignal } from "solid-js";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { qualityFixture } from "../../../packages/game-text/src/localization-workspace.test-support.js";
import type { GameTextClientApi } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";
import {
	createGameTextOperations,
	SyncWithUnreal,
	UnrealSteps,
	OperationPanel
} from "./game-text-operations.js";

const runtime = ManagedRuntime.make(Layer.empty);
const fixture = qualityFixture();
const plan: WorkbenchOperationPlan = {
	id: "sync-1",
	target: fixture.join.target,
	operation: "sync",
	engine: "5.8",
	wholeRecipe: false,
	steps: ["import", "archive", "compile"],
	fileCount: 2
};
const fileNames = [
	"Content/Localization/Game/de/Game.archive",
	"Content/Localization/Game/de/Game.locres"
];
const completed: WorkbenchOperationResult = {
	status: "completed",
	receipt: {
		id: plan.id,
		target: plan.target,
		operation: "sync",
		changedFiles: 2,
		unplannedFiles: 0,
		translationsImported: 1,
		refreshed: true
	}
};
function client(operations: NonNullable<GameTextClientApi["operations"]>): GameTextClientApi {
	const text = textCorpusQuery(fixture.text, undefined, fixture.join);
	let pending = 1;
	return {
		operations,
		loadConfiguredProject: vi.fn(() =>
			Effect.sync(() => {
				pending = 0;
				return { status: "completed" as const, summary: text.summary() };
			})
		),
		chooseProjectAndScan: () => Effect.die("unused"),
		search: (request) => Effect.succeed({ status: "ready", page: text.search(request) }),
		focus: (request) => {
			const focus = text.focus(request);
			return Effect.succeed(focus ? { status: "found", focus } : { status: "not_found" });
		},
		progress: () =>
			Effect.succeed({ phase: "idle", completed: 0, total: 0, stage: "game_text" }),
		locateAsset: () => Effect.die("unused"),
		chooseQualityRules: () => Effect.die("unused"),
		qualityFocus: () => Effect.die("unused"),
		qualitySearch: () => Effect.die("unused"),
		previewQualityRules: () => Effect.die("unused"),
		saveQualityRules: () => Effect.die("unused"),
		localizationTargets: () =>
			Effect.succeed({
				status: "ready",
				targets: [
					{
						name: fixture.join.target,
						nativeCulture: fixture.join.nativeCulture,
						cultures: fixture.join.cultures
					}
				]
			}),
		localizationTarget: () =>
			Effect.succeed({
				status: "ready",
				target: {
					name: fixture.join.target,
					nativeCulture: fixture.join.nativeCulture,
					cultures: fixture.join.cultures
				},
				lines: 1,
				notSynced: pending
			}),
		localizationFocus: (request) => {
			const line = fixture.join.lines[0];
			if (!line) throw new Error("Missing fixture line.");
			return Effect.succeed({
				status: "found",
				focus: localizationFocusPage(fixture.join, line, request)
			});
		}
	};
}
function api(
	options: {
		readonly state?: WorkbenchOperationState;
		readonly result?: WorkbenchOperationResult;
	} = {}
): NonNullable<GameTextClientApi["operations"]> {
	return {
		state: () =>
			Effect.succeed(
				options.state ?? {
					operations: ["gather", "import", "export", "compile", "reports", "sync"],
					wholeRecipe: false
				}
			),
		plan: vi.fn((request: WorkbenchOperationRequest) =>
			Effect.succeed({
				status: "ready" as const,
				plan: {
					...plan,
					operation: request.operation,
					wholeRecipe: options.state?.wholeRecipe ?? false
				}
			})
		),
		run: vi.fn(() => Effect.succeed(options.result ?? completed)),
		cancel: vi.fn(() => Effect.succeed({ status: "cancelled" as const })),
		files: vi.fn(() =>
			Effect.succeed({
				status: "ready" as const,
				files: fileNames.map((path) => ({ path, planned: true })),
				total: 2
			})
		),
		progress: Stream.never
	};
}
function mount(operations = api(), scanning = false, pending = 1) {
	const onCompleted = vi.fn();
	const [scan, setScan] = createSignal(scanning);
	const view = render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<Harness />
		</EffectRuntimeProvider>
	));
	function Harness() {
		const model = createGameTextOperations({
			client: client(operations),
			target: () => fixture.join.target,
			revision: () => textCorpusQuery(fixture.text).summary(),
			scanning: scan,
			onCompleted
		});
		return (
			<>
				<span>1 not synced</span>
				<SyncWithUnreal model={model} pending={pending} />
				<UnrealSteps model={model} />
				<Button disabled={model.busy()} title={model.reason()}>
					Rescan
				</Button>
				<OperationPanel model={model} />
			</>
		);
	}
	return { ...view, onCompleted, setScan };
}
beforeEach(() => {
	const values = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
		clear: () => values.clear()
	});
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
afterAll(() => runtime.dispose());

it("offers supported steps, confirms every run with the engine and copies project-relative files", async () => {
	const user = userEvent.setup();
	const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
	const operations = api();
	mount(operations);
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	const confirmation = await screen.findByRole("region", { name: "Confirm Unreal step" });
	const panel = within(confirmation);
	expect(panel.getByText(/Unreal Engine 5.8/u)).toBeDefined();
	expect(panel.getByText(fileNames[0] ?? "missing")).toBeDefined();
	expect(
		panel.getByText(
			"Check these files out in your source control first; UE Shed does not touch source control."
		)
	).toBeDefined();
	expect(operations.run).not.toHaveBeenCalled();
	await user.click(panel.getByRole("button", { name: "Copy file list" }));
	await waitFor(() => expect(clipboard).toHaveBeenCalledWith(fileNames.join("\n")));
	await user.click(panel.getByRole("button", { name: "Cancel" }));
	expect(screen.queryByRole("region", { name: "Confirm Unreal step" })).toBeNull();
	expect(operations.run).not.toHaveBeenCalled();
	await user.click(screen.getByRole("button", { name: /^Unreal steps:/u }));
	const menu = within(screen.getByRole("dialog", { name: "Unreal steps choices" }));
	for (const label of [
		"Gather text",
		"Import translations",
		"Export PO files",
		"Compile",
		"Generate Unreal reports",
		"Sync with Unreal"
	])
		expect(menu.getByRole("button", { name: label })).toBeDefined();
	await user.click(menu.getByRole("button", { name: "Gather text" }));
	await waitFor(() =>
		expect(operations.plan).toHaveBeenLastCalledWith({
			target: fixture.join.target,
			operation: "gather"
		})
	);
});

it("config-only targets offer their intact recipe, and zero pending edits keep Sync in the menu", async () => {
	const user = userEvent.setup();
	mount(api({ state: { operations: ["gather", "compile"], wholeRecipe: true } }), false, 0);
	await user.click(await screen.findByRole("button", { name: /^Unreal steps:/u }));
	expect(screen.queryByRole("button", { name: "Sync with Unreal" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Import translations" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "Gather text (whole recipe)" }));
	expect(
		await screen.findByText(/by running its whole config recipe with Unreal Engine/u)
	).toBeDefined();
	cleanup();
	mount(api(), false, 0);
	await user.click(await screen.findByRole("button", { name: /^Unreal steps:/u }));
	expect(screen.getByRole("button", { name: "Sync with Unreal" })).toBeDefined();
});

it("pages confirmation files reactively and copies the whole file list through bounded requests", async () => {
	const user = userEvent.setup();
	const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
	const paths = Array.from(
		{ length: 60 },
		(_, index) => `Content/Localization/Game/File${index}.po`
	);
	const operations = {
		...api(),
		plan: () => Effect.succeed({ status: "ready" as const, plan: { ...plan, fileCount: 60 } }),
		files: vi.fn((request: WorkbenchOperationFilesRequest) => {
			const offset = request.offset ?? 0;
			return Effect.succeed({
				status: "ready" as const,
				total: 60,
				files: paths.slice(offset, offset + 50).map((path) => ({ path, planned: true })),
				...(offset === 0 ? { nextOffset: 50 } : undefined)
			});
		})
	};
	mount(operations);
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	await screen.findByRole("region", { name: "Confirm Unreal step" });
	expect(screen.queryByText("Content/Localization/Game/File59.po")).toBeNull();
	await user.click(screen.getByRole("button", { name: "Show more files" }));
	expect(await screen.findByText("Content/Localization/Game/File59.po")).toBeDefined();
	expect(screen.queryByRole("button", { name: "Show more files" })).toBeNull();
	await user.click(screen.getByRole("button", { name: "Copy file list" }));
	await waitFor(() => expect(clipboard).toHaveBeenCalledWith(paths.join("\n")));
	expect(operations.files).toHaveBeenCalledWith({ id: plan.id, kind: "planned", offset: 50 });
});

it("shows bounded live progress and Cancel, disables scans and releases actions after cancellation", async () => {
	const user = userEvent.setup();
	const done = await Effect.runPromise(Deferred.make<WorkbenchOperationResult>());
	const events = await Effect.runPromise(Queue.unbounded<WorkbenchOperationProgress>());
	const operations = {
		...api(),
		run: vi.fn(() => Deferred.await(done)),
		cancel: vi.fn(() =>
			Deferred.succeed(done, { status: "cancelled" }).pipe(
				Effect.as({ status: "cancelled" as const })
			)
		),
		progress: Stream.fromQueue(events)
	};
	mount(operations);
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Run" }));
	await Effect.runPromise(
		Queue.offer(events, {
			id: plan.id,
			target: plan.target,
			operation: "sync",
			phase: "running",
			stepIndex: 1,
			stepTotal: 3,
			kind: "compile"
		})
	);
	expect(await screen.findByText("Syncing with Unreal · step 2 of 3 · Compile")).toBeDefined();
	expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", true);
	expect(screen.getByRole("button", { name: "Sync with Unreal" })).toHaveProperty(
		"disabled",
		true
	);
	expect(screen.getByRole("button", { name: /^Unreal steps:/u })).toHaveProperty(
		"disabled",
		true
	);
	await user.click(screen.getByRole("button", { name: "Cancel" }));
	expect(await screen.findByText(/Unreal step cancelled/u)).toBeDefined();
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", false)
	);
});

it("reports success, imported counts, unexpected writes and changed files without a write action", async () => {
	const user = userEvent.setup();
	const view = mount(
		api({
			result: {
				status: "completed",
				receipt: {
					...completed.receipt,
					unplannedFiles: 1
				}
			}
		})
	);
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Run" }));
	expect(
		await screen.findByText(/Synced: 2 files changed · 1 translation imported/u)
	).toBeDefined();
	expect(screen.getByText("Unreal wrote 1 file outside the confirmed file list.")).toBeDefined();
	await user.click(screen.getByRole("button", { name: "Show changed files" }));
	expect(await screen.findByText(fileNames[1] ?? "missing")).toBeDefined();
	expect(view.onCompleted).toHaveBeenCalledTimes(1);
	expect(screen.queryByRole("button", { name: /Apply|Write/u })).toBeNull();
});

it("shows typed failure recovery and safe details, and keeps actions disabled during a scan", async () => {
	const user = userEvent.setup();
	const view = mount(
		api({
			result: {
				status: "failed",
				code: "project_locked",
				message: "The project is locked.",
				recovery: "Close Unreal and retry.",
				details: ["Error: [path] is locked"]
			}
		}),
		true
	);
	expect(screen.getByRole("button", { name: "Rescan" })).toHaveProperty("disabled", true);
	view.setScan(false);
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Run" }));
	expect(
		await screen.findByText(/The project is locked. Close Unreal and retry./u)
	).toBeDefined();
	await user.click(screen.getByText("Show details"));
	expect(screen.getByText("Error: [path] is locked")).toBeDefined();
});

it("refreshes the retained workspace after success, clearing the pending indicator without rescanning", async () => {
	const user = userEvent.setup();
	let runs = 0;
	const operations = {
		...api(),
		run: vi.fn(() => {
			runs++;
			return Effect.succeed(completed);
		})
	};
	const apiClient = client(operations);
	const load = vi.fn((refresh?: boolean) => {
		expect(refresh).toBe(false);
		const summary = textCorpusQuery(fixture.text, undefined, fixture.join).summary();
		return Effect.succeed({ status: "completed" as const, summary });
	});
	const selected = vi.fn(() =>
		Effect.succeed({
			status: "ready" as const,
			target: {
				name: fixture.join.target,
				nativeCulture: fixture.join.nativeCulture,
				cultures: fixture.join.cultures
			},
			lines: 1,
			notSynced: runs ? 0 : 1
		})
	);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute
				client={{ ...apiClient, loadConfiguredProject: load, localizationTarget: selected }}
			/>
		</EffectRuntimeProvider>
	));
	await user.click(await screen.findByRole("button", { name: "Sync with Unreal" }));
	await user.click(await screen.findByRole("button", { name: "Run" }));
	await waitFor(() => expect(selected).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(screen.queryByText("1 not synced")).toBeNull());
	expect(load).toHaveBeenCalledTimes(2);
});
