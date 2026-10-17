import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import {
	makeAssetReaderTestLayer,
	makeProjectIndexTestLayer,
	MAX_PROTOCOL_PATH_BYTES,
	ProjectIdentity,
	ProjectIndexGeneration,
	ProjectIndexRefreshEvent,
	ProjectIndexUnavailable,
	assetReaderLayer,
	type ProjectIndexSummary
} from "@ue-shed/unreal-assets";
import { GameTextIndexSource } from "./index-refresh.js";
import { gameTextIndexSourceNodeLayer, packageTextReadBatches } from "./index-source-node.js";
import { emptyPackageTextRecord } from "./package-text-record.js";

it("preserves the Project Index failure and its recovery decision", async () => {
	const cause = new ProjectIndexUnavailable({
		message: "The configured catalogue cannot be opened.",
		recovery: "Choose a writable catalogue location.",
		retrySafe: false,
		nextStep: "fix_input"
	});
	const catalog = makeProjectIndexTestLayer({
		rebuild: () => Stream.fail(cause),
		refresh: () => Stream.fail(cause),
		status: () => Effect.fail(cause),
		query: () => Effect.fail(cause)
	});
	const layer = gameTextIndexSourceNodeLayer("unused-cache", { refreshProjectIndex: false }).pipe(
		Layer.provide(catalog),
		Layer.provide(assetReaderLayer({ executable: "unused-reader" }))
	);
	const failure = await Effect.runPromise(
		Effect.gen(function* () {
			const source = yield* GameTextIndexSource;
			return yield* source.inventory({ projectRoot: "unused-project" }).pipe(Effect.flip);
		}).pipe(Effect.provide(layer))
	);
	expect(failure.cause).toBe(cause);
	expect(failure).toMatchObject({
		recovery: cause.recovery,
		nextStep: "fix_input",
		retrySafe: false
	});
});

it.each(["before", "during"] as const)(
	"rejects a changed bundle %s a concurrent multi-package read",
	async (when) => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-signature-bundles-"));
		try {
			await mkdir(join(root, "Content"));
			const inventory = await Promise.all(
				Array.from({ length: 65 }, async (_, row) => {
					const path = `Content/Package${row}.uasset`;
					await writeFile(join(root, path), `package ${row}`);
					const value = await stat(join(root, path), { bigint: true });
					return {
						path,
						signature: JSON.stringify([
							{
								size: Number(value.size),
								modifiedMs: Number(value.mtimeNs) / 1_000_000
							},
							null,
							null,
							null
						])
					};
				})
			);
			const changed = join(root, "Content/Package64.uexp");
			if (when === "before") await writeFile(changed, "new sidecar");
			let reads = 0;
			const reader = makeAssetReaderTestLayer({
				configuration: () =>
					Effect.succeed({
						executable: "uasset",
						timeoutMs: 30_000,
						catalogTimeoutMs: 50 * 60_000
					}),
				catalogProgress: () =>
					Effect.succeed({
						phase: "idle",
						cacheHits: 0,
						processedAssets: 0,
						tablesFound: 0,
						totalAssets: 0
					}),
				scanProgress: () =>
					Effect.succeed({
						phase: "idle",
						cacheHits: 0,
						emittedAssets: 0,
						processedAssets: 0,
						totalAssets: 0
					}),
				savedWorldProgress: () =>
					Effect.succeed({
						phase: "idle",
						actorsFound: 0,
						processedPackages: 0,
						totalPackages: 0
					}),
				readBlueprint: () =>
					Effect.die(new Error("Unexpected readBlueprint in this reader fixture")),
				readLevelSequence: () =>
					Effect.die(new Error("Unexpected readLevelSequence in this reader fixture")),
				readSavedWorld: () =>
					Effect.die(new Error("Unexpected readSavedWorld in this reader fixture")),
				extractProjectText: () =>
					Stream.die(new Error("Unexpected extractProjectText in this reader fixture")),
				extractProjectTextures: () =>
					Stream.die(
						new Error("Unexpected extractProjectTextures in this reader fixture")
					),
				discoverAssets: () => Effect.die("unused"),
				discoverTables: () => Effect.die("unused"),
				readAsset: () => Effect.die("unused"),
				readTable: () => Effect.die("unused"),
				source: () => Effect.succeed("configured"),
				scanProject: () => Effect.die("second enumeration"),
				extractProjectTextPackages: (request) => {
					reads++;
					expect(request.paths).toEqual(inventory.map((entry) => entry.path));
					return Stream.fromEffect(
						Effect.promise(() => writeFile(changed, "new sidecar"))
					).pipe(
						Stream.flatMap(() =>
							Stream.fromIterable(
								inventory.map((entry) => emptyPackageTextRecord(entry.path))
							)
						)
					);
				}
			});
			const catalog = makeProjectIndexTestLayer({
				rebuild: () => Stream.die("unused"),
				refresh: () => Stream.die("unused"),
				status: () => Effect.die("unused"),
				query: () => Effect.die("unused")
			});
			const source = gameTextIndexSourceNodeLayer(root).pipe(
				Layer.provide(reader),
				Layer.provide(catalog)
			);
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					const service = yield* GameTextIndexSource;
					return yield* Stream.runDrain(service.read(root, inventory)).pipe(Effect.flip);
				}).pipe(Effect.provide(source))
			);
			expect(failure.operation).toBe("signature");
			expect(reads).toBe(when === "before" ? 0 : 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);

