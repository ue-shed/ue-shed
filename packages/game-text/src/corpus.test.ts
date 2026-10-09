import { describe, expect, it } from "vitest";
import { buildTextCorpus, textOccurrencesFromInspection } from "./corpus.js";
import { textCorpusQuery } from "./query.js";
import { searchTextCorpus } from "./search.js";
import type { SavedAssetInspection } from "@ue-shed/unreal-assets";

const inspection: SavedAssetInspection = {
	schema_version: 8,
	status: "ok",
	path: "Content/Text.uasset",
	package: {
		name: "/Game/Text",
		version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1
	},
	assets: [
		{
			kind: "DataTable",
			object_path: "/Game/Text.DT_Text",
			row_struct: "/Script/Test.TextRow",
			row_count: 2,
			rows: [
				{
					name: "Greeting",
					properties: [
						{
							name: "Label",
							type: "TextProperty",
							value_kind: "text",
							value: "Hello",
							history: "base",
							namespace: "UI",
							key: "Greeting"
						}
					]
				},
				{
					name: "GreetingAgain",
					properties: [
						{
							name: "Label",
							type: "TextProperty",
							value_kind: "text",
							value: "Hello",
							history: "base",
							namespace: "UI",
							key: "Greeting"
						}
					]
				}
			]
		}
	],
	decode_errors: []
};

describe("game text corpus", () => {
	it("retains unsupported text coverage inside an instanced value", () => {
		const nested: SavedAssetInspection = {
			...inspection,
			assets: [
				{
					kind: "UObject",
					object_path: "/Game/Text.Asset",
					class_path: "/Script/Test.Asset",
					properties: [
						{
							name: "Nested",
							type: "StructProperty",
							value_kind: "instanced_struct",
							struct_type: "/Script/Test.Inner",
							size: 32,
							value: {
								value_kind: "struct",
								properties: [
									{
										name: "Label",
										type: "TextProperty",
										value_kind: "raw",
										reason: "unsupported text history",
										size: 8
									}
								]
							}
						}
					]
				}
			]
		};
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: nested.path, inspection: nested }
		]);
		expect(corpus.coverage.unsupportedTextProperties).toBe(1);
	});
	it("finds text inside native and instanced values without offering unsupported edits", () => {
		const nested: SavedAssetInspection = {
			...inspection,
			assets: [
				{
					kind: "DataTable",
					object_path: "/Game/Text.DT_Text",
					row_struct: "/Script/Test.Row",
					row_count: 1,
					rows: [
						{
							name: "Row",
							properties: [
								{
									name: "Nested",
									type: "StructProperty",
									value_kind: "instanced_struct",
									struct_type: "/Script/Test.Inner",
									size: 64,
									value: {
										value_kind: "native_struct",
										fields: [
											{
												name: "Label",
												value: {
													value_kind: "text",
													history: "base",
													value: "Nested text",
													namespace: "Test",
													key: "Nested"
												}
											}
										]
									}
								}
							]
						}
					]
				}
			]
		};
		const occurrences = textOccurrencesFromInspection({
			inspection: nested,
			packageFile: nested.path
		});
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0]?.source).toBe("Nested text");
		expect(occurrences[0]?.editCapability).toBe("read_only");
		expect(occurrences[0]?.location).toMatchObject({ propertyPath: "Nested.Value.Label" });
	});
	it("groups occurrences by Unreal identity rather than source string", () => {
		const occurrences = textOccurrencesFromInspection({
			inspection,
			packageFile: "Content/Text.uasset"
		});
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection }
		]);

		expect(occurrences).toHaveLength(2);
		expect(corpus.units).toHaveLength(1);
		expect(corpus.units[0]?.occurrences).toHaveLength(2);
		expect(corpus.coverage.resolvedOccurrences).toBe(2);
	});

	it.each(["Hello", "Other"])(
		"retains saved package namespaces while findings compare gathered identities (%s)",
		(secondSource) => {
			const outcomes = ["A", "B"].map((name, index) => ({
				status: "inspected" as const,
				packageFile: `Content/${name}.uasset`,
				inspection: {
					...inspection,
					assets: [
						{
							kind: "DataTable" as const,
							object_path: `/Game/${name}.${name}`,
							row_struct: "/Script/Test.TextRow",
							row_count: 1,
							rows: [
								{
									name: "Greeting",
									properties: [
										{
											name: "Label",
											type: "TextProperty",
											value_kind: "text" as const,
											value: index === 0 ? "Hello" : secondSource,
											history: "base" as const,
											namespace: `UI [${name}]`,
											key: "Greeting"
										}
									]
								}
							]
						}
					]
				}
			}));
			const corpus = buildTextCorpus(outcomes);
			expect(corpus.units).toHaveLength(2);
			expect(corpus.units.map((unit) => unit.identity)).toEqual([
				{ status: "resolved", namespace: "UI [A]", key: "Greeting" },
				{ status: "resolved", namespace: "UI [B]", key: "Greeting" }
			]);
			const query = textCorpusQuery(corpus);
			const page = query.search({ capability: "all", query: "", pageSize: 50 });
			expect(page.counts.duplicate_source).toBe(0);
			expect(page.counts.shared).toBe(2);
			expect(page.counts.conflicting).toBe(secondSource === "Hello" ? 0 : 2);
			const first = corpus.units[0];
			if (!first) throw new Error("Missing saved text unit.");
			expect(query.focus({ id: first.id, pageSize: 50 })?.unit.identity).toEqual(
				first.identity
			);
			const distinct = {
				...corpus,
				units: corpus.units.map((unit, index) =>
					index === 0 || unit.identity.status !== "resolved"
						? unit
						: { ...unit, identity: { ...unit.identity, key: "OtherKey" } }
				)
			};
			expect(
				textCorpusQuery(distinct).search({ capability: "all", query: "", pageSize: 50 })
					.counts.duplicate_source
			).toBe(secondSource === "Hello" ? 2 : 0);
		}
	);

	it("keeps equal source strings separate when identity is unresolved", () => {
		const unresolved: SavedAssetInspection = {
			...inspection,
			assets: [
				{
					kind: "DataTable",
					object_path: "/Game/Text.DT_Text",
					row_struct: "/Script/Test.TextRow",
					row_count: 2,
					rows: ["One", "Two"].map((name) => ({
						name,
						properties: [
							{
								name: "Label",
								type: "TextProperty",
								value_kind: "text" as const,
								value: "Same",
								history: "none" as const
							}
						]
					}))
				}
			]
		};
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection: unresolved }
		]);

		expect(corpus.units).toHaveLength(2);
		expect(corpus.coverage.unresolvedOccurrences).toBe(2);
	});

	it("searches visible source text without mixing in identity or occurrence metadata", () => {
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection }
		]);

		expect(searchTextCorpus(corpus, "hello")).toHaveLength(1);
		expect(searchTextCorpus(corpus, "UI")).toHaveLength(0);
		expect(searchTextCorpus(corpus, "Greeting")).toHaveLength(0);
		expect(searchTextCorpus(corpus, "GreetingAgain Label")).toHaveLength(0);
		expect(searchTextCorpus(corpus, "missing")).toHaveLength(0);
		expect(
			textCorpusQuery(corpus).search({ capability: "all", pageSize: 50, query: "Greeting" })
		).toMatchObject({ total: 0 });
	});

	it("excludes empty FText values and does not search their asset metadata", () => {
		const noisyInspection: SavedAssetInspection = {
			...inspection,
			assets: [
				...inspection.assets,
				{
					kind: "DataTable",
					object_path: "/Game/HelpShelf.DT_Noise",
					row_struct: "/Script/Test.TextRow",
					row_count: 1,
					rows: [
						{
							name: "Help",
							properties: [
								{
									name: "Label",
									type: "TextProperty",
									value_kind: "text",
									value: "",
									history: "none"
								}
							]
						}
					]
				}
			]
		};
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection: noisyInspection }
		]);
		const query = textCorpusQuery(corpus);

		expect(searchTextCorpus(corpus, "hel")).toHaveLength(1);
		expect(query.search({ capability: "all", pageSize: 50, query: "hel" }).total).toBe(1);
		expect(query.search({ capability: "all", pageSize: 50, query: "" }).total).toBe(1);
	});

	it("indexes search fields once and returns bounded cursor pages with focused occurrences", () => {
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection }
		]);
		const query = textCorpusQuery(corpus);

		const page = query.search({
			capability: "source_editable",
			pageSize: 1,
			query: "Hello"
		});
		expect(page.total).toBe(1);
		expect(page.units).toHaveLength(1);
		expect(page.units[0]?.occurrenceCount).toBe(2);

		const unit = page.units[0];
		expect(unit).toBeDefined();
		if (!unit) return;
		const focus = query.focus({ id: unit.id, pageSize: 1 });
		expect(focus?.occurrences).toHaveLength(1);
		expect(focus?.totalOccurrences).toBe(2);
		expect(focus?.nextOccurrenceCursor).toBeDefined();
	});
});

