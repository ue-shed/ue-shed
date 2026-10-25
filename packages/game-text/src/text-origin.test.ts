import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import type { LocalizationTargetEvidence } from "@ue-shed/localization/browser";
import { withIndexedCorpus } from "./indexed-corpus.test-support.js";
import {
	archiveEntry,
	corpus,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import type { NativeTextQuery } from "./native-query-contract.js";
import { TextUnit, type TextCorpus, type TextOriginKind } from "./schema.js";
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
const request = { query: "", capability: "all" as const, pageSize: 50 };
const localized = { ...request, localization: { target: target.name } };
// Gathered-only C++ and config lines beside the saved String Table entry.
const gathered = evidence(
	[
		manifestEntry("K"),
		manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)"),
		manifestEntry("Ini", "From config", "Config/DefaultGame.ini:3")
	],
	[archiveEntry("K"), archiveEntry("Code", "From code"), archiveEntry("Ini", "From config")]
);
const indexed = <A, E>(
	text: TextCorpus,
	files: LocalizationTargetEvidence | undefined,
	use: (query: NativeTextQuery) => Effect.Effect<A, E>
) => withIndexedCorpus(text, files === undefined ? {} : { files }, (model) => use(model.query));

describe("text origins", () => {
	it("classifies gathered manifest paths", () => {
		expect(manifestPathOrigin("Source/Game/Private/Menu.cpp(12)")).toBe("cpp");
		expect(manifestPathOrigin("Source\\Game\\Public\\Menu.h:4")).toBe("cpp");
		expect(manifestPathOrigin("/Game/UI/WBP_Menu.WBP_Menu:Title")).toBe("asset");
		expect(manifestPathOrigin("Config/DefaultGame.ini:3")).toBe("other_source");
		expect(manifestPathOrigin("Content/Localization/Extra.txt")).toBe("other_source");
	});

	it.live("filters saved text by origin, and each origin count equals its filtered total", () =>
		indexed(corpus(units), undefined, (query) =>
			Effect.gen(function* () {
				const all = yield* query.search(request);
				expect(all.counts.origins).toEqual({
					string_table: 1,
					data_table: 1,
					asset: 1,
					cpp: 0,
					other_source: 0
				});
				for (const kind of TEXT_ORIGIN_KINDS) {
					const filtered = yield* query.search({ ...request, where: { kinds: [kind] } });
					expect(filtered.total).toBe(all.counts.origins[kind]);
					// The origin facet never narrows its own counts.
					expect(filtered.counts.origins).toEqual(all.counts.origins);
				}
				const two = yield* query.search({
					...request,
					where: { kinds: ["data_table", "asset"] }
				});
				expect(two.total).toBe(2);
				expect(two.counts.editable).toBe(2);
			})
		)
	);

	it.live("matches a path prefix against object paths and package files in any spelling", () =>
		indexed(corpus(units), undefined, (query) =>
			Effect.gen(function* () {
				const byObject = yield* query.search({
					...request,
					where: { pathPrefix: "/game/ui/" }
				});
				expect(byObject.units.map((item) => item.id)).toEqual(["unreal:NS:Row"]);
				const byFile = yield* query.search({
					...request,
					where: { pathPrefix: "Content\\Characters\\" }
				});
				expect(byFile.units.map((item) => item.id)).toEqual(["unreal:NS:Prop"]);
				expect(byFile.counts.origins.asset).toBe(1);
				expect(byFile.counts.origins.data_table).toBe(0);
				expect(
					unitMatchesTextWhere(asset, { kinds: ["asset"], pathPrefix: "content/" })
				).toBe(true);
				expect(unitMatchesTextWhere(asset, { kinds: ["string_table"] })).toBe(false);
			})
		)
	);

	it.live("places gathered-only C++ and config lines by their manifest paths", () =>
		indexed(corpus([unit("K")]), gathered, (query) =>
			Effect.gen(function* () {
				const all = yield* query.search(localized);
				const expected = {
					string_table: 1,
					data_table: 0,
					asset: 0,
					cpp: 1,
					other_source: 1
				} satisfies Record<TextOriginKind, number>;
				expect(all.counts.origins).toEqual(expected);
				for (const kind of TEXT_ORIGIN_KINDS) {
					const filtered = yield* query.search({
						...localized,
						where: { kinds: [kind] }
					});
					expect(filtered.total).toBe(expected[kind]);
					expect(filtered.counts.origins).toEqual(expected);
				}
				const source = yield* query.search({
					...localized,
					where: { pathPrefix: "source/game/" }
				});
				expect(source.localization?.lines.map((line) => line.identity?.key)).toEqual([
					"Code"
				]);
			})
		)
	);

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

	it.live("keeps lines from changed files and reports how the list relates to the scan", () =>
		indexed(corpus(units), undefined, (query) =>
			Effect.gen(function* () {
				const page = yield* query.search({
					...request,
					where: {
						files: [
							"Content/UI/DT_Menu.uexp",
							"/Game/Missing/Thing",
							"E:/elsewhere/x.uasset",
							"Source/Readme.md"
						]
					}
				});
				expect(page.units.map((item) => item.id)).toEqual(["unreal:NS:Row"]);
				expect(page.fileScope).toEqual({
					files: 4,
					textFiles: 1,
					outside: 1,
					notScanned: 1
				});
				expect(page.counts.origins.data_table).toBe(1);
				expect(page.counts.origins.asset).toBe(0);
				expect((yield* query.search(request)).fileScope).toBeUndefined();
				expect(unitMatchesTextWhere(dataTable, { files: ["/Game/UI/DT_Menu"] })).toBe(true);
				expect(unitMatchesTextWhere(asset, { files: ["/Game/UI/DT_Menu"] })).toBe(false);
			})
		)
	);

	it.live("finds gathered C++ lines from a changed source file", () =>
		indexed(corpus([unit("K")]), gathered, (query) =>
			Effect.gen(function* () {
				const page = yield* query.search({
					...localized,
					where: { files: ["Source\\Game\\Private\\Menu.cpp"] }
				});
				expect(page.localization?.lines.map((line) => line.identity?.key)).toEqual([
					"Code"
				]);
				expect(page.fileScope).toEqual({
					files: 1,
					textFiles: 1,
					outside: 0,
					notScanned: 0
				});
			})
		)
	);
});
