import { it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { describe, expect } from "vitest";
import type { LocalizationGateResult } from "@ue-shed/game-text/checks";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import {
	localizationDiffMarkdown,
	localizationDiffText,
	type LocalizationDiffResult
} from "./workflows/localization-diff.js";
import {
	localizationGateMarkdown,
	localizationGateSummary
} from "./workflows/localization-gate.js";

const change = {
	point: "depot@220253",
	base: "before.depot@220253",
	files: 38,
	read: 36,
	outside: 1,
	code: true
};

const checks = {
	key_changed: 0,
	conflicting_source: 1,
	translated_text_changed: 0,
	text_changed: 0,
	not_gathered: 77,
	unresolved_key: 0,
	removed: 0,
	gathered_source: 0,
	partial_read: 0
};

const result: LocalizationGateResult = {
	schemaVersion: 1,
	status: "failed",
	failOn: ["key_changed", "conflicting_source", "translated_text_changed"],
	targets: [
		{
			target: "Game",
			status: "failed",
			lines: 720,
			checks,
			items: [
				{
					check: "conflicting_source",
					severity: "fail",
					namespace: "UI",
					key: "Buy",
					source: "Buy `now`",
					file: "Content/Shop.uasset",
					guidance: "Give one of the texts its own key in Unreal."
				},
				{
					check: "not_gathered",
					severity: "warn",
					namespace: "Game",
					key: "New",
					source: "New",
					file: "Source/Game/Shop.cpp",
					guidance: "Gather to send it for translation."
				}
			],
			omitted: 76
		}
	],
	skipped: [{ target: "Engine", reason: "It had no manifest when the change was made." }],
	change
};

describe("a changelist's verdict", () => {
	it("as Markdown: counts, failing lines with a way forward, warnings, and coverage", () => {
		expect(localizationGateMarkdown(result)).toBe(
			[
				"### Text check failed: changelist 220253",
				"",
				"**Game**: failed, 720 changed lines checked.",
				"",
				"| Check | Lines | Policy |",
				"| --- | ---: | --- |",
				"| Same key, different text | 1 | fails |",
				"| Not gathered | 77 | warns |",
				"",
				"Failing:",
				"",
				"- **Same key, different text**: `UI,Buy` `` Buy `now` `` in `Content/Shop.uasset`",
				"  Give one of the texts its own key in Unreal.",
				"",
				"Warnings:",
				"",
				"- **Not gathered**: `Game,New` `New` in `Source/Game/Shop.cpp`",
				"  Gather to send it for translation.",
				"- 76 more, listed by `--format json` (up to 200).",
				"",
				"**Engine**: skipped. It had no manifest when the change was made.",
				"",
				"Coverage: read 36 of the 38 files the change touches in the project, before the change and at it; 1 outside the project were left out. Code and config files were read with the project's engine; String Table CSVs and wrapper macros come from the workspace. Reflected metadata (DisplayName, ToolTip) is not checked.",
				""
			].join("\n")
		);
	});

	it("as text: changed lines in the changelist, and a shelf by its own name", () => {
		expect(localizationGateSummary(result).split("\n")[0]).toBe(
			"Game: failed. 720 changed lines in changelist 220253, 1 failing."
		);
		const shelf = { ...result, change: { ...change, point: "shelved:220258" } };
		expect(localizationGateMarkdown(shelf).split("\n")[0]).toBe(
			"### Text check failed: shelved changelist 220258"
		);
		const range = { ...result, change: { ...change, point: "range:220250..220253" } };
		expect(localizationGateMarkdown(range).split("\n")[0]).toBe(
			"### Text check failed: changelists 220250 to 220253"
		);
	});

	it("says when code was not read", () => {
		const unread = { ...result, change: { ...change, code: false, outside: 0 } };
		expect(localizationGateMarkdown(unread)).toContain(
			"before the change and at it. Code and config files were not read"
		);
	});
});

const diff: LocalizationDiffResult = {
	schemaVersion: 1,
	change,
	targets: [
		{
			target: "Game",
			localized: true,
			complete: true,
			counts: { added: 1, removed: 0, rekeyed: 1, edited: 1, unchanged: 4 },
			total: 4,
			changes: [
				{
					kind: "added",
					path: "Source/Game/Shop.cpp",
					place: {
						kind: "code",
						object: "Source/Game/Shop.cpp",
						entry: "",
						property: "LOCTEXT",
						line: 12
					},
					after: {
						status: "resolved",
						namespace: "Game",
						key: "New",
						source: "New",
						notes: ""
					},
					sourceChanged: true,
					notesChanged: false
				},
				{
					kind: "rekeyed",
					path: "Content/Shop.uasset",
					place: {
						kind: "asset_property",
						object: "Shop.Button",
						entry: "",
						property: "Text"
					},
					before: {
						status: "resolved",
						namespace: "UI",
						key: "Sell",
						source: "Sell",
						notes: ""
					},
					after: {
						status: "resolved",
						namespace: "UI",
						key: "SellItem",
						source: "Sell",
						notes: ""
					},
					sourceChanged: false,
					notesChanged: false
				},
				{
					kind: "edited",
					path: "Content/Shop.uasset",
					place: {
						kind: "asset_property",
						object: "Shop.Title",
						entry: "",
						property: "Text"
					},
					before: {
						status: "resolved",
						namespace: "UI",
						key: "Buy",
						source: "Buy",
						notes: ""
					},
					after: {
						status: "resolved",
						namespace: "UI",
						key: "Buy",
						source: "Buy now",
						notes: ""
					},
					sourceChanged: true,
					notesChanged: false
				}
			],
			impact: {
				counts: {
					keyChanged: 1,
					conflictingSource: 0,
					translatedTextChanged: 0,
					textChanged: 0,
					notGathered: 1,
					unresolvedKey: 0,
					removed: 0,
					gatheredSource: 0,
					partialRead: 0
				},
				total: 2,
				built: false,
				rows: [
					{
						check: "key_changed",
						path: "Content/Shop.uasset",
						namespace: "UI",
						key: "SellItem",
						source: "Sell",
						cultures: ["de", "fr"],
						earlier: { namespace: "UI", key: "Sell" }
					}
				]
			}
		}
	]
};

describe("a changelist's differences", () => {
	it("as text: each change with its keys, text and place, and the impact", () => {
		expect(localizationDiffText(diff)).toBe(
			[
				"Game: depot@220253 over before.depot@220253: 1 added, 0 removed, 1 rekeyed, 1 edited, 4 unchanged.",
				'  + added   Game,New "New"  Source/Game/Shop.cpp:12',
				'  ~ rekeyed UI,Sell -> UI,SellItem "Sell"  Content/Shop.uasset (Shop.Button Text)',
				'  * edited  UI,Buy "Buy" -> "Buy now"  Content/Shop.uasset (Shop.Title Text)',
				"  1 more changes not listed; raise --limit.",
				"  Impact: 1 key changed, 1 not gathered.",
				'    Key changed: UI,SellItem (was UI,Sell) "Sell" in Content/Shop.uasset [de, fr]',
				""
			].join("\n")
		);
	});

	it("as Markdown, and without impact when the base had no manifest", () => {
		const { impact: _impact, ...unjudged } = diff.targets[0]!;
		const markdown = localizationDiffMarkdown({
			...diff,
			targets: [{ ...unjudged, localized: false }]
		});
		expect(markdown).toContain("### Text changes: depot@220253");
		expect(markdown).toContain("Impact: not judged; the base had no manifest for this target.");
	});
});

const run = (args: readonly string[]) =>
	Effect.gen(function* () {
		const output = yield* Ref.make("");
		const code = yield* Ref.make(0);
		const runtime = Layer.succeed(CliRuntime, {
			print: (value) => Ref.update(output, (text) => text + value),
			printError: (value) => Ref.update(output, (text) => text + value),
			setExitCode: (value) => Ref.set(code, value)
		});
		yield* runCli(args).pipe(Effect.provide(runtime));
		return { output: yield* Ref.get(output), code: yield* Ref.get(code) };
	});

it.effect.each([
	{ flags: [], message: "Name the change to check" },
	{
		flags: ["--change", "1", "--files", "list.txt"],
		message: "--files and --change name different changes"
	},
	{
		flags: ["--change", "1", "--shelved", "2"],
		message: "--change and --shelved name different changes"
	},
	{
		flags: ["--change", "1", "--from", "1", "--to", "2"],
		message: "--change and --from and --to name different changes"
	},
	{ flags: ["--from", "1"], message: "A range takes both --from <CL> and --to <CL>." },
	{
		flags: ["--from", "5", "--to", "5"],
		message: "--to 5 is not after --from 5. Name the later changelist as --to."
	}
])("a gate takes exactly one change: $message", ({ flags, message }) =>
	Effect.gen(function* () {
		const { output, code } = yield* run([
			"loc",
			"gate",
			"missing-project",
			...flags,
			"--format",
			"text"
		]);
		expect(code).toBe(2);
		expect(output).toContain(message);
	})
);
