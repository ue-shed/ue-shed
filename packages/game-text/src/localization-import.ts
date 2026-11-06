import type { BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	open,
	realpath,
	rm,
	stat,
	rename,
	readFile,
	writeFile
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { localizationImport, type GameTextContract } from "@ue-shed/protocol";
import { withNativeLocalizationSession } from "./localization-native-session.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { Context, Effect, Metric, Option, Result, Schema } from "effect";
import {
	LocalizationError,
	FileProvenance,
	LocalizationEvidence,
	LocalizationTarget,
	resolveLocalizationGatherPath,
	LocalizationProjectRequest
} from "@ue-shed/localization";
import {
	localizationColumnsBuilder,
	type LocalizationImportOptions
} from "./localization-columns.js";
import {
	defaultLocalizationImportLimits,
	importFailure,
	LocalizationImportLimits
} from "./localization-stream.js";
import { SnapshotStoreError } from "./snapshot-store.js";
import {
	SharedIndex,
	sharedIndexNodeLayer,
	sharedIndexDirectory,
	type SharedIndexOptions
} from "./shared-index.js";
import { SnapshotFormatError } from "./snapshot-format.js";
import {
	LocalizationImportSession,
	localizationImportLayer
} from "./localization-import-session.js";

export {
	decodeLocalizationSnapshot,
	type LocalizationFileFormat,
	type LocalizationImportOptions
} from "./localization-columns.js";
export {
	defaultLocalizationImportLimits,
	type LocalizationImportLimits
} from "./localization-stream.js";
/**
 * Version of retained localization import semantics in every content key. The native engine owns
 * it and the keys; hosts keep the keys it returns.
 */
export const LOCALIZATION_IMPORT_VERSION = localizationImport.version;
/**
 * Version of the host's stat hints. 2: a hint keeps the key the engine returned rather than a key
 * the host derived, so hints written before are ignored instead of trusted.
 */
const STAT_HINT_VERSION = 2;
/** Most bytes the engine reads and parses at once, unless a host budget is smaller. */
const MAXIMUM_IN_FLIGHT_BYTES = 256 * 1024 ** 2;
/**
 * Owned positioned-read handle for localization evidence. Reads may be partial; stat uses
 * bigint filesystem metadata and close releases the handle independently of any derived
 * snapshot.
 */
export interface LocalizationImportSourceFile {
	readonly read: (
		bytes: Uint8Array,
		offset: number,
		length: number,
		position: number
	) => Promise<{ readonly bytesRead: number }>;
	readonly stat: () => Promise<BigIntStats>;
	readonly close: () => Promise<void>;
}
/** Positioned source IO; its default owns a real Node file handle. */
const nodeSource = {
	open: async (path: string): Promise<LocalizationImportSourceFile> => {
		const handle = await open(path, "r");
		return {
			read: (bytes, offset, length, position) => handle.read(bytes, offset, length, position),
			stat: () => handle.stat({ bigint: true }),
			close: () => handle.close()
		};
	}
};
/**
 * Positioned source-file adapter. With its Node default the native engine reads the files; any
 * other adapter, like a writer without a native import, selects the TypeScript reference parser.
 * Alternate hosts must preserve stat/read consistency and close resources when the import ends.
 */
export const LocalizationImportSource = Context.Reference<{
	readonly open: (path: string) => Promise<LocalizationImportSourceFile>;
}>("@ue-shed/game-text/LocalizationImportSource", {
	defaultValue: () => nodeSource
});
/**
 * Import counters for bytes read, parsed versus reused files, and dictionary lookups. They
 * describe actual work at the import boundary rather than end-to-end query or UI latency.
 */
export const localizationImportMetrics = {
	bytes: Metric.counter("game_text.localization_import.bytes"),
	parsed: Metric.counter("game_text.localization_import.parsed"),
	reused: Metric.counter("game_text.localization_import.reused"),
	lookupStrings: Metric.counter("game_text.localization_import.dictionary_lookup_strings")
};
const Positive = Schema.Int.check(Schema.isGreaterThan(0));
const Options = Schema.Struct({
	format: Schema.Literals(["manifest", "archive", "po"]),
	poFormat: Schema.optionalKey(Schema.Literals(["Unreal", "Crowdin"])),
	collapseMode: Schema.optionalKey(
		Schema.Literals([
			"IdenticalTextIdAndSource",
			"IdenticalNamespaceAndSource",
			"IdenticalPackageIdTextIdAndSource"
		])
	)
});
const FileRequest = Options.pipe(
	Schema.fieldsAssign({
		projectRoot: Schema.NonEmptyString,
		relativePath: Schema.NonEmptyString,
		cacheRoot: Schema.NonEmptyString,
		limits: Schema.optionalKey(LocalizationImportLimits),
		chunkBytes: Schema.optionalKey(Positive),
		sharedTargetKey: Schema.optionalKey(Schema.NonEmptyString),
		projectScoped: Schema.optionalKey(Schema.Boolean)
	})
);
/**
 * One localization file's project/cache identity, format and import limits. Paths identify
 * authored evidence; derived snapshots remain disposable and must not replace those files.
 */
export type LocalizationFileImportRequest = typeof FileRequest.Type;
/**
 * Validated identity and provenance of a retained parsed localization file. It identifies reuse
 * evidence, not a durable authored-file ID or permission to mutate the source.
 *
 * One native call imports many files, so the call's dictionary and store counters
 * (`lookupStrings`, `reusedStrings`, `shared*`, `profile`, `stages`) are reported on the first
 * file it imported and are zero on the others.
 */
export interface LocalizationFileSnapshotKey {
	readonly key: string;
	readonly contentHash: string;
	readonly provenance: FileProvenance;
	readonly relativePath: string;
	readonly format: LocalizationImportOptions["format"];
	/** True when a new parsed snapshot was published. */
	readonly parsed: boolean;
	readonly statHit: boolean;
	readonly readBytes: number;
	readonly inputBytes: number;
	readonly snapshotBytes: number;
	readonly directory: string;
	readonly sharedBytesAppended: number;
	readonly sharedReadBytes: number;
	readonly sharedIndexReadBytes: number;
	readonly lookupStrings: number;
	readonly reusedStrings: number;
	readonly probePasses: number;
	readonly profile: {
		readonly sortMs: number;
		readonly probeMs: number;
		readonly appendMs: number;
		readonly segments: number;
		readonly stages?: Readonly<Record<string, number>>;
	};
	/** Import timings in milliseconds of the work this file was part of. */
	readonly stages?: Readonly<Record<string, number>>;
}
/**
 * One native import's work: stat hits that needed no read, files the engine imported or that
 * failed, its calls with their parse and publish time, and the writer's store counters after.
 */
export interface LocalizationImportProfile {
	readonly files: number;
	readonly statHits: number;
	readonly imported: number;
	readonly failed: number;
	readonly nativeCalls: number;
	readonly workerCount: number;
	readonly memoryBudgetBytes: number;
	readonly parseMs: number;
	readonly parseCpuMs: number;
	readonly publishMs: number;
	readonly readBytes: number;
	readonly indexReadBytes: number;
	readonly appendedBytes: number;
	readonly lookupStrings: number;
	readonly reusedStrings: number;
	readonly probePasses: number;
	readonly sortMs: number;
	readonly probeMs: number;
	readonly appendMs: number;
	readonly segments: number;
}
function contained(root: string, path: string) {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function fileError(file: string, cause: unknown) {
	if (
		Schema.is(LocalizationError)(cause) ||
		Schema.is(SnapshotStoreError)(cause) ||
		Schema.is(SnapshotFormatError)(cause)
	)
		return cause;
	return importFailure(
		file,
		cause instanceof Error && "code" in cause && cause.code === "ENOENT"
			? "file_missing"
			: "file_unreadable"
	);
}
const io = <A>(file: string, run: () => Promise<A>) =>
	Effect.tryPromise({ try: run, catch: (cause) => fileError(file, cause) }).pipe(
		Effect.uninterruptible
	);

const Stamp = Schema.Struct({
	size: Schema.Finite,
	mtimeNs: Schema.String,
	ctimeNs: Schema.String,
	ino: Schema.String,
	dev: Schema.String
});
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
/** A stat hint: the metadata observed before the file was read, and the key that read returned. */
const StatHint = Schema.Struct({ stamp: Stamp, contentHash: Digest, key: Digest });
function stamp(value: BigIntStats) {
	return {
		size: Number(value.size),
		mtimeNs: String(value.mtimeNs),
		ctimeNs: String(value.ctimeNs),
		ino: String(value.ino),
		dev: String(value.dev)
	};
}
function sameStamp(a: typeof Stamp.Type, b: typeof Stamp.Type) {
	return (
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs &&
		a.ino === b.ino &&
		a.dev === b.dev
	);
}
/** A validated file request, the metadata observed before any read, and its stat hint. */
interface PreparedFile {
	readonly file: string;
	readonly cacheRoot: string;
	readonly options: typeof Options.Type;
	readonly limits: LocalizationImportLimits;
	readonly chunkBytes: number | undefined;
	readonly actualRoot: string;
	readonly actual: string;
	readonly observed: typeof Stamp.Type;
	readonly hintPath: string;
	readonly hint: typeof StatHint.Type | undefined;
	readonly hintBytes: number;
}
type ImportFailure = LocalizationError | SnapshotStoreError | SnapshotFormatError;
/** Validates the path, observes the file's metadata and reads its stat hint; never its bytes. */
const prepareFile = Effect.fn("LocalizationImport.prepareFile")(function* (
	input: LocalizationFileImportRequest
): Effect.fn.Return<PreparedFile, ImportFailure> {
	const boundary = Schema.decodeResult(FileRequest)(input);
	if (Result.isFailure(boundary)) return yield* importFailure("input", "invalid_schema");
	const request = boundary.success;
	const file = request.relativePath;
	const limits = request.limits ?? defaultLocalizationImportLimits;
	const optionsResult = Schema.decodeResult(Options)(request);
	if (Result.isFailure(optionsResult)) return yield* importFailure(file, "invalid_schema");
	const options = optionsResult.success;
	if (request.chunkBytes !== undefined && request.chunkBytes > 1024 * 1024)
		return yield* importFailure(file, "limit_exceeded");
	const path = resolveLocalizationGatherPath(file);
	const normalized = path.root === "project" ? path.path : file;
	const root = resolve(request.projectRoot);
	const candidate = resolve(root, normalized);
	if (
		isAbsolute(normalized) ||
		normalized.includes("\u0000") ||
		normalized.includes("%") ||
		!contained(root, candidate)
	)
		return yield* importFailure(file, "unsafe_path");
	const actualRoot = yield* Effect.tryPromise({
		try: () => realpath(root),
		catch: () => importFailure(file, "directory_unreadable")
	});
	const actual = yield* io(file, () => realpath(candidate));
	if (!contained(actualRoot, actual)) return yield* importFailure(file, "unsafe_path");
	const before = yield* io(file, () => stat(actual, { bigint: true }));
	if (!before.isFile()) return yield* importFailure(file, "file_unreadable");
	if (before.size > limits.maxFileBytes) return yield* importFailure(file, "limit_exceeded");
	const hintPath = join(
		request.cacheRoot,
		"localization-file-stats",
		createHash("sha256")
			.update(
				JSON.stringify([
					STAT_HINT_VERSION,
					LOCALIZATION_IMPORT_VERSION,
					actualRoot,
					actual,
					options
				])
			)
			.digest("hex") + ".json"
	);
	let hintBytes = 0;
	const hint = yield* io(file, async () => {
		try {
			if ((await stat(hintPath)).size > 4096) return undefined;
			const bytes = await readFile(hintPath, "utf8");
			hintBytes = Buffer.byteLength(bytes);
			const decoded = Schema.decodeResult(Schema.fromJsonString(StatHint))(bytes);
			return Result.isSuccess(decoded) ? decoded.success : undefined;
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				return undefined;
			throw cause;
		}
	});
	return {
		file,
		cacheRoot: request.cacheRoot,
		options,
		limits,
		chunkBytes: request.chunkBytes,
		actualRoot,
		actual,
		observed: stamp(before),
		hintPath,
		hint,
		hintBytes
	};
});
/** Keeps only the metadata observed before the read, so a later write invalidates the hint. */
const rememberHint = Effect.fn("LocalizationImport.rememberHint")(function* (
	prepared: PreparedFile,
	contentHash: string,
	key: string
) {
	yield* io(prepared.file, async () => {
		await mkdir(dirname(prepared.hintPath), { recursive: true });
		const temporary = `${prepared.hintPath}.${randomUUID()}.tmp`;
		try {
			await writeFile(
				temporary,
				JSON.stringify({ stamp: prepared.observed, contentHash, key }),
				{ flag: "wx" }
			);
			await rename(temporary, prepared.hintPath);
		} finally {
			await rm(temporary, { force: true });
		}
	});
});
/** Activates a retained layer by key and returns its bytes; fails `missing` when it is gone. */
const activateRetained = (file: string, key: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const store = yield* SharedIndex;
			const manifest = yield* store.inspect;
			const record = yield* store.cached(key);
			if (manifest.active[file] !== record.key) {
				const writer = yield* store.writer;
				yield* writer.publish(file, record.key, { columns: [] });
			}
			return record.bytes;
		})
	);
