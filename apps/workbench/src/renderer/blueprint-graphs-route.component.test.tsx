import { cleanup, render, screen } from "@solidjs/testing-library";
import * as extension from "@ue-shed/extension-blueprint-graphs";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchRendererError, type WorkbenchRendererClient } from "./workbench-client.js";
import { createBlueprintGraphsRoute } from "./blueprint-graphs-route.js";

const host = {
	readBlueprint: vi.fn<WorkbenchRendererClient["readBlueprint"]>(),
	searchBlueprints: vi.fn<WorkbenchRendererClient["searchBlueprints"]>()
};
const runtime = ManagedRuntime.make(Layer.empty);
const Route = createBlueprintGraphsRoute(extension, {
	client: host,
	reviewClient: {
		inventory: () => Effect.never,
		readSequence: () => Effect.never
	}
});
const assetPath = "C:/Project/Content/BP_Example.uasset";
const read: extension.ReadyBlueprintGraphRead = {
	assetPath,
	blueprint: {
		schema_version: 2,
		definition: {
			parent_class: null,
			variables: null,
			default_object: null,
			construction_script: null
		},
		object_path: "/Game/BP_Example.BP_Example",
		coverage_gaps: [],
		graphs: []
	},
	diagnostics: [],
	outcome: "complete",
	status: "ready"
};

beforeEach(() => {
	vi.clearAllMocks();
	host.searchBlueprints.mockReturnValue(Effect.succeed({ status: "not_configured" }));
	host.readBlueprint.mockReturnValue(Effect.succeed(read));
});
afterEach(cleanup);
afterAll(() => runtime.dispose());

describe("BlueprintGraphsRoute", () => {
	it("turns navigation into an initial read and composes the saved review footer", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<Route initialAssetPath={assetPath} />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByRole("heading", { name: "BP_Example" })).toBeTruthy();
		expect(host.readBlueprint).toHaveBeenCalledTimes(1);
		expect(host.readBlueprint).toHaveBeenCalledWith(assetPath);
		expect(host.searchBlueprints).toHaveBeenCalledWith({ query: "" });
		expect(screen.getByRole("region", { name: "Saved references and changes" })).toBeTruthy();
		expect(screen.getByText("Compare saved versions")).toBeTruthy();
	});

	it("preserves the Workbench project-selection copy", async () => {
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<Route />
			</EffectRuntimeProvider>
		));
		expect(await screen.findByRole("heading", { name: "No project selected" })).toBeTruthy();
		expect(
			screen.getByText(/Choose a project in the sidebar to search its Blueprints/)
		).toBeTruthy();
	});

	it("preserves the Workbench transport-failure copy", async () => {
		host.readBlueprint.mockReturnValue(
			Effect.fail(
				new WorkbenchRendererError({
					cause: "IPC unavailable",
					operation: "blueprintGraphs.read",
					recovery: "Retry"
				})
			)
		);
		render(() => (
			<EffectRuntimeProvider runtime={runtime}>
				<Route initialAssetPath={assetPath} />
			</EffectRuntimeProvider>
		));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The local reader request failed");
		expect(alert.textContent).toContain(
			"Workbench could not complete the local reader request."
		);
		expect(alert.textContent).toContain(
			"Verify the configured uasset executable, then retry. Unreal is not required."
		);
	});
});
