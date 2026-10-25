import { gameTextCsv } from "./export-reference.test-support.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import type { LocalizationJoin } from "./localization-schema.js";

import type { TextCorpus, TextCorpusSearchPage, TextCorpusSearchRequest } from "./schema.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

// The fixture's package is Content/Text/Table.uasset, mounted at /Game/Text/Table. Here it is a
// Widget Blueprint with the copies a compile saves, in the shapes the native reader writes them.
const pkg = "/Game/Text/Table";
const classes = [
	{
		blueprint: `${pkg}.Table`,
		generatedClass: `${pkg}.Table_C`,
		classDefault: `${pkg}.Default__Table_C`,
		skeletonClass: `${pkg}.SKEL_Table_C`
	}
];
const at = (
	object: string,
	key: string | null,
	source: string,
	property_path = "Text",
	class_path = "/Script/UMG.TextBlock"
): Occurrence => ({
	source,
	dev_notes: "",
	identity:
		key === null
			? { status: "unresolved", reason: "culture_invariant" }
			: { status: "resolved", namespace: "UI", key },
	location: {
		kind: "asset_property",
		object_path: `${pkg}.${object}`,
		class_path,
		property_path
	},
	edit_capability: "read_only"
});

const saved: Occurrence[] = [
	// Edited in the designer, not compiled since: the class still holds the old text.
	at("Table_C.WidgetTree.Title", "Title", "Play"),
	at("Table.WidgetTree.Title", "Title", "Play now"),
	// Compiled and up to date.
	at("Table.WidgetTree.Options", "Options", "Options"),
	at("Table_C.WidgetTree.Options", "Options", "Options"),
	// A UMG animation and its `_INST` copy in the generated class.
	at(
		"Table.FadeIn.FadeIn.MovieSceneFloatTrack_0",
		"Opacity",
		"Render Opacity",
		"DisplayName",
		"/Script/MovieSceneTracks.MovieSceneFloatTrack"
	),
	at(
		"Table_C.FadeIn_INST.FadeIn.MovieSceneFloatTrack_0",
		"Opacity",
		"Render Opacity",
		"DisplayName",
		"/Script/MovieSceneTracks.MovieSceneFloatTrack"
	),
	// Saved only under the generated class: stays its own place.
	at(
		"Table_C.SimpleConstructionScript_0.SCS_Node_0",
		"Category",
		"Default",
		"CategoryName",
		"/Script/Engine.SCS_Node"
	),
	// Two class-default properties under one key: two places of one line.
	at("Default__Table_C", "Tab0", "01", "ButtonText[0]", `${pkg}.Table_C`),
	at("Default__Table_C", "Tab0", "01", "ButtonTooltipText[0]", `${pkg}.Table_C`),
	// Culture-invariant text is a unit per place; its copy folds and is no unit of its own.
	at("Table.WidgetTree.Version", null, "v1.2"),
	at("Table_C.WidgetTree.Version", null, "v1.1"),
	// The gather table calls the edited tooltip editor-only and the text the compiled class
	// still runs runtime: the line stays player text, so the target still expects it.
	{
		...at("Table.WidgetTree.Hint", "Hint", "New tooltip", "ToolTipText"),
		gather_editor_only: true
	},
	{
		...at(
			"Table_C.WidgetTree.Hint",
			"Hint",
			"Old tooltip",
			"ToolTipText",
			"/Script/UMG.Border"
		),
		gather_editor_only: false
	},
	// Compiled; only a saved skeleton class holds older text. The game shows the new text.
	at("Table.WidgetTree.Quit", "Quit", "Quit now"),
	at("Table_C.WidgetTree.Quit", "Quit", "Quit now"),
	at("SKEL_Table_C.WidgetTree.Quit", "Quit", "Quit")
];

