import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import * as zlib from "node:zlib";
import { Context, Effect, Layer, Metric, Schema, Semaphore, type Scope } from "effect";
import { SnapshotFormatError, snapshotFailure, type SnapshotDirectory } from "./snapshot-format.js";
import {
	openSnapshotFile,
	writeSnapshotFile,
	type SnapshotSource,
	type SnapshotLoadedDomain,
	type SnapshotFileReader
} from "./snapshot-file.js";
export { snapshotNodeChecksum } from "./snapshot-file.js";

export const GAME_TEXT_SNAPSHOT_NAMESPACE = "game-text-v1";
export const SNAPSHOT_ZSTD_LEVEL = 1;
export const SNAPSHOT_STRING_ZSTD_LEVEL = 3;
export const snapshotCompressionLevel = (
	column: Pick<SnapshotSource["columns"][number], "kind" | "compressionLevel">
) =>
	column.compressionLevel ??
	(column.kind === "strings" ? SNAPSHOT_STRING_ZSTD_LEVEL : SNAPSHOT_ZSTD_LEVEL);
export const snapshotStoreMetrics = {
	opens: Metric.counter("ue_shed_game_text_snapshot_open_total", { incremental: true }),
	publishes: Metric.counter("ue_shed_game_text_snapshot_publish_total", { incremental: true }),
	quarantines: Metric.counter("ue_shed_game_text_snapshot_quarantine_total", {
		incremental: true
	}),
	rawBytes: Metric.gauge("ue_shed_game_text_snapshot_raw_bytes")
};
const maximumManifestBytes = 1024 * 1024;
const snapshotName = /^snapshot-[a-f0-9-]+\.snapshot$/u;
const SnapshotName = Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(snapshotName));
const InputKeys = Schema.Record(
	Schema.String.check(Schema.isMaxLength(1024)),
	Schema.String.check(Schema.isMaxLength(1024))
);
const Manifest = Schema.Struct({
	manifestVersion: Schema.Literal(1),
	formatVersion: Schema.Literal(3),
	identity: Schema.String,
	physicalSnapshot: SnapshotName,
	previousSnapshot: Schema.NullOr(SnapshotName),
	inputKeys: InputKeys
});
export type SnapshotManifest = typeof Manifest.Type;
const Owner = Schema.Struct({
	pid: Schema.Int.check(Schema.isGreaterThan(0)),
	host: Schema.String,
	token: Schema.String.check(Schema.isPattern(/^[a-f0-9-]+$/u))
});
const StoreConfiguration = Schema.Struct({
	cacheRoot: Schema.NonEmptyString.check(Schema.isMaxLength(32767)),
	projectKey: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
	targetKey: Schema.NonEmptyString.check(Schema.isMaxLength(4096))
});
export class SnapshotStoreError extends Schema.TaggedErrorClass<SnapshotStoreError>()(
	"SnapshotStoreError",
	{
		operation: Schema.String,
		code: Schema.Literals(["unavailable", "busy", "missing", "invalid_input"]),
		message: Schema.String,
		recovery: Schema.String
	}
) {}
type StoreFailure = SnapshotStoreError | SnapshotFormatError;
function failure(operation: string, cause: unknown): StoreFailure {
	if (cause instanceof SnapshotStoreError || cause instanceof SnapshotFormatError) return cause;
	return new SnapshotStoreError({
		operation,
		code: "unavailable",
		message: String(cause),
		recovery: "Retry after resolving the cache filesystem failure."
	});
}
const busy = () =>
	new SnapshotStoreError({
		operation: "writer",
		code: "busy",
		message: "Another Game Text snapshot writer owns this target.",
		recovery: "Retry after the writer exits. Unreadable or foreign locks require inspection."
	});
const hasCode = (cause: unknown, code: string) =>
	cause instanceof Error && "code" in cause && cause.code === code;

