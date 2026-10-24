import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
	LocalizationBaseline,
	LocalizationProgressReport,
	LocalizationStatusReport
} from "@ue-shed/game-text/corpus";
import { GAME_TEXT_RULES_RELATIVE_PATH, STARTER_CHECK_RULES } from "@ue-shed/game-text/rules";
import { LocalizationQualityReport, TextProblem } from "@ue-shed/game-text/schema";
import { LocalizationChangeSet } from "@ue-shed/localization/browser";
import { ConfigProvider, Effect, FileSystem, Layer, ManagedRuntime, Ref, Schema } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli as runCommand } from "./command.js";
import { cliGameTextIndexLayer, refreshCliGameTextIndex } from "./workflows/game-text-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
let indexed: ReturnType<typeof makeIndexRuntime>;
let cacheRoot: string;
function makeIndexRuntime(root: string) {
	return ManagedRuntime.make(
		cliGameTextIndexLayer(executable).pipe(
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ UE_SHED_PROJECT_INDEX_CACHE_ROOT: root })
				)
			)
		)
	);
}
beforeAll(async () => {
	cacheRoot = await mkdtemp(join(tmpdir(), "ue-shed-cli-index-"));
	indexed = makeIndexRuntime(cacheRoot);
	if (executable) {
		await indexed.runPromise(
			refreshCliGameTextIndex(
				{ projectRoot: fixture.root, targetName: "FixtureGame" },
				executable
			).pipe(Effect.scoped)
		);
	}
});
afterAll(async () => {
	await indexed.dispose();
	await rm(cacheRoot, { recursive: true, force: true });
});
function runCli(args: readonly string[]) {
	return Effect.flatMap(indexed.contextEffect, (context) =>
		runCommand(args).pipe(Effect.provide(context))
	);
}

