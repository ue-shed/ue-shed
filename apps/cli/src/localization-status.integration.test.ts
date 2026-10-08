import { it } from "@effect/vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import { LocalizationStatusReport } from "@ue-shed/game-text/browser";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

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
			expect(header).toMatch(/^"Namespace","Key","Source","Where","Kind","en","en state"/u);
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
});
