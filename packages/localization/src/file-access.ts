import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { localizationError, validate } from "./decode.js";
import { FileProvenance, LocalizationError, type LocalizationLimits } from "./schema.js";

export const LocalizationFileRead = Schema.Struct({
	bytes: Schema.Uint8Array,
	provenance: FileProvenance
});
export type LocalizationFileRead = typeof LocalizationFileRead.Type;
export interface LocalizationFileAccessApi {
	readonly read: (
		root: string,
		path: string,
		limits: LocalizationLimits
	) => Effect.Effect<LocalizationFileRead, LocalizationError>;
	readonly listConfigs: (
		root: string,
		limits: LocalizationLimits
	) => Effect.Effect<readonly string[], LocalizationError>;
	readonly presence: (root: string, path: string) => Effect.Effect<boolean, LocalizationError>;
	/**
	 * Atomically replaces an existing project file, only while its content still hashes to
	 * `expectedHash`. The new bytes are written beside it and renamed over it.
	 */
	readonly replace: (
		root: string,
		path: string,
		bytes: Uint8Array,
		expectedHash: string,
		limits: LocalizationLimits
	) => Effect.Effect<FileProvenance, LocalizationError>;
}
export class LocalizationFileAccess extends Context.Service<
	LocalizationFileAccess,
	LocalizationFileAccessApi
>()("@ue-shed/localization/LocalizationFileAccess") {}

const FileSystemFailure = Schema.Struct({ code: Schema.String });

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function writeError(cause: unknown): LocalizationError {
	return cause instanceof LocalizationError ? cause : localizationError("file_unwritable");
}

function fileError(cause: unknown): LocalizationError {
	if (cause instanceof LocalizationError) return cause;
	const decoded = Schema.decodeUnknownResult(FileSystemFailure)(cause);
	return localizationError(
		Result.isSuccess(decoded) && decoded.success.code === "ENOENT"
			? "file_missing"
			: "file_unreadable"
	);
}