describe.skipIf(!executable)("localization CLI with the real reader", () => {
	it.effect("status and text search share culture/state filtering and counts", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const output = yield* Ref.make("");
			const exitCode = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (text) => Ref.update(output, (value) => value + text),
					printError: () => Effect.void,
					setExitCode: (code) => Ref.set(exitCode, code)
				})
			);
			const flags = [
				"--target",
				"FixtureGame",
				"--culture",
				"de",
				"--state",
				"gathered_only",
				"--limit",
				"1",
				"--reader",
				executable
			];
			yield* runCli(["loc", "status", fixture.root, ...flags]).pipe(Effect.provide(runtime));
			const status = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(LocalizationStatusReport)
			)(yield* Ref.get(output));
			expect(status.diagnostics.length).toBeLessThanOrEqual(200);
			expect(status.diagnosticCount).toBe(
				status.diagnostics.length + status.diagnosticsOmitted
			);
			expect(
				Object.values(status.diagnosticCounts).reduce((sum, count) => sum + count, 0)
			).toBe(status.diagnosticCount);
			expect(status.packageCoverage?.packages.length).toBeLessThanOrEqual(200);
			expect(
				status.packageCoverage?.packages.every((item) =>
					["partial", "failed", "not_gatherable"].includes(item.status)
				)
			).toBe(true);
			expect(status.page.total).toBe(2);
			expect(status.page.localization?.lines).toHaveLength(1);
			expect(
				status.counts.find((count) => count.culture === "de")?.states.gathered_only.lines
			).toBe(2);
			yield* Ref.set(output, "");
			yield* runCli(["text", "search", fixture.root, "Ready", ...flags]).pipe(
				Effect.provide(runtime)
			);
			const search = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(LocalizationStatusReport)
			)(yield* Ref.get(output));
			expect(search.page.total).toBe(1);
			expect(
				search.counts.find((count) => count.culture === "de")?.states.gathered_only.lines
			).toBe(1);
			expect(yield* Ref.get(exitCode)).toBe(0);
		})
	);

	it.effect("filters by where text comes from, with counts that match each filter", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const output = yield* Ref.make("");
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (text) => Ref.update(output, (value) => value + text),
					printError: () => Effect.void,
					setExitCode: () => Effect.void
				})
			);
			const status = (...extra: string[]) =>
				Effect.gen(function* () {
					yield* Ref.set(output, "");
					yield* runCli([
						"loc",
						"status",
						fixture.root,
						"--target",
						"FixtureGame",
						"--reader",
						executable,
						...extra
					]).pipe(Effect.provide(runtime));
					return yield* Schema.decodeUnknownEffect(
						Schema.fromJsonString(LocalizationStatusReport)
					)(yield* Ref.get(output));
				});
			const all = yield* status();
			const cpp = yield* status("--kind", "cpp");
			expect(cpp.page.total).toBeGreaterThan(0);
			expect(cpp.page.total).toBe(all.page.counts.origins.cpp);
			expect(
				cpp.page.localization?.lines.every((line) =>
					line.manifestLocations.every((path) => path.startsWith("Source/"))
				)
			).toBe(true);
			const tables = yield* status("--kind", "string_table", "--kind", "data_table");
			expect(tables.page.total).toBeGreaterThan(0);
			expect(tables.page.total).toBeLessThanOrEqual(
				all.page.counts.origins.string_table + all.page.counts.origins.data_table
			);
			const source = yield* status("--path", "source\\");
			expect(source.page.total).toBe(cpp.page.total);

			// A changed-file list as any version control tool would print it.
			const list = join(
				yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-files-"))),
				"changed.txt"
			);
			const cppFile = cpp.page.localization?.lines[0]?.manifestLocations[0]?.replace(
				/\(\d+\)$/u,
				""
			);
			if (cppFile === undefined) throw new Error("The fixture has no gathered C++ line.");
			yield* Effect.promise(() =>
				writeFile(
					list,
					[
						"# changed in this change",
						join(
							fixture.root,
							"Content",
							"Fixture",
							"Localization",
							"DT_Localization.uasset"
						),
						cppFile,
						join(tmpdir(), "Elsewhere", "Other.uasset")
					].join("\n")
				)
			);
			const changed = yield* status("--files", list);
			expect(changed.page.fileScope).toMatchObject({ files: 3, textFiles: 2, outside: 1 });
			expect(changed.page.total).toBeGreaterThan(cpp.page.total);
			expect(changed.page.counts.origins.cpp).toBe(cpp.page.total);
			expect(changed.page.counts.origins.data_table).toBeGreaterThan(0);
			expect(changed.page.counts.origins.string_table).toBe(0);

			// One spreadsheet with every language, for the same filter.
			const csvFile = join(dirname(list), "all-languages.csv");
			yield* Ref.set(output, "");
			yield* runCli([
				"loc",
				"export",
				fixture.root,
				"--target",
				"FixtureGame",
				"--kind",
				"cpp",
				"--output",
				csvFile,
				"--reader",
				executable
			]).pipe(Effect.provide(runtime));
			expect(yield* Ref.get(output)).toContain(`"rows": ${cpp.page.total}`);
			const csv = yield* Effect.promise(() => readFile(csvFile, "utf8"));
			const header = csv.replace(/^﻿/u, "").split("\r\n")[0];
			expect(header).toMatch(
				/^"Namespace","Key","Source","Where","Kind","Audience","en","en state"/u
			);
			expect(csv.split("\r\n").filter(Boolean)).toHaveLength(cpp.page.total + 1);
			// Existing files are never overwritten.
			yield* Ref.set(output, "");
			yield* runCli([
				"loc",
				"export",
				fixture.root,
				"--target",
				"FixtureGame",
				"--output",
				csvFile,
				"--reader",
				executable
			]).pipe(Effect.provide(runtime));
			expect(yield* Ref.get(output)).toContain("destination_exists");
		})
	);

	it.effect("filters by problem with clauses and narrows to a culture set", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const output = yield* Ref.make("");
			const exitCode = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (text) => Ref.update(output, (value) => value + text),
					printError: () => Effect.void,
					setExitCode: (code) => Ref.set(exitCode, code)
				})
			);
			const status = (...extra: string[]) =>
				Effect.gen(function* () {
					yield* Ref.set(output, "");
					yield* runCli([
						"loc",
						"status",
						fixture.root,
						"--target",
						"FixtureGame",
						"--reader",
						executable,
						...extra
					]).pipe(Effect.provide(runtime));
					return yield* Ref.get(output);
				});
			const report = (text: string) =>
				Schema.decodeUnknownEffect(Schema.fromJsonString(LocalizationStatusReport))(text);
			const all = yield* report(yield* status());
			const problems = all.page.problems;
			if (problems === undefined) throw new Error("The status page has no problem counts.");
			expect(problems.not_gathered).toBeGreaterThan(0);
			// Each problem's count is what its clause returns.
			for (const [problem, count] of Object.entries(problems)) {
				const filtered = yield* report(
					yield* status("--filter", `problem is ${problem.replaceAll("_", "-")}`)
				);
				expect(filtered.page.total).toBe(count);
			}
			const notCode = yield* report(
				yield* status("--filter", "problem is up-to-date", "--filter", "origin is-not cpp")
			);
			expect(notCode.page.total).toBeLessThan(problems.up_to_date);
			// Groups count every matching line once, worst first.
			const byFolder = yield* report(yield* status("--group", "folder"));
			const groups = byFolder.page.groups;
			expect(groups?.by).toBe("folder");
			expect(groups?.entries.reduce((sum, entry) => sum + entry.count, 0)).toBe(
				byFolder.page.total
			);
			// The first group holds the worst problem in the target.
			expect(groups?.entries[0]?.worst).toBe(
				TextProblem.literals.find((problem) => problems[problem] > 0)
			);
			// A culture set narrows the per-culture counts.
			const german = yield* report(yield* status("--cultures", "de"));
			expect(german.counts.map((count) => count.culture)).toEqual(["de"]);
			expect(yield* Ref.get(exitCode)).toBe(0);
			// A malformed clause fails with guidance, not a crash.
			const failed = yield* status("--filter", "problem maybe key-changed");
			expect(failed).toContain("invalid_selection");
			expect(failed).toContain("is or is-not");
			expect(yield* Ref.get(exitCode)).toBe(2);
		})
	);
});