const missingLayer = (cause: unknown) =>
	Schema.is(SnapshotStoreError)(cause) && cause.code === "missing";

type ImportCounters = Pick<
	LocalizationFileSnapshotKey,
	| "sharedBytesAppended"
	| "sharedReadBytes"
	| "sharedIndexReadBytes"
	| "lookupStrings"
	| "reusedStrings"
	| "probePasses"
	| "profile"
	| "stages"
>;
const noCounters: ImportCounters = {
	sharedBytesAppended: 0,
	sharedReadBytes: 0,
	sharedIndexReadBytes: 0,
	lookupStrings: 0,
	reusedStrings: 0,
	probePasses: 0,
	profile: { sortMs: 0, probeMs: 0, appendMs: 0, segments: 0 }
};
interface ImportedFile {
	readonly key: string;
	readonly contentHash: string;
	readonly parsed: boolean;
	readonly snapshotBytes: number;
	readonly counters: ImportCounters;
}
const snapshotKey = Effect.fn("LocalizationImport.snapshotKey")(function* (
	prepared: PreparedFile,
	directory: string,
	statHit: boolean,
	value: ImportedFile
) {
	const readBytes = statHit ? 0 : prepared.observed.size;
	yield* Metric.update(localizationImportMetrics.bytes, readBytes);
	yield* Metric.update(localizationImportMetrics.lookupStrings, value.counters.lookupStrings);
	yield* Metric.update(
		value.parsed ? localizationImportMetrics.parsed : localizationImportMetrics.reused,
		1
	);
	return {
		key: value.key,
		contentHash: value.contentHash,
		provenance: {
			relativePath: prepared.file,
			size: prepared.observed.size,
			modifiedTime: new Date(
				Number(BigInt(prepared.observed.mtimeNs) / 1_000_000n)
			).toISOString(),
			contentHash: value.contentHash
		},
		relativePath: prepared.file,
		format: prepared.options.format,
		parsed: value.parsed,
		statHit,
		readBytes,
		inputBytes: prepared.observed.size,
		snapshotBytes: value.snapshotBytes,
		directory,
		...value.counters,
		sharedReadBytes: value.counters.sharedReadBytes + prepared.hintBytes
	} satisfies LocalizationFileSnapshotKey;
});

