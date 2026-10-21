import { it } from "@effect/vitest";
import { LocalizationGateResult } from "@ue-shed/game-text/checks";
import { ConfigProvider, Effect, Layer, Ref, Schema } from "effect";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect } from "vitest";
import { useSavedFixtureProject } from "../../../fixtures/unreal-project/saved-project.test-support.js";
import { CliRuntime } from "./cli-runtime.js";
import { runCli } from "./command.js";
import { cliGameTextIndexLayer } from "./workflows/game-text-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = useSavedFixtureProject();
const TABLE = "Content/Fixture/Localization/DT_Localization.uasset";

/** Gives one gathered key an earlier name in Unreal's files, as if the saved cell's key changed. */
async function renameGatheredKey(root: string) {
	const folder = join(root, "Content", "Localization", "FixtureGame");
	const changed: string[] = [];
	for (const name of await readdir(folder, { recursive: true })) {
		const path = join(folder, name);
		if (name.endsWith(".manifest") || name.endsWith(".archive")) {
			const text = (await readFile(path)).toString("utf16le");
			const renamed = text.replaceAll('"Key": "MissingFrench"', '"Key": "MissingFrenchOld"');
			if (renamed === text) throw new Error(`No key to rename in ${name}`);
			await writeFile(path, Buffer.from(renamed, "utf16le"));
			changed.push(relative(root, path).replaceAll("\\", "/"));
		} else if (name.endsWith(".po")) {
			const text = await readFile(path, "utf8");
			await writeFile(
				path,
				text
					.replaceAll('Rows,MissingFrench"', 'Rows,MissingFrenchOld"')
					.replaceAll("Key:\tMissingFrench\n", "Key:\tMissingFrenchOld\n")
			);
			changed.push(relative(root, path).replaceAll("\\", "/"));
		}
	}
	return changed;
}