/** Bound reads through the opened handle, including growth after stat. Never readFile an input. */
async function readBounded(
	path: string,
	maximum: number,
	section: string,
	onRead?: (bytes: number) => void
) {
	const handle = await open(path, "r");
	try {
		const size = (await handle.stat()).size;
		if (!Number.isSafeInteger(size) || size < 0 || size > maximum)
			throw snapshotFailure(section, "File length exceeds limit");
		const bytes = new Uint8Array(size);
		let position = 0;
		while (position < size) {
			const { bytesRead } = await handle.read(
				bytes,
				position,
				Math.min(8 * 1024 * 1024, size - position),
				position
			);
			if (bytesRead === 0) throw snapshotFailure(section, "File truncated during read");
			onRead?.(bytesRead);
			position += bytesRead;
		}
		const extra = new Uint8Array(1);
		if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0)
			throw snapshotFailure(section, "File grew during read");
		return bytes;
	} finally {
		await handle.close();
	}
}
async function syncDirectory(path: string) {
	// Node cannot open directory handles on Windows. File fsync + atomic rename is the available
	// contract there; POSIX also syncs the parent directory. This is not a power-loss guarantee.
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
async function removeOwned(path: string) {
	try {
		await unlink(path);
	} catch (cause) {
		if (!hasCode(cause, "ENOENT")) throw cause;
	}
}
async function writeAtomic(path: string, bytes: Uint8Array, checkpoint?: () => Promise<void>) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	// Ownership starts only once exclusive creation succeeds.
	const handle = await open(temporary, "wx");
	try {
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await checkpoint?.();
		await rename(temporary, path);
	} finally {
		await removeOwned(temporary);
	}
}
async function removeEmpty(path: string) {
	try {
		await rmdir(path);
	} catch (cause) {
		if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTEMPTY") && !hasCode(cause, "EEXIST"))
			throw cause;
	}
}
async function acquireLock(directory: string) {
	const lock = `${directory}.lock`;
	const token = randomUUID();
	const candidate = `${lock}.${token}.candidate`;
	const name = `owner-${token}.json`;
	await mkdir(candidate);
	try {
		await writeAtomic(
			join(candidate, name),
			new TextEncoder().encode(JSON.stringify({ pid: process.pid, host: hostname(), token }))
		);
		try {
			await rename(candidate, lock);
		} catch (cause) {
			if (
				!hasCode(cause, "EEXIST") &&
				!hasCode(cause, "ENOTEMPTY") &&
				!hasCode(cause, "EPERM")
			)
				throw cause;
			// Candidate directories are nonempty before rename; a crash cannot leave an empty lock.
			const names = await readdir(lock);
			if (names.length !== 1 || !/^owner-[a-f0-9-]+\.json$/u.test(names[0]!)) throw busy();
			const ownerPath = join(lock, names[0]!);
			let owner;
			try {
				owner = Schema.decodeUnknownSync(Schema.fromJsonString(Owner))(
					new TextDecoder().decode(await readBounded(ownerPath, 4096, "lock"))
				);
			} catch {
				throw busy();
			}
			if (owner.host !== hostname() || names[0] !== `owner-${owner.token}.json`) throw busy();
			try {
				process.kill(owner.pid, 0);
				throw busy();
			} catch (error) {
				if (!hasCode(error, "ESRCH")) throw busy();
			}
			await removeOwned(ownerPath);
			await removeEmpty(lock);
			try {
				await rename(candidate, lock);
			} catch {
				throw busy();
			}
		}
	} catch (cause) {
		await removeOwned(join(candidate, name));
		await removeEmpty(candidate);
		throw cause;
	}
	return async () => {
		await removeOwned(join(lock, name));
		await removeEmpty(lock);
	};
}

export interface SnapshotReader {
	readonly manifest: SnapshotManifest;
	readonly directory: SnapshotDirectory;
	readonly section: (name: string) => Effect.Effect<Uint8Array | Uint32Array, StoreFailure>;
	readonly domain: (domain: string) => Effect.Effect<SnapshotLoadedDomain, StoreFailure>;
	readonly strings: (
		domain: string,
		ids: readonly number[]
	) => Effect.Effect<string[], StoreFailure>;
}
export interface SnapshotWriter {
	readonly publish: (
		source: SnapshotSource,
		inputKeys: typeof InputKeys.Type
	) => Effect.Effect<SnapshotManifest, StoreFailure>;
}
export interface SnapshotStoreApi {
	readonly open: () => Effect.Effect<SnapshotReader, StoreFailure, Scope.Scope>;
	readonly writer: () => Effect.Effect<SnapshotWriter, StoreFailure, Scope.Scope>;
}
export class SnapshotStore extends Context.Service<SnapshotStore, SnapshotStoreApi>()(
	"@ue-shed/game-text/SnapshotStore"
) {}

export interface SnapshotStoreOptions {
	readonly cacheRoot: string;
	readonly projectKey: string;
	readonly targetKey: string;
	/** Physical read instrumentation, including directories and persisted verification. */
	readonly onRead?: (bytes: number) => void;
	/** Deterministic fault injection at the two rename boundaries; useful for process-crash tests. */
	readonly beforeRename?: (kind: "snapshot" | "manifest") => Promise<void>;
}
export function snapshotStoreDirectory(options: SnapshotStoreOptions): string {
	const identity = JSON.stringify([options.projectKey, options.targetKey]);
	return join(
		options.cacheRoot,
		GAME_TEXT_SNAPSHOT_NAMESPACE,
		createHash("sha256").update(identity).digest("hex")
	);
}