async function writeLocalization(projectRoot: string) {
	// Gathered from the last compile: the manifest still has the old title.
	const gathered = [
		["Title", "Play"],
		["Options", "Options"],
		["Tab0", "01"]
	] as const;
	await writeFile(
		join(projectRoot, "Review.manifest"),
		JSON.stringify({
			FormatVersion: 1,
			Namespace: "UI",
			Children: gathered.map(([key, source]) => ({
				Source: { Text: source },
				Keys: [{ Key: key, Path: `${pkg}.Table.${key}` }]
			}))
		})
	);
	for (const culture of ["en", "de"] as const) {
		await writeFile(
			join(projectRoot, `${culture}.archive`),
			JSON.stringify({
				FormatVersion: 2,
				Namespace: "UI",
				Children: gathered.map(([key, source]) => ({
					Key: key,
					Source: { Text: source },
					Translation: { Text: culture === "en" ? source : `${source} (de)` }
				}))
			})
		);
		await writeFile(
			join(projectRoot, `${culture}.po`),
			gathered
				.map(
					([key, source]) =>
						`msgctxt "UI,${key}"\nmsgid "${source}"\nmsgstr "${culture === "en" ? "" : `${source} (de)`}"\n`
				)
				.join("\n")
		);
	}
}

const lineFacts = (join: LocalizationJoin) =>
	Object.fromEntries(
		join.lines.map((line) => [
			line.identity?.key ?? line.id,
			[
				line.source,
				line.audience,
				line.cultures
					.map((culture) => [culture.state, ...(culture.unknownReasons ?? [])].join(","))
					.join("|")
			]
		])
	);

// Culture-invariant text has no key.
const NO_KEY = "(no key)";

const pageFacts = (page: TextCorpusSearchPage) => ({
	total: page.total,
	problems: Object.fromEntries(
		Object.entries(page.problems ?? {}).filter(([, count]) => count > 0)
	),
	units: page.units.map((unit) => [
		unit.identity.status === "resolved" ? unit.identity.key : NO_KEY,
		unit.source.status === "consistent" ? unit.source.value : unit.source.values,
		unit.occurrenceCount,
		unit.reviewSignals,
		unit.audience
	]),
	lines: page.localization?.lines.map((line) => [line.identity?.key ?? NO_KEY, line.source]),
	assets: page.facets?.assets?.entries.map((entry) => [
		entry.key,
		entry.label,
		entry.count,
		entry.needWork,
		entry.worst
	]),
	groups: page.groups?.entries.map((entry) => [
		entry.key,
		entry.label,
		entry.count,
		entry.needWork,
		entry.worst
	])
});