describe.skipIf(!executable)("loc gate with the real reader", () => {
	it.effect(
		"fails a change whose key change would lose translations",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					if (executable === undefined)
						throw new Error("The saved reader is not configured.");
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
					const folder = yield* Effect.promise(() =>
						mkdtemp(join(tmpdir(), "ue-shed-gate-"))
					);
					yield* Effect.addFinalizer(() =>
						Effect.promise(() => rm(folder, { recursive: true, force: true }))
					);
					const indexContext = yield* Layer.build(
						cliGameTextIndexLayer(executable).pipe(
							Layer.provide(
								ConfigProvider.layer(
									ConfigProvider.fromUnknown({
										UE_SHED_PROJECT_INDEX_CACHE_ROOT: join(folder, "cache")
									})
								)
							)
						)
					);
					const list = (name: string, ...files: string[]) =>
						Effect.promise(async () => {
							const path = join(folder, name);
							await writeFile(path, files.join("\n"));
							return path;
						});
					const gate = (...extra: string[]) =>
						Effect.gen(function* () {
							yield* Ref.set(output, "");
							yield* Ref.set(exitCode, 0);
							yield* runCli([
								"loc",
								"gate",
								fixture.root,
								"--reader",
								executable,
								...extra
							]).pipe(Effect.provide(runtime), Effect.provide(indexContext));
							return { text: yield* Ref.get(output), exit: yield* Ref.get(exitCode) };
						});
					const verdict = (text: string) =>
						Schema.decodeUnknownEffect(Schema.fromJsonString(LocalizationGateResult))(
							text
						);
					let table = yield* list("table.txt", "# changed in this change", TABLE);

					const before = yield* gate("--files", table);
					expect(before.text).not.toContain("not_checked");
					const unchanged = yield* verdict(before.text);
					// Check authoring, problem cases, action assets and the gather-only C++ target.
					expect(unchanged.targets.map((target) => target.target)).toEqual([
						"FixtureGame",
						"Game",
						"GameTextActions",
						"GameTextActionsSource"
					]);
					expect(unchanged.skipped).toEqual([]);
					expect(unchanged.targets[0]?.checks.key_changed).toBe(0);
					expect(unchanged.targets[0]?.lines).toBeGreaterThan(0);

					const localizationFiles = yield* Effect.promise(() =>
						renameGatheredKey(fixture.root)
					);
					// Unlisted inputs retain prior evidence; explicitly refresh the files this fixture edits.
					const omitted = yield* verdict(
						(yield* gate("--files", table, "--target", "FixtureGame")).text
					);
					expect(omitted.status).toBe("passed");
					table = yield* list("table-and-localization.txt", TABLE, ...localizationFiles);
					const after = yield* gate("--files", table, "--target", "FixtureGame");
					const changed = yield* verdict(after.text);
					expect(changed.status).toBe("failed");
					expect(after.exit).toBe(1);
					const item = changed.targets[0]?.items.find(
						(entry) => entry.check === "key_changed"
					);
					expect(item).toMatchObject({
						severity: "fail",
						key: "MissingFrench",
						file: "Content/Fixture/Localization/DT_Localization"
					});
					expect(item?.guidance).toContain("MissingFrenchOld");

					// A person reading a pre-submit dialog gets the same verdict as lines.
					const summary = yield* gate(
						"--files",
						table,
						"--target",
						"FixtureGame",
						"--summary"
					);
					expect(summary.text).toContain("FAIL  Key changed: ");
					expect(summary.text).toContain("Text check failed.");
					expect(summary.exit).toBe(1);

					// A project can make a check only warn.
					const relaxed = yield* verdict(
						(yield* gate(
							"--files",
							table,
							"--target",
							"FixtureGame",
							"--warn-on",
							"key_changed"
						)).text
					);
					expect(
						relaxed.targets[0]?.items.find((entry) => entry.key === "MissingFrench")
							?.severity
					).toBe("warn");

					// Files without text pass.
					const other = yield* gate(
						"--files",
						yield* list("other.txt", "Config/Unused.txt"),
						"--target",
						"FixtureGame"
					);
					expect((yield* verdict(other.text)).status).toBe("passed");
					expect(other.exit).toBe(0);

					// Without its files the Game target is not gathered; every later run skips it.
					yield* Effect.promise(() =>
						rm(join(fixture.root, "Content", "Localization", "Game"), {
							recursive: true
						})
					);
					const ungathered = yield* gate(
						"--files",
						yield* list(
							"ungathered.txt",
							TABLE,
							"Content/Localization/Game/Game.manifest",
							...["en", "de", "fr", "ja"].map(
								(culture) => `Content/Localization/Game/${culture}/Game.archive`
							)
						),
						"--target",
						"Game"
					);
					expect(ungathered.exit).toBe(2);
					expect(ungathered.text).toContain("missing_manifest");
					const unknown = yield* gate("--files", table, "--target", "NoSuchTarget");
					expect(unknown.exit).toBe(2);
					expect(unknown.text).toContain("target_not_found");

					// Damaged files make translations unknown: the check stops rather than passing.
					const localization = join(
						fixture.root,
						"Content",
						"Localization",
						"FixtureGame"
					);
					yield* Effect.promise(() =>
						writeFile(join(localization, "de", "FixtureGame.archive"), "not an archive")
					);
					const damagedArchive = yield* gate(
						"--files",
						table,
						"--target",
						"FixtureGame",
						"--warn-on",
						"key_changed"
					);
					expect(damagedArchive.exit).toBe(2);
					expect(damagedArchive.text).toContain("unreadable_evidence");
					expect(damagedArchive.text).toContain("de/FixtureGame.archive");
					expect(damagedArchive.text).toContain("malformed_json");
					expect(damagedArchive.text).toContain(
						"Check the target configuration and regenerate its evidence through Unreal if needed."
					);
					// A damaged manifest is not a target Unreal never gathered.
					yield* Effect.promise(() =>
						writeFile(join(localization, "FixtureGame.manifest"), "not a manifest")
					);
					const damagedManifest = yield* gate(
						"--files",
						table,
						"--target",
						"FixtureGame"
					);
					expect(damagedManifest.exit).toBe(2);
					expect(damagedManifest.text).toContain("unreadable_manifest");
					expect(damagedManifest.text).toContain("malformed_json");
					expect(damagedManifest.text).toContain(
						"Check the target configuration and regenerate its evidence through Unreal if needed."
					);
				})
			),
		// Keep changing-file recovery and host policy behavior on the real native index.
		60000
	);
});
