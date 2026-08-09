// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import {
	makeTextOccurrenceId,
	makeTextUnitId,
	type TextCorpus,
	type TextCorpusFocusResult,
	type TextCorpusQueryRunResult,
	type TextCorpusSearchResult
} from "@ue-shed/game-text/browser";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type GameTextClientShape } from "./game-text-client.js";
import { GameTextRoute } from "./game-text-query-route.js";

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

const summary = {
	coverage: corpus.coverage,
	diagnosticCount: 0,
	schemaVersion: 1,
	status: "complete"
} as const;

const completed = { status: "completed", summary } satisfies TextCorpusQueryRunResult;

function resultFor(unit: TextCorpus["units"][number]) {
	const contexts = unit.occurrences.slice(0, 3).map((occurrence) => ({
		editCapability: occurrence.editCapability,
		location: occurrence.location
	}));
	return {
		contexts,
		id: unit.id,
		identity: unit.identity,
		locationKinds: [...new Set(unit.occurrences.map((occurrence) => occurrence.location.kind))],
		occurrenceCount: unit.occurrences.length,
		remainingContextCount: Math.max(0, unit.occurrences.length - contexts.length),
		source: unit.source
	};
}

afterEach(cleanup);
const runtime = ManagedRuntime.make(Layer.empty);
afterAll(() => runtime.dispose());

function makeClient(): GameTextClientShape {
	return {
		chooseProjectAndScan: () => Effect.succeed(completed),
		loadConfiguredProject: () => Effect.succeed(completed),
		progress: () =>
			Effect.succeed({
				completed: 1,
				phase: "ready",
				stage: "game_text",
				total: 1
			}),
		search: (request) => {
			const terms = request.query.toLocaleLowerCase();
			const units = corpus.units.filter(
				(unit) =>
					unit.source.status === "consistent" &&
					unit.source.value.toLocaleLowerCase().includes(terms) &&
					(request.capability === "all" ||
						unit.occurrences.some(
							(occurrence) => occurrence.editCapability === request.capability
						))
			);
			return Effect.succeed({
				page: { total: units.length, units: units.map(resultFor) },
				status: "ready"
			} satisfies TextCorpusSearchResult);
		},
		focus: (request) => {
			const unit = corpus.units.find((candidate) => candidate.id === request.id);
			const result = unit
				? {
						focus: {
							diagnostics: [],
							occurrences: unit.occurrences,
							totalOccurrences: unit.occurrences.length,
							unit: resultFor(unit)
						},
						status: "found"
					}
				: { status: "not_found" };
			return Effect.succeed(result as TextCorpusFocusResult);
		},
		locateAsset: (objectPath) =>
			Effect.succeed({
				contract: {
					name: "unreal-editor-asset-navigation",
					version: { major: 1, minor: 0 }
				},
				objectPath,
				status: "located"
			})
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

		expect(screen.getByRole("complementary", { name: "Text focus" }).textContent).toContain(
			"Continue"
		);
		expect(
			within(results).getByRole("button", {
				name: "Locate the asset using Continue in Unreal"
			})
		).toBeDefined();
		await user.click(
			within(results).getByRole("button", {
				name: "Locate the asset using Quit game? in Unreal"
			})
		);
		expect(focus.textContent).toContain("Quit game?");
		expect(focus.textContent).toContain("Menu · Quit");
		expect(focus.textContent).toContain("Prompt field");

		await user.type(screen.getByRole("searchbox", { name: "Search corpus" }), "Continue");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Text units" });
			expect(
				within(currentResults).queryByRole("button", {
					name: /Locate the asset using Quit game\?/
				})
			).toBeNull();
			expect(
				within(currentResults).getByRole("button", {
					name: /Locate the asset using Continue/
				})
			).toBeDefined();
		});
		expect(screen.getByRole("complementary", { name: "Text focus" }).textContent).toContain(
			"Continue"
		);
	});

	it("keeps the search input focused while an async page replaces its results", async () => {
		const user = userEvent.setup();
		renderRoute();
		const input = (await screen.findByRole("searchbox", {
			name: "Search corpus"
		})) as HTMLInputElement;

		await user.click(input);
		await user.type(input, "Continue");

		await waitFor(() => {
			expect(input.value).toBe("Continue");
			expect(document.activeElement).toBe(input);
		});
	});

	it("packs identity and useful copy actions into each result", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Text units" });

		expect(within(results).getByText("Unreal identity")).toBeDefined();
		expect(within(results).getByText("Primary source")).toBeDefined();
		expect(within(results).getByText("UI · Continue")).toBeDefined();

		const copyText = within(results).getByRole("button", {
			name: "Copy source text Continue"
		});
		await user.click(copyText);
		await waitFor(() => expect(copyText.textContent).toBe("Copied"));
		expect(await navigator.clipboard.readText()).toBe("Continue");

		const copyIdentity = within(results).getByRole("button", {
			name: "Copy Unreal identity UI · Continue"
		});
		await user.click(copyIdentity);
		await waitFor(() => expect(copyIdentity.textContent).toBe("Copied"));
		expect(await navigator.clipboard.readText()).toBe("UI · Continue");
	});

	it("locates a single-use text asset through the live editor capability", async () => {
		const user = userEvent.setup();
		renderRoute();
		const results = await screen.findByRole("region", { name: "Text units" });
		const locate = within(results).getByRole("button", {
			name: "Locate the asset using Continue in Unreal"
		});

		await user.click(locate);

		await waitFor(() => expect(locate.textContent).toBe("Located"));
		expect(
			within(screen.getByRole("complementary", { name: "Text focus" })).getByRole("button", {
				name: "Located"
			})
		).toBeDefined();
	});

	it("switches between editable and read-only authority filters", async () => {
		const user = userEvent.setup();
		renderRoute();
		await screen.findByRole("region", { name: "Text units" });
		const readOnly = screen.getByRole("button", { name: "Evidence only" });

		await user.click(readOnly);
		expect(readOnly.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Text units" });
			expect(
				within(currentResults).getByRole("button", {
					name: /Locate the asset using Quit game\?/
				})
			).toBeDefined();
			expect(
				within(currentResults).queryByRole("button", {
					name: /Locate the asset using Continue/
				})
			).toBeNull();
		});

		const editable = screen.getByRole("button", { name: "Supported sources" });
		await user.click(editable);
		expect(editable.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => {
			const currentResults = screen.getByRole("region", { name: "Text units" });
			expect(
				within(currentResults).getByRole("button", {
					name: /Locate the asset using Continue/
				})
			).toBeDefined();
			expect(
				within(currentResults).queryByRole("button", {
					name: /Locate the asset using Quit game\?/
				})
			).toBeNull();
		});
	});
});