describe.skipIf(!executable)("localization check CLI with the real reader", () => {
	it.effect("filters culture and repeated check ids and creates only the proposal", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const changesPath = join(directory, "suggestions.json");
			// Without a rules file no check runs: the project lists the starter's for this run.
			const rulesPath = join(fixture.root, GAME_TEXT_RULES_RELATIVE_PATH);
			yield* Effect.acquireRelease(
				fs
					.makeDirectory(dirname(rulesPath), { recursive: true })
					.pipe(
						Effect.andThen(
							fs.writeFileString(rulesPath, JSON.stringify(STARTER_CHECK_RULES))
						)
					),
				() => fs.remove(dirname(rulesPath), { recursive: true }).pipe(Effect.orDie)
			);
			const output = yield* Ref.make("");
			const exit = yield* Ref.make(0);
			const runtime = Layer.succeed(
				CliRuntime,
				CliRuntime.of({
					print: (text) => Ref.update(output, (value) => value + text),
					printError: () => Effect.void,
					setExitCode: (code) => Ref.set(exit, code)
				})
			);
			const paths = [
				"Content/Localization/FixtureGame/FixtureGame.manifest",
				"Content/Localization/FixtureGame/FixtureGame.locmeta",
				...["en", "de", "fr"].flatMap((culture) =>
					["archive", "po", "locres"].map(
						(extension) =>
							`Content/Localization/FixtureGame/${culture}/FixtureGame.${extension}`
					)
				)
			];
			const before = yield* Effect.forEach(paths, (path) =>
				fs.readFile(join(fixture.root, path))
			);
			yield* runCli([
				"loc",
				"check",
				fixture.root,
				"--target",
				"FixtureGame",
				"--culture",
				"de",
				"--check",
				"format_argument_renamed",
				"--check",
				"rich_text",
				"--changes",
				changesPath,
				"--reader",
				executable
			]).pipe(Effect.provide(runtime));
			const report = Schema.decodeUnknownSync(
				Schema.fromJsonString(LocalizationQualityReport)
			)(yield* Ref.get(output));
			expect(report.findings.length).toBeGreaterThan(0);
			expect(
				report.findings.every(
					(finding) =>
						"culture" in finding &&
						finding.culture === "de" &&
						["format_argument_renamed", "rich_text"].includes(finding.kind)
				)
			).toBe(true);
			expect(
				report.changes.changes.some(
					(change) =>
						change.key === "NamedArgument" &&
						change.translation === "Gespräch mit {PlayerName}"
				)
			).toBe(true);
			expect(
				Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationChangeSet))(
					yield* fs.readFileString(changesPath)
				)
			).toEqual(report.changes);
			expect(yield* fs.readDirectory(directory)).toEqual(["suggestions.json"]);
			const after = yield* Effect.forEach(paths, (path) =>
				fs.readFile(join(fixture.root, path))
			);
			expect(after).toEqual(before);
			expect(yield* Ref.get(exit)).toBe(0);
		}).pipe(Effect.provide(NodeServices.layer))
	);
});

