import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { LocalizationEvidence } from "@ue-shed/localization";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";
import { GameTextIndexRefresh } from "./index-refresh.js";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { typeScriptIndexBuilderLayer } from "./index-reference.test-support.js";
import { joinLocalizationTarget } from "./localization.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { textCorpusQuery } from "./query.test-support.js";
import type { TextCorpusSearchPage, TextCorpusSearchRequest } from "./schema.js";

type Occurrence = SavedAssetPackageTextRecord["occurrences"][number];

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const KEY = "0A1B2C3D4E5F60718293A4B5C6D7E8F9";
const saved = (
	object: string,
	namespace: string,
	property: string,
	source = "Welcome"
): Occurrence => ({
	source,
	dev_notes: "",
	identity: { status: "resolved", namespace, key: KEY },
	location: {
		kind: "asset_property",
		object_path: object,
		class_path: "/Script/Engine.DataAsset",
		property_path: property
	},
	edit_capability: "read_only"
});

// Unreal saves each asset's text under its package's namespace marker; it gathers them as one
// key in namespace "", and its manifest keeps only the first path it saw.
const packages = [
	{
		path: "Content/Text/DT_Labels.uasset",
		occurrences: [
			saved("/Game/Text/DT_Labels.DT_Labels", "[11111111222222223333333344444444]", "Label")
		]
	},
	{
		path: "Content/Text/WBP_Menu.uasset",
		occurrences: [
			saved("/Game/Text/WBP_Menu.WBP_Menu", "[55555555666666667777777788888888]", "Title")
		]
	},
	{
		path: "Content/Text/BP_Sign.uasset",
		occurrences: [
			saved(
				"/Game/Text/BP_Sign.Default__BP_Sign_C",
				"[9999999900000000AAAAAAAABBBBBBBB]",
				"DisplayName"
			)
		]
	},
	{
		// A String Table entry keeps its namespace: it is not a package marker.
		path: "Content/Text/ST_Menu.uasset",
		occurrences: [
			{
				...saved("/Game/Text/ST_Menu.ST_Menu", "[Table]", "Entry"),
				location: {
					kind: "string_table_entry",
					object_path: "/Game/Text/ST_Menu.ST_Menu",
					entry_key: KEY
				}
			} satisfies Occurrence
		]
	}
];

const builders = [
	["columnar reference", typeScriptIndexBuilderLayer],
	...(executable
		? [
				[
					"native engine",
					nativeIndexBuilderLayer({
						executable,
						timeoutMs: 30000,
						catalogTimeoutMs: 120000
					})
				] as const
			]
		: [])
] as const;

const places = (page: TextCorpusSearchPage) =>
	page.units
		.map((unit) => ({
			id: unit.id,
			namespace: unit.identity.status === "resolved" ? unit.identity.namespace : "",
			places: unit.occurrenceCount,
			files: unit.contexts.map((context) => context.location.objectPath).sort()
		}))
		.sort((left, right) => left.id.localeCompare(right.id));

describe("saved text in several packages", () => {
	for (const [name, builder] of builders)
		it(`is one unit and one line per gathered key through the ${name}`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const fixture = yield* makeIndexRegressionFixture();
						yield* Effect.promise(() =>
							writeFile(
								join(fixture.projectRoot, "Review.manifest"),
								JSON.stringify({
									FormatVersion: 1,
									Namespace: "",
									Children: [
										{
											Source: { Text: "Welcome" },
											Keys: [
												{
													Key: KEY,
													Path: "/Game/Text/DT_Labels.DT_Labels.Label"
												}
											]
										}
									]
								})
							)
						);
						// Scans read packages in path order, which decides a unit's first place.
						fixture.addPackages(
							[...packages].sort((left, right) => left.path.localeCompare(right.path))
						);
						yield* Effect.gen(function* () {
							const result = yield* (yield* GameTextIndexRefresh).refresh(
								fixture.request
							);
							const memory = fixture.raw();
							const evidence = yield* Effect.gen(function* () {
								return yield* (yield* LocalizationEvidence).read({
									projectRoot: fixture.projectRoot,
									target: fixture.target
								});
							}).pipe(Effect.provide(fixture.evidence));
							const inMemory = textCorpusQuery(
								memory,
								undefined,
								joinLocalizationTarget(memory, evidence)
							);
							const request: TextCorpusSearchRequest = {
								query: "Welcome",
								capability: "all",
								pageSize: 50
							};
							const units = places(yield* result.search(request));
							expect(units).toEqual(places(inMemory.search(request)));
							// The three package namespaces are one key; the String Table entry
							// keeps its own namespace.
							expect(units.map((unit) => [unit.id, unit.places])).toEqual(
								[
									[`unreal:${encodeURIComponent("[Table]")}:${KEY}`, 1],
									[`unreal::${KEY}`, 3]
								].sort((left, right) =>
									String(left[0]).localeCompare(String(right[0]))
								)
							);
							expect(units.find((unit) => unit.places === 3)!.files).toEqual([
								"/Game/Text/BP_Sign.Default__BP_Sign_C",
								"/Game/Text/DT_Labels.DT_Labels",
								"/Game/Text/WBP_Menu.WBP_Menu"
							]);
							// The line lists every saved place, though the manifest names one path.
							const lines = yield* result.query.selectLocalizationLines(
								{
									query: "Welcome",
									capability: "all",
									localization: { target: fixture.target.name }
								},
								["identity", "places"]
							);
							const gathered = lines.find(
								(line) =>
									line.identity?.namespace === "" && line.identity.key === KEY
							)!;
							expect(gathered.places.map((place) => place.objectPath).sort()).toEqual(
								[
									"/Game/Text/BP_Sign.Default__BP_Sign_C",
									"/Game/Text/DT_Labels.DT_Labels",
									"/Game/Text/WBP_Menu.WBP_Menu"
								]
							);
						}).pipe(
							Effect.provide(fixture.layer(false, fixture.source, false, builder))
						);
					})
				)
			);
		});
});
