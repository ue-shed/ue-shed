import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { defaultLocalizationImportLimits } from "./localization-stream.js";
import { SharedIndex } from "./shared-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
describe.skipIf(!executable)("native localization import", () => {
	it("publishes the files that import, reports the rest, and reuses previous content", async () => {
		if (!executable) throw new Error("The native reader is required.");
		const root = await mkdtemp(join(tmpdir(), "ue-shed-native-localization-"));
		try {
			const projectRoot = join(root, "project");
			const cacheRoot = join(root, "cache");
			await mkdir(projectRoot);
			const source = 'msgctxt "N,K"\nmsgid "source"\nmsgstr "translation"\n';
			await writeFile(join(projectRoot, "valid.po"), source);
			await writeFile(join(projectRoot, "bad.po"), 'msgid "unterminated');
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const builder = yield* GameTextIndexBuilder;
						yield* builder.withSession(
							{
								configuration: {
									cacheRoot,
									projectKey: projectRoot,
									targetKey: "localization"
								}
							},
							Effect.gen(function* () {
								const writer = yield* (yield* SharedIndex).writer();
								if (!writer.importLocalization)
									throw new Error("The native import is required.");
								const files = ["valid.po", "bad.po"].map((relativePath) => ({
									projectRoot,
									file: join(projectRoot, relativePath),
									relativePath,
									options: { format: "po" as const, poFormat: "Unreal" },
									limits: defaultLocalizationImportLimits
								}));
								const progress: number[] = [];
								const failed = yield* writer.importLocalization(
									{ files, maximumInFlightBytes: 1 },
									(completed, total) => {
										expect(total).toBe(2);
										progress.push(completed);
									}
								);
								expect(progress).toEqual([1, 2]);
								expect(failed.workerCount).toBe(1);
								expect(failed.files[1]).toMatchObject({
									outcome: "failed",
									error: {
										code: "malformed_po",
										message:
											"bad.po at line 1: localization import failed (malformed_po)."
									}
								});
								const valid = failed.files[0];
								if (valid?.outcome !== "imported")
									throw new Error("valid.po did not import.");
								expect(writer.manifest().active).toEqual({
									"valid.po": valid.file.key
								});
								yield* Effect.promise(() =>
									writeFile(join(projectRoot, "bad.po"), source)
								);
								const published = yield* writer.importLocalization({
									files,
									maximumInFlightBytes: 1
								});
								// bad.po now holds valid.po's content, so both reuse its layer.
								expect(
									published.files.map((entry) =>
										entry.outcome === "imported" ? entry.file.parsed : null
									)
								).toEqual([false, false]);
								const key = valid.file.key;
								expect(writer.manifest().active).toEqual({
									"valid.po": key,
									"bad.po": key
								});
								yield* Effect.promise(() =>
									writeFile(
										join(projectRoot, "valid.po"),
										source.replace("translation", "changed")
									)
								);
								yield* writer.importLocalization({
									files: files.slice(0, 1),
									maximumInFlightBytes: 1
								});
								yield* Effect.promise(() =>
									writeFile(join(projectRoot, "valid.po"), source)
								);
								const reused = yield* writer.importLocalization({
									files: files.slice(0, 1),
									maximumInFlightBytes: 1
								});
								expect(reused.files[0]).toMatchObject({
									outcome: "imported",
									file: { key, parsed: false }
								});
								expect(writer.manifest().active["valid.po"]).toBe(key);
							})
						);
					})
				).pipe(
					Effect.provide(
						nativeIndexBuilderLayer({
							executable,
							timeoutMs: 30_000,
							catalogTimeoutMs: 120_000
						})
					)
				)
			);
			expect(await readdir(cacheRoot)).not.toContain("localization-import-staging");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
