import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { open, readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect, Schema, Stream, type Scope } from "effect";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory
} from "../packages/game-text/src/shared-index.ts";
import { refreshJoinedTarget, reasonBit } from "../packages/game-text/src/joined-target.ts";
import { u32 } from "../packages/game-text/src/joined-target-input.ts";
import {
	openJoinedTarget,
	inspectJoinedTarget,
	hydrateJoinedTarget
} from "../packages/game-text/src/joined-target-reader.ts";
import { LocalizationLine } from "../packages/game-text/src/localization-schema.ts";
import { packageTextJsonLines } from "../packages/game-text/src/package-text-ndjson.ts";
import { compareLocalizationJoins } from "./localization-join-oracle.test-support.ts";
import { refreshPackageTextLayer } from "../packages/game-text/src/package-text-layer.ts";
import { importLocalizationTarget } from "../packages/game-text/src/localization-import.ts";
import { textCorpusWithExcludedPackages } from "../packages/game-text/dist/index.js";
import {
	LocalizationEvidenceNodeLive,
	LocalizationFileAccessLive,
	readLocalizationReview
} from "../packages/localization/dist/index.js";
import {
	readGeneratedPackageInventory,
	readGeneratedPackageRecord
} from "./package-text-generated.ts";
import { readScaleRecipe } from "./game-text-scale-options.ts";
import { readScaleEvidence, readScaleCorpus, joinScaleTarget } from "./game-text-scale-pipeline.ts";
import { captureBenchmarkByte, restoreBenchmarkByte } from "./localization-benchmark-byte.ts";
import { expectJoinRecipe } from "./columnar-join-recipe.test-support.ts";

