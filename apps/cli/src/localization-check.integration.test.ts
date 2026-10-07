import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { describe, expect } from "vitest";
import { LocalizationChangeSet } from "@ue-shed/localization/browser";
import { LocalizationQualityReport } from "@ue-shed/game-text/browser";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();

describe.skipIf(!executable)("localization check CLI with the real reader", () => {
	it.effect("filters culture and repeated check ids and creates only the proposal", () =>
		Effect.gen(function* () {
			if (executable === undefined) throw new Error("The saved reader is not configured.");
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const changesPath = join(directory, "suggestions.json");
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
				"format_arguments",
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
						["format_arguments", "rich_text"].includes(finding.kind)
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
