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
import { afterAll, afterEach, expect, it, vi } from "vitest";
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
	requests: LocalizationFileComparisonRequest[],
	failing: (request: LocalizationFileComparisonRequest) => boolean = () => false,
	options: {
		/** Every comparison's total, when more than the changes it lists. */
		readonly total?: number;
		/** Milliseconds a request takes to answer. */
		readonly delay?: (request: LocalizationFileComparisonRequest) => number;
	} = {}
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
			const wait = Effect.sleep(options.delay?.(request) ?? 0);
			if (failing(request))
				return Effect.as(wait, {
					status: "failed" as const,
					code: "compare_failed",
					message: "The engine stopped.",
					recovery: "Compare again."
				});
			const groups = request.filter?.groups ?? [];
			const listed = changes.filter(
				(change) => groups.length === 0 || groups.includes(change.group)
			);
			return Effect.as(wait, {
				status: "ready" as const,
				files: request.files,
				format: "po" as const,
				counts,
				listed: counts,
				total: options.total ?? listed.length,
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
	expect(within(before).getByText("old/de/Game.po")).toBeTruthy();
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
		filter: { groups: [], query: "", asset: "", preview: 5 },
		changes: { offset: 0, limit: 200 }
	});
	expect(requests.at(-1)?.filter).toEqual({
		groups: ["added"],
		query: "",
		asset: "",
		preview: 0
	});
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

async function chooseBoth(api: GameTextClientApi, fakeTimers = false) {
	const user = userEvent.setup(fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {});
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
	return user;
}

it("drops a filter still being typed when the files change, and searches every match", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const requests: LocalizationFileComparisonRequest[] = [];
		const user = await chooseBoth(client(["C:/old/Game.po", "C:/new/Game.po"], requests), true);
		await screen.findByRole("region", { name: "File comparison" });
		await user.type(screen.getByRole("searchbox", { name: "Filter by text or key" }), "fish");
		await user.click(screen.getByRole("button", { name: "Swap before and after" }));
		await vi.advanceTimersByTimeAsync(1000);
		expect(requests.some((request) => request.filter?.query === "fish")).toBe(false);
		await screen.findByRole("region", { name: "File comparison" });
		await user.type(screen.getByRole("searchbox", { name: "Filter by text or key" }), "where");
		await vi.advanceTimersByTimeAsync(1000);
		expect(requests.at(-1)?.filter).toEqual({
			groups: [],
			query: "where",
			asset: "",
			preview: 0
		});
	} finally {
		vi.useRealTimers();
	}
});

it("puts back the view on screen when a new filter fails", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = await chooseBoth(
		client(["C:/old/Game.po", "C:/new/Game.po"], requests, (request) =>
			(request.filter?.groups ?? []).includes("added")
		)
	);
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	await user.click(within(comparison).getByRole("button", { name: "Added, 1" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("The engine stopped.")
	);
	expect(
		within(comparison).getByRole("button", { name: "Added, 1" }).getAttribute("aria-pressed")
	).toBe("false");
	expect(within(comparison).getAllByRole("heading", { level: 4 })).toHaveLength(3);
});

it("filters to a rollup's asset at once, exactly, and offers every asset back", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = await chooseBoth(client(["C:/old/Game.po", "C:/new/Game.po"], requests));
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	await user.click(within(comparison).getByRole("button", { name: /^DT_Scott/u }));
	expect(requests.at(-1)?.filter).toEqual({
		groups: ["rekeyed"],
		query: "",
		asset: "DT_Scott",
		preview: 0
	});
	expect(
		within(comparison).getByRole("searchbox", { name: "Filter by text or key" })
	).toHaveProperty("value", "");
	await user.click(within(comparison).getByRole("button", { name: "Show every asset" }));
	expect(requests.at(-1)?.filter?.asset).toBe("");
});

it("will not compare a file with itself", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	await chooseBoth(client(["C:/a/Game.po", "C:/a/Game.po"], requests));
	expect(screen.getByRole("alert").textContent).toContain("the same file");
	expect(requests).toEqual([]);
});

it("pages on from a typed filter once it has loaded", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const requests: LocalizationFileComparisonRequest[] = [];
		const user = await chooseBoth(
			client(["C:/old/Game.po", "C:/new/Game.po"], requests, () => false, { total: 401 }),
			true
		);
		await screen.findByRole("region", { name: "File comparison" });
		await user.type(screen.getByRole("searchbox", { name: "Filter by text or key" }), "e");
		await vi.advanceTimersByTimeAsync(1000);
		await waitFor(() => expect(requests.at(-1)?.filter?.query).toBe("e"));
		await user.click(await screen.findByRole("button", { name: "Load more" }));
		expect(requests.at(-1)).toMatchObject({
			filter: { query: "e" },
			changes: { offset: 3, limit: 200 }
		});
	} finally {
		vi.useRealTimers();
	}
});

it("puts back the filter whose list is on screen when a quickly typed one fails", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	try {
		const requests: LocalizationFileComparisonRequest[] = [];
		const user = await chooseBoth(
			client(
				["C:/old/Game.po", "C:/new/Game.po"],
				requests,
				(request) => request.filter?.query === "fish"
			),
			true
		);
		await screen.findByRole("region", { name: "File comparison" });
		const search = screen.getByRole("searchbox", { name: "Filter by text or key" });
		await user.type(search, "fish");
		await vi.advanceTimersByTimeAsync(1000);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("The engine stopped.")
		);
		expect(requests.map((request) => request.filter?.query)).toEqual(["", "fish"]);
		expect(search).toHaveProperty("value", "");
	} finally {
		vi.useRealTimers();
	}
});

it("does not put back a view that was still loading when the next one fails", async () => {
	const requests: LocalizationFileComparisonRequest[] = [];
	const user = await chooseBoth(
		client(
			["C:/old/Game.po", "C:/new/Game.po"],
			requests,
			(request) => (request.filter?.groups ?? []).includes("reworded"),
			{ delay: (request) => ((request.filter?.groups ?? []).includes("added") ? 200 : 0) }
		)
	);
	const comparison = await screen.findByRole("region", { name: "File comparison" });
	await user.click(within(comparison).getByRole("button", { name: "Added, 1" }));
	await user.click(within(comparison).getByRole("button", { name: "Wording changed, 1" }));
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toContain("The engine stopped.")
	);
	await new Promise((resolve) => setTimeout(resolve, 300));
	for (const name of ["Added, 1", "Wording changed, 1"])
		expect(within(comparison).getByRole("button", { name }).getAttribute("aria-pressed")).toBe(
			"false"
		);
	expect(within(comparison).getAllByRole("heading", { level: 4 })).toHaveLength(3);
});
