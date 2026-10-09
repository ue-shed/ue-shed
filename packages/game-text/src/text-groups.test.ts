import { TextNamespace } from "@ue-shed/localization/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	target
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.js";
import { TextUnit, type TextCorpusSearchRequest, type TextGroupBy } from "./schema.js";
import { textFileLabel, textFolderLabel } from "./text-origin.js";

interface Placement {
	readonly key: string;
	readonly folder: string;
	readonly namespace: string;
	readonly source: string;
}

function placed({ key, folder, namespace, source }: Placement): TextUnit {
	const identity = { status: "resolved", namespace, key };
	return Schema.decodeUnknownSync(TextUnit)({
		id: `unit:${key}`,
		source: { status: "consistent", value: source },
		identity,
		occurrences: [
			{
				id: `occurrence:${key}`,
				devNotes: "",
				packageFile: `Content/${folder}/ST_${key}.uasset`,
				source,
				identity,
				editCapability: "source_editable",
				location: {
					kind: "string_table_entry",
					objectPath: `/Game/${folder}/ST_${key}.ST_${key}`,
					entryKey: key
				}
			}
		]
	});
}

// The test target gathers Content/Text. Start is not gathered yet; Quit changed since the gather;
// Intro and Outro share their text; Health and a gathered C++ line are up to date.
const placements: readonly Placement[] = [
	{ key: "Start", folder: "Text/UI/Menus", namespace: "Menus", source: "Start" },
	{ key: "Quit", folder: "Text/UI/Menus", namespace: "Menus", source: "Quit" },
	{ key: "Health", folder: "Text/UI/HUD", namespace: "HUD", source: "Health" },
	{ key: "Intro", folder: "Text/Quests/Act1", namespace: "Quests", source: "Begin" },
	{ key: "Outro", folder: "Text/Quests/Act1", namespace: "Quests", source: "Begin" }
];
const units = placements.map(placed);
const text = {
	...corpus(units),
	packageCoverage: placements.map(({ key, folder }) => ({
		packageFile: `Content/${folder}/ST_${key}.uasset`,
		status: "complete" as const
	}))
};
const gathered = placements.filter(({ key }) => key !== "Start");
const decodeNamespace = Schema.decodeUnknownSync(TextNamespace);
const inNamespace = <Entry extends { readonly namespace: TextNamespace }>(
	entry: Entry,
	namespace: string
): Entry => ({ ...entry, namespace: decodeNamespace(namespace) });
const join = joinLocalizationTarget(
	text,
	evidence(
		[
			...gathered.map(({ key, folder, namespace, source }) =>
				inNamespace(
					manifestEntry(
						key,
						key === "Quit" ? "Earlier" : source,
						`/Game/${folder}/ST_${key}.ST_${key}`
					),
					namespace
				)
			),
			inNamespace(
				manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)"),
				"Code"
			)
		],
		[
			...gathered.map(({ key, namespace, source }) =>
				inNamespace(
					archiveEntry(key, key === "Quit" ? "Earlier" : source, "Übersetzt"),
					namespace
				)
			),
			inNamespace(archiveEntry("Code", "From code", "Aus dem Code"), "Code")
		]
	),
	target
);
const query = textCorpusQuery(text, undefined, join);
const request: TextCorpusSearchRequest = {
	query: "",
	capability: "all",
	pageSize: 50,
	localization: { target: target.name }
};

