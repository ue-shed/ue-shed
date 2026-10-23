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
import {
	localizationQualityWorkspace,
	localizationQualityWorkspaceOf
} from "./localization-workspace.js";
import type { LocalizationJoin } from "./localization-schema.js";
import { textCorpusQuery } from "./query.test-support.js";
import type { TextCorpus, TextCorpusSearchPage, TextCorpusSearchRequest } from "./schema.js";
type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];
// Every occurrence is in Content/Text/Table.uasset, inside the test target's gather paths. The
// target's GatherTextFromAssets step leaves ShouldGatherFromEditorOnlyData at Unreal's default,
// false, so it skips editor-only text.
const occurrence = (
	key: string,
	source: string,
	location: Partial<
		Extract<
			Occurrence["location"],
			{
				kind: "asset_property";
			}
		>
	> = {},
	gather?: boolean
) =>
	({
		source,
		dev_notes: "",
		identity: { status: "resolved", namespace: "UI", key },
		location: {
			kind: "asset_property",
			object_path: "/Game/Text/Table.Table",
			class_path: "/Script/Engine.DataAsset",
			property_path: "Label",
			...location
		},
		edit_capability: "read_only",
		...(gather === undefined ? undefined : { gather_editor_only: gather })
	}) satisfies Occurrence;
const saved: Occurrence[] = [
	// Unreal's gather table says editor-only, though the policy table knows nothing about it.
	occurrence("EditorOnly", "Shown in the Details panel", { property_path: "Description" }, true),
	// Unreal's gather table says runtime, though the policy table would call it a tooltip.
	occurrence("Runtime", "Hold to sprint", { property_path: "ToolTip" }, false),
	// Policy: a Blueprint graph node.
	occurrence("Node", "Calls the spawner", {
		object_path: "/Game/Text/Table.Table:EventGraph.K2Node_CallFunction_3",
		class_path: "/Script/BlueprintGraph.K2Node_CallFunction",
		property_path: "PinToolTip"
	}),
	// Policy: a widget's UMG palette category.
	occurrence("Palette", "Menus", {
		object_path: "/Game/Text/Table.Table:WidgetTree.Button_1",
		class_path: "/Script/UMG.Button",
		property_path: "PaletteCategory"
	}),
	// Policy: developer folders are editor text, but not editor-only data a gather skips.
	occurrence("Dev", "Test level sign", { object_path: "/Game/Dev/Test.Test" }),
	// Policy: a Blueprint enum's display names are player text. The reader writes them as map
	// values (`saved_enum_display_names_are_map_values` in uasset-inspection).
	occurrence("Enum", "Rare item", {
		object_path: "/Game/Text/Table.Table",
		class_path: "/Script/Engine.UserDefinedEnum",
		property_path: "DisplayNameMap{0}.value"
	}),
	// Policy: a widget animation's editor display names, a `TMap<FString, FText>`.
	occurrence("Anim", "Hover target", {
		object_path: "/Game/Text/Table.Table:HoverAnim.MovieScene_0",
		class_path: "/Script/MovieScene.MovieScene",
		property_path: "ObjectsToDisplayNames{0}.value"
	}),
	// Policy: DataTable cells are player text.
	{
		...occurrence("Cell", "Open the gate"),
		location: {
			kind: "data_table_cell",
			object_path: "/Game/Text/Table.Table",
			row: "Row_1",
			property_path: "Name"
		}
	},
	// No evidence either way.
	occurrence("Plain", "Welcome back"),
	// One line, two places: an editor tooltip and unknown text. Unknown wins, and the line stays
	// in scope because one place is not editor-only.
	occurrence("Mixed", "Inventory", { property_path: "ToolTip" }),
	occurrence("Mixed", "Inventory", { property_path: "Copy" }),
	// Blank text is never listed; its audience must not leak into listed lines.
	occurrence("Blank", "", { property_path: "Hint" }, true)
];
const expectedAudiences = {
	EditorOnly: ["editor", "gather_table_editor_only", undefined],
	Runtime: ["player", "gather_table_runtime", undefined],
	Node: ["editor", "editor_object", "k2_node"],
	Palette: ["editor", "editor_property", "palette_category"],
	Dev: ["editor", "developer_folder", "dev_folder"],
	Enum: ["player", "player_asset", "user_defined_enum_display_name"],
	Anim: ["editor", "editor_property", "objects_to_display_names"],
	Cell: ["player", "player_asset", "data_table"],
	Plain: ["unknown", "no_evidence", undefined],
	Mixed: ["editor", "editor_property", "tooltip"],
	Blank: ["editor", "gather_table_editor_only", undefined]
};
/** Gathered keys: Enum, Cell and Plain. Everything else is missing from the manifest. */
async function writeLocalization(projectRoot: string) {
	const gathered = [
		["Enum", "Rare item"],
		["Cell", "Open the gate"],
		["Plain", "Welcome back"]
	] as const;
	await writeFile(
		join(projectRoot, "Review.manifest"),
		JSON.stringify({
			FormatVersion: 1,
			Namespace: "UI",
			Children: gathered.map(([key, source]) => ({
				Source: { Text: source },
				Keys: [{ Key: key, Path: `/Game/Text/Table.Table.${key}` }]
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
					Translation: { Text: culture === "en" ? source : "" }
				}))
			})
		);
		await writeFile(
			join(projectRoot, `${culture}.po`),
			gathered
				.map(([key, source]) => `msgctxt "UI,${key}"\nmsgid "${source}"\nmsgstr ""\n`)
				.join("\n")
		);
	}
}
const keyOfUnit = (corpus: TextCorpus, id: string) => {
	const unit = corpus.units.find((item) => item.id === id)!;
	return unit.identity.status === "resolved" ? unit.identity.key : unit.id;
};
const audienceByLine = (join: LocalizationJoin) =>
	Object.fromEntries(
		join.lines.map((line) => [
			line.identity?.key ?? line.id,
			[
				line.audience,
				line.outOfScope,
				[...new Set(line.cultures.map((culture) => culture.state))].sort().join(",")
			]
		])
	);
