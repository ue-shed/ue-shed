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
