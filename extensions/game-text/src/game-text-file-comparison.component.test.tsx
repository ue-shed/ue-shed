// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { userEvent } from "@testing-library/user-event";
import type {
	LocalizationFileChange,
	LocalizationFileChoiceRequest,
	LocalizationFileComparisonRequest
} from "@ue-shed/game-text/schema";
import { EffectRuntimeProvider } from "@ue-shed/ui";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, expect, it } from "vitest";
import type { GameTextClientApi } from "./game-text-client.js";
import {
	GameTextFileComparison,
	distinctNames,
	fileComparisonEntries,
	fileComparisonSummary
} from "./game-text-file-comparison.js";

const runtime = ManagedRuntime.make(Layer.empty);
afterEach(cleanup);
afterAll(() => runtime.dispose());

const changes: LocalizationFileChange[] = [
	{
		kind: "rekeyed",
		group: "rekeyed",
		before: { namespace: "Dialogue", key: "Line_01" },
		after: { namespace: "Dialogue", key: "00A6E0EA46DC851E2C1872BF76A5AA48" },
		fields: [
			{ name: "source", before: "Where were you?", after: "Where were you?" },
			{ name: "translation", before: "Wo warst du?", after: "Wo warst du?" }
		]
	},
	{
		kind: "edited",
		group: "source",
		before: { namespace: "Menu", key: "Quit" },
		after: { namespace: "Menu", key: "Quit" },
		fields: [
			{ name: "source", before: "Quit", after: "Quit game" },
			{ name: "translation", before: "Beenden", after: "Beenden" }
		]
	},
	{
		kind: "added",
		group: "added",
		after: { namespace: "Shop", key: "Apples" },
		fields: [
			{ name: "source", after: "{0} apple" },
			{ name: "translation", form: 0, after: "{0} Apfel" },
			{ name: "references", after: "/Game/UI/Shop.Shop" }
		]
	}
];
const counts = {
	rekeyed: 1,
	source: 1,
	removed: 0,
	added: 1,
	translation: 0,
	context: 0,
	unchanged: 40
};

const notUsed = () => Effect.die("Not used");

function client(
	choices: string[],
	requests: LocalizationFileComparisonRequest[]
): GameTextClientApi {
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
		chooseLocalizationFile: (_: LocalizationFileChoiceRequest) => {
			const path = choices.shift();
			if (path === undefined) return Effect.succeed({ status: "cancelled" });
			const format = path.endsWith(".po") ? "po" : "archive";
			return Effect.succeed({ status: "selected", path, format });
		},
		compareLocalizationFiles: (request) => {
			requests.push(request);
			const groups = request.filter?.groups ?? [];
			const listed = changes.filter(
				(change) => groups.length === 0 || groups.includes(change.group)
			);
			const offset = request.changes.offset;
			return Effect.succeed({
				status: "ready",
				files: request.files,
				format: "po",
				counts,
				total: listed.length,
				changes: listed.slice(offset, offset === 0 ? 2 : undefined)
			});
		}
	};
}

it("names a new key, a stale translation and an untranslated entry", () => {
	const entries = fileComparisonEntries("Game.po", "po", changes, 0);
	expect(entries[0]?.note).toBe("A key someone wrote was replaced by a generated one.");
	expect(entries[1]?.fields.find((field) => field.label === "Translation")).toMatchObject({
		context: true,
		note: "made for the old source"
	});
	expect(entries[2]?.fields.map((field) => [field.label, field.secondary === true])).toEqual([
		["Source", false],
		["Translation [0]", false],
		["References", true]
	]);
	expect(fileComparisonSummary(counts)).toBe(
		"1 moved to a new key · 1 with a changed source · 1 added · 40 unchanged."
	);
});

it("tells two files of one name apart by their folders", () => {
	expect(distinctNames("C:\\old\\de\\Game.po", "C:\\new\\de\\Game.po")).toEqual({
		before: "old\\de\\Game.po",
		after: "new\\de\\Game.po"
	});
	expect(distinctNames("C:/a/Old.po", "C:/a/New.po")).toEqual({
		before: "Old.po",
		after: "New.po"
	});
});

it("compares two chosen files, filters in the engine and pages", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = userEvent.setup();
	const api = client(["C:/new/de/Game.po", "C:/old/de/Game.po"], requests);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextFileComparison client={api} />
		</EffectRuntimeProvider>
	));
	const compare = screen.getByRole("button", { name: "Compare" });
	expect(compare.hasAttribute("disabled")).toBe(true);
	const before = screen.getByRole("group", { name: "Before" });
	const after = screen.getByRole("group", { name: "After" });
	// Picked the wrong way round, then swapped.
	await user.click(within(before).getByRole("button", { name: "Choose…" }));
	await user.click(within(after).getByRole("button", { name: "Choose…" }));
	await user.click(screen.getByRole("button", { name: "Swap before and after" }));
	expect(within(before).getByText("old\\de\\Game.po")).toBeTruthy();
	await user.click(compare);
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	expect(within(comparison).getByRole("status").textContent).toContain("1 moved to a new key");
	expect(
		within(comparison)
			.getAllByRole("heading", { level: 4 })
			.map((heading) => heading.textContent)
	).toEqual(["New key", "Source changed"]);
	await user.click(within(comparison).getByRole("button", { name: "Load more" }));
	await waitFor(() =>
		expect(within(comparison).getAllByRole("listitem", { name: "Added" })).toHaveLength(1)
	);
	await user.click(within(comparison).getByRole("button", { name: "Added, 1" }));
	await waitFor(() =>
		expect(within(comparison).queryByRole("listitem", { name: "New key" })).toBeNull()
	);
	expect(requests.map((request) => [request.filter, request.changes.offset])).toEqual([
		[{ groups: [], query: "" }, 0],
		[{ groups: [], query: "" }, 2],
		[{ groups: ["added"], query: "" }, 0]
	]);
	expect(requests[0]?.files).toEqual({ before: "C:/old/de/Game.po", after: "C:/new/de/Game.po" });
});

it("will not compare files of two kinds", async () => {
	const user = userEvent.setup();
	const api = client(["C:/a/Game.po", "C:/a/Game.archive"], []);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextFileComparison client={api} />
		</EffectRuntimeProvider>
	));
	await user.click(
		within(screen.getByRole("group", { name: "Before" })).getByRole("button", {
			name: "Choose…"
		})
	);
	await user.click(
		within(screen.getByRole("group", { name: "After" })).getByRole("button", {
			name: "Choose…"
		})
	);
	expect(screen.getByRole("alert").textContent).toContain("same kind");
	expect(screen.getByRole("button", { name: "Compare" }).hasAttribute("disabled")).toBe(true);
});