it.each([true, false])(
	"uses committed signature pages with refresh=%s and verifies sidecars",
	async (refreshProjectIndex) => {
		const root = await mkdtemp(join(tmpdir(), "ue-shed-signature-source-"));
		try {
			await mkdir(join(root, "Content"));
			const path = "Content/Table.uasset",
				absolute = join(root, path),
				sidecar = join(root, "Content/Table.uexp");
			await writeFile(absolute, "package");
			await writeFile(sidecar, "sidecar");
			const stamp = async (file: string) => {
				const value = await stat(file, { bigint: true });
				// Rust's canonical JSON has sorted keys; comparison must not depend on key order.
				return { modifiedMs: Number(value.mtimeNs) / 1_000_000, size: Number(value.size) };
			};
			let signature = JSON.stringify([
				await stamp(absolute),
				await stamp(sidecar),
				null,
				null
			]);
			let summary: ProjectIndexSummary = {
				projectId: ProjectIdentity.make(root),
				generation: ProjectIndexGeneration.make(1),
				packageCount: 1,
				mapCount: 0,
				changedPackages: 1,
				removedPackages: 0,
				completeness: "complete",
				diagnostics: []
			};
			let refreshes = 0,
				reads = 0,
				queries = 0;
			const catalog = makeProjectIndexTestLayer({
				rebuild: () => Stream.die("unused"),
				refresh: () => {
					refreshes++;
					return Stream.succeed(
						ProjectIndexRefreshEvent.cases.Completed.make({ summary })
					);
				},
				status: () => Effect.succeed({ status: "ready", summary }),
				query: (request) => {
					queries++;
					expect(request._tag).toBe("Inventory");
					expect(request.expectedGeneration).toBe(summary.generation);
					return Effect.succeed({
						projectId: summary.projectId,
						generation: summary.generation,
						items: [{ kind: "inventory", packagePath: path, signature }]
					});
				}
			});
			const reader = makeAssetReaderTestLayer({
				configuration: () =>
					Effect.succeed({
						executable: "uasset",
						timeoutMs: 30_000,
						catalogTimeoutMs: 50 * 60_000
					}),
				catalogProgress: () =>
					Effect.succeed({
						phase: "idle",
						cacheHits: 0,
						processedAssets: 0,
						tablesFound: 0,
						totalAssets: 0
					}),
				scanProgress: () =>
					Effect.succeed({
						phase: "idle",
						cacheHits: 0,
						emittedAssets: 0,
						processedAssets: 0,
						totalAssets: 0
					}),
				savedWorldProgress: () =>
					Effect.succeed({
						phase: "idle",
						actorsFound: 0,
						processedPackages: 0,
						totalPackages: 0
					}),
				readBlueprint: () =>
					Effect.die(new Error("Unexpected readBlueprint in this reader fixture")),
				readLevelSequence: () =>
					Effect.die(new Error("Unexpected readLevelSequence in this reader fixture")),
				readSavedWorld: () =>
					Effect.die(new Error("Unexpected readSavedWorld in this reader fixture")),
				extractProjectText: () =>
					Stream.die(new Error("Unexpected extractProjectText in this reader fixture")),
				extractProjectTextures: () =>
					Stream.die(
						new Error("Unexpected extractProjectTextures in this reader fixture")
					),
				discoverAssets: () => Effect.die("second enumeration"),
				discoverTables: () => Effect.die("unused"),
				readAsset: () => Effect.die("unused"),
				readTable: () => Effect.die("unused"),
				source: () => Effect.succeed("configured"),
				scanProject: () => Effect.die("second enumeration"),
				extractProjectTextPackages: (request) => {
					reads++;
					expect(request.paths).toEqual([path]);
					return Stream.succeed(emptyPackageTextRecord(absolute));
				}
			});
			const source = gameTextIndexSourceNodeLayer(root, { refreshProjectIndex }).pipe(
				Layer.provide(Layer.merge(catalog, reader))
			);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const service = yield* GameTextIndexSource;
						const inventory = yield* service.inventory({ projectRoot: root });
						expect(refreshes).toBe(refreshProjectIndex ? 1 : 0);
						expect(yield* service.inventory({ projectRoot: root })).toBe(inventory);
						expect(queries).toBe(1);
						const events = Array.from(
							yield* Stream.runCollect(service.read(root, inventory))
						);
						expect(events[0]).toMatchObject({ path });
						expect(reads).toBe(1);
						yield* Effect.promise(() => writeFile(sidecar, "changed sidecar"));
						const failure = yield* Stream.runCollect(
							service.read(root, inventory)
						).pipe(Effect.flip);
						expect(failure.operation).toBe("signature");
						expect(reads).toBe(1);
						summary = { ...summary, generation: ProjectIndexGeneration.make(2) };
						signature = yield* Effect.promise(async () =>
							JSON.stringify([
								await stamp(absolute),
								await stamp(sidecar),
								null,
								null
							])
						);
						const updated = yield* service.inventory({ projectRoot: root });
						expect(queries).toBe(2);
						expect(updated).not.toBe(inventory);
						yield* Stream.runDrain(service.read(root, updated));
						expect(reads).toBe(2);
					})
				).pipe(Effect.provide(source))
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);

it("batches a whole project so each reader request fits the frame limit", () => {
	const entries = Array.from({ length: 100_000 }, (_, row) => ({
		path: `Content/Generated/Package_${String(row).padStart(8, "0")}.uasset`,
		signature: "[]"
	}));
	const batches = packageTextReadBatches(entries);

	expect(batches.length).toBeGreaterThan(1);
	expect(batches.flat()).toEqual(entries);
	for (const batch of batches)
		expect(
			Buffer.byteLength(JSON.stringify(batch.map((item) => item.path)), "utf8")
		).toBeLessThan(MAX_PROTOCOL_PATH_BYTES + 2);
	expect(packageTextReadBatches(entries.slice(0, 3))).toEqual([entries.slice(0, 3)]);
	expect(packageTextReadBatches([])).toEqual([]);
});
