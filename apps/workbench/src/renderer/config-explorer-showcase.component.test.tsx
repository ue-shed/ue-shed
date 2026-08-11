import { ConfigExplorerShowcaseResult } from "../main/ipc-contracts.js";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConfigExplorerShowcase } from "./config-explorer-showcase.js";

const runtime = ManagedRuntime.make(Layer.empty);

function explanation(options: {
	readonly key: string;
	readonly platform: "PlatformA" | "PlatformB";
	readonly status?: "complete" | "partial";
	readonly value: unknown;
}) {
	return {
		schemaVersion: 1,
		status: options.status ?? "complete",
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
				status: options.status === "partial" ? "unsupported" : "read"
			}
		],
		authorities: [
			{ authority: "live_cvars", status: "excluded", detail: "Not live runtime state." }
		],
		diagnostics:
			options.status === "partial"
				? [{ code: "unsupported_operator", message: "Keyed arrays are unsupported." }]
				: []
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

const ready = Schema.decodeUnknownSync(ConfigExplorerShowcaseResult)({
	status: "ready",
	comparison: {
		schemaVersion: 1,
		status: "different",
		left: platformA,
		right: platformB,
		valueChanged: true,
		coverageChanged: false
	},
	explicitEmpty: explanation({
		key: "ExplicitEmpty",
		platform: "PlatformA",
		value: { kind: "empty_array" }
	}),
	redirectInvolvement: explanation({
		key: "LegacyRedirected",
		platform: "PlatformA",
		status: "partial",
		value: { kind: "missing" }
	}),
	scalarReplacement: explanation({
		key: "Mode",
		platform: "PlatformA",
		value: { kind: "scalar", value: "PlatformA" }
	}),
	unsupportedSyntax: explanation({
		key: "Unsupported",
		platform: "PlatformA",
		status: "partial",
		value: { kind: "missing" }
	})
});

afterEach(cleanup);
afterAll(() => runtime.dispose());

function renderShowcase(result = ready) {
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<ConfigExplorerShowcase
				client={{ configExplorerShowcase: () => Effect.succeed(result) }}
			/>
		</EffectRuntimeProvider>
	));
}

describe("ConfigExplorerShowcase", () => {
	it("loads real-shaped supplied evidence and switches between showcase presets", async () => {
		renderShowcase();
		await screen.findByText("VALUE DIVERGES");
		expect(screen.getByRole("heading", { name: "PlatformA" })).toBeDefined();
		expect(screen.getByRole("heading", { name: "PlatformB" })).toBeDefined();

		await userEvent.setup().click(screen.getByRole("button", { name: /Explicit empty/ }));
		expect(await screen.findByText("[ explicit empty ]")).toBeDefined();

		await userEvent.setup().click(screen.getByRole("button", { name: /Unsupported/ }));
		expect((await screen.findAllByText("partial coverage")).length).toBeGreaterThan(0);
		expect(screen.getAllByText("unsupported").length).toBeGreaterThan(0);
	});

	it("renders typed acquisition failures with recovery and retry", async () => {
		const failed = Schema.decodeUnknownSync(ConfigExplorerShowcaseResult)({
			error: {
				code: "showcase_unavailable",
				message: "Fixture unavailable.",
				recovery: "Launch through pnpm showcase.",
				retrySafe: false
			},
			status: "failed"
		});
		renderShowcase(failed);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("Fixture unavailable");
		expect(alert.textContent).toContain("pnpm showcase");
		expect(screen.getByRole("button", { name: "RETRY" })).toBeDefined();
		await waitFor(() => expect(screen.queryByText(/Reconstructing/)).toBeNull());
	});
});
