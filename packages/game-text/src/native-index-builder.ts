import { importLocalizationFile, importLocalizationTarget } from "./localization-import.js";
import { refreshPackageTextLayer } from "./package-text-layer.js";
import { nativeIndexConfiguration } from "./native-index-configuration.js";
import { nativeIndexQueryLayer } from "./index-query-native.js";
import { snapshotStoreGuidance } from "./snapshot-store.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Duration, Effect, Exit, Layer, Option, Pool, Schema } from "effect";
import {
	AssetReader,
	NativeGameTextIndexClient,
	nativeGameTextIndexClientLayer,
	encodeGameTextJoinInput,
	type AssetReaderConfiguration,
	type AssetReaderError,
	type GameTextIndexBuildRequest
} from "@ue-shed/unreal-assets";
import { GameTextIndexBuilder } from "./index-builder.js";
import { LocalizationImportSession } from "./localization-import-session.js";
import {
	SharedIndex,
	SharedIndexManifestSchema,
	LayerRecord,
	sharedIndexNodeLayer,
	sharedIndexDirectory,
	type SharedIndexOptions,
	type SharedIndexWriter
} from "./shared-index.js";
import { SnapshotStoreError, snapshotStoreFailure } from "./snapshot-store.js";
import { writeSnapshotFile, type SnapshotSource } from "./snapshot-file.js";
import { snapshotCheck } from "./snapshot-format.js";
import { decodeWtf8, encodeWtf8 } from "./wtf8.js";

const unavailable = (operation: string, cause: unknown) =>
	new SnapshotStoreError({
		operation,
		code: "invalid_response",
		...snapshotStoreGuidance("invalid_response"),
		message: `The native Game Text index returned an invalid result for ${operation}.`,
		cause,
		recovery: "Install matching host and native reader versions, then open a new build session."
	});

const nativeFailure = (cause: AssetReaderError, operation = "native-index-builder") => {
	let code: SnapshotStoreError["code"];
	switch (cause.code) {
		case "executable_missing":
			code = "executable_missing";
			break;
		case "busy":
			code = "busy";
			break;
		case "invalid_input":
			code = "invalid_input";
			break;
		case "invalid_cache":
			code = "invalid_cache";
			break;
		case "stale_generation":
			code = "stale_generation";
			break;
		case "limit_exceeded":
			code = "resource_limit";
			break;
		case "not_found":
			code = "missing";
			break;
		case "io_error":
			code = "io_error";
			break;
		default:
			code =
				cause.kind === "timeout"
					? "timeout"
					: cause.kind === "resource_limit"
						? "resource_limit"
						: cause.kind === "contract"
							? "invalid_response"
							: "native_failed";
	}
	return new SnapshotStoreError({
		operation,
		code,
		...snapshotStoreGuidance(code),
		message:
			code === "executable_missing"
				? "The native Game Text index executable is unavailable."
				: cause.message,
		cause,
		recovery:
			code === "executable_missing"
				? "Install the matching @ue-shed/uasset runtime provider or configure an existing compatible reader executable."
				: code === "busy"
					? "Wait for the current Game Text writer to finish, then open a new build session."
					: code === "invalid_cache" || code === "stale_generation" || code === "missing"
						? "Close the failed session and rebuild the disposable Game Text index from its inputs."
						: code === "timeout" || code === "native_failed"
							? "Reopen the index to inspect its last published state before starting a new build session."
							: cause.recovery
	});
};
const io = <A>(operation: string, action: (signal: AbortSignal) => Promise<A>) =>
	Effect.callback<A, ReturnType<typeof snapshotStoreFailure>>((resume, signal) => {
		const pending = Promise.resolve().then(() => action(signal));
		pending.then(
			(value) => resume(Effect.succeed(value)),
			(cause) =>
				resume(
					Effect.fail(
						snapshotStoreFailure(
							operation,
							cause,
							"Inspect the cache filesystem failure before opening a new build session."
						)
					)
				)
		);
		// Interruption aborts the operation, then waits for its owned file handles to close before
		// the enclosing scope removes the staging directory (important on Windows).
		return Effect.promise(() =>
			pending.then(
				() => undefined,
				() => undefined
			)
		);
	});