type Measure = <A>(
	name: string,
	run: () => Promise<A>,
	summary: (value: A) => object
) => Promise<void>;
export async function measureColumnarJoin(
	project: string,
	cache: string,
	records: string,
	measure: Measure,
	task: string,
	changedByte: number
) {
	const recipe = await readScaleRecipe(project);
	const options = { cacheRoot: cache, projectKey: project, targetKey: "Generated" };
	const run = <A, E>(effect: Effect.Effect<A, E, SharedIndex | Scope.Scope>) =>
		Effect.runPromise(
			Effect.scoped(effect).pipe(Effect.provide(sharedIndexNodeLayer(options)))
		);
	const columnProof = () =>
		run(
			Effect.gen(function* () {
				const joined = yield* openJoinedTarget(),
					hashes: Record<string, string> = {};
				for (const name of [
					...new Set([
						...joined.layer.directory.entries.keys(),
						...Object.keys(joined.meta.aliases),
						...Object.keys(joined.meta.patches ?? {})
					])
				].sort()) {
					if (name === "shared.meta" || name === "join.meta") continue;
					const values = yield* joined.layer.section(name);
					hashes[name] = createHash("sha256")
						.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength))
						.digest("hex");
				}
				return {
					hashes,
					pairs: joined.meta.pairs,
					ambiguous: joined.meta.ambiguous,
					count: joined.meta.count
				};
			})
		);
	if (task === "compare") {
		if (recipe.scale >= 10) throw new Error("Only 1× has a saved object oracle");
		const inventory = await readGeneratedPackageInventory(records);
		await run(
			refreshPackageTextLayer({
				inventory,
				read: (paths) =>
					Stream.unwrap(
						Effect.promise(async () =>
							Stream.fromIterable(
								await Promise.all(
									paths.map(async (path) => {
										const record = (
											await readGeneratedPackageRecord(records, path)
										).evidence;
										if (record.event === "not_gatherable")
											throw new Error("Unexpected excluded read");
										return record;
									})
								)
							)
						)
					)
			})
		);
		const files = await Effect.runPromise(
			importLocalizationTarget({
				projectRoot: project,
				cacheRoot: cache,
				targetName: "Generated"
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
		const review = await Effect.runPromise(
			readLocalizationReview({ projectRoot: project, target: files.target.name }).pipe(
				Effect.provide(LocalizationFileAccessLive)
			)
		);
		await run(
			refreshJoinedTarget({
				projectRoot: project,
				target: files.target,
				...(review.contentHash === null ? undefined : { review: review.file }),
				force: true
			})
		);
		await measure(
			"compare:saved-oracle",
			async () => {
				const expected = new Map<string, LocalizationLine>();
				const decode = Schema.decodeUnknownSync(Schema.fromJsonString(LocalizationLine));
				const oracle = resolve(project, "../phase5-oracle/oracle-1x.ndjson");
				const header = JSON.parse(
					await readFile(resolve(project, "../phase5-oracle/oracle-1x.meta.json"), "utf8")
				);
				for await (const text of packageTextJsonLines(oracle)) {
					const line = decode(text);
					if (expected.has(line.id)) throw new Error("Saved oracle has duplicate IDs");
					expected.set(line.id, line);
				}
				const expectedLines = expected.size;
				return await run(
					Effect.gen(function* () {
						const joined = yield* openJoinedTarget();
						const reasons = yield* u32(joined.layer, "line.reasons");
						let conflictingSourceLines = 0;
						for (const bits of reasons)
							if (bits & reasonBit("conflicting_source")) conflictingSourceLines++;
						let conflictingSourcesAcrossPackages = 0;
						if (conflictingSourceLines) {
							const rows = yield* u32(joined.layer, "occurrence.rows");
							const starts = yield* u32(joined.layer, "line.occ_start");
							const ends = yield* u32(joined.layer, "line.occ_end");
							const packageRows = new Uint32Array(rows.length);
							const identities = new Uint32Array(rows.length);
							let packageBase = 0;
							for (let shard = 0; shard < joined.meta.packageNames.length; shard++) {
								const layer = yield* joined.reader.layer(
									joined.meta.packageNames[shard]!
								);
								const ranges = yield* u32(layer, "package.occurrence_start");
								const offset = joined.meta.packageStarts[shard]!;
								identities.set(yield* u32(layer, "occurrence.identity"), offset);
								for (let pkg = 0; pkg + 1 < ranges.length; pkg++)
									packageRows.fill(
										packageBase + pkg,
										offset + ranges[pkg]!,
										offset + ranges[pkg + 1]!
									);
								packageBase += ranges.length - 1;
							}
							for (let row = 0; row < reasons.length; row++) {
								if (!(reasons[row]! & reasonBit("conflicting_source"))) continue;
								const occurrences = rows.subarray(starts[row]!, ends[row]!);
								const authored = occurrences.some(
									(occurrence) => identities[occurrence] !== 1
								);
								const packages = new Set<number>();
								for (const occurrence of occurrences)
									if (!authored || identities[occurrence] !== 1)
										packages.add(packageRows[occurrence]!);
								if (packages.size > 1) conflictingSourcesAcrossPackages++;
							}
						}
						if (
							joined.meta.count !== header.lines ||
							joined.meta.input.target.name !== header.target ||
							joined.meta.input.target.nativeCulture !== header.nativeCulture ||
							JSON.stringify(joined.meta.input.target.cultures) !==
								JSON.stringify(header.cultures) ||
							joined.meta.pairs.length !== header.keyChanges.pairs.length ||
							joined.meta.ambiguous !== header.keyChanges.ambiguous
						)
							throw new Error("STOP: saved oracle header/key changes differ");
						let matchedLines = 0;
						for (let start = 0; start < joined.meta.count; start += 1000) {
							const actual = yield* hydrateJoinedTarget(joined, start, 1000);
							const lines = actual.lines.flatMap((line) => {
								const value = expected.get(line.id);
								return value ? [value] : [];
							});
							const equality = compareLocalizationJoins({ ...actual, lines }, actual);
							if (!equality.equal) {
								yield* Effect.promise(() =>
									writeFile(
										join(cache, "join-STOP.json"),
										JSON.stringify(equality, null, "\t") + "\n"
									)
								);
								throw new Error(
									`STOP: columnar join differs from saved oracle: ${equality.message}`
								);
							}
							matchedLines += equality.matchedLines;
							for (const line of actual.lines) expected.delete(line.id);
						}
						if (expected.size || matchedLines !== expectedLines)
							throw new Error(
								`STOP: saved oracle has ${expected.size} missing lines`
							);
						return {
							equal: true,
							expectedLines,
							matchedLines,
							differences: 0,
							oracle,
							conflictingSourceLines,
							conflictingSourcesAcrossPackages
						};
					})
				);
			},
			(value) => value
		);
		return;
	}
	if (task === "oracle") {
		if (recipe.scale >= 10) throw new Error("Today's in-memory join must never run at 10×");
		await mkdir(cache, { recursive: true });
		const destination = join(cache, "oracle-1x.ndjson");
		// Exclusive creation precedes the one authorized join; never silently repeat it.
		const reserved = await open(destination, "wx");
		await reserved.close();
		const descriptor = JSON.parse(await readFile(join(project, "scale.json"), "utf8"));
		const textPackages = (descriptor.recipe ?? descriptor["shape"]).textPackages;
		let evidence: Awaited<ReturnType<typeof readScaleEvidence>>;
		await measure(
			"oracle:evidence",
			async () => {
				evidence = await readScaleEvidence(project);
				return { files: 1 + evidence.cultures.length * 2 };
			},
			(value) => value
		);
		let corpus: Awaited<ReturnType<typeof readScaleCorpus>>;
		await measure(
			"oracle:corpus",
			async () => {
				const full = await readScaleCorpus(project);
				const selected = (path: string) =>
					Number(/Package(\d+)/u.exec(path)?.[1]) < textPackages;
				const excluded = (full.packageCoverage ?? [])
					.filter((entry) => !selected(entry.packageFile))
					.map((entry) => entry.packageFile);
				corpus = textCorpusWithExcludedPackages(
					{
						...full,
						packageCoverage: (full.packageCoverage ?? []).filter((entry) =>
							selected(entry.packageFile)
						),
						diagnostics: full.diagnostics.filter((entry) => selected(entry.packageFile))
					},
					excluded
				);
				return { units: corpus.units.length, excluded: excluded.length };
			},
			(value) => value
		);
		await measure(
			"oracle:join-and-save",
			async () => {
				const { join: oracle, keyChanges } = await joinScaleTarget(
					project,
					corpus!,
					evidence!
				);
				const file = createWriteStream(destination, { flags: "w" });
				try {
					for (const line of oracle.lines)
						if (!file.write(JSON.stringify(line) + "\n")) await once(file, "drain");
					file.end();
					await once(file, "finish");
				} finally {
					file.destroy();
				}
				await writeFile(
					join(cache, "oracle-1x.meta.json"),
					JSON.stringify(
						{
							schemaVersion: 1,
							target: oracle.target,
							nativeCulture: oracle.nativeCulture,
							cultures: oracle.cultures,
							lines: oracle.lines.length,
							keyChanges,
							mapping:
								"Phase 4 selected/excluded coverage; decoded occurrences unchanged"
						},
						null,
						"\t"
					) + "\n"
				);
				return {
					lines: oracle.lines.length,
					keyChanges: keyChanges.pairs.length,
					bytes: (await stat(destination)).size,
					destination
				};
			},
			(value) => value
		);
		return;
	}
	let inventory: Awaited<ReturnType<typeof readGeneratedPackageInventory>>;
	await measure(
		"prepare:inventory",
		async () => {
			inventory = await readGeneratedPackageInventory(records);
			return { packages: inventory.length };
		},
		(value) => value
	);
	const read = (version?: string) => (paths: readonly string[]) =>
		Stream.unwrap(
			Effect.promise(async () => {
				if (paths.length !== 1 || !paths[0]!.endsWith("/Package0.uasset"))
					throw new Error("Refresh read an unchanged package");
				const stored = await readGeneratedPackageRecord(records, paths[0]!);
				if (stored.evidence.event !== "text_package_record")
					throw new Error("Missing selected package");
				return Stream.succeed({
					...stored.evidence,
					occurrences: stored.evidence.occurrences.map((occurrence, row) =>
						version && row === 0
							? { ...occurrence, source: `${occurrence.source} ${version}` }
							: occurrence
					)
				});
			})
		);
	const localization = () =>
		Effect.runPromise(
			importLocalizationTarget({
				projectRoot: project,
				cacheRoot: cache,
				targetName: "Generated"
			}).pipe(Effect.provide(LocalizationEvidenceNodeLive))
		);
	let target: Awaited<ReturnType<typeof localization>>["target"];
	await measure(
		"prepare:restore-original-inputs",
		async () => {
			const packages = await run(
				refreshPackageTextLayer({ inventory: inventory!, read: read() })
			);
			const files = await localization();
			target = files.target;
			return { packages, parsedFiles: files.files.filter((file) => file.parsed).length };
		},
		(value) => value
	);
	const reviewResult = await Effect.runPromise(
		readLocalizationReview({ projectRoot: project, target: target!.name }).pipe(
			Effect.provide(LocalizationFileAccessLive)
		)
	);
	const input = {
		projectRoot: project,
		target: target!,
		...(reviewResult.contentHash === null ? undefined : { review: reviewResult.file })
	};
	let incrementalProof: Awaited<ReturnType<typeof columnProof>> | undefined;
	if (task !== "refresh")
		await measure(
			"cold:join",
			() => run(refreshJoinedTarget(input)),
			(value) => {
				if (!value.rebuilt) throw new Error("Cold join was already built");
				return value;
			}
		);
	else await run(refreshJoinedTarget(input));
	await measure(
		"validate:join",
		async () =>
			expectJoinRecipe(
				project,
				await run(
					Effect.gen(function* () {
						return yield* inspectJoinedTarget(yield* openJoinedTarget());
					})
				)
			),
		(value) => value
	);
	if (task === "all" || task === "refresh") {
		const noRead = () => Stream.die(new Error("No-change refresh read a package"));
		await measure(
			"refresh:no-change",
			async () => {
				const packages = await run(
					refreshPackageTextLayer({ inventory: inventory!, read: noRead })
				);
				const files = await localization(),
					joined = await run(refreshJoinedTarget(input));
				if (joined.rebuilt || packages.published || files.files.some((file) => file.parsed))
					throw new Error("No-change refresh rebuilt a layer");
				return {
					packages,
					parsedFiles: 0,
					joined,
					readBytes: files.files.reduce((sum, file) => sum + file.readBytes, 0)
				};
			},
			(value) => value
		);
		const saved = await captureBenchmarkByte(
			join(project, "Content/Localization/Generated/en/Generated.po"),
			"mirava"
		);
		try {
			const handle = await open(saved.path, "r+");
			try {
				await handle.write(Uint8Array.of(changedByte), 0, 1, saved.offset);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await measure(
				"refresh:package-po-and-join",
				async () => {
					const changed = inventory!.map((entry) =>
						entry.path.endsWith("/Package0.uasset")
							? { ...entry, signature: entry.signature + ":phase5" }
							: entry
					);
					const packages = await run(
						refreshPackageTextLayer({ inventory: changed, read: read("phase5") })
					);
					const files = await localization();
					if (files.files.filter((file) => file.parsed).length !== 1)
						throw new Error("PO edit was not freshly parsed");
					const joined = await run(refreshJoinedTarget(input));
					if (!joined.rebuilt) throw new Error("Changed inputs did not rebuild the join");
					return { packages, parsedFiles: 1, joined };
				},
				(value) => value
			);
		} finally {
			await restoreBenchmarkByte(saved);
		}
		// Re-import the edited PO content key without an authored write: the index retains
		// it while the supervisor restores only the benchmark byte. Full uses the same root.
		incrementalProof = await columnProof();
	}
	await measure(
		"size:whole-index",
		async () => {
			const manifest = await run(
				Effect.gen(function* () {
					return yield* (yield* SharedIndex).inspect();
				})
			);
			const active = Object.entries(manifest.active);
			const bytes = (predicate: (name: string) => boolean) =>
				active
					.filter(([name]) => predicate(name))
					.reduce((sum, [, key]) => sum + manifest.layers[key]!.bytes, 0);
			const packageBytes = bytes((name) => name.startsWith("package-text.")),
				localizationBytes = bytes((name) => /\.(manifest|archive|po)$/u.test(name)),
				joinedBytes = bytes((name) => name === "joined" || name === "joined-base"),
				sharedBytes = manifest.segments.reduce((sum, segment) => sum + segment.bytes, 0);
			let physicalBytes = 0,
				statHintBytes = 0;
			for (const file of await readdir(sharedIndexDirectory(options)))
				physicalBytes += (await stat(join(sharedIndexDirectory(options), file))).size;
			for (const file of await readdir(join(cache, "localization-file-stats")))
				statHintBytes += (await stat(join(cache, "localization-file-stats", file))).size;
			return {
				packageBytes,
				localizationBytes,
				joinedBytes,
				sharedBytes,
				physicalBytes,
				statHintBytes,
				retainedAndPublicationBytes:
					physicalBytes +
					statHintBytes -
					packageBytes -
					localizationBytes -
					joinedBytes -
					sharedBytes,
				totalBytes: physicalBytes + statHintBytes
			};
		},
		(value) => value
	);
	if (incrementalProof)
		await measure(
			"proof:incremental-full",
			async () => {
				await run(refreshJoinedTarget({ ...input, force: true }));
				const full = await columnProof();
				if (JSON.stringify(incrementalProof) !== JSON.stringify(full))
					throw new Error("STOP: incremental columns differ from full rebuild");
				return {
					equal: true,
					columns: Object.keys(full.hashes).length,
					lines: full.count,
					differences: 0
				};
			},
			(value) => value
		);
}