// Each unit as a page lists it: its source, places, review signals and audience. The compiled
// copies of the title, the hint and the culture-invariant version still hold their old text.
const unitRows = {
	[NO_KEY]: ["v1.2", 1, ["unresolved", "evidence_only", "compiled_copy_differs"], "player"],
	Category: ["Default", 1, ["evidence_only"], "editor"],
	Hint: ["New tooltip", 1, ["evidence_only", "compiled_copy_differs"], "player"],
	Opacity: ["Render Opacity", 1, ["evidence_only"], "editor"],
	Options: ["Options", 1, ["evidence_only"], "player"],
	Quit: ["Quit now", 1, ["evidence_only"], "player"],
	Tab0: ["01", 2, ["evidence_only"], "unknown"],
	Title: ["Play now", 1, ["evidence_only", "compiled_copy_differs"], "player"]
} as const;
type UnitKey = keyof typeof unitRows;
// Units list by ID, and the culture-invariant text's ID comes first; lines list by line ID, and its
// line comes last.
const keyed: readonly UnitKey[] = [
	"Category",
	"Hint",
	"Opacity",
	"Options",
	"Quit",
	"Tab0",
	"Title"
];
const upToDate = (count: number) => ["up_to_date", "Up to date", count, 0, "up_to_date"];
const table = (count: number, needWork: number, worst: string) => [
	"content/text/table",
	"Content/Text/Table",
	count,
	needWork,
	worst
];
// Each search without a target and with one. With it, the manifest's old title changed since the
// gather; the hint and quit text were never gathered; the culture-invariant text cannot be
// checked; and the editor text the target skips is up to date.
const searches = [
	{
		query: "",
		units: [
			[NO_KEY, ...keyed],
			[...keyed, NO_KEY]
		],
		problems: [
			{ up_to_date: 8 },
			{ not_gathered: 2, changed_since_gather: 1, unchecked: 1, up_to_date: 4 }
		],
		assets: [table(8, 0, "up_to_date"), table(8, 3, "not_gathered")],
		byProblem: [
			[upToDate(8)],
			[
				["not_gathered", "Not gathered yet", 2, 2, "not_gathered"],
				["changed_since_gather", "Changed since gather", 1, 1, "changed_since_gather"],
				["unchecked", "Couldn't check", 1, 0, "unchecked"],
				upToDate(4)
			]
		]
	},
	{
		query: "play",
		units: [["Title"], ["Title"]],
		problems: [{ up_to_date: 1 }, { changed_since_gather: 1 }],
		assets: [table(1, 0, "up_to_date"), table(1, 1, "changed_since_gather")],
		byProblem: [
			[upToDate(1)],
			[["changed_since_gather", "Changed since gather", 1, 1, "changed_since_gather"]]
		]
	},
	{
		query: "render",
		units: [["Opacity"], ["Opacity"]],
		problems: [{ up_to_date: 1 }, { up_to_date: 1 }],
		assets: [table(1, 0, "up_to_date"), table(1, 0, "up_to_date")],
		byProblem: [[upToDate(1)], [upToDate(1)]]
	}
] as const;

const places = (corpus: TextCorpus) =>
	corpus.units.flatMap((unit) =>
		unit.occurrences.map((occurrence) =>
			JSON.stringify([
				occurrence.location.objectPath,
				occurrence.location.kind === "asset_property"
					? occurrence.location.propertyPath
					: "",
				occurrence.source,
				occurrence.copies?.map((copy) => [copy.kind, copy.objectPath, copy.source]) ?? []
			])
		)
	);

