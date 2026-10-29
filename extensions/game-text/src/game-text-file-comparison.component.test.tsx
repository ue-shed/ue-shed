// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type {
	LocalizationFileChange,
	LocalizationFileComparisonRequest
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, expect, it } from "vitest";
import type { GameTextClientApi } from "./game-text-client.js";
import { fileComparisonEntries } from "./game-text-file-comparison.js";
import { GameTextReports } from "./game-text-reports.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

const changes: LocalizationFileChange[] = [
	{
		kind: "edited",
		before: { namespace: "Menu", key: "Quit" },
		after: { namespace: "Menu", key: "Quit" },
		fields: [
			{ name: "source", before: "Quit", after: "Quit" },
			{ name: "translation", before: "Quitter", after: "Quitter le jeu" }
		]
	},
	{
		kind: "rekeyed",
		before: { namespace: "Dialogue", key: "Line_01" },
		after: { namespace: "Dialogue", key: "6F1C" },
		fields: [{ name: "source", before: "Where were you?", after: "Where were you?" }]
	},
	{
		kind: "added",
		after: { namespace: "Shop", key: "Apples" },
		fields: [
			{ name: "source", after: "{0} apple" },
			{ name: "translation", form: 0, after: "{0} pomme" },
			{ name: "translation", form: 1, after: "{0} pommes" }
		]
	}
];

const notUsed = () => Effect.die("Not used");

function client(requests: LocalizationFileComparisonRequest[]): GameTextClientApi {
	return {
		focus: notUsed,
		loadConfiguredProject: notUsed,
		locateAsset: notUsed,
		progress: Stream.empty,
		search: notUsed,
		searchRows: notUsed,
		chooseQualityRules: notUsed,
		qualityFocus: notUsed,
		qualitySearch: notUsed,
		previewQualityRules: notUsed,
		saveQualityRules: notUsed,
		localizationReport: () => Effect.succeed({ status: "not_ready" }),
		compareLocalizationFiles: (request) => {
			requests.push(request);
			const offset = request.changes.offset;
			return Effect.succeed({
				status: "ready",
				files: { before: "C:/old/fr/Game.po", after: "C:/new/fr/Game.po" },
				format: "po",
				counts: { added: 1, removed: 0, rekeyed: 1, edited: 1, unchanged: 40 },
				total: changes.length,
				changes: changes.slice(offset, offset === 0 ? 2 : undefined)
			});
		}
	};
}

it("labels each field, and gives a new key its old and new key", () => {
	const entries = fileComparisonEntries("Game.po", changes, 0);
	expect(entries.map((entry) => [entry.kind, entry.after?.full, entry.place])).toEqual([
		["edited", "Menu,Quit", "Menu"],
		["rekeyed", "Dialogue,6F1C", "Dialogue"],
		["added", "Shop,Apples", "Shop"]
	]);
	expect(entries[1]?.fields.at(-1)).toEqual({
		label: "Key",
		before: "Dialogue,Line_01",
		after: "Dialogue,6F1C",
		code: true
	});
	expect(entries[2]?.fields.map((field) => field.label)).toEqual([
		"Source",
		"Translation [0]",
		"Translation [1]"
	]);
});

it("compares two chosen files in place of the report, a page at a time", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = userEvent.setup();
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextReports client={client(requests)} target="Game" revision={undefined} />
		</EffectRuntimeProvider>
	));
	await user.click(screen.getByRole("button", { name: "Compare two files…" }));
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	expect(screen.queryByRole("region", { name: "Reports" })).toBeNull();
	expect(within(comparison).getAllByRole("listitem", { name: /Edited|New key/u })).toHaveLength(
		2
	);
	await user.click(within(comparison).getByRole("button", { name: "Load more" }));
	await waitFor(() =>
		expect(within(comparison).getAllByRole("listitem", { name: "Added" })).toHaveLength(1)
	);
	expect(requests).toEqual([
		{ changes: { offset: 0, limit: 200 } },
		{
			files: { before: "C:/old/fr/Game.po", after: "C:/new/fr/Game.po" },
			changes: { offset: 2, limit: 200 }
		}
	]);
	await user.click(within(comparison).getByRole("button", { name: "Back to reports" }));
	expect(screen.queryByRole("region", { name: "File comparison" })).toBeNull();
	expect(screen.getByRole("region", { name: "Reports" })).toBeTruthy();
});
