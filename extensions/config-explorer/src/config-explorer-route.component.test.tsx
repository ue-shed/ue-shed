import { ConfigComparison, ConfigExplanation } from "@ue-shed/config-explorer/browser";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigExplorerRoute } from "./config-explorer-route.js";

function explanation(platform: "PlatformA" | "PlatformB", partial = false) {
	return Schema.decodeUnknownSync(ConfigExplanation)({
		schemaVersion: 1,
		status: partial ? "partial" : "complete",
		project: { descriptor: "FixtureProject" },
		platform,
		family: "Game",
		section: "Fixture.Settings",
		key: "Entries",
		effectiveValue: { kind: "array", values: [platform] },
		contributions: [
			{
				sequence: 0,
				source: { scope: "project", path: `Config/${platform}/${platform}Game.ini` },
				location: { line: 3, column: 1 },
				operation: "add_unique",
				inputValue: platform,
				priorValue: { kind: "missing" },
				effect: { kind: "added", index: 0 },
				remainsEffective: true
			}
		],
		layers: [
			{
				order: 0,
				layer: "ProjectPlatform",
				source: { scope: "project", path: `Config/${platform}/${platform}Game.ini` },
				status: "read"
			},
			{
				order: 1,
				layer: "ProjectGenerated",
				source: { scope: "project", path: "Config/GeneratedGame.ini" },
				status: "missing"
			},
			...(partial
				? [
						{
							order: 2,
							layer: "ProjectDefault",
							source: { scope: "project" as const, path: "Config/DefaultGame.ini" },
							status: "unsupported" as const
						}
					]
				: [])
		],
		authorities: [{ authority: "live_cvars", status: "excluded", detail: "Not live." }],
		diagnostics: partial
			? [{ code: "unsupported_operator", message: "Unsupported keyed array." }]
			: []
	});
}

afterEach(cleanup);

describe("ConfigExplorerRoute", () => {
	it("renders supplied evidence and labels the saved-source authority boundary", () => {
		render(() => <ConfigExplorerRoute result={explanation("PlatformA", true)} />);
		expect(screen.getByText(/Saved source.*no runtime authority/su)).toBeDefined();
		expect(screen.getByText("partial coverage")).toBeDefined();
		expect(screen.getAllByText("unsupported").length).toBeGreaterThan(0);
		expect(screen.getByLabelText("effect survives")).toBeDefined();
		expect(screen.getByText(/Coverage ·/)).toBeDefined();
		expect(screen.getByText(/Excluded runtime authorities/)).toBeDefined();
	});

	it("renders independent platform ledgers side by side", () => {
		const comparison = Schema.decodeUnknownSync(ConfigComparison)({
			schemaVersion: 1,
			status: "different",
			left: explanation("PlatformA"),
			right: explanation("PlatformB"),
			valueChanged: true,
			coverageChanged: false
		});
		render(() => <ConfigExplorerRoute result={comparison} />);
		const region = screen.getByRole("region", { name: "Platform config comparison" });
		expect(within(region).getByRole("heading", { name: "PlatformA" })).toBeDefined();
		expect(within(region).getByRole("heading", { name: "PlatformB" })).toBeDefined();
		expect(screen.getByText("Value diverges")).toBeDefined();
		expect(screen.getByText("Coverage aligned")).toBeDefined();
		cleanup();

		const matching = Schema.decodeUnknownSync(ConfigComparison)({
			schemaVersion: 1,
			status: "same",
			left: explanation("PlatformA"),
			right: explanation("PlatformA"),
			valueChanged: false,
			coverageChanged: false
		});
		render(() => <ConfigExplorerRoute result={matching} />);
		expect(screen.getByText("Values match")).toBeDefined();
	});

	it("keeps missing and explicit-empty values semantically distinct", () => {
		const base = explanation("PlatformA");
		const missing = Schema.decodeUnknownSync(ConfigExplanation)({
			...base,
			effectiveValue: { kind: "missing" }
		});
		render(() => <ConfigExplorerRoute result={missing} />);
		expect(screen.getByText("Missing")).toBeDefined();
		cleanup();

		const empty = Schema.decodeUnknownSync(ConfigExplanation)({
			...base,
			effectiveValue: { kind: "empty_array" }
		});
		render(() => <ConfigExplorerRoute result={empty} />);
		expect(screen.getByText("[ explicit empty ]")).toBeDefined();
	});
});