/**
 * The TypeScript reference parse of one file, for alternate source adapters and writers without
 * a native import (the TypeScript reference builder). It reads once, hashes and parses in chunks,
 * and publishes through the writer. Its key uses the engine's formula, so layers either
 * implementation retains stay reusable by the other.
 */
const referenceImport = Effect.fn("LocalizationImport.referenceFile")(function* (
	prepared: PreparedFile
): Effect.fn.Return<ImportedFile, ImportFailure, SharedIndex> {
	const { file, options, limits, observed, actual } = prepared;
	const chunkBytes = prepared.chunkBytes ?? 256 * 1024;
	const key = (hash: string) =>
		createHash("sha256")
			.update(JSON.stringify([LOCALIZATION_IMPORT_VERSION, options, hash]))
			.digest("hex");
	const stages = {
		readMs: 0,
		hashMs: 0,
		decodeMs: 0,
		parseMs: 0,
		finishMs: 0,
		writeMs: 0,
		cachedLookupMs: 0
	};
	const sourceAccess = yield* LocalizationImportSource;
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const stagingRoot = join(prepared.cacheRoot, "localization-import-staging");
			yield* io(file, () => mkdir(stagingRoot, { recursive: true }));
			const staging = yield* Effect.acquireRelease(
				io(file, () => mkdtemp(join(stagingRoot, "file-"))),
				(directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))
			);
			const input = yield* Effect.acquireRelease(
				io(file, () => sourceAccess.open(actual)),
				(handle) => Effect.promise(() => handle.close())
			);
			const builder = yield* Effect.acquireRelease(
				Effect.try({
					try: () =>
						localizationColumnsBuilder(file, join(staging, "columns"), options, limits),
					catch: (cause) => fileError(file, cause)
				}),
				(value) => Effect.sync(() => value.close())
			);
			const content = yield* io(file, async () => {
				if (!sameStamp(observed, stamp(await input.stat())))
					throw importFailure(file, "file_changed");
				const hash = createHash("sha256");
				const bytes = new Uint8Array(chunkBytes);
				// A fixed prefix handles BOMs even when the configured read chunk is one byte.
				const prefix = new Uint8Array(3);
				let prefixSize = 0;
				let decoder: InstanceType<typeof TextDecoder> | undefined;
				let size = 0;
				let parseError: unknown;
				function decode(value: Uint8Array, final = false) {
					if (parseError) return;
					let text: string;
					const decodeStarted = performance.now();
					try {
						text = decoder!.decode(value, { stream: !final });
					} catch {
						parseError = importFailure(
							file,
							"invalid_encoding",
							` at byte offset ${size}`
						);
						return;
					}
					try {
						stages.decodeMs += performance.now() - decodeStarted;
						const started = performance.now();
						builder.feed(text);
						stages.parseMs += performance.now() - started;
					} catch (cause) {
						parseError = cause;
					}
				}
				function start() {
					const utf16 =
						options.format !== "po" &&
						prefixSize >= 2 &&
						prefix[0] === 255 &&
						prefix[1] === 254;
					const bom =
						prefixSize === 3 &&
						prefix[0] === 239 &&
						prefix[1] === 187 &&
						prefix[2] === 191;
					decoder = new TextDecoder(utf16 ? "utf-16le" : "utf-8", {
						fatal: true,
						ignoreBOM: true
					});
					decode(prefix.subarray(utf16 ? 2 : bom ? 3 : 0, prefixSize));
				}
				while (true) {
					const readStarted = performance.now();
					const { bytesRead } = await input.read(bytes, 0, bytes.length, size);
					stages.readMs += performance.now() - readStarted;
					if (!bytesRead) break;
					size += bytesRead;
					if (size > limits.maxFileBytes)
						throw importFailure(file, "limit_exceeded", ` at byte offset ${size}`);
					const chunk = bytes.subarray(0, bytesRead);
					const hashStarted = performance.now();
					hash.update(chunk);
					stages.hashMs += performance.now() - hashStarted;
					let offset = 0;
					if (!decoder) {
						while (prefixSize < 3 && offset < chunk.length)
							prefix[prefixSize++] = chunk[offset++]!;
						if (prefixSize === 3) start();
					}
					if (decoder) decode(chunk.subarray(offset));
				}
				if (!decoder) start();
				decode(new Uint8Array(0), true);
				const after = await input.stat();
				const current = await stat(actual, { bigint: true });
				if (
					observed.size !== size ||
					!sameStamp(observed, stamp(after)) ||
					!sameStamp(observed, stamp(current))
				)
					throw importFailure(file, "file_changed");
				return { hash: hash.digest("hex"), parseError };
			});
			const contentKey = key(content.hash);
			const lookupStarted = performance.now();
			const opened = yield* activateRetained(file, contentKey).pipe(Effect.result);
			stages.cachedLookupMs += performance.now() - lookupStarted;
			if (Result.isSuccess(opened))
				return {
					key: contentKey,
					contentHash: content.hash,
					parsed: false,
					snapshotBytes: opened.success,
					counters: { ...noCounters, stages: { ...stages } }
				};
			if (!missingLayer(opened.failure)) return yield* opened.failure;
			if (content.parseError) return yield* fileError(file, content.parseError);
			const finishStarted = performance.now();
			const source = yield* io(file, () => builder.finish());
			stages.finishMs += performance.now() - finishStarted;
			const writeStarted = performance.now();
			const writer = yield* (yield* SharedIndex).writer;
			const layer = yield* writer.publish(file, contentKey, source, prepared.hint?.key);
			stages.writeMs += performance.now() - writeStarted;
			const shared = writer.metrics();
			return {
				key: contentKey,
				contentHash: content.hash,
				parsed: true,
				snapshotBytes: layer.bytes,
				counters: {
					sharedBytesAppended: shared.appendedBytes,
					sharedReadBytes: shared.readBytes,
					sharedIndexReadBytes: shared.indexReadBytes,
					lookupStrings: shared.lookupStrings,
					reusedStrings: shared.reusedStrings,
					probePasses: shared.probePasses,
					profile: { ...shared, stages: { ...stages, ...shared.timings } },
					stages: { ...stages }
				}
			};
		})
	);
});