describe.skipIf(!executable)("loc report with the real reader", () => {
	it.effect(
		"reports archive progress and baseline deltas while preserving all localization outputs",
		() =>
			Effect.gen(function* () {
				if (executable === undefined)
					throw new Error("The saved reader is not configured.");
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* fs.makeTempDirectoryScoped();
				const baselinePath = join(directory, "baseline.json");
				const output = yield* Ref.make("");
				const exit = yield* Ref.make(0);
				const runtime = Layer.succeed(
					CliRuntime,
					CliRuntime.of({
						print: (value) => Ref.update(output, (text) => text + value),
						printError: () => Effect.void,
						setExitCode: (code) => Ref.set(exit, code)
					})
				);
				const paths = [
					"FixtureGame.manifest",
					"FixtureGame.locmeta",
					"FixtureGame.csv",
					...["de", "en", "fr"].flatMap((culture) =>
						["archive", "po", "locres"].map(
							(extension) => `${culture}/FixtureGame.${extension}`
						)
					)
				];
				const before = yield* Effect.forEach(paths, (path) =>
					fs.readFile(join(fixture.root, "Content/Localization/FixtureGame", path))
				);
				const args = [
					"loc",
					"report",
					fixture.root,
					"--target",
					"FixtureGame",
					"--reader",
					executable
				];
				yield* runCli([...args, "--save-baseline", baselinePath]).pipe(
					Effect.provide(runtime)
				);
				const report = Schema.decodeUnknownSync(
					Schema.fromJsonString(LocalizationProgressReport)
				)(yield* Ref.get(output));
				expect(
					report.cultures
						.map((culture) => [
							culture.culture,
							culture.total.sourceWords,
							culture.upToDateArchive.sourceWords
						])
						.sort()
				).toEqual([
					["de", 62, 59],
					["en", 62, 62],
					["fr", 62, 54]
				]);
				expect(
					report.cultures.every(
						(culture) =>
							culture.reviewed === "not_tracked" &&
							culture.proofread === "not_tracked"
					)
				).toBe(true);
				expect(
					report.gatherEvidence.some(
						(file) => file.kind === "manifest" && file.provenance
					)
				).toBe(true);
				const baseline = Schema.decodeUnknownSync(
					Schema.fromJsonString(LocalizationBaseline)
				)(yield* fs.readFileString(baselinePath));
				expect(baseline.entries.length).toBeGreaterThan(0);
				yield* Ref.set(output, "");
				yield* runCli([...args, "--baseline", baselinePath]).pipe(Effect.provide(runtime));
				const compared = Schema.decodeUnknownSync(
					Schema.fromJsonString(LocalizationProgressReport)
				)(yield* Ref.get(output));
				expect(
					compared.cultures.every(
						(culture) =>
							culture.baselineDelta?.addedCounts.lines === 0 &&
							culture.baselineDelta.changedCounts.lines === 0 &&
							culture.baselineDelta.removedCounts.lines === 0
					)
				).toBe(true);
				expect(yield* Ref.get(exit)).toBe(0);
				expect(yield* fs.readDirectory(directory)).toEqual(["baseline.json"]);
				const after = yield* Effect.forEach(paths, (path) =>
					fs.readFile(join(fixture.root, "Content/Localization/FixtureGame", path))
				);
				expect(after).toEqual(before);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000
	);
});

// The repository lane deliberately runs without the native reader. The UAsset IO lane
// supplies it and runs both real fixture replays below.
it.skipIf(!process.env.UE_SHED_UASSET_EXECUTABLE).each(["game_text", "texture_audit"])(
	"replays a %s preset through the CLI and native reader",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-cli-investigation-"));
		const project = fixture.root;
		let output = "";
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) =>
					Effect.sync(() => {
						output += value;
					}),
				printError: (value) => Effect.die(value),
				setExitCode: (code) => Effect.die(`Unexpected exit ${code}`)
			})
		);
		try {
			const rules = JSON.parse(
				await readFile(
					join(
						project,
						"FixtureSource",
						kind === "game_text"
							? "Text/quality-rules.json"
							: "Audits/texture-rules.json"
					),
					"utf8"
				)
			);
			const preset = {
				schemaVersion: 1,
				kind,
				sort: kind === "game_text" ? "domain_order" : "object_path",
				query:
					kind === "game_text"
						? {
								mode: "quality",
								query: "",
								capability: "all",
								lens: "all",
								qualityFilter: "character_budget"
							}
						: { findingsOnly: true, query: "" },
				rules
			};
			const presetPath = join(root, "preset.json");
			const outputPath = join(root, "export.csv");
			await writeFile(presetPath, JSON.stringify(preset));
			const args = ["investigations", "run", project, "--preset", presetPath];
			await Effect.runPromise(runCli(args).pipe(Effect.provide(runtime)));
			const exported = JSON.parse(output);
			expect(exported.preset).toEqual(preset);
			expect(exported.source).toEqual({
				projectRoot: project,
				generation: null,
				authority: "project_files"
			});
			const rows =
				kind === "game_text" ? exported.result.report.findings : exported.result.records;
			expect(rows.length).toBeGreaterThan(0);
			output = "";
			await Effect.runPromise(
				runCli([...args, "--format", "csv", "--output", outputPath]).pipe(
					Effect.provide(runtime)
				)
			);
			expect(output).toBe("");
			const csv = await readFile(outputPath, "utf8");
			expect(csv).toContain('"metadata"');
			expect(csv).toContain('"record"');
			await writeFile(presetPath, JSON.stringify({ ...preset, schemaVersion: 99 }));
			await expect(
				Effect.runPromise(runCli(args).pipe(Effect.provide(runtime)))
			).rejects.toMatchObject({ _tag: "CliCommandError" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	60_000
);

describe.skipIf(!process.env.UE_SHED_UASSET_EXECUTABLE)("localization quality presets", () => {
	it("replays the quality list with the target's review file, as Workbench does", async () => {
		let output = "";
		const runtime = Layer.succeed(
			CliRuntime,
			CliRuntime.of({
				print: (value) =>
					Effect.sync(() => {
						output += value;
					}),
				printError: () => Effect.void,
				setExitCode: (code) => Effect.die(`Unexpected exit ${code}`)
			})
		);
		const run = async (args: readonly string[]) => {
			output = "";
			await Effect.runPromise(runCli(args).pipe(Effect.provide(runtime)));
			return output;
		};
		const preset = {
			schemaVersion: 2,
			kind: "game_text",
			sort: "domain_order",
			query: {
				mode: "quality",
				query: "",
				capability: "all",
				lens: "all",
				qualityFilter: "all",
				workspaceFilter: "format_argument_renamed",
				localization: { target: "FixtureGame", culture: "de" }
			},
			// Without rules nothing runs; the Workbench list replays the starter's checks.
			rules: STARTER_CHECK_RULES
		};
		const presetPath = join(fixture.root, "Saved", "localization-quality.json");
		await mkdir(dirname(presetPath), { recursive: true });
		await writeFile(presetPath, JSON.stringify(preset));
		const args = ["investigations", "run", fixture.root, "--preset", presetPath];
		const before = JSON.parse(await run(args));
		expect(before.schemaVersion).toBe(2);
		expect(before.preset.schemaVersion).toBe(2);
		expect(before.result).toMatchObject({
			mode: "localization_quality",
			report: { target: "FixtureGame", culture: "de", filter: "format_argument_renamed" }
		});
		expect(before.result.report.findings.length).toBeGreaterThan(0);
		const csv = await run([...args, "--format", "csv"]);
		expect(csv).toContain('"finding_id","kind","culture","source","problem","context"');
		// An accepted finding leaves the replay exactly as it leaves the Workbench list.
		await run([
			"loc",
			"review",
			"accept",
			fixture.root,
			"--target",
			"FixtureGame",
			"--culture",
			"de",
			"--check",
			"localization.format_argument_renamed",
			"--line",
			"Fixture.Localization.Table,NamedArgument"
		]);
		const after = JSON.parse(await run(args));
		expect(after.result.report.findings.length).toBeLessThan(
			before.result.report.findings.length
		);
	}, 60_000);
});