it.live("folded copies agree between the index and the in-memory corpus and join", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot));
		fixture.update(saved, classes);
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const memory = fixture.raw();

			// Places: one per authored site, each with the raw copies folded into it.
			expect(places(memory).sort()).toEqual(
				[
					[
						`${pkg}.Table.FadeIn.FadeIn.MovieSceneFloatTrack_0`,
						"DisplayName",
						"Render Opacity",
						[
							[
								"instance",
								`${pkg}.Table_C.FadeIn_INST.FadeIn.MovieSceneFloatTrack_0`,
								"Render Opacity"
							]
						]
					],
					[
						`${pkg}.Table.WidgetTree.Options`,
						"Text",
						"Options",
						[["generated_class", `${pkg}.Table_C.WidgetTree.Options`, "Options"]]
					],
					[
						`${pkg}.Table.WidgetTree.Title`,
						"Text",
						"Play now",
						[["generated_class", `${pkg}.Table_C.WidgetTree.Title`, "Play"]]
					],
					[
						`${pkg}.Table.WidgetTree.Version`,
						"Text",
						"v1.2",
						[["generated_class", `${pkg}.Table_C.WidgetTree.Version`, "v1.1"]]
					],
					[
						`${pkg}.Table_C.SimpleConstructionScript_0.SCS_Node_0`,
						"CategoryName",
						"Default",
						[]
					],
					[`${pkg}.Default__Table_C`, "ButtonText[0]", "01", []],
					[`${pkg}.Default__Table_C`, "ButtonTooltipText[0]", "01", []],
					[
						`${pkg}.Table.WidgetTree.Hint`,
						"ToolTipText",
						"New tooltip",
						[["generated_class", `${pkg}.Table_C.WidgetTree.Hint`, "Old tooltip"]]
					],
					[
						`${pkg}.Table.WidgetTree.Quit`,
						"Text",
						"Quit now",
						[
							["generated_class", `${pkg}.Table_C.WidgetTree.Quit`, "Quit now"],
							["skeleton", `${pkg}.SKEL_Table_C.WidgetTree.Quit`, "Quit"]
						]
					]
				]
					.map((place) => JSON.stringify(place))
					.sort()
			);
			expect(memory.coverage).toMatchObject({ textUnits: 8, textOccurrences: 9 });
			expect((yield* result.corpus).coverage).toEqual(memory.coverage);
			expect((yield* result.corpus).units).toEqual(memory.units);

			// Focus through the index decodes the title's compiled copy.
			const title = memory.units.find(
				(unit) => unit.identity.status === "resolved" && unit.identity.key === "Title"
			)!;
			const { localization: _line, ...focused } = (yield* result.query.focus({
				id: title.id,
				pageSize: 50
			}))!;
			expect(focused.diagnostics).toEqual([]);
			expect(focused.totalOccurrences).toBe(1);
			expect(focused.occurrences).toHaveLength(1);
			expect(focused.occurrences[0]).toMatchObject({
				source: "Play now",
				identity: { status: "resolved", namespace: "UI", key: "Title" },
				location: {
					kind: "asset_property",
					objectPath: `${pkg}.Table.WidgetTree.Title`,
					classPath: "/Script/UMG.TextBlock",
					propertyPath: "Text"
				},
				audience: "player",
				copies: [
					{
						objectPath: `${pkg}.Table_C.WidgetTree.Title`,
						kind: "generated_class",
						source: "Play"
					}
				]
			});
			expect(focused.unit).toMatchObject({
				id: "unreal:UI:Title",
				source: { status: "consistent", value: "Play now" },
				occurrenceCount: 1,
				characterCount: 8,
				wordCount: 2,
				problems: ["up_to_date"]
			});
			expect(focused.unit.reviewSignals).toEqual(["evidence_only", "compiled_copy_differs"]);

			// Lines: the authored text is the line's source; no key has two texts.
			const evidence = yield* Effect.gen(function* () {
				return yield* (yield* LocalizationEvidence).read({
					projectRoot: fixture.projectRoot,
					target: fixture.target
				});
			}).pipe(Effect.provide(fixture.evidence));
			const memoryJoin = joinLocalizationTarget(memory, evidence);
			const lines = lineFacts(memoryJoin);
			expect(JSON.stringify(lines)).not.toContain("conflicting_source");
			expect(lines.Title?.[0]).toBe("Play now");
			// A runtime compiled copy keeps an editor-only place's line player text and in scope.
			expect(lines.Hint?.slice(0, 2)).toEqual(["New tooltip", "player"]);
			expect(lines.Hint?.[2]).not.toContain("outside_target");
			const hint = memoryJoin.lines.find((line) => line.identity?.key === "Hint")!;
			expect(hint.outOfScope).toBeUndefined();
			// A skeleton-only difference is not stale runtime text.
			const quit = memory.units.find(
				(unit) => unit.identity.status === "resolved" && unit.identity.key === "Quit"
			)!;
			expect(
				(yield* result.query.focus({ id: quit.id, pageSize: 1 }))!.unit.reviewSignals
			).not.toContain("compiled_copy_differs");
			expect(lineFacts(yield* result.localizationJoin)).toEqual(lines);

			// Search, problems, facets and groups, without a target and with one. Searches have no
			// lens: a request's lens changes nothing.
			for (const [index, scoped] of [false, true].entries())
				for (const search of searches)
					for (const lens of [undefined, "conflicting", "shared"] as const)
						for (const group of [undefined, "problem", "asset"] as const) {
							const request: TextCorpusSearchRequest = {
								query: search.query,
								capability: "all",
								pageSize: 50,
								facets: { assets: true },
								...(scoped
									? { localization: { target: fixture.target.name } }
									: undefined),
								...(lens === undefined ? undefined : { lens }),
								...(group === undefined ? undefined : { group })
							};
							const keys = search.units[index]!;
							expect(
								pageFacts(yield* result.search(request)),
								JSON.stringify(request)
							).toEqual({
								total: keys.length,
								problems: search.problems[index],
								units: keys.map((key) => [key, ...unitRows[key]]),
								lines: scoped
									? keys.map((key) => [key, unitRows[key][0]])
									: undefined,
								assets: [search.assets[index]],
								groups:
									group === "problem"
										? search.byProblem[index]
										: group === "asset"
											? [search.assets[index]]
											: undefined
							});
						}
			const all = yield* result.search({ query: "", capability: "all", pageSize: 50 });
			expect(all.counts.conflicting).toBe(0);
			expect(
				all.units
					.filter((unit) => unit.reviewSignals.includes("compiled_copy_differs"))
					.map((unit) => unit.source)
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
			).toEqual([
				{ status: "consistent", value: "New tooltip" },
				{ status: "consistent", value: "Play now" },
				{ status: "consistent", value: "v1.2" }
			]);
			// The compiled copy's old text is provenance, not a searchable place.
			const old = yield* result.search({ query: "v1.1", capability: "all", pageSize: 50 });
			expect(old.total).toBe(0);

			// Exported lines and rows list places, not copies.
			const exported = {
				query: "",
				capability: "all",
				localization: { target: fixture.target.name }
			} as const;
			expect(
				(yield* result.query.localizationLines(exported)).map(
					(line) => line.identity?.key ?? NO_KEY
				)
			).toEqual([...keyed, NO_KEY]);
			expect(gameTextCsv(memory).split("\r\n").filter(Boolean)).toHaveLength(1 + 9);

			// Edit the authored title again, still without compiling: only place text changes, so
			// the join refreshes incrementally and keeps the signal. Then compile: the copy catches
			// up and the signal clears.
			const differing = (page: TextCorpusSearchPage) =>
				page.units
					.filter((unit) => unit.reviewSignals.includes("compiled_copy_differs"))
					.map((unit) => (unit.source.status === "consistent" ? unit.source.value : ""))
					.sort();
			const edit = (title: string, compiled: string) =>
				saved.map((item) =>
					item.location.object_path === `${pkg}.Table.WidgetTree.Title`
						? { ...item, source: title }
						: item.location.object_path === `${pkg}.Table_C.WidgetTree.Title`
							? { ...item, source: compiled }
							: item
				);
			const request = { query: "", capability: "all", pageSize: 50 } as const;
			// Place text edits join incrementally, whatever the texts' length.
			const long = "Press any button to begin a new adventure";
			const longer = "Press any button to begin your next adventure";
			for (const [title, compiled, expected, strategy] of [
				[long, "Play", ["New tooltip", long, "v1.2"], "incremental"],
				[longer, "Play", ["New tooltip", longer, "v1.2"], "incremental"],
				// The copy's text and the place's copy flags change: a full join.
				[longer, longer, ["New tooltip", "v1.2"], "full"]
			] as const) {
				fixture.update(edit(title, compiled), classes);
				const next = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
				expect(next.join).toMatchObject({ strategy });
				const nextMemory = fixture.raw();
				expect((yield* next.corpus).units).toEqual(nextMemory.units);
				const page = yield* next.search(request);
				expect(differing(page)).toEqual(expected);
				const rows = {
					...unitRows,
					Title: [
						title,
						1,
						compiled === title
							? ["evidence_only"]
							: ["evidence_only", "compiled_copy_differs"],
						"player"
					]
				};
				expect(pageFacts(page)).toEqual({
					total: 8,
					problems: { up_to_date: 8 },
					units: ([NO_KEY, ...keyed] satisfies UnitKey[]).map((key) => [
						key,
						...rows[key]
					]),
					lines: undefined,
					assets: undefined,
					groups: undefined
				});
			}
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