/** One requested file's outcome. A failed file keeps whatever layer was active for it. */
type FileOutcome =
	| { readonly _tag: "imported"; readonly file: LocalizationFileSnapshotKey }
	| {
			readonly _tag: "failed";
			readonly relativePath: string;
			readonly error: LocalizationError;
	  };
/** A per-file localization failure becomes an outcome; store and format failures stop the import. */
const failedOutcome = (relativePath: string, cause: ImportFailure) =>
	Schema.is(LocalizationError)(cause)
		? Effect.succeed<FileOutcome>({ _tag: "failed", relativePath, error: cause })
		: Effect.fail(cause);
interface Miss {
	readonly row: number;
	readonly prepared: PreparedFile;
}
function chunks<A>(values: readonly A[], size: number) {
	const result: A[][] = [];
	for (let start = 0; start < values.length; start += size)
		result.push(values.slice(start, start + size));
	return result;
}
function nativeInput(prepared: PreparedFile): GameTextContract.LocalizationInput {
	return {
		projectRoot: prepared.actualRoot,
		file: prepared.actual,
		relativePath: prepared.file,
		options: prepared.options,
		limits: prepared.limits,
		...(prepared.chunkBytes === undefined ? undefined : { chunkBytes: prepared.chunkBytes })
	};
}
const annotateCounts = Effect.fn("LocalizationImport.annotateCounts")(function* (
	files: number,
	statHits: number,
	outcomes: readonly FileOutcome[],
	nativeCalls: number
) {
	const failed = outcomes.filter((outcome) => outcome._tag === "failed").length;
	const counts = { files, statHits, imported: files - statHits - failed, failed, nativeCalls };
	yield* Effect.annotateCurrentSpan({
		"localization.import.files": counts.files,
		"localization.import.statHits": counts.statHits,
		"localization.import.imported": counts.imported,
		"localization.import.failed": counts.failed,
		"localization.import.nativeCalls": counts.nativeCalls
	});
	return counts;
});

