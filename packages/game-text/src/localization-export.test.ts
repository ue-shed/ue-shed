import { describe, expect, it } from "vitest";
import { joinLocalizationTarget } from "./localization.js";
import { localizationLinesCsv, pickedLocalizationCultures } from "./localization-export.js";
import {
	archiveEntry,
	corpus,
	cultureCode,
	evidence,
	manifestEntry,
	target,
	unit
} from "./localization.test-support.js";
import { textCorpusQuery } from "./query.js";

function rows(csv: string): string[][] {
	return csv
		.replace(/^﻿/u, "")
		.trimEnd()
		.split("\r\n")
		.map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/gu)].map((match) => match[1] ?? ""));
}

describe("all-languages spreadsheet", () => {
	it("lines up every culture by key, native first, with empty cells for missing text", () => {
		const text = corpus([unit("Zeta", "Last line"), unit("Alpha", "=SUM(1,2)")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[
					manifestEntry("Zeta", "Last line"),
					manifestEntry("Alpha", "=SUM(1,2)"),
					manifestEntry("Code", "From code", "Source/Game/Private/Menu.cpp(12)")
				],
				[archiveEntry("Zeta", "Last line", "Letzte Zeile")]
			)
		);
		const lines = textCorpusQuery(text, undefined, joined).localizationLines({
			query: "",
			capability: "all",
			localization: { target: target.name }
		});
		const { csv, rows: count } = localizationLinesCsv({ join: joined, lines, corpus: text });
		const table = rows(csv);
		expect(count).toBe(3);
		expect(table[0]).toEqual([
			"Namespace",
			"Key",
			"Source",
			"Where",
			"Kind",
			"en",
			"en state",
			"de",
			"de state"
		]);
		// Code-unit order by namespace, then key.
		expect(table.slice(1).map((row) => row[1])).toEqual(["Alpha", "Code", "Zeta"]);
		const alpha = table[1] ?? [];
		// Spreadsheet formulas never run from source text.
		expect(alpha[2]).toBe("'=SUM(1,2)");
		expect(alpha[4]).toBe("String table");
		expect(alpha[7]).toBe("");
		expect(alpha[8]).toBe("Not translated");
		const code = table[2] ?? [];
		expect(code[3]).toBe("Source/Game/Private/Menu.cpp(12)");
		expect(code[4]).toBe("C++");
		const zeta = table[3] ?? [];
		expect(zeta[7]).toBe("Letzte Zeile");
		expect(zeta[8]).toBe("Translated");
	});

	it("exports only the picked lines and cultures", () => {
		const text = corpus([unit("Zeta", "Last line"), unit("Alpha", "First line")]);
		const joined = joinLocalizationTarget(
			text,
			evidence(
				[manifestEntry("Zeta", "Last line"), manifestEntry("Alpha", "First line")],
				[archiveEntry("Zeta", "Last line", "Letzte Zeile")]
			)
		);
		const query = textCorpusQuery(text, undefined, joined);
		const all = query.localizationLines({
			query: "",
			capability: "all",
			localization: { target: target.name }
		});
		const zeta = all.find((line) => line.identity?.key === "Zeta");
		if (zeta === undefined) throw new Error("The fixture has a Zeta line.");
		const selection = { target: target.name, culture: cultureCode("en") };
		const lines = query.localizationLines({
			query: "",
			capability: "all",
			localization: selection,
			lines: [zeta.id]
		});
		expect(lines.map((line) => line.identity?.key)).toEqual(["Zeta"]);
		expect(pickedLocalizationCultures(selection)).toEqual(["en"]);
		expect(pickedLocalizationCultures({ target: target.name })).toEqual([]);
		// The native culture always leads; other cultures appear only when picked.
		const table = rows(
			localizationLinesCsv({
				join: joined,
				lines,
				corpus: text,
				cultures: pickedLocalizationCultures(selection)
			}).csv
		);
		expect(table[0]?.slice(5)).toEqual(["en", "en state"]);
		expect(table).toHaveLength(2);
	});
});