export function snapshotStoreNodeLayer(
	options: SnapshotStoreOptions
): Layer.Layer<SnapshotStore, SnapshotStoreError> {
	return Layer.unwrap(
		Schema.decodeUnknownEffect(StoreConfiguration)(options).pipe(
			Effect.mapError(
				(cause) =>
					new SnapshotStoreError({
						operation: "configure",
						code: "invalid_input",
						message: String(cause),
						recovery:
							"Provide a bounded cache root and nonempty project and target keys."
					})
			),
			Effect.flatMap(() => {
				if (!zlib.createZstdCompress || !zlib.createZstdDecompress)
					return Effect.fail(
						new SnapshotStoreError({
							operation: "configure",
							code: "unavailable",
							message:
								"Built-in zstd is unavailable for the Game Text snapshot store.",
							recovery: "Use Node 24 or 26 for the Node snapshot store."
						})
					);
				return Effect.succeed(makeNodeLayer(options));
			})
		)
	);
}

function makeNodeLayer(options: SnapshotStoreOptions): Layer.Layer<SnapshotStore> {
	const directory = snapshotStoreDirectory(options);
	const identity = JSON.stringify([options.projectKey, options.targetKey]);
	const boundary = <A>(operation: string, run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) });
	async function manifest(): Promise<SnapshotManifest | null> {
		let bytes;
		try {
			bytes = await readBounded(
				join(directory, "manifest.json"),
				maximumManifestBytes,
				"manifest",
				options.onRead
			);
		} catch (cause) {
			if (hasCode(cause, "ENOENT")) return null;
			throw cause;
		}
		try {
			const value = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes)
			);
			if (value.identity !== identity)
				throw snapshotFailure("manifest", "Target identity mismatch");
			return value;
		} catch (cause) {
			throw snapshotFailure("manifest", `Invalid manifest: ${String(cause)}`);
		}
	}
	async function openReader(): Promise<{ manifest: SnapshotManifest; file: SnapshotFileReader }> {
		const value = await manifest();
		if (value === null)
			throw new SnapshotStoreError({
				operation: "open",
				code: "missing",
				message: "No Game Text snapshot is published.",
				recovery: "Refresh the target to build its snapshot."
			});
		try {
			return {
				manifest: value,
				file: await openSnapshotFile(
					join(directory, value.physicalSnapshot),
					options.onRead ? { onRead: options.onRead } : undefined
				)
			};
		} catch (cause) {
			if (hasCode(cause, "ENOENT"))
				throw snapshotFailure("snapshot", "Manifest names a missing snapshot");
			throw cause;
		}
	}
	async function quarantine() {
		const destination = `${directory}.quarantine-${randomUUID()}`;
		await mkdir(destination);
		for (const name of await readdir(directory))
			await rename(join(directory, name), join(destination, name));
		await syncDirectory(destination);
	}
	async function cleanup(value: SnapshotManifest | null) {
		for (const name of await readdir(directory)) {
			if (name === value?.physicalSnapshot || name === value?.previousSnapshot) continue;
			if (snapshotName.test(name) || /^.+\.[a-f0-9-]+\.tmp$/u.test(name))
				await removeOwned(join(directory, name));
		}
	}
	return Layer.effect(
		SnapshotStore,
		Effect.sync(() => {
			const openReaderEffect = Effect.fn("GameTextSnapshot.open")(function* () {
				const mutex = yield* Semaphore.make(1);
				let active = true;
				const columns = new Map<string, Uint8Array | Uint32Array>();
				const reader = yield* Effect.acquireRelease(
					boundary("open", openReader),
					(reader) =>
						mutex
							.withPermits(1)(
								boundary("close", async () => {
									active = false;
									await reader.file.close();
									columns.clear();
								})
							)
							.pipe(Effect.orDie)
				);
				const section = Effect.fn("GameTextSnapshot.section")((name: string) =>
					mutex
						.withPermits(1)(
							boundary("section", async () => {
								if (!active) throw snapshotFailure(name, "Reader scope is closed");
								if (reader.file.directory.entries.get(name)?.kind === "strings")
									return reader.file.load(name);
								const existing = columns.get(name);
								if (existing !== undefined) return existing;
								const values = await reader.file.load(name);
								columns.set(name, values);
								return values;
							})
						)
						.pipe(Effect.uninterruptible)
				);
				const strings = Effect.fn("GameTextSnapshot.strings")(
					(domain: string, ids: readonly number[]) =>
						mutex
							.withPermits(1)(
								boundary("strings", () => reader.file.strings(domain, ids))
							)
							.pipe(Effect.uninterruptible)
				);
				const domain = Effect.fn("GameTextSnapshot.domain")((domain: string) =>
					mutex
						.withPermits(1)(boundary("domain", () => reader.file.domain(domain)))
						.pipe(Effect.uninterruptible)
				);
				yield* Metric.update(snapshotStoreMetrics.opens, 1);
				yield* Metric.update(
					snapshotStoreMetrics.rawBytes,
					[...reader.file.directory.entries.values()].reduce(
						(sum, entry) => sum + entry.rawLength,
						0
					)
				);
				yield* Effect.logDebug("Game Text snapshot directory opened", {
					sections: reader.file.directory.entries.size,
					formatVersion: 3
				});
				return {
					manifest: reader.manifest,
					directory: reader.file.directory,
					domain,
					section,
					strings
				};
			});
			const writer = Effect.fn("GameTextSnapshot.writer")(function* () {
				let active = true;
				const release = yield* Effect.acquireRelease(
					boundary("lock", async () => {
						await mkdir(directory, { recursive: true });
						return acquireLock(directory);
					}),
					(release) =>
						boundary("unlock", async () => {
							active = false;
							await release();
						}).pipe(Effect.orDie)
				);
				// The scope owns release; keep it out of the public writer interface.
				void release;
				let current: SnapshotManifest | null = null;
				let quarantined = false;
				yield* boundary("recover", async () => {
					try {
						current = await manifest();
						if (current !== null) {
							const reader = await openReader();
							try {
								await reader.file.verify();
							} finally {
								await reader.file.close();
							}
						}
					} catch (cause) {
						if (!(cause instanceof SnapshotFormatError)) throw cause;
						await quarantine();
						quarantined = true;
						current = null;
					}
					await cleanup(current);
				}).pipe(Effect.uninterruptible);
				if (quarantined) {
					yield* Metric.update(snapshotStoreMetrics.quarantines, 1);
					yield* Effect.logDebug("Damaged Game Text snapshot quarantined");
				}
				const mutex = yield* Semaphore.make(1);
				let uncertain = false;
				const publish = Effect.fn("GameTextSnapshot.publish")(
					(source: SnapshotSource, inputKeys: typeof InputKeys.Type) =>
						mutex
							.withPermits(1)(
								boundary("publish", async () => {
									if (!active)
										throw new SnapshotStoreError({
											operation: "publish",
											code: "unavailable",
											message: "The writer scope is closed.",
											recovery: "Acquire a new scoped writer."
										});
									if (uncertain)
										throw new SnapshotStoreError({
											operation: "publish",
											code: "unavailable",
											message: "Manifest publication outcome is uncertain.",
											recovery:
												"Close and reopen the writer before publishing again."
										});
									let keys;
									try {
										keys = Schema.decodeUnknownSync(InputKeys)(inputKeys);
									} catch (cause) {
										throw new SnapshotStoreError({
											operation: "publish",
											code: "invalid_input",
											message: String(cause),
											recovery: "Provide bounded string input keys."
										});
									}
									const physicalSnapshot = `snapshot-${randomUUID()}.snapshot`;
									const value = Manifest.make({
										manifestVersion: 1,
										formatVersion: 3,
										identity,
										physicalSnapshot,
										previousSnapshot: current?.physicalSnapshot ?? null,
										inputKeys: keys
									});
									const manifestBytes = new TextEncoder().encode(
										JSON.stringify(value) + "\n"
									);
									if (manifestBytes.length > maximumManifestBytes)
										throw snapshotFailure("manifest", "Manifest exceeds 1 MiB");
									const snapshotPath = join(directory, physicalSnapshot);
									const temporary = `${snapshotPath}.${randomUUID()}.tmp`;
									// Exclusive destination reservation preserves nonce-collision ownership.
									const reservation = await open(snapshotPath, "wx");
									await reservation.close();
									try {
										await writeSnapshotFile(
											temporary,
											source,
											snapshotCompressionLevel
										);
										await options.beforeRename?.("snapshot");
										await rename(temporary, snapshotPath);
										await syncDirectory(directory);
										const persisted = await openSnapshotFile(
											snapshotPath,
											options.onRead ? { onRead: options.onRead } : undefined
										);
										try {
											await persisted.verify();
										} finally {
											await persisted.close();
										}
									} catch (cause) {
										await removeOwned(snapshotPath);
										throw cause;
									} finally {
										await removeOwned(temporary);
									}
									// From this point retain the candidate even if rename succeeded before a later error.
									uncertain = true;
									await writeAtomic(
										join(directory, "manifest.json"),
										manifestBytes,
										() =>
											options.beforeRename?.("manifest") ?? Promise.resolve()
									);
									await syncDirectory(directory);
									current = value;
									uncertain = false;
									await cleanup(value);
									return value;
								})
							)
							.pipe(
								Effect.tap(() => Metric.update(snapshotStoreMetrics.publishes, 1)),
								Effect.tap(() =>
									Effect.logDebug("Game Text snapshot published", {
										sections: source.columns.length,
										formatVersion: 3
									})
								),
								Effect.uninterruptible
							)
				);
				return { publish };
			});
			return SnapshotStore.of({ open: openReaderEffect, writer });
		})
	);
}