/**
 * The one import path for any set of files in one store, cold or warm. A file whose metadata
 * matches its stat hint reuses the hinted layer without a read. The engine reads every other file
 * in as few calls as its file limit allows, decides per file whether it is cold or warm, and
 * publishes the files that imported in one root per call; a file that fails is reported and not
 * published. An interrupted call publishes nothing. Store, cache and format failures fail the
 * whole import.
 */
const importFiles = Effect.fn("LocalizationImport.files")(function* (
	configuration: SharedIndexOptions,
	inputs: readonly LocalizationFileImportRequest[],
	report: (completed: number) => void,
	reportPublish: () => void,
	memoryBudgetBytes?: number
): Effect.fn.Return<
	{
		readonly outcomes: readonly FileOutcome[];
		readonly profile: LocalizationImportProfile | null;
	},
	ImportFailure
> {
	const indexLayer =
		(yield* localizationImportLayer(configuration)) ?? sharedIndexNodeLayer(configuration);
	const directory = sharedIndexDirectory(configuration);
	const outcomes: FileOutcome[] = [];
	let completed = 0;
	const misses: Miss[] = [];
	let statHits = 0;
	for (const [row, input] of inputs.entries()) {
		const prepared = yield* prepareFile(input).pipe(Effect.result);
		if (Result.isFailure(prepared)) {
			outcomes[row] = yield* failedOutcome(input.relativePath, prepared.failure);
			report(++completed);
			continue;
		}
		const { hint, observed, file } = prepared.success;
		const reused =
			hint && sameStamp(hint.stamp, observed)
				? yield* activateRetained(file, hint.key).pipe(
						Effect.provide(indexLayer),
						Effect.result
					)
				: undefined;
		if (reused && Result.isFailure(reused) && !missingLayer(reused.failure))
			return yield* reused.failure;
		if (!hint || !reused || Result.isFailure(reused)) {
			misses.push({ row, prepared: prepared.success });
			continue;
		}
		statHits++;
		outcomes[row] = {
			_tag: "imported",
			file: yield* snapshotKey(prepared.success, directory, true, {
				key: hint.key,
				contentHash: hint.contentHash,
				parsed: false,
				snapshotBytes: reused.success,
				counters: noCounters
			})
		};
		report(++completed);
	}
	const nativeWriter = yield* Effect.scoped(
		Effect.gen(function* () {
			return (yield* (yield* SharedIndex).writer).importLocalization !== undefined;
		})
	).pipe(Effect.provide(indexLayer));
	if (!nativeWriter || (yield* LocalizationImportSource) !== nodeSource) {
		for (const { row, prepared } of misses) {
			const result = yield* referenceImport(prepared).pipe(
				Effect.provide(indexLayer),
				Effect.result
			);
			if (Result.isFailure(result))
				outcomes[row] = yield* failedOutcome(prepared.file, result.failure);
			else {
				yield* rememberHint(prepared, result.success.contentHash, result.success.key);
				outcomes[row] = {
					_tag: "imported",
					file: yield* snapshotKey(prepared, directory, false, result.success)
				};
			}
			report(++completed);
		}
		yield* annotateCounts(inputs.length, statHits, outcomes, 0);
		return { outcomes, profile: null };
	}
	const maximumInFlightBytes = Math.max(
		1,
		Math.floor(Math.min(MAXIMUM_IN_FLIGHT_BYTES, memoryBudgetBytes ?? Infinity))
	);
	const calls = {
		count: 0,
		workerCount: 0,
		parseMs: 0,
		parseCpuMs: 0,
		publishMs: 0,
		lookupStrings: 0,
		reusedStrings: 0
	};
	const metrics = yield* Effect.scoped(
		Effect.gen(function* () {
			const writer = yield* (yield* SharedIndex).writer;
			const importLocalization = writer.importLocalization!;
			for (const chunk of chunks(misses, localizationImport.maximumFiles)) {
				const before = writer.metrics();
				const offset = completed;
				const reply = yield* importLocalization(
					{
						files: chunk.map(({ prepared }) => nativeInput(prepared)),
						maximumInFlightBytes
					},
					(done, total) => {
						report(offset + done);
						if (done === total) reportPublish();
					}
				);
				calls.count++;
				calls.workerCount = Math.max(calls.workerCount, reply.workerCount);
				calls.parseMs += reply.parseMs;
				calls.parseCpuMs += reply.parseCpuMs;
				calls.publishMs += reply.publishMs;
				calls.lookupStrings += reply.lookupStrings;
				calls.reusedStrings += reply.reusedStrings;
				const after = writer.metrics();
				let counters: ImportCounters = {
					sharedBytesAppended: after.appendedBytes - before.appendedBytes,
					sharedReadBytes: after.readBytes - before.readBytes,
					sharedIndexReadBytes: after.indexReadBytes - before.indexReadBytes,
					lookupStrings: reply.lookupStrings,
					reusedStrings: reply.reusedStrings,
					probePasses: 0,
					profile: {
						sortMs: after.sortMs - before.sortMs,
						probeMs: 0,
						appendMs: after.appendMs - before.appendMs,
						segments: after.segments
					},
					stages: {
						parseMs: reply.parseMs,
						parseCpuMs: reply.parseCpuMs,
						publishMs: reply.publishMs
					}
				};
				for (const [index, entry] of reply.files.entries()) {
					const { row, prepared } = chunk[index]!;
					if (entry.outcome === "failed") {
						outcomes[row] = {
							_tag: "failed",
							relativePath: prepared.file,
							error: yield* Schema.decodeUnknownEffect(LocalizationError)({
								_tag: "LocalizationError",
								...entry.error
							}).pipe(Effect.orDie)
						};
						continue;
					}
					yield* rememberHint(prepared, entry.file.contentHash, entry.file.key);
					outcomes[row] = {
						_tag: "imported",
						file: yield* snapshotKey(prepared, directory, false, {
							key: entry.file.key,
							contentHash: entry.file.contentHash,
							parsed: entry.file.parsed,
							snapshotBytes: entry.file.snapshotBytes,
							counters
						})
					};
					counters = noCounters;
				}
				// The engine reported each file of the call as it finished reading it.
				completed = offset + chunk.length;
			}
			return writer.metrics();
		})
	).pipe(Effect.provide(indexLayer));
	const counts = yield* annotateCounts(inputs.length, statHits, outcomes, calls.count);
	yield* Effect.annotateCurrentSpan({
		"localization.import.stage_ms.parse": calls.parseMs,
		"localization.import.stage_ms.parse_cpu": calls.parseCpuMs,
		"localization.import.stage_ms.publish": calls.publishMs,
		"localization.import.workerCount": calls.workerCount,
		"localization.import.maximumInFlightBytes": maximumInFlightBytes
	});
	return {
		outcomes,
		profile: {
			readBytes: metrics.readBytes,
			indexReadBytes: metrics.indexReadBytes,
			appendedBytes: metrics.appendedBytes,
			probePasses: metrics.probePasses,
			sortMs: metrics.sortMs,
			probeMs: metrics.probeMs,
			appendMs: metrics.appendMs,
			segments: metrics.segments,
			...counts,
			workerCount: calls.workerCount,
			memoryBudgetBytes: maximumInFlightBytes,
			parseMs: calls.parseMs,
			parseCpuMs: calls.parseCpuMs,
			publishMs: calls.publishMs,
			lookupStrings: calls.lookupStrings,
			reusedStrings: calls.reusedStrings
		}
	};
});