describe("text groups and facets", () => {
	it("spells files and folders the way the project does", () => {
		expect(textFileLabel("/Game/UI/Menus/WBP_Menu.WBP_Menu:Title")).toBe(
			"Content/UI/Menus/WBP_Menu"
		);
		expect(textFileLabel("Content\\UI\\HUD\\ST_HUD.uasset")).toBe("Content/UI/HUD/ST_HUD");
		expect(textFileLabel("Source/Game/Private/Menu.cpp(12)")).toBe(
			"Source/Game/Private/Menu.cpp"
		);
		expect(textFolderLabel("Content/UI/HUD/ST_HUD")).toBe("Content/UI/HUD");
		expect(textFolderLabel("README.txt")).toBe("");
	});

	it("groups every matching line once, and an open group lists only its own lines", () => {
		for (const by of [
			"problem",
			"folder",
			"asset",
			"origin",
			"namespace"
		] satisfies TextGroupBy[]) {
			const page = query.search({ ...request, group: by });
			const groups = page.groups;
			if (groups === undefined) throw new Error(`No groups by ${by}.`);
			expect(groups.by).toBe(by);
			expect(groups.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(page.total);
			for (const entry of groups.entries) {
				const open = query.search({ ...request, group: by, openGroup: entry.key });
				expect(open.localization?.lines).toHaveLength(entry.count);
				// Opening a group never changes the counts or the other groups.
				expect(open.total).toBe(page.total);
				expect(open.groups).toEqual(groups);
			}
		}
	});

	it("orders groups worst first and counts the lines that need work", () => {
		const byFolder = query.search({ ...request, group: "folder" }).groups?.entries;
		expect(byFolder?.map((entry) => [entry.label, entry.worst, entry.needWork])).toEqual([
			["Content/Text/UI/Menus", "not_gathered", 2],
			["Content/Text/Quests/Act1", "finding", 0],
			["Content/Text/UI/HUD", "up_to_date", 0],
			["Source/Game/Private", "up_to_date", 0]
		]);
		const byProblem = query.search({ ...request, group: "problem" }).groups?.entries;
		expect(byProblem?.map((entry) => entry.key)).toEqual([
			"not_gathered",
			"changed_since_gather",
			"finding",
			"up_to_date"
		]);
	});

	it("lists folders a level at a time, each count equal to its filter's total", () => {
		const top = query.search({ ...request, facets: { folder: "" } }).facets?.folders;
		expect(top?.entries.map((entry) => entry.label)).toEqual(["Content", "Source"]);
		const ui = query.search({ ...request, facets: { folder: "Content/Text/UI" } }).facets
			?.folders;
		expect(ui?.under).toBe("Content/Text/UI");
		expect(ui?.entries.map((entry) => [entry.label, entry.count])).toEqual([
			["Content/Text/UI/Menus", 2],
			["Content/Text/UI/HUD", 1]
		]);
		for (const entry of ui?.entries ?? []) {
			const filter = [
				{ field: "folder" as const, op: "is" as const, values: [entry.key + "/"] }
			];
			const filtered = query.search({
				...request,
				filter,
				facets: { folder: "Content/Text/UI" }
			});
			expect(filtered.total).toBe(entry.count);
			// The folder facet leaves out folder clauses.
			expect(filtered.facets?.folders).toEqual(ui);
		}
	});

	it("counts assets, origins and cultures, each leaving out its own clauses", () => {
		const page = query.search({
			...request,
			facets: { assets: true, origins: true, cultures: true }
		});
		const assets = page.facets?.assets?.entries ?? [];
		expect(assets).toHaveLength(6);
		for (const entry of assets) {
			const filtered = query.search({
				...request,
				filter: [{ field: "asset", op: "is", values: [entry.label] }],
				facets: { assets: true }
			});
			expect(filtered.total).toBe(entry.count);
			expect(filtered.facets?.assets).toEqual(page.facets?.assets);
		}
		expect(page.facets?.origins?.entries.map((entry) => [entry.key, entry.count])).toEqual([
			["string_table", 5],
			["cpp", 1]
		]);
		const cultures = page.facets?.cultures ?? [];
		expect(cultures.map((facet) => facet.culture).sort()).toEqual(["de", "en"]);
		// A culture set narrows the lines' work, but the picker still sees every culture.
		const scoped = query.search({
			...request,
			localization: { target: target.name, cultures: [cultureCode("de")] },
			facets: { cultures: true }
		});
		expect(scoped.facets?.cultures).toEqual(cultures);
	});

	it("groups and filters text without a localization target", () => {
		const page = query.search({ query: "", capability: "all", pageSize: 50, group: "folder" });
		// Without a target only findings count: the repeated quest text comes first.
		expect(page.groups?.entries.map((entry) => entry.label)).toEqual([
			"Content/Text/Quests/Act1",
			"Content/Text/UI/Menus",
			"Content/Text/UI/HUD"
		]);
		const quests = query.search({
			query: "",
			capability: "all",
			pageSize: 50,
			filter: [{ field: "namespace", op: "is", values: ["Quests"] }]
		});
		expect(quests.total).toBe(2);
	});
});