class NativeBuildSession extends Context.Service<
	NativeBuildSession,
	{
		readonly refreshJoinedTarget: import("./joined-target.js").RefreshJoinedTarget;
	}
>()("@ue-shed/game-text/NativeBuildSession") {}

const makeWriter = Effect.fn("NativeIndexBuilder.writer")(function* (
	options: SharedIndexOptions,
	stage: string
) {
	const client = yield* NativeGameTextIndexClient;
	const configuration = nativeIndexConfiguration(options);
	let closed = false;
	const begin = yield* client
		.execute({ action: "begin", configuration })
		.pipe(Effect.mapError(nativeFailure));
	let nativeIo = begin.io;
	let lookupStrings = 0,
		reusedStrings = 0;
	const stageTimes: Record<string, number> = {};
	let manifest = yield* Schema.decodeUnknownEffect(SharedIndexManifestSchema)(begin.root).pipe(
		Effect.mapError((cause) => unavailable("native-index-root", cause))
	);
	const command = Effect.fn("NativeIndexBuilder.execute")(
		function* (request: GameTextIndexBuildRequest) {
			if (closed)
				return yield* Effect.fail(
					unavailable("native-index-session", "The build session is closed.")
				);
			const result = yield* client
				.execute(request)
				.pipe(
					Effect.mapError((cause) =>
						nativeFailure(cause, `native-index-${request.action}`)
					)
				);
			nativeIo = result.io;
			for (const [name, seconds] of Object.entries(result.stageSeconds))
				stageTimes[name] = (stageTimes[name] ?? 0) + seconds * 1000;
			if (result.root !== null)
				manifest = yield* Schema.decodeUnknownEffect(SharedIndexManifestSchema)(
					result.root
				).pipe(Effect.mapError((cause) => unavailable("native-index-root", cause)));
			return result;
		},
		Effect.onExit((exit) =>
			Effect.sync(() => {
				if (Exit.isFailure(exit)) closed = true;
			})
		)
	);
	let sequence = 0;
	const staged = (source: SnapshotSource, existing?: string) =>
		existing
			? Effect.succeed(existing)
			: io("native-index-stage", async (signal) => {
					const file = join(stage, `${++sequence}.snapshot`);
					await writeSnapshotFile(file, source, 0, undefined, signal, { durable: false });
					return file;
				});
	const publish: SharedIndexWriter["publishBatch"] = Effect.fn("NativeIndexBuilder.publish")(
		function* (entries, removedNames) {
			const inputs = [];
			for (const entry of entries)
				inputs.push({
					name: entry.name,
					key: entry.key,
					file: manifest.layers[entry.key]
						? join(sharedIndexDirectory(options), manifest.layers[entry.key]!.file)
						: yield* staged(entry.source, entry.stagedFile)
				});
			const result = yield* command({
				action: "publish",
				configuration,
				inputs,
				...(removedNames ? { removedNames } : undefined)
			});
			return yield* Schema.decodeUnknownEffect(Schema.Array(LayerRecord))(
				result.records
			).pipe(Effect.mapError((cause) => unavailable("native-index-layer", cause)));
		}
	);
	const writer: SharedIndexWriter = {
		sortsColdStrings: true,
		replacePackages: Effect.fn("NativeIndexBuilder.replacePackages")(
			function* (entries, removedNames) {
				const inputs = [];
				for (const entry of entries)
					inputs.push({
						name: entry.name,
						key: entry.key,
						previousKey: entry.previousKey,
						file: yield* staged(entry.source),
						rows: entry.rows
					});
				const result = yield* command({
					action: "publish_packages",
					configuration,
					inputs,
					...(removedNames ? { removedNames } : undefined)
				});
				return yield* Schema.decodeUnknownEffect(Schema.Array(LayerRecord))(
					result.records
				).pipe(Effect.mapError((cause) => unavailable("native-package-layer", cause)));
			}
		),
		manifest: () => manifest,
		metrics: () => ({
			readBytes: nativeIo.storedBytes,
			indexReadBytes: nativeIo.indexBytes,
			appendedBytes: nativeIo.writtenBytes,
			lookupStrings,
			reusedStrings,
			probePasses: 0,
			sortMs: 0,
			probeMs: 0,
			appendMs: (stageTimes.publish ?? 0) + (stageTimes.publish_packages ?? 0),
			segments: manifest.segments.length,
			timings: {
				collectMs: 0,
				reuseMs: 0,
				layerEncodeMs: 0,
				layerVerifyMs: 0,
				garbageMs: 0,
				rootPublishMs: 0
			}
		}),
		publishBatch: publish,
		publish: (name, key, source) =>
			publish([{ name, key, source }]).pipe(Effect.map((records) => records[0]!)),
		publishColdFiles: Effect.fn("NativeIndexBuilder.publishColdFiles")(
			function* (entries, removedNames) {
				const result = yield* command({
					action: "publish",
					configuration,
					inputs: entries.map((entry) => ({
						name: entry.name,
						key: entry.key,
						file: manifest.layers[entry.key]
							? join(sharedIndexDirectory(options), manifest.layers[entry.key]!.file)
							: entry.stagedFile
					})),
					cold: true,
					...(removedNames ? { removedNames } : undefined)
				});
				return yield* Schema.decodeUnknownEffect(Schema.Array(LayerRecord))(
					result.records
				).pipe(Effect.mapError((cause) => unavailable("native-index-layer", cause)));
			}
		),
		publishCold: Effect.fn("NativeIndexBuilder.publishCold")(function* (entries, removedNames) {
			const inputs = [];
			for (const entry of entries)
				inputs.push({
					name: entry.name,
					key: entry.key,
					file: manifest.layers[entry.key]
						? join(sharedIndexDirectory(options), manifest.layers[entry.key]!.file)
						: yield* staged(entry.source, entry.stagedFile)
				});
			const result = yield* command({
				action: "publish",
				configuration,
				inputs,
				cold: true,
				...(removedNames ? { removedNames } : undefined)
			});
			return yield* Schema.decodeUnknownEffect(Schema.Array(LayerRecord))(
				result.records
			).pipe(Effect.mapError((cause) => unavailable("native-index-layer", cause)));
		}),
		publishIds: Effect.fn("NativeIndexBuilder.publishIds")(
			function* (name, key, source, generation, retained, removed) {
				const file = yield* staged({
					columns: source.columns.map((column) =>
						column.kind === "stringIds"
							? { name: column.name, kind: "u32", load: column.load }
							: column
					)
				});
				const stringColumns = Object.fromEntries(
					source.columns
						.filter((column) => column.kind === "stringIds")
						.map((column) => [column.name, column.domain!])
				);
				const result = yield* command({
					action: "publish_ids",
					configuration,
					name,
					key,
					file,
					generation,
					stringColumns,
					...(retained ? { retained } : undefined),
					...(removed ? { removed } : undefined)
				});
				return yield* Schema.decodeUnknownEffect(LayerRecord)(result.records[0]).pipe(
					Effect.mapError((cause) => unavailable("native-index-layer", cause))
				);
			}
		),
		intern: Effect.fn("NativeIndexBuilder.intern")(function* (domain, values) {
			const ids = new Uint32Array(values.length);
			for (let start = 0; start < values.length; ) {
				const chunks: Uint8Array[] = [];
				let bytes = 0,
					end = start;
				while (end < values.length && end - start < 8192) {
					const value = encodeWtf8(values[end]!);
					snapshotCheck(value.length <= 1024 ** 2, "strings", "String exceeds 1 MiB");
					if (end > start && bytes + value.length + 4 > 16 * 1024 ** 2) break;
					const length = Buffer.allocUnsafe(4);
					length.writeUInt32LE(value.length);
					chunks.push(length, value);
					bytes += value.length + 4;
					end++;
				}
				const file = join(stage, `${++sequence}.strings`);
				yield* io("native-index-intern", (signal) =>
					writeFile(file, Buffer.concat(chunks), { signal })
				);
				const previousCount = manifest.segments.reduce(
					(sum, segment) => sum + segment.count,
					0
				);
				const result = yield* command({ action: "intern", configuration, domain, file });
				lookupStrings += result.ids.length;
				reusedStrings += result.ids.filter((id) => id < previousCount).length;
				snapshotCheck(
					result.ids.length === end - start,
					"strings",
					"Native intern count differs"
				);
				ids.set(result.ids, start);
				start = end;
			}
			return ids;
		}),
		strings: Effect.fn("NativeIndexBuilder.strings")(function* (ids) {
			const values: string[] = [];
			// Each dictionary string is capped at 1 MiB; this bounds the response to 32 MiB.
			for (let start = 0; start < ids.length; start += 32) {
				const selected = ids.slice(start, start + 32),
					output = join(stage, `${++sequence}.strings`);
				const result = yield* command({
					action: "strings",
					configuration,
					ids: [...selected],
					output
				});
				const bytes = yield* io("native-index-strings", (signal) =>
					readFile(output, { signal })
				);
				const size = (selected.length + 1) * 4;
				snapshotCheck(
					result.stringCount === selected.length && bytes.length >= size,
					"strings",
					"Invalid native string response"
				);
				for (let row = 0; row < selected.length; row++) {
					const begin = bytes.readUInt32LE(row * 4),
						end = bytes.readUInt32LE((row + 1) * 4);
					snapshotCheck(
						begin <= end && size + end <= bytes.length,
						"strings",
						"Invalid native string bounds"
					);
					values.push(decodeWtf8(bytes.subarray(size + begin, size + end)));
				}
			}
			return values;
		}),
		compact: (force) =>
			command({
				action: "compact",
				configuration,
				...(force === undefined ? undefined : { force })
			}).pipe(
				Effect.flatMap((result) =>
					result.compaction
						? Effect.succeed(result.compaction)
						: Effect.fail(unavailable("native-index-compact", "Missing result"))
				)
			)
	};
	const refreshJoinedTarget: import("./joined-target.js").RefreshJoinedTarget = Effect.fn(
		"NativeIndexBuilder.join"
	)(function* (input) {
		const file = join(stage, `${++sequence}.join.json`);
		yield* io("native-index-join-stage", (signal) =>
			writeFile(file, JSON.stringify(encodeGameTextJoinInput(JSON.stringify(input))), {
				signal
			})
		);
		const response = yield* command({ action: "join", configuration, file });
		const result = response.join;
		if (!result)
			return yield* Effect.fail(unavailable("native-index-join", "Missing join result"));
		if (!result.rebuilt)
			return {
				rebuilt: false,
				key: result.key,
				bytes: result.bytes,
				count: null,
				keyChanges: null
			};
		if (result.count === null || result.keyChanges === null)
			return yield* Effect.fail(unavailable("native-index-join", "Missing rebuilt counts"));
		if (result.strategy === "incremental") {
			if (result.affectedLines === null)
				return yield* Effect.fail(
					unavailable("native-index-join", "Missing affected row count")
				);
			return {
				rebuilt: true,
				strategy: "incremental" as const,
				key: result.key,
				bytes: result.bytes,
				count: result.count,
				keyChanges: result.keyChanges,
				affectedLines: result.affectedLines
			};
		}
		return {
			rebuilt: true,
			strategy: "full" as const,
			incrementalFallback: response.incrementalFallback,
			key: result.key,
			bytes: result.bytes,
			count: result.count,
			keyChanges: result.keyChanges
		};
	});
	let ended = false;
	return {
		writer,
		refreshJoinedTarget,
		/** Whether `end` ran and succeeded, releasing the native writer lease in this process. */
		ended: () => ended,
		close: (): Effect.Effect<void, SnapshotStoreError> =>
			closed
				? Effect.void
				: command({ action: "end", configuration }).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								ended = true;
							})
						),
						Effect.asVoid,
						Effect.ensuring(
							Effect.sync(() => {
								closed = true;
							})
						)
					)
	};
});

