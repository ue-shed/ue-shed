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
		before: { namespace: "Dialogue", key: "74_Text" },
		after: { namespace: "Dialogue", key: "00A6E0EA46DC851E2C1872BF76A5AA48" },
		fields: [
			{ name: "source", before: "Where were you?", after: "Where were you?" },
			{ name: "translation", before: "Wo warst du?" }
		]
	},
	{
		kind: "edited",
		group: "reworded",
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
			{ name: "source", after: "Apples" },
			{ name: "translation", after: "Apples" },
			{ name: "references", after: "/Game/UI/Shop.Shop" }
		]
	}
];
const counts = {
	rekeyed: 1,
	reworded: 1,
	retouched: 0,
	removed: 0,
	added: 1,
	translation: 0,
	carried: 0,
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
			return Effect.succeed({
				status: "ready",
				files: request.files,
				format: "po",
				counts,
				listed: counts,
				total: listed.length,
				changes: listed,
				assets: [{ group: "rekeyed", asset: "DT_Scott", count: 2, generated: 2 }]
			});
		}
	};
}

it("notes only the exceptions: a cleared translation and one that copies the source", () => {
	const entries = fileComparisonEntries("Game.po", "po", changes, 0);
	expect(entries[0]?.note).toBe("Now untranslated: the game shows the source.");
	expect(entries[0]?.after).toEqual({
		label: "00A6E0EA…",
		full: "Dialogue,00A6E0EA46DC851E2C1872BF76A5AA48"
	});
	expect(entries[1]?.note).toBeUndefined();
	expect(entries[1]?.fields.find((field) => field.label === "Translation")).toMatchObject({
		context: true
	});
	expect(entries[2]?.fields.map((field) => [field.label, field.note ?? ""])).toEqual([
		["Source", ""],
		["Translation", "same as the source"],
		["References", ""]
	]);
	expect(fileComparisonSummary("po", counts)).toBe(
		"For translators: 1 lost on a new key · 1 reworded. Also 1 added · 40 unchanged."
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

it("compares as soon as both files are chosen, as an overview filtered in the engine", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = userEvent.setup();
	const api = client(["C:/new/de/Game.po", "C:/old/de/Game.po"], requests);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextFileComparison client={api} />
		</EffectRuntimeProvider>
	));
	const before = screen.getByRole("group", { name: "Before" });
	const after = screen.getByRole("group", { name: "After" });
	// Picked the wrong way round, then swapped.
	await user.click(within(before).getByRole("button", { name: "Choose…" }));
	await user.click(within(after).getByRole("button", { name: "Choose…" }));
	await user.click(screen.getByRole("button", { name: "Swap before and after" }));
	expect(within(before).getByText("old\\de\\Game.po")).toBeTruthy();
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	expect(within(comparison).getByRole("status").textContent).toContain(
		"For translators: 1 lost on a new key"
	);
	expect(
		within(comparison)
			.getAllByRole("heading", { level: 4 })
			.map((heading) => heading.textContent)
	).toEqual(["New key, translation lost", "Wording changed", "Added"]);
	const rollup = within(comparison).getByRole("list", { name: "Most changes come from" });
	expect(rollup.textContent).toContain("every written key replaced by a generated one");
	await user.click(within(comparison).getByRole("button", { name: "Added, 1" }));
	await waitFor(() =>
		expect(within(comparison).queryByRole("listitem", { name: /^New key:/u })).toBeNull()
	);
	expect(requests.at(-2)).toEqual({
		files: { before: "C:/old/de/Game.po", after: "C:/new/de/Game.po" },
		filter: { groups: [], query: "", preview: 5 },
		changes: { offset: 0, limit: 200 }
	});
	expect(requests.at(-1)?.filter).toEqual({ groups: ["added"], query: "", preview: 0 });
});

it("will not compare files of two kinds", async () => {
	const user = userEvent.setup();
	const requests: LocalizationFileComparisonRequest[] = [];
	const api = client(["C:/a/Game.po", "C:/a/Game.archive"], requests);
	render(() => (
		<EffectRuntimeProvider runtime={runtime}>
			<GameTextFileComparison client={api} />
		</EffectRuntimeProvider>
	));
	for (const side of ["Before", "After"])
		await user.click(
			within(screen.getByRole("group", { name: side })).getByRole("button", {
				name: "Choose…"
			})
		);
	expect(screen.getByRole("alert").textContent).toContain("same kind");
	expect(screen.getByRole("button", { name: "Compare again" }).hasAttribute("disabled")).toBe(
		true
	);
	expect(requests).toEqual([]);
});
