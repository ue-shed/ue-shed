import { open, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Stream, type Scope } from "effect";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory
} from "../packages/game-text/src/shared-index.ts";
import {
	refreshPackageTextLayer,
	type PackageTextInventoryEntry
} from "../packages/game-text/src/package-text-layer.ts";
import { importColdPackageTextLayer } from "../packages/game-text/src/package-text-cold.ts";
import {
	convertGeneratedPackageText,
	readGeneratedPackageInventory,
	readGeneratedPackageRecord
} from "./package-text-generated.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";
import { importLocalizationTarget } from "../packages/game-text/src/localization-import.ts";
import { LocalizationEvidenceNodeLive } from "../packages/localization/dist/index.js";
import { openSnapshotFile } from "../packages/game-text/src/snapshot-file.ts";

type Measure = <A>(
	name: string,
	run: () => Promise<A>,
	summary: (value: A) => object
) => Promise<void>;
export async function measurePackageTextLayer(
	project: string,
	cache: string,
	records: string,
	measure: Measure,
	task: string
) {
	const recipe = await readScaleRecipe(project);
	if (task === "convert") {
		const descriptor = JSON.parse(await readFile(join(project, "scale.json"), "utf8"));
		await measure(
			"convert:retained-events",
			() =>
				convertGeneratedPackageText(
					project,
					records,
					(descriptor.recipe ?? descriptor["shape"]).textPackages
				),
			(result) => result
		);
		return;
	}
	let inventory: PackageTextInventoryEntry[] = [];
	await measure(
		"inventory:converted",
		async () => {
			inventory = await readGeneratedPackageInventory(records);
			return { packages: inventory.length };
		},
		(result) => result
	);
	const options = { cacheRoot: cache, projectKey: project, targetKey: "Generated" };
	const run = <A, E>(effect: Effect.Effect<A, E, SharedIndex | Scope.Scope>) =>
		Effect.runPromise(
			Effect.scoped(effect).pipe(Effect.provide(sharedIndexNodeLayer(options)))
		);
	if (task === "integrated") {
		const file = await openSnapshotFile(resolveSnapshot(recipe.scale));
		try {
			await measure(
				"cold:package-into-whole-index",
				() =>
					run(
						importColdPackageTextLayer({
							inventory,
							recordDirectory: records,
							stagingRoot: join(cache, "staging"),
							additionalSources: [
								{
									name: "joined",
									key: "phase4-full-width-phase2",
									source: {
										columns: [...file.directory.entries.values()].map(
											(entry) => ({
												...entry,
												load: () => file.load(entry.name)
											})
										)
									}
								}
							]
						})
					),
				(result) => result
			);
		} finally {
			await file.close();
		}
	}
	if (task === "all" || task === "cold")
		await measure(
			"cold:package-layer",
			() =>
				run(
					importColdPackageTextLayer({
						inventory,
						recordDirectory: records,
						stagingRoot: join(cache, "staging")
					})
				),
			(result) => result
		);
	const noRead = () => Stream.die(new Error("Unchanged package must not be read"));
	await measure(
		"refresh:no-change",
		() => run(refreshPackageTextLayer({ inventory, read: noRead })),
		(result) => result
	);
	const selected = inventory.find((entry) => entry.path.endsWith("/Package0.uasset"));
	if (!selected) throw new Error("Generated package 0 absent");
	const change = (version: string) =>
		inventory.map((entry) =>
			entry.path === selected.path
				? { ...entry, signature: `${selected.signature}:${version}` }
				: entry
		);
	const read = (version: string) => (paths: readonly string[]) =>
		Stream.unwrap(
			Effect.promise(async () => {
				if (paths.length !== 1 || paths[0] !== selected.path)
					throw new Error("Refresh read an unchanged package");
				const current = await readGeneratedPackageRecord(records, selected.path);
				if (current.evidence.event !== "text_package_record")
					throw new Error("Missing package");
				return Stream.succeed({
					...current.evidence,
					occurrences: current.evidence.occurrences.map((occurrence, row) =>
						row === 0
							? { ...occurrence, source: `${occurrence.source} ${version}` }
							: occurrence
					)
				});
			})
		);
	await measure(
		"refresh:one-package",
		() =>
			run(
				refreshPackageTextLayer({ inventory: change("changed-1"), read: read("changed-1") })
			),
		(result) => result
	);
	if (["all", "refresh", "combined", "integrated"].includes(task)) {
		await measure(
			"prepare:localization",
			() =>
				Effect.runPromise(
					importLocalizationTarget({
						projectRoot: project,
						cacheRoot: cache,
						targetName: "Generated"
					}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
				),
			(result) => ({
				files: result.files.length,
				parsed: result.files.filter((file) => file.parsed).length
			})
		);
		await measure(
			"refresh:no-change-whole-index",
			async () => {
				const packages = await run(
					refreshPackageTextLayer({ inventory: change("changed-1"), read: noRead })
				);
				const localization = await Effect.runPromise(
					importLocalizationTarget({
						projectRoot: project,
						cacheRoot: cache,
						targetName: "Generated"
					}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
				);
				return {
					packages,
					parsedFiles: localization.files.filter((file) => file.parsed).length,
					readBytes: localization.files.reduce((sum, file) => sum + file.readBytes, 0)
				};
			},
			(result) => result
		);
		const saved = await captureBenchmarkByte(
			join(project, "Content/Localization/Generated/en/Generated.po"),
			"mirava"
		);
		try {
			const handle = await open(saved.path, "r+");
			try {
				await handle.write(
					Uint8Array.of(saved.byte === 109 ? 110 : 109),
					0,
					1,
					saved.offset
				);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await measure(
				"refresh:package-and-po",
				async () => {
					const packages = await run(
						refreshPackageTextLayer({
							inventory: change("changed-2"),
							read: read("changed-2")
						})
					);
					const localization = await Effect.runPromise(
						importLocalizationTarget({
							projectRoot: project,
							cacheRoot: cache,
							targetName: "Generated"
						}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
					);
					return {
						packages,
						parsedFiles: localization.files.filter((file) => file.parsed).length,
						readBytes: localization.files.reduce((sum, file) => sum + file.readBytes, 0)
					};
				},
				(result) => result
			);
		} finally {
			await restoreBenchmarkByte(saved);
		}
	}
	await measure(
		"size:package-layer",
		async () => {
			const manifest = await run(
				Effect.gen(function* () {
					return yield* (yield* SharedIndex).inspect();
				})
			);
			const active = Object.entries(manifest.active);
			const packageBytes = active
				.filter(([name]) => name.startsWith("package-text."))
				.reduce((sum, [, key]) => sum + manifest.layers[key]!.bytes, 0);
			const localizationBytes = active
				.filter(([name]) => /\.(manifest|archive|po)$/u.test(name))
				.reduce((sum, [, key]) => sum + manifest.layers[key]!.bytes, 0);
			const joinedBytes = manifest.layers[manifest.active.joined ?? ""]?.bytes ?? 0;
			const sharedBytes = manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
			const directory = sharedIndexDirectory(options);
			let physicalBytes = 0;
			for (const file of await readdir(directory))
				physicalBytes += (await stat(join(directory, file))).size;
			let statHintBytes = 0;
			try {
				for (const file of await readdir(join(cache, "localization-file-stats")))
					statHintBytes += (await stat(join(cache, "localization-file-stats", file)))
						.size;
			} catch (cause) {
				if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
					throw cause;
			}
			return {
				scale: recipe.scale,
				packageBytes,
				localizationBytes,
				joinedBytes,
				sharedBytes,
				activeBytes: packageBytes + localizationBytes + joinedBytes + sharedBytes,
				physicalBytes,
				statHintBytes,
				totalBytes: physicalBytes + statHintBytes,
				retainedAndPublicationBytes:
					physicalBytes - packageBytes - localizationBytes - joinedBytes - sharedBytes
			};
		},
		(result) => result
	);
}

function resolveSnapshot(scale: number) {
	return join(
		"test-results/game-text-scale",
		scale === 1 ? "snapshot-v3-final-1x-256.snapshot" : "snapshot-v3-final-10x-256.snapshot"
	);
}
