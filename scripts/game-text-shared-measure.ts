import { open, readFile, stat, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { localizationColumnsBuilder } from "../packages/game-text/src/localization-columns.ts";
import { defaultLocalizationImportLimits } from "../packages/game-text/src/localization-stream.ts";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
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
import { openSnapshotFile, type SnapshotSource } from "../packages/game-text/src/snapshot-file.ts";
import type { SharedLoadedDomain } from "../packages/game-text/src/shared-string-file.ts";
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
	task = "all",
	changedPoByte = 110
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
	if (task === "parse") {
		const po = files.find((file) => file.format === "po")!;
		const staging = await mkdtemp(join(tmpdir(), "ue-shed-po-profile-"));
		const handle = await open(resolve(project, po.path!), "r");
		const builder = localizationColumnsBuilder(
			po.path!,
			join(staging, "columns"),
			{
				format: "po",
				poFormat: target.poFormat,
				collapseMode: target.collapseMode
			},
			defaultLocalizationImportLimits
		);
		try {
			await measure(
				"parse:po",
				async () => {
					const decoder = new TextDecoder("utf-8", { fatal: true });
					const buffer = Buffer.allocUnsafe(256 * 1024);
					let bytes = 0;
					for (;;) {
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
						if (!bytesRead) break;
						bytes += bytesRead;
						builder.feed(
							decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
						);
					}
					builder.feed(decoder.decode());
					const source = await builder.finish();
					return {
						inputBytes: bytes,
						rows: (await source.columns.find((c) => c.name === "entry.key")!.load())
							.length
					};
				},
				(result) => result
			);
		} finally {
			builder.close();
			await handle.close();
			await rm(staging, { recursive: true, force: true });
		}
		return;
	}
	if (["all", "cold", "refresh", "cold-po", "cold-probe"].includes(task)) {
		if (task === "all" || task === "cold") {
			await measure(
				"cold:target",
				async () => {
					const result = await Effect.runPromise(
						importLocalizationTarget({
							projectRoot: project,
							cacheRoot: cache,
							targetName: target.name
						}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
					);
					if (
						result.diagnostics.length ||
						result.files.length !== files.length ||
						result.files.some((file) => !file.parsed)
					)
						throw new Error(
							"Cold measurement requires every target file freshly parsed."
						);
					return result;
				},
				(result) => ({
					files: result.files.length,
					parsed: result.files.filter((file) => file.parsed).length,
					diagnostics: result.diagnostics,
					profile: result.profile
				})
			);
		} else if (task !== "refresh")
			for (const file of task === "cold-probe" ? files.slice(0, 7) : files) {
				if (task === "cold-po" && !(file.format === "po" && file.path?.includes("/en/")))
					continue;
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
		if (task === "cold-po" || task === "cold-probe") return;
		if (task === "refresh")
			await measure(
				"prepare-stat-hints",
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
					readBytes: result.files.reduce((n, file) => n + file.readBytes, 0)
				})
			);
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
				lookupStrings: result.files.reduce((n, file) => n + file.lookupStrings, 0),
				reusedStrings: result.files.reduce((n, file) => n + file.reusedStrings, 0),
				probePasses: result.files.reduce((n, file) => n + file.probePasses, 0),
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
			const replacement = original === changedPoByte ? 109 : changedPoByte;
			if (replacement === original)
				throw new Error("PO replacement byte must change the input.");
			await handle.write(Uint8Array.of(replacement), 0, 1, offset);
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
					).then((result) => {
						if (result.files.filter((file) => file.parsed).length !== 1)
							throw new Error(
								"PO change is already cached: compact first or choose an unseen --po-change-byte."
							);
						return result;
					}),
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
					lookupStrings: result.files.reduce((n, file) => n + file.lookupStrings, 0),
					reusedStrings: result.files.reduce((n, file) => n + file.reusedStrings, 0),
					probePasses: result.files.reduce((n, file) => n + file.probePasses, 0),
					profiles: result.files
						.filter((file) => file.parsed)
						.map((file) => ({ path: file.relativePath, ...file.profile }))
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
				? resolve("test-results/game-text-scale/snapshot-v3-final-1x-256.snapshot")
				: resolve("test-results/game-text-scale/snapshot-v3-final-10x-256.snapshot");
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
	if (task === "all" || task === "reader" || task === "folder")
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const index = yield* (yield* SharedIndex).open();
					const po = yield* index.layer(
						target.outputPaths.portableObjects[target.cultures[0]!]!
					);
					const metadata = Schema.decodeUnknownSync(
						Schema.fromJsonString(Schema.Struct({ pathPrefix: Schema.String }))
					)(new TextDecoder().decode(yield* po.section("file.meta")));
					const prefix = metadata.pathPrefix;
					if (!prefix.endsWith("/")) throw new Error("Native folder prefix absent.");
					let paths: Uint32Array = new Uint32Array(),
						flags: Uint32Array = new Uint32Array(),
						matches = 0;
					yield* Effect.promise(() =>
						measure(
							"reader:native-folder",
							async () => {
								const pathColumn = await Effect.runPromise(
									po.section("entry.path")
								);
								const flagColumn = await Effect.runPromise(
									po.section("entry.options")
								);
								if (
									!(pathColumn instanceof Uint32Array) ||
									!(flagColumn instanceof Uint32Array)
								)
									throw new Error("Native folder columns are not u32.");
								paths = pathColumn;
								flags = flagColumn;
								const suffixRanges = await Effect.runPromise(index.range(""));
								const fullRanges = await Effect.runPromise(index.range(prefix));
								for (let row = 0; row < paths.length; row++) {
									const ranges = flags[row]! & 1024 ? suffixRanges : fullRanges;
									if (
										ranges.some(
											(range) =>
												paths[row]! >= range.start &&
												paths[row]! < range.end
										)
									)
										matches++;
								}
								return { prefix, references: matches, rows: paths.length };
							},
							(result) => result
						)
					);
					yield* Effect.promise(() =>
						measure(
							"reader:native-folder-oracle",
							async () => {
								const order = Uint32Array.from(paths, (_, row) => row).sort(
									(a, b) => paths[a]! - paths[b]!
								);
								let oracle = 0;
								for (let start = 0; start < order.length; start += 8192) {
									const rows = order.subarray(start, start + 8192);
									const strings = await Effect.runPromise(
										index.strings(Array.from(rows, (row) => paths[row]!))
									);
									for (let id = 0; id < strings.length; id++) {
										const path =
											(flags[rows[id]!]! & 1024 ? prefix : "") + strings[id]!;
										if (path.startsWith(prefix)) oracle++;
									}
								}
								if (oracle !== matches)
									throw new Error(
										"Native folder range differs from hydrated paths."
									);
								return { prefix, references: oracle };
							},
							(result) => result
						)
					);
				})
			)
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
					const folderPrefix = recipe.scale === 1 ? "/Game/" : "Package";
					let folderMatches = 0;
					yield* Effect.promise(() =>
						measure(
							"reader:folder-range",
							() => Effect.runPromise(index.range(folderPrefix)),
							(ranges) => {
								folderMatches = ranges.reduce(
									(n, range) => n + range.end - range.start,
									0
								);
								return {
									ranges: ranges.length,
									prefix: folderPrefix,
									matches: folderMatches
								};
							}
						)
					);
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
					const retained: (readonly SharedLoadedDomain[])[] = [];
					for (const [domain, owners] of [
						["source", ["source"]],
						["culture", ["culture.en", "c0"]],
						["paths", ["paths"]]
					] as const) {
						let loaded: readonly SharedLoadedDomain[] = [];
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
										(n, domain) =>
											n + domain.utf8.length + domain.offsets.byteLength,
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
						if (domain === "paths")
							yield* Effect.promise(() =>
								measure(
									"reader:folder-oracle",
									async () => {
										let matches = 0;
										for (const block of loaded)
											for (let id = 0; id < block.count; id++)
												if (block.string(id).startsWith(folderPrefix))
													matches++;
										if (matches !== folderMatches)
											throw new Error(
												"Folder range differs from the path-domain oracle."
											);
										return matches;
									},
									(matches) => ({ matches, prefix: folderPrefix })
								)
							);
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
								cache: index.metrics(),
								blocksLoaded:
									index.metrics().blocksLoaded - beforePage.blocksLoaded,
								readBytes: index.metrics().readBytes - beforePage.readBytes,
								retainedColdBytes: retained
									.flat()
									.reduce(
										(sum, domain) =>
											sum + domain.utf8.length + domain.offsets.byteLength,
										0
									)
							})
						)
					);
					yield* Effect.promise(() =>
						measure(
							"reader:page-hot",
							() => Effect.runPromise(index.strings(ids)),
							(result) => ({ strings: result.length, cache: index.metrics() })
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
			ownershipBytes: number;
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
				ownershipBytes: 0,
				directoryBytes: 0
			});
			domain.strings += segment.count;
			domain.rawUtf8Bytes += segment.utf8Bytes;
			let payload = 0;
			for (const entry of reader.directory.entries.values()) {
				payload += entry.storedLength;
				if (entry.name.startsWith("front.o") && entry.name !== "front.offsets")
					domain.ownershipBytes += entry.storedLength;
				if (entry.name.startsWith("front.") && !entry.name.startsWith("front.b"))
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
