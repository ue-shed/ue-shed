import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { acquireHistoricalProjectTree } from "./historical-project-tree.js";

function temporarySource(contents: string) {
	return Effect.acquireRelease(
		Effect.promise(async () => {
			const root = await mkdtemp(resolve(tmpdir(), "ue-shed-map-history-source-"));
			const path = resolve(root, "package.bin");
			await writeFile(path, contents);
			return { path, root };
		}),
		(source) => Effect.promise(() => rm(source.root, { force: true, recursive: true }))
	);
}

describe("HistoricalProjectTree", () => {
	it.effect("folds add, edit, and delete revisions into one owned tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const tree = yield* acquireHistoricalProjectTree();
				const baseline = yield* temporarySource("baseline");
				const edited = yield* temporarySource("edited");
				const relativePath = "Content/Maps/L_History.umap";
				const target = resolve(tree.projectRoot, relativePath);

				yield* tree.applyRevision([
					{
						action: "add",
						materializedPath: baseline.path,
						projectRelativePath: relativePath
					}
				]);
				expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("baseline");

				yield* tree.applyRevision([
					{
						action: "edit",
						materializedPath: edited.path,
						projectRelativePath: relativePath
					}
				]);
				expect(yield* Effect.promise(() => readFile(target, "utf8"))).toBe("edited");

				yield* tree.applyRevision([
					{ action: "delete", projectRelativePath: relativePath }
				]);
				expect(existsSync(target)).toBe(false);
			})
		)
	);

	it.effect("rejects path traversal before changing the tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const tree = yield* acquireHistoricalProjectTree();
				const source = yield* temporarySource("outside");
				const error = yield* tree
					.applyRevision([
						{
							action: "add",
							materializedPath: source.path,
							projectRelativePath: "../outside.uasset"
						}
					])
					.pipe(Effect.flip);

				expect(error.kind).toBe("invalid_target");
				expect(existsSync(resolve(tree.projectRoot, "..", "outside.uasset"))).toBe(false);
			})
		)
	);

	it.effect("validates an entire revision before applying any file", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const tree = yield* acquireHistoricalProjectTree();
				const source = yield* temporarySource("valid");
				const target = resolve(tree.projectRoot, "Content/Maps/L_History.umap");

				yield* tree
					.applyRevision([
						{
							action: "add",
							materializedPath: source.path,
							projectRelativePath: "Content/Maps/L_History.umap"
						},
						{
							action: "add",
							materializedPath: source.path,
							projectRelativePath: "../outside.uasset"
						}
					])
					.pipe(Effect.flip);

				expect(existsSync(target)).toBe(false);
			})
		)
	);

	it.effect("removes the owned project after scope completion", () =>
		Effect.gen(function* () {
			const observedRoot = yield* Ref.make("");
			yield* Effect.scoped(
				Effect.gen(function* () {
					const tree = yield* acquireHistoricalProjectTree();
					yield* Ref.set(observedRoot, tree.projectRoot);
					expect(existsSync(tree.projectRoot)).toBe(true);
				})
			);

			expect(existsSync(yield* Ref.get(observedRoot))).toBe(false);
		})
	);
});
