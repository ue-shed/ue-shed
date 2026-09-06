import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
	investigationCsv,
	investigationReplayCommand,
	investigationTable
} from "./investigation.js";
import { readInvestigationPresetJson, writeInvestigationFile } from "./investigation-files.js";

it("quotes multiline cells, escapes spreadsheet formulas, and retains empty export metadata", () => {
	expect(investigationCsv([["a,b", 'a"b', "a\nb", "=1+1", " \t@call", -2]])).toBe(
		'"a,b","a""b","a\nb","\'=1+1","\' \t@call","-2"\r\n'
	);
	const csv = investigationTable({ generation: 2 }, ["value"], []);
	expect(csv).toContain('"metadata"');
	expect(csv).toContain('""generation"":2');
	expect(csv.split("\r\n")).toHaveLength(3);
	expect(investigationReplayCommand("C:/User's Project", "C:/rules.json")).toContain(
		"'C:/User''s Project'"
	);
});

it("bounds preset reads and atomically replaces output without leftover temporary files", async () => {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-investigation-"));
	try {
		const path = join(root, "preset.json");
		await writeFile(path, "old contents");
		await Effect.runPromise(writeInvestigationFile(path, '{"schemaVersion":1}'));
		expect(await readFile(path, "utf8")).toBe('{"schemaVersion":1}');
		expect(await Effect.runPromise(readInvestigationPresetJson(path))).toEqual({
			schemaVersion: 1
		});
		expect(await readdir(root)).toEqual(["preset.json"]);
		await writeFile(path, " ".repeat(4 * 1024 * 1024 + 1));
		await expect(Effect.runPromise(readInvestigationPresetJson(path))).rejects.toMatchObject({
			_tag: "InvestigationError"
		});
		await writeFile(path, "{bad json");
		await expect(Effect.runPromise(readInvestigationPresetJson(path))).rejects.toMatchObject({
			_tag: "InvestigationError"
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