/**
 * Writer processes kept between build sessions. A rescan opens two sessions back to back, and each
 * new process costs a spawn and a protocol handshake. Idle processes exit after this long.
 */
const WRITER_PROCESS_IDLE = Duration.seconds(30);
const WRITER_PROCESS_LIMIT = 4;

/** Native storage and joins with explicit worker configuration; TS producers own extraction policy. */
export const nativeIndexBuilderLayer = (configuration: AssetReaderConfiguration) =>
	Layer.effect(
		GameTextIndexBuilder,
		Effect.gen(function* () {
			// A process is reused only after its session's `end` succeeded, which releases the native
			// writer lease and its file lock. A failed command, a failed `end` or an interruption
			// discards it.
			const writers = yield* Pool.makeWithTTL({
				acquire: Layer.build(nativeGameTextIndexClientLayer(configuration)).pipe(
					Effect.map((services) => Context.get(services, NativeGameTextIndexClient))
				),
				min: 0,
				max: WRITER_PROCESS_LIMIT,
				timeToLive: WRITER_PROCESS_IDLE,
				timeToLiveStrategy: "usage"
			});
			return GameTextIndexBuilder.of({
				importLocalizationFile,
				importLocalizationTarget,
				refreshPackageTextLayer,
				intern: Effect.fn("NativeIndexBuilder.intern")(function* (domain, values) {
					const index = yield* SharedIndex;
					return yield* (yield* index.writer()).intern(domain, values);
				}),
				compact: Effect.fn("NativeIndexBuilder.compact")(function* (force) {
					const index = yield* SharedIndex;
					return yield* (yield* index.writer()).compact(force);
				}),
				withSession: (request, effect) =>
					Effect.scoped(
						Effect.gen(function* () {
							const client = yield* Pool.get(writers);
							let endedCleanly = false;
							yield* Effect.addFinalizer(() =>
								endedCleanly ? Effect.void : Pool.invalidate(writers, client)
							);
							const backing = yield* SharedIndex;
							const stage = yield* Effect.acquireRelease(
								io("native-index-stage", async () => {
									await mkdir(request.configuration.cacheRoot, {
										recursive: true
									});
									return mkdtemp(
										join(request.configuration.cacheRoot, "native-build-")
									);
								}),
								(path) =>
									Effect.promise(() => rm(path, { recursive: true, force: true }))
							);
							const native = yield* Effect.acquireRelease(
								makeWriter(request.configuration, stage).pipe(
									Effect.provideService(NativeGameTextIndexClient, client)
								),
								(native) =>
									native.close().pipe(
										Effect.andThen(
											Effect.sync(() => {
												endedCleanly = native.ended();
											})
										),
										Effect.catch((cause) =>
											Effect.logWarning(
												"Native index session cleanup failed",
												cause
											)
										)
									),
								{ interruptible: true }
							);
							const leased = SharedIndex.of({
								...backing,
								inspect: () => Effect.succeed(native.writer.manifest()),
								writer: () => Effect.succeed(native.writer)
							});
							return yield* effect.pipe(
								Effect.provideService(SharedIndex, leased),
								Effect.provideService(NativeBuildSession, native),
								Effect.provideService(LocalizationImportSession, {
									configuration: request.configuration,
									index: leased,
									...(request.files && native.writer.manifest().active.joined
										? { files: request.files }
										: undefined)
								})
							);
						})
					).pipe(Effect.provide(sharedIndexNodeLayer(request.configuration))),
				refreshJoinedTarget: Effect.fn("NativeIndexBuilder.refreshJoinedTarget")(
					function* (input) {
						const session = yield* Effect.serviceOption(NativeBuildSession);
						if (Option.isNone(session))
							return yield* Effect.fail(
								unavailable(
									"native-index-session",
									"Call withSession around native build operations."
								)
							);
						return yield* session.value.refreshJoinedTarget(input);
					}
				)
			});
		})
	).pipe(Layer.merge(nativeIndexQueryLayer(configuration)));

/**
 * Production index builder, using the host's existing AssetReader configuration. Each build owns
 * a scoped native process and writer lease. Capability or process failures are reported to the
 * caller and never select a JavaScript query backend.
 */
export const GameTextIndexBuilderLive = Layer.unwrap(
	Effect.gen(function* () {
		const reader = yield* AssetReader;
		const configuration = yield* reader.configuration();
		return nativeIndexBuilderLayer(configuration);
	})
);
