import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, normalize } from "node:path";
import { Effect, Stream, type Scope } from "effect";
import { describe, expect, it } from "vitest";
import {
	assetReaderLayer,
	scanSavedProject,
	type SavedAssetPackageTextEvent
} from "../packages/unreal-assets/dist/index.js";
import { SharedIndex, sharedIndexNodeLayer } from "../packages/game-text/src/shared-index.ts";
import {
	refreshPackageTextLayer,
	textCorpusFromPackageTextLayer,
	type PackageTextInventoryEntry,
	packageTextSelection,
	packageTextShard
} from "../packages/game-text/src/package-text-layer.ts";
import { importColdPackageTextLayer } from "../packages/game-text/src/package-text-cold.ts";
import {
	packageTextRecordsFromEvents,
	emptyPackageTextRecord
} from "../packages/game-text/src/package-text-record.ts";
import { comparePackageTextLayerWithEvents } from "./package-text-layer-oracle.test-support.ts";
import { gameTextScaleRecipe, gameTextScaleEvents } from "./localization-scale-data.ts";
import {
	committedPackagePaths,
	packageTextFixtureProjects,
	measureNativeText
} from "./package-text-reader.test-support.ts";
import { ensureUassetExecutable } from "./native-tools.ts";
import { packageTextColumns } from "../packages/game-text/src/package-text-columns.ts";
import {
	convertGeneratedPackageText,
	readGeneratedPackageInventory
} from "./package-text-generated.ts";

