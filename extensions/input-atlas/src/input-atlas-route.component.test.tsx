// @vitest-environment jsdom

import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { EnhancedInputReport, type EnhancedInputRunResult } from "@ue-shed/enhanced-input/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { InputAtlasClientApi } from "./input-atlas-client.js";
import { InputAtlasRoute } from "./input-atlas-route.js";

const available = (value: string) =>
	({ status: "available", source: "serialized", value }) as const;

const mappingContext = (name: string, key: string, action: string) => ({
	objectPath: `/Game/Input/${name}.${name}`,
	classPath: "/Script/EnhancedInput.InputMappingContext" as const,
	packageFile: `Content/Input/${name}.uasset`,
	contextDescription: available(name),
	mappingsProperty: "Mappings" as const,
	mappings: [{ action, keyName: available(key), triggers: [], modifiers: [] }],
	exports: []
});

const report = Schema.decodeUnknownSync(EnhancedInputReport)({
	schemaVersion: 1,
	status: "complete",
	coverage: {
		discoveredPackages: 4,
		inspectedPackages: 4,
		partialPackages: 0,
		failedPackages: 0,
		inputActions: 2,
		mappingContexts: 2
	},
	actions: [
		{
			objectPath: "/Game/Input/IA_Jump.IA_Jump",
			classPath: "/Script/EnhancedInput.InputAction",
			packageFile: "Content/Input/IA_Jump.uasset",
			actionDescription: available("Jump"),
			valueType: { status: "unavailable", reason: "not_serialized" },
			consumeInput: { status: "unavailable", reason: "not_serialized" }
		},
		{
			objectPath: "/Game/Input/IA_Handbrake.IA_Handbrake",
			classPath: "/Script/EnhancedInput.InputAction",
			packageFile: "Content/Input/IA_Handbrake.uasset",
			actionDescription: available("Handbrake"),
			valueType: { status: "unavailable", reason: "not_serialized" },
			consumeInput: { status: "unavailable", reason: "not_serialized" }
		}
	],
	mappingContexts: [
		mappingContext("IMC_Gameplay", "SpaceBar", "/Game/Input/IA_Jump.IA_Jump"),
		mappingContext("IMC_Vehicle", "SpaceBar", "/Game/Input/IA_Handbrake.IA_Handbrake")
	],
	diagnostics: []
});

const completed = {
	report,
	status: "completed",
	projectRoot: "D:/Projects/DemoGame"
} satisfies EnhancedInputRunResult;

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function renderRoute(client?: Partial<InputAtlasClientApi>) {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<InputAtlasRoute
				client={{
					chooseProjectAndScan: () => Effect.succeed(completed),
					loadConfiguredProject: () => Effect.succeed(completed),
					...client
				}}
			/>
		</EffectRuntimeProvider>
	));
}

describe("InputAtlasRoute interactions", () => {
	it("opens on the contested key and names every context claiming it", async () => {
		renderRoute();
		await screen.findByText("SpaceBar");
		expect(screen.getByText("1 contested")).toBeDefined();
		expect(screen.getByText("Claimed by 2 contexts")).toBeDefined();
		expect(screen.getByText("IA_Jump")).toBeDefined();
		expect(screen.getByText("IA_Handbrake")).toBeDefined();
	});

	it("names the scanned project so a switch is visible", async () => {
		renderRoute();
		await screen.findByText("SpaceBar");
		expect(screen.getByText("DemoGame")).toBeDefined();
		expect(screen.getByText("D:/Projects/DemoGame")).toBeDefined();
	});

	it("keeps the route responsive while a newly chosen project is scanning", async () => {
		const user = userEvent.setup();
		renderRoute({ chooseProjectAndScan: () => Effect.never });
		await screen.findByText("SpaceBar");

		await user.click(screen.getByRole("button", { name: "Choose project…" }));

		expect(screen.getByRole("progressbar")).toBeDefined();
		expect(screen.getByText("Rescanning DemoGame…")).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Choose project…" }).hasAttribute("disabled")
		).toBe(true);
	});

	it("resolves the contest when a context is switched off", async () => {
		const user = userEvent.setup();
		renderRoute();
		const vehicle = await screen.findByRole("button", { name: /IMC_Vehicle/ });

		await user.click(vehicle);
		expect(vehicle.getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByText("No contested keys")).toBeDefined();
		expect(screen.queryByText("IA_Handbrake")).toBeNull();
		expect(screen.getByText("IA_Jump")).toBeDefined();
	});

	it("inverts context selection so only the previously off contexts remain", async () => {
		const user = userEvent.setup();
		renderRoute();
		const vehicle = await screen.findByRole("button", { name: /IMC_Vehicle/ });
		const gameplay = screen.getByRole("button", { name: /IMC_Gameplay/ });

		await user.click(vehicle);
		await user.click(screen.getByRole("button", { name: "Invert" }));

		expect(vehicle.getAttribute("aria-pressed")).toBe("true");
		expect(gameplay.getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByText("No contested keys")).toBeDefined();
		expect(screen.queryByText("IA_Jump")).toBeNull();
		expect(screen.getByText("IA_Handbrake")).toBeDefined();
	});

	it("reports a key nothing claims as unbound rather than hiding it", async () => {
		const user = userEvent.setup();
		renderRoute();
		await screen.findByText("SpaceBar");

		await user.click(screen.getByRole("button", { name: "F" }));
		expect(screen.getByText("Unbound in every enabled context.")).toBeDefined();
		expect(screen.queryByText("IA_Jump")).toBeNull();
	});

	it("renders the full keyboard, including function, navigation, and numpad keys", async () => {
		renderRoute();
		await screen.findByText("SpaceBar");
		expect(screen.getByRole("button", { name: "F12" })).toBeDefined();
		expect(screen.getByRole("button", { name: "Backspace" })).toBeDefined();
		expect(screen.getByRole("button", { name: "PgDn" })).toBeDefined();
		expect(screen.getByTitle("NumPadSeven")).toBeDefined();
	});

	it("says a mapping carried no serialized trigger rather than assuming one", async () => {
		renderRoute();
		await screen.findByText("SpaceBar");
		expect(screen.getAllByText("No trigger").length).toBeGreaterThan(0);
	});

	it("surfaces a failed scan with its recovery guidance", async () => {
		renderRoute({
			loadConfiguredProject: () =>
				Effect.succeed({
					status: "failed",
					error: {
						code: "invalid_project",
						message: "Content directory is missing.",
						recovery: "Choose an Unreal project directory.",
						retrySafe: true
					}
				})
		});
		expect(await screen.findByText("Couldn’t scan this project")).toBeDefined();
		expect(screen.getByText("Content directory is missing.")).toBeDefined();
		expect(screen.getByText("Choose an Unreal project directory.")).toBeDefined();
		expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
	});
});
