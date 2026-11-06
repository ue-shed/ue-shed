import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assetReaderLayer } from "@ue-shed/unreal-assets";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { GameTextIndexBuilder } from "./index-builder.js";
import type { GameTextIndexError } from "./index-error.js";
import { GameTextIndexSource } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer } from "./index-source-node.js";
import { nativeIndexBuilderLayer } from "./native-index-builder.js";
import { decodePackageTextColumns } from "./package-text-columns.js";
import type { PackageTextRefreshInput } from "./package-text-layer.js";
import { mountPackageTextEvent } from "./package-object-path.js";
import { SharedIndex, sharedIndexNodeLayer } from "./shared-index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixture = fileURLToPath(new URL("../../../fixtures/unreal-project/", import.meta.url));

/**
 * An in-place refresh of real packages: with staging the reader reads and converts the changed
 * packages itself and the host reads none; without it, the host spools what it reads. Both give
 * the layers a fresh build of the changed project gives.
 */
describe.skipIf(!executable)("in-place package refresh of real packages", () => {
	it("stages the changed packages in the reader, as a fresh build of the project", async () => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-package-staged-"));
		const projectRoot = join(root, "project");
		await cp(fixture, projectRoot, { recursive: true });
		const layer = Layer.mergeAll(
			gameTextIndexSourceNodeLayer(join(root, "catalog")),
			nativeIndexBuilderLayer({
				executable: executable!,
				timeoutMs: 60_000,
				catalogTimeoutMs: 120_000
			})
		).pipe(Layer.provideMerge(assetReaderLayer({ executable: executable! })));
		const build = (cacheRoot: string, staged: boolean) =>
			Effect.gen(function* () {
				const source = yield* GameTextIndexSource;
				const builder = yield* GameTextIndexBuilder;
				const inventory = yield* source.inventory({ projectRoot });
				const byPath = new Map(inventory.map((entry) => [entry.path, entry]));
				let hostReads = 0;
				const input: PackageTextRefreshInput<GameTextIndexError, never> = {
					inventory,
					coldMinimumPackages: 1,
					read: (paths) =>
						source
							.read(
								projectRoot,
								paths.map((path) => byPath.get(path)!)
							)
							.pipe(
								Stream.map((event) => mountPackageTextEvent(projectRoot, event)),
								Stream.tap(() => Effect.sync(() => hostReads++))
							),
					...(staged
						? {
								stage: {
									projectRoot,
									read: (paths, directory, groups, snapshots) =>
										source.stage!(
											projectRoot,
											paths.map((path) => byPath.get(path)!),
											{ directory, groups, snapshots }
										)
								}
							}
						: undefined)
				};
				const configuration = { cacheRoot, projectKey: projectRoot, targetKey: "staged" };
				const result = yield* builder.withSession(
					{ configuration },
					Effect.scoped(builder.refreshPackageTextLayer(input))
				);
				const layers = yield* Effect.gen(function* () {
					const reader = yield* (yield* SharedIndex).open;
					const layers: Record<
						string,
						{
							readonly key: string | undefined;
							readonly records: Effect.Success<
								ReturnType<typeof decodePackageTextColumns>
							>;
						}
					> = {};
					for (const name of Object.keys(reader.manifest.active).sort())
						if (name.startsWith("package-text."))
							layers[name] = {
								key: reader.manifest.active[name],
								records: yield* decodePackageTextColumns(yield* reader.layer(name))
							};
					return layers;
				}).pipe(Effect.provide(sharedIndexNodeLayer(configuration)));
				return { result, layers, hostReads };
			});
		try {
			const outcome = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const before = yield* build(join(root, "staged"), true);
						yield* build(join(root, "spooled"), false);
						const texts = Object.values(before.layers)
							.flatMap((layer) => layer.records)
							.filter(
								(record) =>
									record.evidence.event === "text_package_record" &&
									record.evidence.occurrences.length
							)
							.map((record) => record.path);
						// Copies of a text package land in new shards; one text package is edited.
						yield* Effect.promise(async () => {
							const copies = join(projectRoot, "Content", "Copies");
							await mkdir(copies);
							for (let copy = 0; copy < 24; copy++)
								await copyFile(
									join(projectRoot, texts[0]!),
									join(copies, `Copy${copy}.uasset`)
								);
							await copyFile(
								join(projectRoot, texts[2]!),
								join(projectRoot, texts[1]!)
							);
						});
						return {
							texts: texts.length,
							staged: yield* build(join(root, "staged"), true),
							spooled: yield* build(join(root, "spooled"), false),
							fresh: yield* build(join(root, "fresh"), true)
						};
					})
				).pipe(Effect.provide(layer))
			);
			const { staged, spooled, fresh } = outcome;
			expect(outcome.texts).toBeGreaterThan(2);
			expect(Object.keys(fresh.layers).length).toBeGreaterThan(8);
			expect(staged.layers).toEqual(fresh.layers);
			expect(spooled.layers).toEqual(fresh.layers);
			// Only the 24 copies and the edited package are read, in place.
			for (const refresh of [staged, spooled]) {
				expect(refresh.result.readPackages).toBe(25);
				expect(refresh.result.reusedPackages).toBeGreaterThan(0);
				expect(refresh.result.changedShards).toBeGreaterThan(8);
			}
			expect(staged.hostReads).toBe(0);
			expect(spooled.hostReads).toBeGreaterThanOrEqual(25);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 300_000);
});
