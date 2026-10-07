import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import { LocalizationBaseline, LocalizationProgressReport } from "@ue-shed/game-text/browser";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
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
			}).pipe(Effect.provide(NodeServices.layer))
	);
});
