import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	corpusContentFolder,
	decodeCorpusManifest,
	developerFolderName,
	parseCorpusArguments,
	summarizeCorpusManifest
} from "./game-text-corpus.ts";

describe("parseCorpusArguments", () => {
	it("defaults to 10000 lines, seed 1 and the user's developer folder", () => {
		expect(parseCorpusArguments(["--project", "Game/Game.uproject"], "jane.doe")).toEqual({
			project: resolve("Game/Game.uproject"),
			lines: 10_000,
			seed: 1,
			root: "/Game/Developers/janedoe/GameTextCorpus",
			engineRoot: undefined,
			clean: false
		});
	});

	it("reads every option", () => {
		const parsed = parseCorpusArguments(
			[
				"--project",
				"Game.uproject",
				"--lines",
				"250",
				"--seed",
				"7",
				"--root",
				"/Game/Developers/qa/Corpus/",
				"--engine-root",
				"Engines/UE_5.7",
				"--clean"
			],
			"user"
		);
		expect(parsed).toMatchObject({
			lines: 250,
			seed: 7,
			root: "/Game/Developers/qa/Corpus",
			engineRoot: resolve("Engines/UE_5.7"),
			clean: true
		});
	});

	it.each([
		[["--lines", "10"], /--project/u],
		[["--project", "Game.uproject", "--lines", "0"], /at least 1/u],
		[["--project", "Game.uproject", "--lines", "1e4"], /whole number/u],
		[["--project", "Game.uproject", "--seed", "x"], /whole number/u],
		[["--project", "Game.uproject", "--root", "/Game"], /two levels/u],
		[["--project", "Game.uproject", "--root", "/Game/Corpus"], /two levels/u],
		[["--project", "Game.uproject", "--root", "/Engine/A/B"], /two levels/u],
		[["--project", "Game.uproject", "--root", "/Game/A/../B"], /two levels/u]
	])("rejects %j", (argv, message) => {
		expect(() => parseCorpusArguments(argv, "user")).toThrow(message);
	});

	it("rejects unknown options", () => {
		expect(() =>
			parseCorpusArguments(["--project", "Game.uproject", "--force"], "user")
		).toThrow();
	});
});

it("keeps only package-name characters in the developer folder", () => {
	expect(developerFolderName("DOMAIN\\Jane Doe")).toBe("DOMAINJaneDoe");
	expect(developerFolderName("...")).toBe("User");
});

it("maps a /Game root to the project's Content folder", () => {
	expect(
		corpusContentFolder(join("D:", "Game", "Game.uproject"), "/Game/Developers/me/Corpus")
	).toBe(join("D:", "Game", "Content", "Developers", "me", "Corpus"));
});

const manifestJson = JSON.stringify({
	format: "ue-shed-game-text-corpus",
	version: 1,
	seed: 3,
	lines: 4,
	root: "/Game/Developers/me/Corpus",
	engineVersion: "5.7.4-1+++UE5+Release-5.7",
	counts: { stringTableEntry: 2, widgetText: 2, total: 4 },
	duplicates: { sharedSource: 1, keyConflicts: 0, empty: 1, whitespace: 0 },
	packages: [
		{
			path: "/Game/Developers/me/Corpus/StringTables/ST_Menu_000",
			kind: "stringTable",
			lines: 2,
			texts: [
				{
					kind: "stringTableEntry",
					field: "Menu_00000",
					namespace: "Corpus.Menu",
					key: "Menu_00000",
					source: "Back",
					notes: "Button label."
				},
				{
					kind: "stringTableEntry",
					field: "Menu_00001",
					namespace: "Corpus.Menu",
					key: "Menu_00001",
					source: ""
				}
			]
		},
		{
			path: "/Game/Developers/me/Corpus/Widgets/WBP_Corpus_000",
			kind: "widgetBlueprint",
			lines: 2,
			texts: []
		}
	]
});

it("decodes a manifest and summarizes it by kind", () => {
	expect(summarizeCorpusManifest(decodeCorpusManifest(manifestJson))).toBe(
		[
			"Game Text corpus: 4 lines in 2 packages (seed 3, Unreal 5.7.4-1+++UE5+Release-5.7)",
			"Root: /Game/Developers/me/Corpus",
			"Lines by kind:",
			"  stringTableEntry  2",
			"  widgetText        2",
			"  total             4",
			"Packages by kind:",
			"  stringTable       1",
			"  widgetBlueprint   1",
			"Duplicates: 1 shared source, 0 key conflicts, 1 empty, 0 whitespace-only"
		].join("\n")
	);
});

it("rejects a file that is not a corpus manifest", () => {
	expect(() =>
		decodeCorpusManifest(JSON.stringify({ ...JSON.parse(manifestJson), format: "other" }))
	).toThrow();
	expect(() => decodeCorpusManifest("{")).toThrow();
});
