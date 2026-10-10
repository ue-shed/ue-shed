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
import { isAbsolute, relative, resolve, sep, join } from "node:path";
import { Context, Effect, Metric, Result, Schema } from "effect";
import {
	LocalizationError,
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
import { SharedIndex, sharedIndexNodeLayer, sharedIndexDirectory } from "./shared-index.js";
import { SnapshotFormatError } from "./snapshot-format.js";

export {
	decodeLocalizationSnapshot,
	type LocalizationFileFormat,
	type LocalizationImportOptions
} from "./localization-columns.js";
export {
	defaultLocalizationImportLimits,
	type LocalizationImportLimits
} from "./localization-stream.js";
export const LOCALIZATION_IMPORT_VERSION = 5;
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
export const LocalizationImportSource = Context.Reference<{
	readonly open: (path: string) => Promise<LocalizationImportSourceFile>;
}>("@ue-shed/game-text/LocalizationImportSource", {
	defaultValue: () => ({
		open: async (path) => {
			const handle = await open(path, "r");
			return {
				read: (bytes, offset, length, position) =>
					handle.read(bytes, offset, length, position),
				stat: () => handle.stat({ bigint: true }),
				close: () => handle.close()
			};
		}
	})
});
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
		sharedTargetKey: Schema.optionalKey(Schema.NonEmptyString)
	})
);
export type LocalizationFileImportRequest = typeof FileRequest.Type;
export interface LocalizationFileSnapshotKey {
	readonly key: string;
	readonly contentHash: string;
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
}
function contained(root: string, path: string) {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function fileError(file: string, cause: unknown) {
	if (
		cause instanceof LocalizationError ||
		cause instanceof SnapshotStoreError ||
		cause instanceof SnapshotFormatError
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
	size: Schema.Number,
	mtimeNs: Schema.String,
	ctimeNs: Schema.String,
	ino: Schema.String,
	dev: Schema.String
});
const CachedFile = Schema.Struct({
	stamp: Stamp,
	contentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
	key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
});
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
/** Stat hits never open authored bytes; misses hash and parse one bounded read. */
export const importLocalizationFile = Effect.fn("LocalizationSnapshot.importFile")(function* (
	input: LocalizationFileImportRequest
) {
	const boundary = Schema.decodeUnknownResult(FileRequest)(input);
	if (Result.isFailure(boundary))
		return yield* Effect.fail(importFailure("input", "invalid_schema"));
	const request = boundary.success;
	const file = request.relativePath;
	const limits = request.limits ?? defaultLocalizationImportLimits;
	const optionsResult = Schema.decodeUnknownResult(Options)(request);
	if (Result.isFailure(optionsResult))
		return yield* Effect.fail(importFailure(file, "invalid_schema"));
	const options = optionsResult.success;
	const chunkBytes = request.chunkBytes ?? 256 * 1024;
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > 1024 * 1024)
		return yield* Effect.fail(importFailure(file, "limit_exceeded"));
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
		return yield* Effect.fail(importFailure(file, "unsafe_path"));
	const actualRoot = yield* Effect.tryPromise({
		try: () => realpath(root),
		catch: () => importFailure(file, "directory_unreadable")
	});
	const actual = yield* io(file, () => realpath(candidate));
	if (!contained(actualRoot, actual))
		return yield* Effect.fail(importFailure(file, "unsafe_path"));
	const before = yield* io(file, () => stat(actual, { bigint: true }));
	if (!before.isFile()) return yield* Effect.fail(importFailure(file, "file_unreadable"));
	if (before.size > limits.maxFileBytes)
		return yield* Effect.fail(importFailure(file, "limit_exceeded"));
	const observed = stamp(before);
	let rootReadBytes = 0;
	const stateRoot = join(request.cacheRoot, "localization-file-stats");
	const statePath = join(
		stateRoot,
		createHash("sha256")
			.update(JSON.stringify([LOCALIZATION_IMPORT_VERSION, actualRoot, actual, options]))
			.digest("hex") + ".json"
	);
	const cached = yield* io(file, async () => {
		try {
			if ((await stat(statePath)).size > 4096) return undefined;
			const bytes = await readFile(statePath, "utf8");
			rootReadBytes += Buffer.byteLength(bytes);
			const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(CachedFile))(bytes);
			return Result.isSuccess(decoded) ? decoded.success : undefined;
		} catch (cause) {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				return undefined;
			throw cause;
		}
	});
	function contentKey(hash: string) {
		const key = createHash("sha256")
			.update(JSON.stringify([LOCALIZATION_IMPORT_VERSION, options, hash]))
			.digest("hex");
		return key;
	}
	function storeOptions() {
		return {
			cacheRoot: request.cacheRoot,
			projectKey: actualRoot,
			targetKey: request.sharedTargetKey ?? "localization",
			onRead: (bytes: number) => {
				rootReadBytes += bytes;
			}
		};
	}
	const existing = (hash: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* SharedIndex;
				const manifest = yield* store.inspect();
				const record = yield* store.cached(contentKey(hash));
				if (manifest.active[file] !== record.key) {
					const writer = yield* store.writer();
					yield* writer.publish(file, record.key, { columns: [] });
				}
				return record.bytes;
			})
		).pipe(Effect.provide(sharedIndexNodeLayer(storeOptions())), Effect.result);
	let contentHash: string;
	let snapshotBytes: number;
	let parsed = false;
	let sharedBytesAppended = 0,
		sharedReadBytes = 0,
		sharedIndexReadBytes = 0;
	let lookupStrings = 0,
		reusedStrings = 0,
		probePasses = 0;
	const hit =
		cached && cached.key === contentKey(cached.contentHash) && sameStamp(cached.stamp, observed)
			? yield* existing(cached.contentHash)
			: undefined;
	if (hit && Result.isSuccess(hit)) {
		contentHash = cached!.contentHash;
		snapshotBytes = hit.success;
	} else {
		if (
			hit &&
			Result.isFailure(hit) &&
			(!(hit.failure instanceof SnapshotStoreError) || hit.failure.code !== "missing")
		)
			return yield* Effect.fail(hit.failure);
		const result = yield* Effect.scoped(
			Effect.gen(function* () {
				const sourceAccess = yield* LocalizationImportSource;
				const stagingRoot = join(request.cacheRoot, "localization-import-staging");
				yield* io(file, () => mkdir(stagingRoot, { recursive: true }));
				const staging = yield* Effect.acquireRelease(
					io(file, () => mkdtemp(join(stagingRoot, "file-"))),
					(directory) =>
						Effect.promise(() => rm(directory, { recursive: true, force: true }))
				);
				const input = yield* Effect.acquireRelease(
					io(file, () => sourceAccess.open(actual)),
					(handle) => Effect.promise(() => handle.close())
				);
				const builder = yield* Effect.acquireRelease(
					Effect.try({
						try: () =>
							localizationColumnsBuilder(
								file,
								join(staging, "columns"),
								options,
								limits
							),
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
							builder.feed(text);
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
						const { bytesRead } = await input.read(bytes, 0, bytes.length, size);
						if (!bytesRead) break;
						size += bytesRead;
						if (size > limits.maxFileBytes)
							throw importFailure(file, "limit_exceeded", ` at byte offset ${size}`);
						const chunk = bytes.subarray(0, bytesRead);
						hash.update(chunk);
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
				const opened = yield* existing(content.hash);
				if (Result.isSuccess(opened))
					return { hash: content.hash, parsed: false, bytes: opened.success };
				if (
					!(opened.failure instanceof SnapshotStoreError) ||
					opened.failure.code !== "missing"
				)
					return yield* Effect.fail(opened.failure);
				if (content.parseError)
					return yield* Effect.fail(fileError(file, content.parseError));
				const source = yield* io(file, () => builder.finish());
				const bytes = yield* Effect.gen(function* () {
					const store = yield* SharedIndex;
					const writer = yield* store.writer();
					const layer = yield* writer.publish(
						file,
						contentKey(content.hash),
						source,
						cached?.key
					);
					return { bytes: layer.bytes, ...writer.metrics() };
				}).pipe(Effect.provide(sharedIndexNodeLayer(storeOptions())));
				return { hash: content.hash, parsed: true, bytes: bytes.bytes, shared: bytes };
			})
		);
		contentHash = result.hash;
		snapshotBytes = result.bytes;
		parsed = result.parsed;
		if ("shared" in result && result.shared) {
			sharedBytesAppended = result.shared.appendedBytes;
			sharedReadBytes = result.shared.readBytes;
			sharedIndexReadBytes = result.shared.indexReadBytes;
			lookupStrings = result.shared.lookupStrings;
			reusedStrings = result.shared.reusedStrings;
			probePasses = result.shared.probePasses;
		}
		yield* io(file, async () => {
			await mkdir(stateRoot, { recursive: true });
			const temporary = `${statePath}.${randomUUID()}.tmp`;
			try {
				await writeFile(
					temporary,
					JSON.stringify({
						stamp: observed,
						contentHash,
						key: contentKey(contentHash)
					}),
					{ flag: "wx" }
				);
				await rename(temporary, statePath);
			} finally {
				await rm(temporary, { force: true });
			}
		});
	}
	const statHit = Boolean(hit && Result.isSuccess(hit));
	sharedReadBytes += rootReadBytes;
	const readBytes = statHit ? 0 : observed.size;
	const configuration = storeOptions();
	const key = contentKey(contentHash);
	yield* Metric.update(localizationImportMetrics.bytes, readBytes);
	yield* Metric.update(localizationImportMetrics.lookupStrings, lookupStrings);
	yield* Metric.update(
		parsed ? localizationImportMetrics.parsed : localizationImportMetrics.reused,
		1
	);
	yield* Effect.annotateCurrentSpan({
		"localization.import.bytes": observed.size,
		"localization.import.parsed": parsed,
		"localization.import.statHit": statHit,
		"localization.import.readBytes": readBytes,
		"localization.import.lookupStrings": lookupStrings,
		"localization.import.reusedStrings": reusedStrings,
		"localization.import.probePasses": probePasses
	});
	yield* Effect.logDebug("Localization file snapshot imported", {
		file,
		format: options.format,
		inputBytes: observed.size,
		snapshotBytes,
		sharedBytesAppended,
		sharedReadBytes,
		sharedIndexReadBytes,
		lookupStrings,
		reusedStrings,
		probePasses,
		parsed
	});
	return {
		key,
		contentHash,
		relativePath: file,
		format: options.format,
		parsed,
		statHit,
		readBytes,
		inputBytes: observed.size,
		snapshotBytes,
		directory: sharedIndexDirectory(configuration),
		sharedBytesAppended,
		sharedReadBytes,
		sharedIndexReadBytes,
		lookupStrings,
		reusedStrings,
		probePasses
	} satisfies LocalizationFileSnapshotKey;
});

const TargetRequest = LocalizationProjectRequest.pipe(
	Schema.fieldsAssign({
		cacheRoot: Schema.NonEmptyString,
		targetName: Schema.NonEmptyString,
		importLimits: Schema.optionalKey(LocalizationImportLimits)
	})
);
export type LocalizationTargetImportRequest = typeof TargetRequest.Type;
/** Discovery remains the localization service's authority. Each file has an independent key. */
export const importLocalizationTarget = Effect.fn("LocalizationSnapshot.importTarget")(function* (
	input: LocalizationTargetImportRequest
) {
	const boundary = Schema.decodeUnknownResult(TargetRequest)(input);
	if (Result.isFailure(boundary))
		return yield* Effect.fail(importFailure("target", "invalid_schema"));
	const request = boundary.success;
	const evidence = yield* LocalizationEvidence;
	const discoveryRequest: LocalizationProjectRequest = { projectRoot: request.projectRoot };
	if (request.limits) Object.assign(discoveryRequest, { limits: request.limits });
	const discovery = yield* evidence.discover(discoveryRequest);
	const target = discovery.targets.find((value) => value.name === request.targetName);
	if (!target) return yield* Effect.fail(importFailure(request.targetName, "target_not_found"));
	const validated = Schema.decodeUnknownResult(LocalizationTarget)(target);
	if (Result.isFailure(validated))
		return yield* Effect.fail(importFailure(request.targetName, "invalid_schema"));
	if (
		target.cultures.length * 2 + 1 >
		(request.importLimits ?? defaultLocalizationImportLimits).maxFiles
	)
		return yield* Effect.fail(importFailure(request.targetName, "limit_exceeded"));
	const files: LocalizationFileSnapshotKey[] = [];
	const diagnostics: { relativePath: string | null; error: LocalizationError }[] = [];
	const add = Effect.fn("LocalizationSnapshot.importTargetFile")(function* (
		relativePath: string | null | undefined,
		format: LocalizationImportOptions["format"]
	) {
		if (!relativePath) {
			diagnostics.push({
				relativePath: null,
				error: importFailure("target", "file_missing")
			});
			return;
		}
		const fileRequest: LocalizationFileImportRequest = {
			projectRoot: request.projectRoot,
			cacheRoot: request.cacheRoot,
			relativePath,
			format,
			poFormat: target.poFormat,
			collapseMode: target.collapseMode,
			sharedTargetKey: target.name
		};
		if (request.importLimits) Object.assign(fileRequest, { limits: request.importLimits });
		const result = yield* importLocalizationFile(fileRequest).pipe(Effect.result);
		if (Result.isFailure(result)) {
			if (!(result.failure instanceof LocalizationError))
				return yield* Effect.fail(result.failure);
			diagnostics.push({ relativePath, error: result.failure });
		} else files.push(result.success);
	});
	yield* add(target.outputPaths.manifest, "manifest");
	for (const culture of target.cultures) {
		yield* add(target.outputPaths.archives[culture], "archive");
		yield* add(target.outputPaths.portableObjects[culture], "po");
	}
	return { target, files, diagnostics };
});
