import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import { GameTextIndexSource } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import type { PackageTextRefreshInput } from "./package-text-layer.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const projectRoot = fileURLToPath(new URL("../../../fixtures/unreal-project/", import.meta.url));

/**
 * The native writer plans a package refresh from the Project Index Catalog and the reader stages
 * the changed shards from its plan file. Both must give the layers the host's plan of the same
 * inventory gives: the same shard keys, so an existing index stays valid, and the same records.
 */
describe.skipIf(!executable)("package refresh planned by the native writer", () => {
	it("publishes the shard keys and records the host's plan publishes", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-package-plan-"));
		const catalogRoot = join(root, "catalog");
		const layer = Layer.mergeAll(
			gameTextIndexSourceNodeLayer(catalogRoot),
			nativeIndexBuilderLayer({
				executable: executable!,
				timeoutMs: 60_000,
				catalogTimeoutMs: 120_000
			})
		).pipe(Layer.provideMerge(assetReaderLayer({ executable: executable! })));
		const build = (cacheRoot: string, native: boolean, changedFiles?: readonly string[]) =>
			Effect.gen(function* () {
				const source = yield* GameTextIndexSource;
				const builder = yield* GameTextIndexBuilder;
				const catalog = native ? yield* source.catalog!({ projectRoot }) : undefined;
				const inventory = native ? [] : yield* source.inventory({ projectRoot });
				const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
				const input: PackageTextRefreshInput<unknown, never> = {
					...(catalog ? { catalog } : { inventory }),
					...(changedFiles ? { changedFiles } : undefined),
					// Every changed shard is staged by the reader, as a cold build of a large project.
					coldMinimumPackages: 1,
					read: (paths, signatures) =>
						source.read(
							projectRoot,
							paths.map(
								(path) =>
									byPath.get(path) ?? { path, signature: signatures.get(path)! }
							)
						),
					stage: {
						projectRoot,
						read: (paths, directory, groups, snapshots) =>
							source.stage!(
								projectRoot,
								paths.map((path) => byPath.get(path)!),
								{ directory, groups, snapshots }
							)
					}
				};
				const configuration = { cacheRoot, projectKey: projectRoot, targetKey: "plan" };
				const result = yield* builder.withSession(
					{ configuration },
					Effect.scoped(builder.refreshPackageTextLayer(input))
				);
				const layers = yield* Effect.gen(function* () {
					const reader = yield* (yield* SharedIndex).open();
					const layers: Record<string, unknown> = {};
					for (const name of Object.keys(reader.manifest.active).sort())
						if (name.startsWith("package-text."))
							layers[name] = {
								key: reader.manifest.active[name],
								records: yield* decodePackageTextColumns(yield* reader.layer(name))
							};
					return layers;
				}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)));
				return { result, layers };
			});
		try {
			const outcome = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const host = yield* build(join(root, "host"), false);
						const native = yield* build(join(root, "native"), true);
						const changed = (yield* (yield* GameTextIndexSource).inventory({
							projectRoot
						}))
							.slice(0, 2)
							.map((entry) => entry.path);
						return {
							host,
							native,
							retained: yield* build(join(root, "native"), true, changed),
							unchanged: yield* build(join(root, "native"), true)
						};
					})
				).pipe(Effect.provide(layer))
			);
			expect(Object.keys(outcome.native.layers).length).toBeGreaterThan(8);
			expect(outcome.native.layers).toEqual(outcome.host.layers);
			expect(outcome.native.result.readPackages).toBeGreaterThan(0);
			expect(outcome.native.result.readPackages).toBe(outcome.host.result.readPackages);
			// Named files that didn't change keep every shard's key.
			expect(outcome.retained.result.published).toBe(false);
			expect(outcome.retained.layers).toEqual(outcome.host.layers);
			expect(outcome.unchanged.result).toMatchObject({ readPackages: 0, published: false });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 180_000);
});