/** What a page says about audience: its rows in order, totals, facet and groups. */
const pageAudience = (page: TextCorpusSearchPage) => ({
	total: page.total,
	units: page.units.map((unit) => [unit.id, unit.audience]),
	lines: page.localization?.lines.map((line) => [line.id, line.audience, line.outOfScope]),
	audiences: page.facets?.audiences,
	groups: page.groups
});
it.live("audience is stored, filtered, faceted and grouped the same through the index", () =>
	Effect.gen(function* () {
		const fixture = yield* makeIndexRegressionFixture();
		yield* Effect.promise(() => writeLocalization(fixture.projectRoot));
		fixture.update(saved);
		yield* Effect.gen(function* () {
			const result = yield* (yield* GameTextIndexRefresh).refresh(fixture.request);
			const memory = fixture.raw();
			// Every occurrence carries the audience its evidence gives, through both paths.
			const occurrences = (corpus: TextCorpus) =>
				Object.fromEntries(
					corpus.units.map((unit) => [
						keyOfUnit(corpus, unit.id),
						unit.occurrences.map((item) => [
							item.audience,
							item.audienceReason,
							item.audienceRule
						])
					])
				);
			const expected = Object.fromEntries(
				Object.entries(expectedAudiences).map(([key, value]) => [
					key,
					key === "Mixed" ? [value, ["unknown", "no_evidence", undefined]] : [value]
				])
			);
			expect(occurrences(memory)).toEqual(expected);
			expect(occurrences(yield* result.corpus)).toEqual(expected);
			expect((yield* result.corpus).units).toEqual(memory.units);
			// Lines: the rollup, and editor text the target skips is out of scope.
			const evidence = yield* Effect.gen(function* () {
				return yield* (yield* LocalizationEvidence).read({
					projectRoot: fixture.projectRoot,
					target: fixture.target
				});
			}).pipe(Effect.provide(fixture.evidence));
			const memoryJoin = joinLocalizationTarget(memory, evidence);
			const lines = audienceByLine(memoryJoin);
			expect(lines).toEqual({
				EditorOnly: ["editor", "editor_only_data_not_gathered", "outside_target"],
				Runtime: ["player", undefined, "not_gathered"],
				Node: ["editor", "editor_only_data_not_gathered", "outside_target"],
				Palette: ["editor", "editor_only_data_not_gathered", "outside_target"],
				// A developer folder is editor text by convention, not editor-only data.
				Dev: ["editor", undefined, "not_gathered"],
				Enum: ["player", undefined, "not_translated,translated"],
				Anim: ["editor", "editor_only_data_not_gathered", "outside_target"],
				Cell: ["player", undefined, "not_translated,translated"],
				Plain: ["unknown", undefined, "not_translated,translated"],
				Mixed: ["unknown", undefined, "not_gathered"],
				// Blank text has no visible place, so nothing says who it is for.
				Blank: ["unknown", "editor_only_data_not_gathered", "outside_target"]
			});
			// The index lists lines with visible text, as the in-memory query does.
			const { Blank: _blank, ...visible } = lines;
			expect(audienceByLine(yield* result.localizationJoin)).toEqual(visible);
			// Search, filters, facets and groups agree without a target and with one.
			const inMemory = textCorpusQuery(memory, undefined, memoryJoin);
			const localization = { target: fixture.target.name };
			const requests: TextCorpusSearchRequest[] = [];
			for (const scoped of [false, true])
				for (const filter of [
					undefined,
					[{ field: "audience", op: "is", values: ["player"] }] as const,
					[{ field: "audience", op: "is_not", values: ["editor"] }] as const,
					[{ field: "audience", op: "is", values: ["editor", "unknown"] }] as const
				])
					for (const group of [undefined, "audience"] as const)
						requests.push({
							query: "",
							capability: "all",
							pageSize: 50,
							facets: { audiences: true },
							...(scoped ? { localization } : undefined),
							...(filter === undefined ? undefined : { filter }),
							...(group === undefined ? undefined : { group })
						});
			for (const request of requests) {
				const indexed = yield* result.search(request);
				expect(pageAudience(indexed), JSON.stringify(request)).toEqual(
					pageAudience(inMemory.search(request))
				);
			}
			// Localization checks skip out-of-scope lines through the index as in memory.
			const legacy = localizationQualityWorkspace(
				undefined,
				yield* result.localizationCheck(),
				memoryJoin
			);
			const indexed = localizationQualityWorkspaceOf(
				undefined,
				yield* result.localizationQuality()
			);
			const all = { target: fixture.target.name, filter: "all" } as const;
			expect(yield* indexed.export(all)).toEqual(legacy.export(all));
			// Editor text the target never gathers asks for no translator notes or translations.
			expect(
				[...new Set(legacy.export(all).findings.map((finding) => finding.source))].sort()
			).toEqual([
				"Hold to sprint",
				"Inventory",
				"Open the gate",
				"Rare item",
				"Test level sign",
				"Welcome back"
			]);
			// Exported lines carry the same audience and scope.
			const exported = {
				query: "",
				capability: "all",
				localization,
				filter: [{ field: "audience", op: "is_not", values: ["player"] }]
			} as const;
			const memoryLines = inMemory.localizationLines(exported);
			expect(memoryLines.map((line) => line.identity?.key).sort()).toEqual([
				"Anim",
				"Dev",
				"EditorOnly",
				"Mixed",
				"Node",
				"Palette",
				"Plain"
			]);
			expect(
				audienceByLine({
					...memoryJoin,
					lines: yield* result.query.localizationLines(exported)
				})
			).toEqual(audienceByLine({ ...memoryJoin, lines: memoryLines }));
			// The audience facet leaves out its own clause, and counts each line once.
			const player = yield* result.search({
				query: "",
				capability: "all",
				pageSize: 50,
				localization,
				filter: [{ field: "audience", op: "is", values: ["player"] }],
				facets: { audiences: true }
			});
			expect(player.localization?.lines.map((line) => line.identity?.key).sort()).toEqual([
				"Cell",
				"Enum",
				"Runtime"
			]);
			expect(
				Object.fromEntries(
					player.facets!.audiences!.entries.map((entry) => [entry.key, entry.count])
				)
			).toEqual({ player: 3, editor: 5, unknown: 2 });
			// Without a target, units are listed by their own audience.
			const editor = yield* result.search({
				query: "",
				capability: "all",
				pageSize: 50,
				filter: [{ field: "audience", op: "is", values: ["editor"] }]
			});
			expect(editor.units.map((unit) => keyOfUnit(memory, unit.id)).sort()).toEqual([
				"Anim",
				"Dev",
				"EditorOnly",
				"Node",
				"Palette"
			]);
		}).pipe(Effect.provide(fixture.layer()));
	}).pipe(Effect.scoped)
);
