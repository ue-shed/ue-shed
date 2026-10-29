import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localizationFileFormat } from "./file-comparison.js";
import { nativeIndexQueryLayer } from "./index-query-native.js";
import { GameTextIndexQuery } from "./index-query-native.js";
import { workspaceFileComparison } from "./workspace-file-comparison.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;

const po = (entries: readonly (readonly [string, string, string])[]) =>
	[
		'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n',
		...entries.map(
			([context, source, translation]) =>
				`#. Key:\t${context}\nmsgctxt "${context}"\nmsgid "${source}"\nmsgstr "${translation}"\n`
		)
	].join("\n");

let directory = "";
let before = "";
let after = "";

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "ue-shed-file-comparison-"));
	before = join(directory, "before.po");
	after = join(directory, "after.po");
	await writeFile(
		before,
		po([
			["Menu,Play", "Play", "Jouer"],
			["Menu,Quit", "Quit", "Quitter"]
		])
	);
	await writeFile(
		after,
		po([
			["Menu,Play", "Play", "Jouer"],
			["Menu,Quit", "Quit", "Quitter le jeu"],
			["Menu,Credits", "Credits", "Générique"]
		])
	);
});

afterAll(() => rm(directory, { recursive: true, force: true }));

it("names a file's format by its extension", () => {
	expect(localizationFileFormat("Game/fr/Game.PO")).toBe("po");
	expect(localizationFileFormat("Game/fr/Game.archive")).toBe("archive");
	expect(localizationFileFormat("Game/Game.manifest")).toBe("manifest");
	expect(localizationFileFormat("Game/Game.csv")).toBeUndefined();
});

describe.skipIf(!executable)("comparing two localization files in the engine", () => {
	const query = () =>
		nativeIndexQueryLayer({
			// SAFETY: the suite is skipped without the reader.
			executable: executable as string,
			timeoutMs: 30_000,
			catalogTimeoutMs: 30_000
		});

	it("pages the changes and keeps the comparison for the next page", async () => {
		const [first, second] = await Effect.runPromise(
			Effect.gen(function* () {
				const index = yield* GameTextIndexQuery;
				if (!index.compareTextFiles) throw new Error("The native query compares files.");
				const request = {
					options: { format: "po" as const },
					before: { file: before, path: "before.po" },
					after: { file: after, path: "after.po" },
					changes: { offset: 0, limit: 1 }
				};
				const first = yield* index.compareTextFiles(request);
				const second = yield* index.compareTextFiles({
					...request,
					changes: { offset: 1, limit: 1 }
				});
				return [first, second] as const;
			}).pipe(Effect.provide(query()))
		);
		expect(first.counts).toEqual({ added: 1, removed: 0, rekeyed: 0, edited: 1, unchanged: 1 });
		expect(first.changes.map((change) => change.after?.key)).toEqual(["Quit"]);
		expect(second.kept).toBe(true);
		expect(second.changes.map((change) => [change.kind, change.after?.key])).toEqual([
			["added", "Credits"]
		]);
	});

	it("compares only files the person chose, and asks for them when none are named", async () => {
		const chosen = [before, after];
		const results = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const index = yield* GameTextIndexQuery;
					if (!index.compareTextFiles)
						throw new Error("The native query compares files.");
					const compare = workspaceFileComparison(
						{
							files: {
								chooseFile: () =>
									Effect.sync(() => {
										const path = chosen.shift();
										return path === undefined
											? { status: "cancelled" as const }
											: { status: "selected" as const, path };
									}),
								chooseSaveFile: () =>
									Effect.succeed({ status: "cancelled" as const }),
								readFile: () => Effect.die("This test reads no file."),
								readFileWithin: () => Effect.die("This test reads no file."),
								writeFile: () => Effect.die("This test writes no file.")
							}
						},
						index.compareTextFiles
					);
					const page = { offset: 0, limit: 10 };
					const asked = yield* compare({ changes: page });
					const later = yield* compare({ files: { before, after }, changes: page });
					const other = yield* compare({
						files: { before, after: join(directory, "other.po") },
						changes: page
					});
					const cancelled = yield* compare({ changes: page });
					return { asked, later, other, cancelled };
				})
			).pipe(Effect.provide(query()))
		);
		expect(results.asked.status).toBe("ready");
		expect(results.later.status === "ready" && results.later.total).toBe(2);
		expect(results.other).toMatchObject({ status: "failed", code: "file_not_chosen" });
		expect(results.cancelled).toEqual({ status: "cancelled" });
	});
});
