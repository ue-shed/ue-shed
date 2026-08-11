import { ConfigExplorerQueryResult } from "../main/ipc-contracts.js";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { ConfigExplorerQuery } from "../main/preload.js";
import { ConfigExplorerShowcase } from "./config-explorer-showcase.js";

const runtime = ManagedRuntime.make(Layer.empty);

function explanation(options: {
	readonly key: string;
	readonly platform: "PlatformA" | "PlatformB";
	readonly value: unknown;
}) {
	return {
		schemaVersion: 1,
		status: "complete",
		project: { descriptor: "FixtureProject" },
		platform: options.platform,
		family: "Game",
		section: "Fixture.Settings",
		key: options.key,
		effectiveValue: options.value,
		contributions: [],
		layers: [
			{
				order: 0,
				layer: "ProjectDefault",
				source: { scope: "project", path: "Config/DefaultGame.ini" },
				status: "read"
			}
		],
		authorities: [
			{ authority: "live_cvars", status: "excluded", detail: "Not live runtime state." }
		],
		diagnostics: []
	};
}

const platformA = explanation({
	key: "Entries",
	platform: "PlatformA",
	value: { kind: "array", values: ["PlatformA"] }
});
const platformB = explanation({
	key: "Entries",
	platform: "PlatformB",
	value: { kind: "array", values: ["PlatformB", "PlatformB"] }
});

const ready = Schema.decodeUnknownSync(ConfigExplorerQueryResult)({
	evidence: {
		schemaVersion: 1,
		status: "different",
		left: platformA,
		right: platformB,
		valueChanged: true,
		coverageChanged: false
	},
	mode: "compare",
	projectName: "UE Shed config fixture",
	source: "sample_fixture",
	status: "ready"
});

afterEach(cleanup);
afterAll(() => runtime.dispose());

function renderShowcase(args: {
	readonly query: (request: ConfigExplorerQuery) => Effect.Effect<ConfigExplorerQueryResult>;
}) {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ConfigExplorerShowcase client={{ configExplorerQuery: args.query }} />
		</EffectRuntimeProvider>
	));
}

describe("ConfigExplorerShowcase", () => {
	it("runs an editable platform comparison and renders supplied evidence", async () => {
		const requests: ConfigExplorerQuery[] = [];
		renderShowcase({
			query: (request) => {
				requests.push(request);
				return Effect.succeed(ready);
			}
		});

		await userEvent.setup().clear(screen.getByLabelText("Config key"));
		await userEvent.setup().type(screen.getByLabelText("Config key"), "Entries");
		await userEvent.setup().click(screen.getByRole("button", { name: /^COMPARE/ }));

		expect(await screen.findByText("VALUE DIVERGES")).toBeDefined();
		expect(requests).toEqual([
			{
				family: "Game",
				key: "Entries",
				leftPlatform: "PlatformA",
				mode: "compare",
				rightPlatform: "PlatformB",
				section: "Fixture.Settings",
				source: "sample_fixture"
			}
		]);
	});

	it("switches to the selected project and surfaces typed recovery", async () => {
		const failed = Schema.decodeUnknownSync(ConfigExplorerQueryResult)({
			error: {
				code: "project_unavailable",
				message: "No Workbench project is selected.",
				recovery: "Choose a project from the Workbench header, then retry.",
				retrySafe: true
			},
			status: "failed"
		});
		renderShowcase({ query: () => Effect.succeed(failed) });

		await userEvent.setup().click(screen.getByRole("button", { name: "Selected project" }));
		await userEvent.setup().click(screen.getByRole("button", { name: /^COMPARE/ }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("No Workbench project is selected");
		expect(alert.textContent).toContain("Choose a project from the Workbench header");
	});
});
