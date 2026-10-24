import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect, Layer, Schema, Stream } from "effect";
import { LocalizationTarget } from "@ue-shed/localization";
import { makeIndexRegressionFixture } from "./index-refresh-regressions.test-support.js";
import { GameTextRuleDocument } from "./game-text-rules.js";
import { STARTER_CHECK_RULES } from "./starter-rules.js";
import { GameTextIndexSource } from "./index-refresh.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import type { SavedAssetPackageTextRecord } from "@ue-shed/unreal-assets";

export const workspaceScaleRules = Schema.decodeUnknownSync(GameTextRuleDocument)({
	schemaVersion: 1,
	roles: [
		{
			id: "labels",
			scopes: [{ matchers: [{ kind: "object_path", operator: "prefix", value: "/Game/" }] }]
		}
	],
	rules: [
		...STARTER_CHECK_RULES.rules,
		{
			id: "source.limit",
			kind: "character_budget",
			role: "labels",
			maximumCharacters: 12,
			recovery: "Shorten the label."
		},
		{
			id: "source.terms",
			kind: "terminology",
			role: "labels",
			caseSensitive: true,
			terms: [{ kind: "forbidden", term: "TODO" }],
			recovery: "Finish the label."
		},
		{
			id: "translation.limit",
			kind: "localization_character_budget",
			role: "labels",
			cultures: { de: 8 },
			recovery: "Shorten the translation."
		}
	]
});

/** The fixture's source text of line `index`. */
export const workspaceScaleSource = (index: number) =>
	`${["TODO", "TODO FIXME", "FIXME", "Ready"][index % 4]} label ${index} {PlayerName}`;

/**
 * Real saved-text/index inputs, independent of Unreal and any retained project data. `source`
 * gives each line's source text, such as one many lines share.
 */
export const workspaceScaleFixture = Effect.fn("Test.GameText.workspaceScale")(function* (
	count: number,
	cultureCount = 10,
	source: (index: number) => string = workspaceScaleSource
) {
	const parent = resolve("test-results/stall");
	yield* Effect.promise(() => mkdir(parent, { recursive: true }));
	const fixture = yield* makeIndexRegressionFixture(parent);
	const cultures = [
		"en",
		"de",
		"fr",
		"es",
		"it",
		"ja",
		"ko",
		"zh",
		"pt",
		"pl",
		"ru",
		"tr",
		"nl",
		"sv"
	].slice(0, cultureCount);
	const target = Schema.decodeUnknownSync(LocalizationTarget)({
		...fixture.target,
		cultures,
		outputPaths: {
			...fixture.target.outputPaths,
			archives: Object.fromEntries(
				cultures.map((culture) => [culture, `${culture}.archive`])
			),
			portableObjects: Object.fromEntries(
				cultures.map((culture) => [culture, `${culture}.po`])
			)
		}
	});
	fixture.setTargets([target]);
	// Some placeholders are fully covered by source rules, some partly, and some not at all.
	const entries = Array.from({ length: count }, (_, index) => ({
		key: `K${String(index).padStart(7, "0")}`,
		source: source(index)
	}));
	const records: SavedAssetPackageTextRecord[] = [];
	for (let start = 0; start < entries.length; start += 1000) {
		const path = join(fixture.projectRoot, `Content/Text/Table${start}.uasset`);
		records.push({
			...emptyPackageTextRecord(path),
			occurrences: entries.slice(start, start + 1000).map(({ key, source }, index) => ({
				source,
				dev_notes: "",
				identity: { status: "resolved", namespace: "UI", key },
				location: {
					kind: "asset_property",
					object_path: "/Game/Text/Table.Table",
					class_path: "/Script/Engine.DataAsset",
					property_path: `Label${index}`
				},
				edit_capability: "read_only"
			}))
		});
	}
	records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const sourceLayer = Layer.succeed(
		GameTextIndexSource,
		GameTextIndexSource.of({
			inventory: () =>
				Effect.succeed(
					records.map((record) => ({
						path: record.path,
						signature: "generated",
						headerData: {
							packageFlags: 0x00040000,
							gatherableTextDataCount: 1,
							gatherableTextDataOffset: 1,
							hasTextProperty: true
						}
					}))
				),
			read: (_root, entries) => {
				const wanted = new Set(entries.map((entry) => entry.path));
				return Stream.fromIterable(records.filter((record) => wanted.has(record.path)));
			}
		})
	);
	yield* Effect.promise(async () => {
		await writeFile(
			join(fixture.projectRoot, "Review.manifest"),
			JSON.stringify({
				FormatVersion: 1,
				Namespace: "UI",
				Children: entries.map(({ key, source }) => ({
					Source: { Text: source },
					Keys: [{ Key: key, Path: "/Game/Text/Table.Table" }]
				}))
			})
		);
		for (const culture of cultures) {
			await writeFile(
				join(fixture.projectRoot, `${culture}.archive`),
				JSON.stringify({
					FormatVersion: 2,
					Namespace: "UI",
					Children: entries.map(({ key, source }) => ({
						Key: key,
						Source: { Text: source },
						Translation: {
							Text: culture === "en" ? source : `Translated ${key} {Name}`
						}
					}))
				})
			);
			// Archive evidence suffices; an empty PO is valid and keeps setup smaller.
			await writeFile(join(fixture.projectRoot, `${culture}.po`), "");
		}
	});
	return {
		fixture: { request: fixture.request, layer: () => fixture.layer(sourceLayer) },
		target
	};
});