/** The native engine's lease is taken here unless a session or an alternate source is present. */
const needsNativeSession = Effect.fn("LocalizationImport.needsNativeSession")(function* () {
	return (
		(yield* LocalizationImportSource) === nodeSource &&
		Option.isNone(yield* Effect.serviceOption(LocalizationImportSession))
	);
});

/**
 * Parses or reuses one localization input within the selected builder's scoped session. It
 * verifies source provenance around reads and reports typed localization/cache failures;
 * authored bytes are never rewritten.
 */
export const importLocalizationFile = Effect.fn("LocalizationSnapshot.importFileRequest")(
	function* (
		input: LocalizationFileImportRequest
	): Effect.fn.Return<LocalizationFileSnapshotKey, ImportFailure> {
		const boundary = Schema.decodeResult(FileRequest)(input);
		if (Result.isFailure(boundary)) return yield* importFailure("input", "invalid_schema");
		const request = boundary.success;
		const actualRoot = yield* Effect.tryPromise({
			try: () => realpath(resolve(request.projectRoot)),
			catch: () => importFailure(request.relativePath, "directory_unreadable")
		});
		const configuration: SharedIndexOptions = {
			cacheRoot: request.cacheRoot,
			projectKey: actualRoot,
			targetKey: request.sharedTargetKey ?? "localization"
		};
		if (request.projectScoped)
			Object.assign(configuration, { projectView: { kind: "source" } });
		if (yield* needsNativeSession())
			return yield* withNativeLocalizationSession(
				configuration,
				importLocalizationFile(input)
			);
		const { outcomes } = yield* importFiles(
			configuration,
			[request],
			() => undefined,
			() => undefined
		);
		const outcome = outcomes[0]!;
		return outcome._tag === "failed" ? yield* outcome.error : outcome.file;
	}
);

