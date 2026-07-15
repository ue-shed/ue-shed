import { describe, expect, it } from "vitest";
import { buildTextCorpus, textOccurrencesFromInspection } from "./corpus.js";
import { searchTextCorpus } from "./search.js";
import type { SavedAssetInspection } from "@ue-shed/unreal-assets";

const inspection: SavedAssetInspection = {
	schema_version: 7,
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

	it("searches source, identity, and occurrence context", () => {
		const corpus = buildTextCorpus([
			{ status: "inspected", packageFile: "Content/Text.uasset", inspection }
		]);

		expect(searchTextCorpus(corpus, "hello UI")).toHaveLength(1);
		expect(searchTextCorpus(corpus, "GreetingAgain Label")).toHaveLength(1);
		expect(searchTextCorpus(corpus, "missing")).toHaveLength(0);
	});
});
