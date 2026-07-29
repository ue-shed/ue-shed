// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	type TextCorpus,
	type TextCorpusRunResult
} from "@ue-shed/game-text/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type GameTextClientShape } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-route.js";

const corpus: TextCorpus = {
	coverage: {
		discoveredPackages: 2,
		failedPackages: 0,
		inspectedPackages: 2,
		partialPackages: 0,
		resolvedOccurrences: 2,
		textOccurrences: 2,
		textUnits: 2,
		unresolvedOccurrences: 0,
		unsupportedTextProperties: 0
	},
	diagnostics: [],
	schemaVersion: 1,
	status: "complete",
	units: [
		{
			id: makeTextUnitId("unreal:UI:Continue"),
			identity: { key: "Continue", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					editCapability: "source_editable",
					id: makeTextOccurrenceId("occurrence:continue"),
					identity: { key: "Continue", namespace: "UI", status: "resolved" },
					location: {
						entryKey: "PromptContinue",
						kind: "string_table_entry",
						objectPath: "/Game/Text/ST_Game.ST_Game"
					},
					packageFile: "Content/Text/ST_Game.uasset",
					source: "Continue"
				}
			],
			source: { status: "consistent", value: "Continue" }
		},
		{
			id: makeTextUnitId("unreal:UI:Quit"),
			identity: { key: "Quit", namespace: "UI", status: "resolved" },
			occurrences: [
				{
					editCapability: "read_only",
					id: makeTextOccurrenceId("occurrence:quit"),
					identity: { key: "Quit", namespace: "UI", status: "resolved" },
					location: {
						kind: "data_table_cell",
						objectPath: "/Game/Text/DT_Menu.DT_Menu",
						propertyPath: "Prompt",
						row: "Quit"
					},
					packageFile: "Content/Text/DT_Menu.uasset",
					source: "Quit game?"
				}
			],
			source: { status: "consistent", value: "Quit game?" }
		}
	]
};

const completed = { corpus, status: "completed" } satisfies TextCorpusRunResult;

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function makeClient(): GameTextClientShape {
	return {
		chooseProjectAndScan: () => Effect.succeed(completed),
		loadConfiguredProject: () => Effect.succeed(completed)
	};
}

function renderRoute() {
	return render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextRoute client={makeClient()} />
		</EffectRuntimeProvider>
	));
}

describe("GameTextRoute interactions", () => {
	it("uses the Workbench project selection rather than exposing a second chooser", async () => {
		renderRoute();
		await screen.findByRole("region", { name: "Text units" });
		expect(screen.queryByRole("button", { name: "Choose project" })).toBeNull();
	});

	it("searches results and moves focus through user-visible controls", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Text units" });
		const focus = screen.getByRole("complementary", { name: "Text focus" });

		expect(focus.textContent).toContain("Continue");
		await user.click(within(results).getByRole("button", { name: /Quit game\?/ }));
		expect(focus.textContent).toContain("Quit game?");

		await user.type(screen.getByRole("searchbox", { name: "Search corpus" }), "Continue");
		expect(within(results).queryByRole("button", { name: /Quit game\?/ })).toBeNull();
		expect(within(results).getByRole("button", { name: /Continue/ })).toBeDefined();
		expect(focus.textContent).toContain("Continue");
	});

	it("switches between editable and read-only authority filters", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Text units" });
		const readOnly = screen.getByRole("button", { name: "Read only" });

		await user.click(readOnly);
		expect(readOnly.getAttribute("aria-pressed")).toBe("true");
		expect(within(results).getByRole("button", { name: /Quit game\?/ })).toBeDefined();
		expect(within(results).queryByRole("button", { name: /Continue/ })).toBeNull();

		const editable = screen.getByRole("button", { name: "Source editable" });
		await user.click(editable);
		expect(editable.getAttribute("aria-pressed")).toBe("true");
		expect(within(results).getByRole("button", { name: /Continue/ })).toBeDefined();
		expect(within(results).queryByRole("button", { name: /Quit game\?/ })).toBeNull();
	});
});