const executable = ensureUassetExecutable();
const header = (selected: boolean) => ({
	packageFlags: selected ? 0x00040000 : 0,
	gatherableTextDataCount: 0,
	gatherableTextDataOffset: 0,
	hasTextProperty: false
});
async function withStore(run: (root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "ue-shed-package-layer-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
const runIn = <A, E>(root: string, effect: Effect.Effect<A, E, SharedIndex | Scope.Scope>) =>
	Effect.runPromise(
		Effect.scoped(effect).pipe(
			Effect.provide(
				sharedIndexNodeLayer({
					cacheRoot: root,
					projectKey: "fixture",
					targetKey: "layer"
				})
			)
		)
	);

describe("package text layer", () => {
	it("an empty fixture has a persistent layer and a no-change refresh publishes nothing", async () => {
		await withStore(async (cache) => {
			const read = () => Stream.die(new Error("Empty inventory must not be read"));
			await runIn(cache, refreshPackageTextLayer({ inventory: [], read }));
			expect(
				await runIn(cache, refreshPackageTextLayer({ inventory: [], read }))
			).toMatchObject({
				published: false,
				readPackages: 0
			});
			expect((await runIn(cache, textCorpusFromPackageTextLayer("."))).units).toEqual([]);
		});
	});
	it("converts retained generated events, flags text packages and preserves the mapped layer oracle", async () => {
		await withStore(async (cache) => {
			const recipe = gameTextScaleRecipe(0.0001),
				events = [...gameTextScaleEvents(recipe, 57)];
			const project = join(cache, "input");
			await mkdir(project);
			await writeFile(
				join(project, "saved-text.ndjson"),
				events.map((event) => JSON.stringify(event)).join("\n") + "\n"
			);
			const directory = join(cache, "converted");
			expect(
				await convertGeneratedPackageText(project, directory, recipe.textPackages)
			).toMatchObject({
				packages: recipe.packages,
				occurrences: recipe.occurrences,
				gaps: recipe.gaps,
				selectedPackages: recipe.textPackages
			});
			const inventory = await readGeneratedPackageInventory(directory);
			await runIn(
				cache,
				importColdPackageTextLayer({
					inventory,
					recordDirectory: directory,
					stagingRoot: join(cache, "staging")
				})
			);
			expect(
				await runIn(
					cache,
					comparePackageTextLayerWithEvents({ projectRoot: project, inventory, events })
				)
			).toMatchObject({ equal: true, differenceCount: 0 });
		});
	});
	it("a cold package publication into an existing store reuses shared strings and preserves active layers", async () => {
		await withStore(async (cache) => {
			await runIn(
				cache,
				Effect.gen(function* () {
					const writer = yield* (yield* SharedIndex).writer();
					yield* writer.publishCold([
						{
							name: "old",
							key: "old-key",
							source: packageTextColumns([
								{ path: "A", signature: "1", evidence: emptyPackageTextRecord("A") }
							])
						}
					]);
					const count = writer
						.manifest()
						.segments.reduce((sum, segment) => sum + segment.count, 0);
					yield* writer.publishCold([
						{
							name: "new",
							key: "new-key",
							source: packageTextColumns([
								{ path: "B", signature: "1", evidence: emptyPackageTextRecord("B") }
							])
						}
					]);
					expect(writer.manifest().active).toEqual({ old: "old-key", new: "new-key" });
					expect(
						writer.manifest().segments.reduce((sum, segment) => sum + segment.count, 0)
					).toBe(count + 1);
				})
			);
		});
	});
	it.each(packageTextFixtureProjects)(
		"layer oracle on every committed root: %s",
		async (project) => {
			await withStore(async (cache) => {
				const projectRoot = resolve(project),
					paths = committedPackagePaths(project);
				const scan = await Effect.runPromise(
					scanSavedProject({
						projectRoot,
						paths,
						depth: "header",
						headerData: true,
						inventory: true
					}).pipe(Effect.provide(assetReaderLayer({ executable })))
				);
				expect(scan.failures).toEqual([]);
				const inventory: PackageTextInventoryEntry[] = scan.assets
					.map((asset) => {
						if (asset.depth !== "header") throw new Error("Expected header");
						const signature = scan.inventory?.find(
							(entry) => entry.path === asset.header.path
						);
						if (!signature) throw new Error("Missing signature inventory");
						if (!asset.header.package.header_data)
							throw new Error("Missing header data");
						return {
							path: asset.header.path,
							signature: JSON.stringify([signature.size, signature.modifiedMs]),
							headerData: asset.header.package.header_data
						};
					})
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
				const old = measureNativeText(executable, project, false, paths);
				await runIn(
					cache,
					refreshPackageTextLayer({
						inventory,
						read: (selected) =>
							Stream.fromIterable(
								measureNativeText(
									executable,
									project,
									true,
									selected
								).events.filter(
									(event): event is SavedAssetPackageTextEvent =>
										event.event !== "text_occurrence" &&
										event.event !== "text_coverage_gap" &&
										event.event !== "text_package"
								)
							)
					})
				);
				const oracle = await runIn(
					cache,
					comparePackageTextLayerWithEvents({
						projectRoot,
						inventory,
						events: old.events.filter(
							(
								event
							): event is Extract<
								(typeof old.events)[number],
								{
									event:
										| "text_occurrence"
										| "text_coverage_gap"
										| "text_package"
										| "text_summary"
										| "error";
								}
							> => event.event !== "text_package_record"
						)
					})
				);
				expect(oracle, JSON.stringify(oracle)).toMatchObject({
					equal: true,
					differenceCount: 0
				});
			});
		}
	);
	it.each([0.0001, 0.001, 0.002])(
		"parallel cold layer equals the generated event oracle at %s",
		async (scale) => {
			await withStore(async (cache) => {
				const recipe = gameTextScaleRecipe(scale),
					events = [...gameTextScaleEvents(recipe, 57)];
				const records = [...packageTextRecordsFromEvents(events)].filter(
					(event) => event.event === "text_package_record"
				);
				const inventory = records
					.map((record) => ({
						path: record.path,
						signature: "1",
						headerData: header(
							Number(record.path.match(/Package(\d+)/u)?.[1]) < recipe.textPackages
						)
					}))
					.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
				const selected = new Set(
					packageTextSelection(inventory).flatMap((shard) =>
						shard.entries
							.filter((entry) => entry.selected)
							.map((entry) => entry.entry.path)
					)
				);
				const directory = join(cache, "records");
				await mkdir(directory);
				const buckets = new Map<number, string[]>();
				for (const record of records) {
					const shard = packageTextShard(record.path),
						lines = buckets.get(shard) ?? [];
					lines.push(
						JSON.stringify({
							path: record.path,
							signature: "1",
							evidence: selected.has(record.path)
								? record
								: { event: "not_gatherable", path: record.path }
						})
					);
					buckets.set(shard, lines);
				}
				for (const [shard, lines] of buckets)
					await writeFile(
						join(directory, `package-text.${shard}.ndjson`),
						lines.join("\n") + "\n"
					);
				const cold = await runIn(
					cache,
					importColdPackageTextLayer({
						inventory,
						recordDirectory: directory,
						stagingRoot: join(cache, "staging")
					})
				);
				expect(cold.profile.probePasses).toBe(0);
				expect(cold.workerCount).toBeGreaterThan(1);
				expect(
					await runIn(
						cache,
						comparePackageTextLayerWithEvents({ projectRoot: ".", inventory, events })
					)
				).toMatchObject({ equal: true, differenceCount: 0 });
			});
		}
	);
	it("refresh reads changed/new/renamed/flag-gained packages, drops removed/flag-lost ones, and reuses the rest", async () => {
		await withStore(async (cache) => {
			const calls: string[] = [];
			const entry = (
				path: string,
				signature = "1",
				selected = true
			): PackageTextInventoryEntry => ({ path, signature, headerData: header(selected) });
			let version = "initial";
			const read = (paths: readonly string[]) => {
				calls.push(...paths);
				return Stream.fromIterable(
					paths.map((path) => ({
						...emptyPackageTextRecord(path),
						occurrences: [
							{
								source: `${path}:${version}`,
								dev_notes: "notes\u2028kept",
								identity: {
									status: "resolved" as const,
									namespace: "Fixture",
									key: path
								},
								location: {
									kind: "asset_property" as const,
									object_path: path,
									class_path: "Fixture",
									property_path: "Label"
								},
								edit_capability: "read_only" as const
							}
						]
					}))
				);
			};
			const initial = ["A", "B", "C", "D", "E", "F", "G"].map((path) =>
				entry(path, "1", path !== "G")
			);
			await runIn(cache, refreshPackageTextLayer({ inventory: initial, read }));
			calls.length = 0;
			const before = await runIn(
				cache,
				Effect.gen(function* () {
					return yield* (yield* SharedIndex).inspect();
				})
			);
			expect(
				await runIn(cache, refreshPackageTextLayer({ inventory: initial, read }))
			).toMatchObject({ published: false, readPackages: 0 });
			expect(calls).toEqual([]);
			const after = await runIn(
				cache,
				Effect.gen(function* () {
					return yield* (yield* SharedIndex).inspect();
				})
			);
			expect(after).toEqual(before);
			const next = [
				entry("A", "2"),
				entry("B"),
				entry("D-renamed"),
				entry("E", "2", false),
				entry("F"),
				entry("G", "2"),
				entry("H")
			];
			version = "changed";
			expect(
				await runIn(cache, refreshPackageTextLayer({ inventory: next, read }))
			).toMatchObject({ readPackages: 4 });
			expect(calls.sort()).toEqual(["A", "D-renamed", "G", "H"]);
			const corpus = await runIn(cache, textCorpusFromPackageTextLayer("."));
			expect(corpus.packageCoverage?.map((item) => item.packageFile).sort()).toEqual(
				next.map((entry) => entry.path)
			);
			expect(corpus.packageCoverage?.find((item) => item.packageFile === "E")?.status).toBe(
				"not_gatherable"
			);
			expect(corpus.units.map((unit) => unit.source)).toEqual([
				{ status: "consistent", value: "A:changed" },
				{ status: "consistent", value: "B:initial" },
				{ status: "consistent", value: "D-renamed:changed" },
				{ status: "consistent", value: "F:initial" },
				{ status: "consistent", value: "G:changed" },
				{ status: "consistent", value: "H:changed" }
			]);
		});
	});
	it("omitted or duplicate reader output leaves the published generation unchanged", async () => {
		await withStore(async (cache) => {
			const inventory = [{ path: "A", signature: "1", headerData: header(true) }];
			await runIn(
				cache,
				refreshPackageTextLayer({
					inventory,
					read: (paths) => Stream.fromIterable(paths.map(emptyPackageTextRecord))
				})
			);
			const prior = await runIn(
				cache,
				Effect.gen(function* () {
					return yield* (yield* SharedIndex).inspect();
				})
			);
			await expect(
				runIn(
					cache,
					refreshPackageTextLayer({
						inventory: [{ ...inventory[0]!, signature: "2" }],
						read: () => Stream.empty
					})
				)
			).rejects.toBeDefined();
			expect(
				await runIn(
					cache,
					Effect.gen(function* () {
						return yield* (yield* SharedIndex).inspect();
					})
				)
			).toEqual(prior);
		});
	});
	it("external package addition/removal changes selection without changing the outer package signature", async () => {
		await withStore(async (cache) => {
			const outer = {
				path: "Content/Maps/World.umap",
				signature: "1",
				headerData: header(false)
			};
			const actor = {
				path: "Content/__ExternalActors__/Maps/World/A/B/Actor.uasset",
				signature: "1",
				headerData: header(false)
			};
			const calls: string[] = [];
			const read = (paths: readonly string[]) => {
				calls.push(...paths);
				return Stream.fromIterable(paths.map(emptyPackageTextRecord));
			};
			await runIn(cache, refreshPackageTextLayer({ inventory: [outer], read }));
			expect(calls).toEqual([]);
			await runIn(cache, refreshPackageTextLayer({ inventory: [outer, actor], read }));
			expect(calls.sort()).toEqual([outer.path, actor.path].sort());
			calls.length = 0;
			await runIn(cache, refreshPackageTextLayer({ inventory: [outer], read }));
			expect(calls).toEqual([]);
			expect(
				(await runIn(cache, textCorpusFromPackageTextLayer("."))).packageCoverage
			).toEqual([{ packageFile: normalize(outer.path), status: "not_gatherable" }]);
		});
	});
});
