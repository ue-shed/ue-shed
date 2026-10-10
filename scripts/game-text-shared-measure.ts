import { open, readFile, stat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import {
	LocalizationEvidence,
	LocalizationEvidenceNodeLive
} from "../packages/localization/dist/index.js";
import {
	importLocalizationFile,
	importLocalizationTarget
} from "../packages/game-text/src/localization-import.ts";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory,
	type SharedIndexManifest
} from "../packages/game-text/src/shared-index.ts";
import {
	openSnapshotFile,
	type SnapshotSource,
	type SnapshotLoadedDomain
} from "../packages/game-text/src/snapshot-file.ts";
import { reblockSnapshot } from "./game-text-snapshot-reblock.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";

type Measure = <A>(
	name: string,
	run: () => Promise<A>,
	summary: (value: A) => object
) => Promise<void>;
export async function measureSharedIndex(
	project: string,
	cache: string,
	measure: Measure,
	task = "all"
) {
	const recipe = await readScaleRecipe(project);
	const target = await Effect.runPromise(
		Effect.gen(function* () {
			const evidence = yield* LocalizationEvidence;
			const discovery = yield* evidence.discover({ projectRoot: project });
			const target = discovery.targets.find((target) => target.name === "Generated");
			if (!target) throw new Error("Generated target absent");
			return target;
		}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
	);
	const options = { cacheRoot: cache, projectKey: project, targetKey: target.name };
	const layer = sharedIndexNodeLayer(options);
	const run = <A, E>(effect: Effect.Effect<A, E, SharedIndex>) =>
		Effect.runPromise(effect.pipe(Effect.provide(layer)));
	const files = [
		{ path: target.outputPaths.manifest, format: "manifest" as const },
		...target.cultures.flatMap((culture) => [
			{ path: target.outputPaths.archives[culture], format: "archive" as const },
			{ path: target.outputPaths.portableObjects[culture], format: "po" as const }
		])
	];
	if (task === "all" || task === "cold" || task === "refresh") {
		if (task !== "refresh")
			for (const file of files) {
				if (!file.path) throw new Error("Missing input path");
				await measure(
					`cold:${file.path}`,
					() =>
						Effect.runPromise(
							importLocalizationFile({
								projectRoot: project,
								cacheRoot: cache,
								relativePath: file.path!,
								format: file.format,
								poFormat: target.poFormat,
								collapseMode: target.collapseMode,
								sharedTargetKey: target.name
							})
						),
					(result) => ({ ...result })
				);
			}
		await measure(
			"stat-hit:target",
			() =>
				Effect.runPromise(
					importLocalizationTarget({
						projectRoot: project,
						cacheRoot: cache,
						targetName: target.name
					}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
				),
			(result) => ({
				files: result.files.length,
				parsed: result.files.filter((file) => file.parsed).length,
				readBytes: result.files.reduce((n, file) => n + file.readBytes, 0),
				sharedReadBytes: result.files.reduce((n, file) => n + file.sharedReadBytes, 0),
				sharedIndexReadBytes: result.files.reduce(
					(n, file) => n + file.sharedIndexReadBytes,
					0
				),
				sharedBytesAppended: result.files.reduce(
					(n, file) => n + file.sharedBytesAppended,
					0
				),
				diagnostics: result.diagnostics.length
			})
		);
		const po = files.find((file) => file.format === "po")!;
		const handle = await open(resolve(project, po.path!), "r+");
		let offset = -1,
			original = 0;
		try {
			const bytes = Buffer.alloc(4096);
			await handle.read(bytes, 0, bytes.length, 0);
			offset = bytes.indexOf("mirava");
			if (offset < 0) throw new Error("Change word absent");
			original = bytes[offset]!;
			await handle.write(Uint8Array.of(original === 109 ? 110 : 109), 0, 1, offset);
			await handle.sync();
			await measure(
				"one-byte-po:target",
				() =>
					Effect.runPromise(
						importLocalizationTarget({
							projectRoot: project,
							cacheRoot: cache,
							targetName: target.name
						}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
					),
				(result) => ({
					files: result.files.length,
					parsed: result.files.filter((file) => file.parsed).length,
					readBytes: result.files.reduce((n, file) => n + file.readBytes, 0),
					sharedReadBytes: result.files.reduce((n, file) => n + file.sharedReadBytes, 0),
					sharedIndexReadBytes: result.files.reduce(
						(n, file) => n + file.sharedIndexReadBytes,
						0
					),
					sharedBytesAppended: result.files.reduce(
						(n, file) => n + file.sharedBytesAppended,
						0
					)
				})
			);
		} finally {
			if (offset >= 0) {
				await handle.write(Uint8Array.of(original), 0, 1, offset);
				await handle.sync();
			}
			await handle.close();
		}
		// Reuse the original content key after restoration; it remains independently cached.
		await Effect.runPromise(
			importLocalizationTarget({
				projectRoot: project,
				cacheRoot: cache,
				targetName: target.name
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
	}
	if (task === "all" || task === "projection") {
		const reference =
			recipe.scale === 1
				? join(cache, "joined-replay.snapshot")
				: resolve("test-results/game-text-scale/snapshot-v3-final-10x-256.snapshot");
		if (recipe.scale === 1)
			await measure(
				"replay-phase2-raw",
				() =>
					reblockSnapshot(
						resolve("test-results/game-text-scale/snapshot-v2-1x.raw"),
						reference,
						256 * 1024
					),
				(result) => ({ fileBytes: result.fileLength })
			);
		const reader = await openSnapshotFile(reference);
		try {
			const source: SnapshotSource = {
				columns: [...reader.directory.entries.values()].map((entry) => ({
					...entry,
					load: () => reader.load(entry.name)
				}))
			};
			await measure(
				"rebase-phase2-joined",
				() =>
					run(
						Effect.scoped(
							Effect.gen(function* () {
								const store = yield* SharedIndex,
									writer = yield* store.writer();
								const record = yield* writer.publish(
									"joined",
									"saved-phase2",
									source
								);
								return { record, ...writer.metrics() };
							})
						)
					),
				(result) => result
			);
		} finally {
			await reader.close();
		}
	}
	if (task === "all" || task === "compact")
		await measure(
			"compaction",
			() =>
				run(
					Effect.scoped(
						Effect.gen(function* () {
							const store = yield* SharedIndex,
								writer = yield* store.writer();
							const result = yield* writer.compact(true);
							return { ...result, ...writer.metrics() };
						})
					)
				),
			(result) => result
		);
	const manifest = await run(
		Effect.scoped(
			Effect.gen(function* () {
				return yield* (yield* SharedIndex).inspect();
			})
		)
	);
	await measure(
		"size",
		() => componentSizes(sharedIndexDirectory(options), manifest),
		(result) => result
	);
	if (task === "all" || task === "reader")
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const store = yield* SharedIndex;
					const started = performance.now(),
						index = yield* store.open();
					const openedMs = performance.now() - started;
					const joined = yield* index.layer("joined");
					const hot = [
						"culture.names",
						"line.id",
						"line.namespace",
						"line.key",
						"line.source",
						"line.origin",
						"occurrence.line",
						"occurrence.id",
						"occurrence.kind",
						...target.cultures.map((_, culture) => `c${culture}.state`),
						"c0.facts",
						"c0.reasons",
						"c0.reduced"
					];
					yield* Effect.promise(() =>
						measure(
							"reader:open",
							async () => {
								for (const name of hot)
									await Effect.runPromise(joined.section(name));
								const timings = index.metrics();
								return {
									directoryMs: openedMs,
									columnLoadMs: timings.columnLoadMs,
									idDecodeMs: timings.idDecodeMs,
									idValidateMs: timings.idValidateMs
								};
							},
							(result) => result
						)
					);
					const retained: (readonly SnapshotLoadedDomain[])[] = [];
					for (const [domain, owners] of [
						["source", ["source"]],
						["culture", ["culture.en", "c0"]],
						["paths", ["paths"]]
					] as const) {
						let loaded: readonly SnapshotLoadedDomain[] = [];
						yield* Effect.promise(() =>
							measure(
								`reader:domain:${domain}`,
								async () => {
									loaded = [];
									for (const owner of owners)
										loaded = [
											...loaded,
											...(await Effect.runPromise(index.domain(owner)))
										];
									return loaded;
								},
								(result) => ({
									rawBytes: result.reduce(
										(n, domain) => n + domain.bytes.length,
										0
									),
									storedBytes: result.reduce(
										(n, domain) => n + domain.timings.storedBytes,
										0
									),
									strings: result.reduce((n, domain) => n + domain.count, 0),
									decompressMs: result.reduce(
										(n, domain) => n + domain.timings.decompressMs,
										0
									),
									verifyMs: result.reduce(
										(n, domain) => n + domain.timings.verifyMs,
										0
									),
									readMs: result.reduce(
										(n, domain) => n + domain.timings.readMs,
										0
									),
									copyMs: result.reduce(
										(n, domain) => n + domain.timings.copyMs,
										0
									)
								})
							)
						);
						const needle =
							domain === "paths" ? "/" : recipe.scale === 1 ? "TALUMA" : "SOURCE";
						yield* Effect.promise(() =>
							measure(
								`reader:scan:${domain}`,
								async () =>
									loaded.reduce(
										(sum, domain) => sum + domain.scanSubstring(needle),
										0
									),
								(matches) => ({ matches, needle })
							)
						);
						retained.push(loaded);
					}
					const names = [
						"line.id",
						"line.namespace",
						"line.key",
						"line.source",
						"line.place",
						"c0.translation"
					];
					const ids: number[] = [];
					yield* Effect.promise(() =>
						measure(
							"reader:page-columns",
							async () => {
								const before = index.metrics();
								for (const name of [
									"line.place",
									"occurrence.package",
									"occurrence.object",
									"occurrence.property",
									"occurrence.row",
									"c0.translation",
									"c0.po.rows",
									"c0.po.ids"
								])
									await Effect.runPromise(joined.section(name));
								for (const name of names)
									ids.push(
										...Array.from(
											(
												await Effect.runPromise(joined.section(name))
											).subarray(0, 50)
										)
									);
								const after = index.metrics();
								return {
									columns: 8,
									columnLoadMs: after.columnLoadMs - before.columnLoadMs,
									idDecodeMs: after.idDecodeMs - before.idDecodeMs,
									idValidateMs: after.idValidateMs - before.idValidateMs
								};
							},
							(result) => result
						)
					);
					const beforePage = index.metrics();
					yield* Effect.promise(() =>
						measure(
							"reader:page",
							() => Effect.runPromise(index.strings(ids)),
							(result) => ({
								strings: result.length,
								blocksLoaded:
									index.metrics().blocksLoaded - beforePage.blocksLoaded,
								readBytes: index.metrics().readBytes - beforePage.readBytes,
								retainedColdBytes: retained
									.flat()
									.reduce((sum, domain) => sum + domain.bytes.length, 0)
							})
						)
					);
				})
			)
		);
}

async function componentSizes(directory: string, manifest: SharedIndexManifest) {
	const domains: Record<
		string,
		{
			strings: number;
			rawUtf8Bytes: number;
			stringBytes: number;
			indexBytes: number;
			fingerprintBytes: number;
			pointerBytes: number;
			prefilterBytes: number;
			fenceBytes: number;
			directoryBytes: number;
		}
	> = {};
	for (const segment of manifest.segments) {
		const reader = await openSnapshotFile(join(directory, segment.file));
		try {
			const domain = (domains[segment.domain] ??= {
				strings: 0,
				rawUtf8Bytes: 0,
				stringBytes: 0,
				indexBytes: 0,
				fingerprintBytes: 0,
				pointerBytes: 0,
				prefilterBytes: 0,
				fenceBytes: 0,
				directoryBytes: 0
			});
			domain.strings += segment.count;
			domain.rawUtf8Bytes += segment.utf8Bytes;
			let payload = 0;
			for (const entry of reader.directory.entries.values()) {
				payload += entry.storedLength;
				if (entry.name.startsWith("hash.p")) domain.fingerprintBytes += entry.storedLength;
				if (entry.name.startsWith("id.p")) domain.pointerBytes += entry.storedLength;
				if (entry.name === "hash.bloom") domain.prefilterBytes += entry.storedLength;
				if (entry.name === "hash.fences") domain.fenceBytes += entry.storedLength;
				if (entry.name.startsWith("hash.") || entry.name.startsWith("id."))
					domain.indexBytes += entry.storedLength;
				else domain.stringBytes += entry.storedLength;
			}
			domain.directoryBytes += segment.bytes - payload;
		} finally {
			await reader.close();
		}
	}
	const layers = Object.fromEntries(
		Object.entries(manifest.active).map(([name, key]) => [name, manifest.layers[key]!.bytes])
	);
	let packageEstimate = 0;
	const joined = manifest.layers[manifest.active.joined ?? ""];
	if (joined) {
		const reader = await openSnapshotFile(join(directory, joined.file));
		try {
			for (const entry of reader.directory.entries.values())
				if (
					entry.name.startsWith("occurrence.") ||
					["line.namespace", "line.key", "line.source"].includes(entry.name)
				)
					packageEstimate += entry.storedLength + 96;
		} finally {
			await reader.close();
		}
	}
	const current = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
	const publicationBytes =
		(await stat(join(directory, "manifest.json"))).size +
		(await stat(join(directory, current.physicalSnapshot))).size +
		(current.previousSnapshot
			? (await stat(join(directory, current.previousSnapshot))).size
			: 0);
	const sharedBytes = manifest.segments.reduce((n, segment) => n + segment.bytes, 0);
	const layerBytes = Object.values(layers).reduce((n, size) => n + size, 0);
	let physicalStoreBytes = 0;
	for (const file of await readdir(directory))
		physicalStoreBytes += (await stat(join(directory, file))).size;
	let statHintBytes = 0;
	const hintDirectory = resolve(directory, "../..", "localization-file-stats");
	for (const file of await readdir(hintDirectory))
		statHintBytes += (await stat(join(hintDirectory, file))).size;
	return {
		scaleProjection: joined
			? "saved Phase 2 projection; 10x uses the retained synthetic width probe"
			: "localization only",
		domains,
		layers,
		sharedBytes,
		layerBytes,
		publicationBytes,
		packageEstimate,
		physicalStoreBytes,
		statHintBytes,
		retainedBytes: physicalStoreBytes - sharedBytes - layerBytes - publicationBytes,
		totalBytes: physicalStoreBytes + statHintBytes + packageEstimate
	};
}