const TargetRequest = LocalizationProjectRequest.pipe(
	Schema.fieldsAssign({
		cacheRoot: Schema.NonEmptyString,
		targetName: Schema.NonEmptyString,
		sharedTargetKey: Schema.optionalKey(Schema.NonEmptyString),
		projectScoped: Schema.optionalKey(Schema.Boolean),
		importLimits: Schema.optionalKey(LocalizationImportLimits),
		/** Explicit parser-pool budget when another cold pool runs beside this import. */
		memoryBudgetBytes: Schema.optionalKey(Schema.Finite)
	})
);
/**
 * One discovered localization target and its import configuration. Import retains
 * manifest/archive/PO evidence and reports file failures instead of silently dropping
 * unreadable cultures.
 */
export type LocalizationTargetImportRequest = typeof TargetRequest.Type;
type TargetImportReply = {
	target: LocalizationTarget;
	files: LocalizationFileSnapshotKey[];
	diagnostics: { relativePath: string | null; error: LocalizationError }[];
	/** The native import's work, cold or warm; null for the TypeScript reference parser. */
	profile: LocalizationImportProfile | null;
};
/** Discovery remains the localization service's authority. Each file has an independent key. */
export const importLocalizationTarget = Effect.fn("LocalizationSnapshot.importTarget")(function* (
	input: LocalizationTargetImportRequest
): Effect.fn.Return<TargetImportReply, ImportFailure, LocalizationEvidence> {
	const reportProgress = yield* GameTextIndexProgressReporter;
	reportProgress({ phase: "localization", completed: 0, total: 0 });
	const boundary = Schema.decodeResult(TargetRequest)(input);
	if (Result.isFailure(boundary)) return yield* importFailure("target", "invalid_schema");
	const request = boundary.success;
	const evidence = yield* LocalizationEvidence;
	const discoveryRequest: LocalizationProjectRequest = { projectRoot: request.projectRoot };
	if (request.limits) Object.assign(discoveryRequest, { limits: request.limits });
	const discovery = yield* evidence.discover(discoveryRequest);
	const target = discovery.targets.find((value) => value.name === request.targetName);
	if (!target) return yield* importFailure(request.targetName, "target_not_found");
	const validated = Schema.decodeResult(LocalizationTarget)(target);
	if (Result.isFailure(validated))
		return yield* importFailure(request.targetName, "invalid_schema");
	if (
		target.cultures.length * 2 + 1 >
		(request.importLimits ?? defaultLocalizationImportLimits).maxFiles
	)
		return yield* importFailure(request.targetName, "limit_exceeded");
	const actualRoot = yield* io("target", () => realpath(request.projectRoot));
	const configuration: SharedIndexOptions = {
		cacheRoot: request.cacheRoot,
		projectKey: actualRoot,
		targetKey: request.sharedTargetKey ?? target.name
	};
	if (request.projectScoped)
		Object.assign(configuration, {
			projectView: { kind: "localization", target: target.name }
		});
	if (yield* needsNativeSession())
		return yield* withNativeLocalizationSession(configuration, importLocalizationTarget(input));
	const session = yield* Effect.serviceOption(LocalizationImportSession);
	const selectedFiles = Option.isSome(session) ? session.value.files : undefined;
	const diagnostics: { relativePath: string | null; error: LocalizationError }[] = [];
	const requests: LocalizationFileImportRequest[] = [];
	const paths = [
		[target.outputPaths.manifest, "manifest"] as const,
		...target.cultures.flatMap((culture) => [
			[target.outputPaths.archives[culture], "archive"] as const,
			[target.outputPaths.portableObjects[culture], "po"] as const
		])
	];
	for (const [relativePath, format] of paths) {
		if (!relativePath) {
			diagnostics.push({
				relativePath: null,
				error: importFailure("target", "file_missing")
			});
			continue;
		}
		if (selectedFiles !== undefined && !selectedFiles.includes(relativePath)) continue;
		const fileRequest: LocalizationFileImportRequest = {
			projectRoot: actualRoot,
			cacheRoot: request.cacheRoot,
			relativePath,
			format,
			poFormat: target.poFormat,
			collapseMode: target.collapseMode,
			sharedTargetKey: configuration.targetKey,
			projectScoped: request.projectScoped ?? false
		};
		if (request.importLimits) Object.assign(fileRequest, { limits: request.importLimits });
		requests.push(fileRequest);
	}
	const total = requests.length;
	reportProgress({ phase: "localization", completed: 0, total });
	const imported = yield* importFiles(
		configuration,
		requests,
		(completed) => reportProgress({ phase: "localization", completed, total }),
		() => reportProgress({ phase: "localization_publish", completed: 0, total: 0 }),
		request.memoryBudgetBytes
	);
	const files: LocalizationFileSnapshotKey[] = [];
	for (const outcome of imported.outcomes)
		if (outcome._tag === "imported") files.push(outcome.file);
		else diagnostics.push({ relativePath: outcome.relativePath, error: outcome.error });
	return { target, files, diagnostics, profile: imported.profile };
});