it("preserves translator notes from keyed properties and string table entries", () => {
	const withNotes: SavedAssetInspection = {
		...inspection,
		assets: [
			{
				kind: "UObject",
				object_path: "/Game/Notes.Notes",
				class_path: "/Script/Engine.DataAsset",
				properties: [
					{
						name: "Label",
						type: "TextProperty",
						value_kind: "text",
						value: "Hello",
						history: "base",
						namespace: "Fixture",
						key: "Greeting",
						dev_notes: "Greeting, not a command"
					}
				]
			},
			{
				kind: "StringTable",
				object_path: "/Game/Notes.ST_Notes",
				string_table_namespace: "Fixture",
				string_table_metadata: {
					Goodbye: { Comment: "Translator comment" },
					Legacy: { Comment: "Legacy translator note" }
				},
				string_table_entries: [
					{ key: "Goodbye", source: "Bye", dev_notes: "Friendly farewell" },
					{ key: "Legacy", source: "Legacy", dev_notes: "" }
				]
			}
		]
	};
	const occurrences = textOccurrencesFromInspection({
		packageFile: "Content/Notes.uasset",
		inspection: withNotes
	});
	expect(occurrences.map((occurrence) => occurrence.devNotes)).toEqual([
		"Greeting, not a command",
		"Friendly farewell\n\nTranslator comment",
		"Legacy translator note"
	]);
	const legacy = textOccurrencesFromInspection({
		packageFile: "Content/Text.uasset",
		inspection
	});
	expect(legacy.every((occurrence) => occurrence.devNotes === "")).toBe(true);
});