function contained(root: string, path: string): boolean {
	const child = relative(root, path);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

const projectPath = Effect.fn("LocalizationFileAccess.projectPath")(function* (
	root: string,
	path: string
) {
	// Output paths remain project-relative. Neither traversal nor symlinks grant outside authority.
	const normalized = path.replace(/^%LOCPROJECTROOT%[/\\]?/iu, "");
	if (isAbsolute(normalized) || normalized.includes("\u0000") || normalized.includes("%"))
		return yield* Effect.fail(localizationError("unsafe_path"));
	const base = resolve(root);
	const candidate = resolve(base, normalized);
	if (!contained(base, candidate)) return yield* Effect.fail(localizationError("unsafe_path"));
	const actualRoot = yield* Effect.tryPromise({
		try: () => realpath(base),
		catch: () => localizationError("directory_unreadable")
	});
	const actualPath = yield* Effect.tryPromise({
		try: () => realpath(candidate),
		catch: fileError
	});
	if (!contained(actualRoot, actualPath))
		return yield* Effect.fail(localizationError("unsafe_path"));
	return actualPath;
});

export const LocalizationFileAccessLive = Layer.succeed(
	LocalizationFileAccess,
	LocalizationFileAccess.of({
		read: Effect.fn("LocalizationFileAccess.read")((root, path, limits) =>
			Effect.scoped(
				Effect.gen(function* () {
					const actual = yield* projectPath(root, path);
					const handle = yield* Effect.acquireRelease(
						Effect.tryPromise({ try: () => open(actual, "r"), catch: fileError }),
						(handle) => Effect.promise(() => handle.close())
					);
					const before = yield* Effect.tryPromise({
						try: () => handle.stat(),
						catch: fileError
					});
					if (!before.isFile())
						return yield* Effect.fail(localizationError("file_unreadable"));
					if (before.size > limits.maxFileBytes)
						return yield* Effect.fail(localizationError("limit_exceeded"));
					const bytes = new Uint8Array(before.size);
					let offset = 0;
					while (offset < bytes.length) {
						const read = yield* Effect.tryPromise({
							try: () => handle.read(bytes, offset, bytes.length - offset, offset),
							catch: fileError
						});
						if (read.bytesRead === 0)
							return yield* Effect.fail(localizationError("file_changed"));
						offset += read.bytesRead;
					}
					const after = yield* Effect.tryPromise({
						try: () => handle.stat(),
						catch: fileError
					});
					if (
						before.size !== after.size ||
						before.mtimeMs !== after.mtimeMs ||
						before.ctimeMs !== after.ctimeMs
					) {
						return yield* Effect.fail(localizationError("file_changed"));
					}
					return validate(LocalizationFileRead, {
						bytes,
						provenance: {
							relativePath: path.replaceAll("\\", "/"),
							size: bytes.length,
							modifiedTime: before.mtime.toISOString(),
							contentHash: sha256(bytes)
						}
					});
				})
			)
		),
		listConfigs: Effect.fn("LocalizationFileAccess.listConfigs")(function* (root, limits) {
			const location = yield* projectPath(root, "Config/Localization").pipe(Effect.result);
			if (location._tag === "Failure") {
				if (location.failure.code === "file_missing") return [];
				return yield* Effect.fail(location.failure);
			}
			const files = yield* Effect.tryPromise({
				try: () => readdir(location.success, { withFileTypes: true }),
				catch: () => localizationError("directory_unreadable")
			});
			const names = files
				.filter((entry) => entry.isFile() && /\.ini$/iu.test(entry.name))
				.map((entry) => `Config/Localization/${entry.name}`)
				.sort();
			if (names.length > limits.maxFiles)
				return yield* Effect.fail(localizationError("limit_exceeded"));
			return names;
		}),
		replace: Effect.fn("LocalizationFileAccess.replace")(
			function* (root, path, bytes, expectedHash, limits) {
				if (bytes.byteLength > limits.maxFileBytes)
					return yield* Effect.fail(localizationError("limit_exceeded"));
				const actual = yield* projectPath(root, path);
				const current = yield* Effect.tryPromise({
					try: () => readFile(actual),
					catch: fileError
				});
				if (sha256(current) !== expectedHash)
					return yield* Effect.fail(localizationError("file_changed"));
				// Write beside the target and rename over it, so readers never see a partial file.
				const temporary = `${actual}.ue-shed-${randomUUID().slice(0, 8)}.tmp`;
				yield* Effect.tryPromise({
					try: async () => {
						await writeFile(temporary, bytes, { flag: "wx" });
						await rename(temporary, actual);
					},
					catch: writeError
				}).pipe(
					Effect.tapError(() =>
						Effect.promise(() => rm(temporary, { force: true }).catch(() => undefined))
					)
				);
				const info = yield* Effect.tryPromise({
					try: () => stat(actual),
					catch: fileError
				});
				yield* Effect.annotateCurrentSpan({ "localization.file.bytes": bytes.byteLength });
				return validate(FileProvenance, {
					relativePath: path.replaceAll("\\", "/"),
					size: bytes.byteLength,
					modifiedTime: info.mtime.toISOString(),
					contentHash: sha256(bytes)
				});
			}
		),
		presence: Effect.fn("LocalizationFileAccess.presence")(function* (root, path) {
			const location = yield* projectPath(root, path).pipe(Effect.result);
			if (location._tag === "Failure") {
				if (location.failure.code === "file_missing") return false;
				return yield* Effect.fail(location.failure);
			}
			const info = yield* Effect.tryPromise({
				try: () => stat(location.success),
				catch: fileError
			});
			return info.isFile();
		})
	})
);

export function makeLocalizationFileAccessTestLayer(api: LocalizationFileAccessApi) {
	return Layer.succeed(LocalizationFileAccess, LocalizationFileAccess.of(api));
}
