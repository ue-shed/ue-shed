import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.js";
import { TextUnit, type TextOriginKind } from "./schema.js";
import {
	TEXT_ORIGIN_KINDS,
	manifestPathOrigin,
	projectRelativeTextFiles,
	textFileKey,
	unitMatchesTextWhere
} from "./text-origin.js";

function located(key: string, packageFile: string, location: Record<string, string>): TextUnit {
	return Schema.decodeUnknownSync(TextUnit)({
		id: `unit:${key}`,
		source: { status: "consistent", value: `Text ${key}` },
		identity: { status: "resolved", namespace: "NS", key },
		occurrences: [
			{
				id: `occurrence:${key}`,
				devNotes: "",
				packageFile,
				source: `Text ${key}`,
				identity: { status: "resolved", namespace: "NS", key },
				editCapability: "source_editable",
				location
			}
		]
	});
}

const dataTable = located("Row", "Content/UI/DT_Menu.uasset", {
	kind: "data_table_cell",
	objectPath: "/Game/UI/DT_Menu.DT_Menu",
	row: "Start",
	propertyPath: "Label"
});
const asset = located("Prop", "Content/Characters/BP_Hero.uasset", {
	kind: "asset_property",
	objectPath: "/Game/Characters/BP_Hero.BP_Hero_C",
	classPath: "/Game/Characters/BP_Hero.BP_Hero_C",
	propertyPath: "DisplayName"
});
const units = [unit("Table"), dataTable, asset];

describe("text origins", () => {
	it("classifies gathered manifest paths", () => {
		expect(manifestPathOrigin("Source/Game/Private/Menu.cpp(12)")).toBe("cpp");
		expect(manifestPathOrigin("Source\\Game\\Public\\Menu.h:4")).toBe("cpp");
		expect(manifestPathOrigin("/Game/UI/WBP_Menu.WBP_Menu:Title")).toBe("asset");
		expect(manifestPathOrigin("Config/DefaultGame.ini:3")).toBe("other_source");
		expect(manifestPathOrigin("Content/Localization/Extra.txt")).toBe("other_source");
	});

	it("filters saved text by origin, and each origin count equals its filtered total", () => {
		const query = textCorpusQuery(corpus(units));
		const request = { query: "", capability: "all" as const, pageSize: 50 };
		const all = query.search(request);
		expect(all.counts.origins).toEqual({
			string_table: 1,
			data_table: 1,
			asset: 1,
			cpp: 0,
			other_source: 0
		});
		for (const kind of TEXT_ORIGIN_KINDS) {
			const filtered = query.search({ ...request, where: { kinds: [kind] } });
			expect(filtered.total).toBe(all.counts.origins[kind]);
			// The origin facet never narrows its own counts.
			expect(filtered.counts.origins).toEqual(all.counts.origins);
		}
		const two = query.search({ ...request, where: { kinds: ["data_table", "asset"] } });
		expect(two.total).toBe(2);
		expect(two.counts.editable).toBe(2);
	});

	it("matches a path prefix against object paths and package files in any spelling", () => {
		const query = textCorpusQuery(corpus(units));
		const request = { query: "", capability: "all" as const, pageSize: 50 };
		const byObject = query.search({ ...request, where: { pathPrefix: "/game/ui/" } });
		expect(byObject.units.map((item) => item.id)).toEqual([dataTable.id]);
		const byFile = query.search({ ...request, where: { pathPrefix: "Content\\Characters\\" } });
		expect(byFile.units.map((item) => item.id)).toEqual([asset.id]);
		expect(byFile.counts.origins.asset).toBe(1);
		expect(byFile.counts.origins.data_table).toBe(0);
		expect(unitMatchesTextWhere(asset, { kinds: ["asset"], pathPrefix: "content/" })).toBe(
			true
		);
		expect(unitMatchesTextWhere(asset, { kinds: ["string_table"] })).toBe(false);
	});

	it("places gathered-only C++ and config lines by their manifest paths", () => {
		const text = corpus([unit("K")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[
					manifestEntry("K"),
					manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)"),
					manifestEntry("Ini", "From config", "Config/DefaultGame.ini:3")
				],
				[
					archiveEntry("K"),
					archiveEntry("Code", "From code"),
					archiveEntry("Ini", "From config")
				]
			)
		);
		const query = textCorpusQuery(text, undefined, joined);
		const request = {
			query: "",
			capability: "all" as const,
			pageSize: 50,
			localization: { target: target.name }
		};
		const all = query.search(request);
		const expected = {
			string_table: 1,
			data_table: 0,
			asset: 0,
			cpp: 1,
			other_source: 1
		} satisfies Record<TextOriginKind, number>;
		expect(all.counts.origins).toEqual(expected);
		for (const kind of TEXT_ORIGIN_KINDS) {
			const filtered = query.search({ ...request, where: { kinds: [kind] } });
			expect(filtered.total).toBe(expected[kind]);
			expect(filtered.counts.origins).toEqual(expected);
		}
		const source = query.search({ ...request, where: { pathPrefix: "source/game/" } });
		expect(source.localization?.lines.map((line) => line.identity?.key)).toEqual(["Code"]);
	});

	it("compares changed files by package stem or source file, in any spelling", () => {
		expect(textFileKey("Content\\UI\\WBP_Menu.uexp")).toBe("content/ui/wbp_menu");
		expect(textFileKey("/Game/UI/WBP_Menu")).toBe("content/ui/wbp_menu");
		expect(textFileKey("/Game/UI/WBP_Menu.WBP_Menu:Title")).toBe("content/ui/wbp_menu");
		expect(textFileKey('"Content/Maps/L_Main.umap"')).toBe("content/maps/l_main");
		expect(textFileKey("Source/Game/Private/Menu.cpp(12)")).toBe(
			"source/game/private/menu.cpp"
		);
		expect(textFileKey("Config/DefaultGame.ini:3")).toBe("config/defaultgame.ini");
		expect(
			projectRelativeTextFiles(
				[
					"D:\\Proj\\Content\\UI\\A.uasset",
					"# a comment",
					"  ",
					"E:\\Other\\B.uasset",
					"Source/X.cpp"
				],
				"d:/proj"
			)
		).toEqual(["content/ui/a.uasset", "E:\\Other\\B.uasset", "Source/X.cpp"]);
	});

	it("keeps lines from changed files and reports how the list relates to the scan", () => {
		const scanned = {
			...corpus(units),
			packageCoverage: [
				{ packageFile: "Content/Text/Table.uasset", status: "complete" as const },
				{ packageFile: "Content/UI/DT_Menu.uasset", status: "complete" as const },
				{ packageFile: "Content/Characters/BP_Hero.uasset", status: "complete" as const }
			]
		};
		const query = textCorpusQuery(scanned);
		const page = query.search({
			query: "",
			capability: "all",
			pageSize: 50,
			where: {
				files: [
					"Content/UI/DT_Menu.uexp",
					"/Game/Missing/Thing",
					"E:/elsewhere/x.uasset",
					"Source/Readme.md"
				]
			}
		});
		expect(page.units.map((item) => item.id)).toEqual([dataTable.id]);
		expect(page.fileScope).toEqual({ files: 4, textFiles: 1, outside: 1, notScanned: 1 });
		expect(page.counts.origins.data_table).toBe(1);
		expect(page.counts.origins.asset).toBe(0);
		expect(
			query.search({ query: "", capability: "all", pageSize: 50 }).fileScope
		).toBeUndefined();
		expect(unitMatchesTextWhere(dataTable, { files: ["/Game/UI/DT_Menu"] })).toBe(true);
		expect(unitMatchesTextWhere(asset, { files: ["/Game/UI/DT_Menu"] })).toBe(false);
	});

	it("finds gathered C++ lines from a changed source file", () => {
		const text = corpus([unit("K")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[
					manifestEntry("K"),
					manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)")
				],
				[archiveEntry("K"), archiveEntry("Code", "From code")]
			)
		);
		const page = textCorpusQuery(text, undefined, joined).search({
			query: "",
			capability: "all",
			pageSize: 50,
			localization: { target: target.name },
			where: { files: ["Source\\Game\\Private\\Menu.cpp"] }
		});
		expect(page.localization?.lines.map((line) => line.identity?.key)).toEqual(["Code"]);
		expect(page.fileScope).toEqual({ files: 1, textFiles: 1, outside: 0, notScanned: 0 });
	});
});
