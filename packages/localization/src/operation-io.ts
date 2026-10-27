import { createHash } from "node:crypto";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Result, Schema } from "effect";
import { localizationOperationError, localizationRelativePath } from "./operation-plan.js";
import {
	LocalizationFileChange,
	LocalizationOperationError,
	type LocalizationOperationPlan,
	isLocalizationOperationError
} from "./operation-schema.js";

const FileError = Schema.Struct({ code: Schema.String });
export function isLocalizationFileMissing(cause: unknown): boolean {
	const result = Schema.decodeUnknownResult(FileError)(cause);
	return Result.isSuccess(result) && result.success.code === "ENOENT";
}
export function localizationIOFailure(cause: unknown): LocalizationOperationError {
	return isLocalizationOperationError(cause)
		? cause
		: localizationOperationError("io_failed", cause);
}
function contained(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
/** Check existing ancestors too: a missing output must not escape through a directory symlink. */
export async function validateLocalizationOutputPath(root: string, path: string): Promise<void> {
	const base = await realpath(root);
	let candidate = resolve(root, localizationRelativePath(path));
	if (!contained(resolve(root), candidate)) throw localizationOperationError("unsafe_path");
	for (;;) {
		try {
			const actual = await realpath(candidate);
			if (!contained(base, actual)) throw localizationOperationError("unsafe_path");
			return;
		} catch (error) {
			if (!isLocalizationFileMissing(error)) throw error;
			const parent = dirname(candidate);
			if (parent === candidate) throw localizationOperationError("unsafe_path");
			candidate = parent;
		}
	}
}
export async function localizationProjectDescriptor(root: string): Promise<string> {
	const names = (await readdir(root, { withFileTypes: true })).filter(
		(entry) => entry.isFile() && /\.uproject$/iu.test(entry.name)
	);
	if (names.length !== 1)
		throw localizationOperationError(names.length ? "project_ambiguous" : "project_missing");
	const name = names[0];
	if (!name) throw localizationOperationError("project_missing");
	return resolve(root, name.name);
}
export async function readLocalizationConfig(root: string, path: string): Promise<Uint8Array> {
	await validateLocalizationOutputPath(root, path);
	const handle = await open(resolve(root, path), "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > 4 * 1024 * 1024)
			throw localizationOperationError("limit_exceeded");
		const bytes = new Uint8Array(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead === 0) throw localizationOperationError("config_changed");
			offset += result.bytesRead;
		}
		const after = await handle.stat();
		if (info.size !== after.size || info.mtimeMs !== after.mtimeMs)
			throw localizationOperationError("config_changed");
		return bytes;
	} finally {
		await handle.close();
	}
}

/**
 * Bounds on the before/after write audit of a commandlet run. The audit records the size and
 * modification time of every project file outside the plan's excluded directories, and reads only
 * the files it hashes. Exceeding one fails the run with `limit_exceeded`.
 */
export interface LocalizationAuditLimits {
	/** Directory entries visited. */
	readonly maxEntries: number;
	/** Bytes in one hashed file. */
	readonly maxFileBytes: number;
	/** Bytes across all hashed files. */
	readonly maxTotalBytes: number;
}

/** Default audit bounds: 1,000,000 entries, 512 MiB per hashed file and 2 GiB hashed in total. */
export const defaultLocalizationAuditLimits: LocalizationAuditLimits = {
	maxEntries: 1_000_000,
	maxFileBytes: 512 * 1024 * 1024,
	maxTotalBytes: 2 * 1024 * 1024 * 1024
};

/** One audited file: its size and modification time, and its content hash when it was read. */
export interface LocalizationAuditedFile {
	readonly size: number;
	readonly mtimeMs: number;
	readonly hash?: string;
}

/** Files stated at once within one directory. */
const AUDIT_STAT_CONCURRENCY = 64;

/**
 * Durable project inputs/outputs, excluding named engine scratch/build directories at any depth.
 * Every file is recorded by size and modification time. The plan's own files are hashed, and so,
 * given the snapshot from before the run, is every file that is new or whose size or modification
 * time changed. A write outside the plan is still found without reading the whole project.
 */
export async function snapshotLocalizationProject(
	root: string,
	plan: LocalizationOperationPlan,
	limits: LocalizationAuditLimits = defaultLocalizationAuditLimits,
	before?: ReadonlyMap<string, LocalizationAuditedFile>
): Promise<ReadonlyMap<string, LocalizationAuditedFile>> {
	const planned = new Set(plan.files.map((file) => file.relativePath));
	const files = new Map<string, LocalizationAuditedFile>();
	const pending = [""];
	let hashedBytes = 0;
	let entriesSeen = 0;
	const hashFile = async (path: string): Promise<LocalizationAuditedFile> => {
		await validateLocalizationOutputPath(root, path);
		const handle = await open(resolve(root, path), "r");
		try {
			const info = await handle.stat();
			hashedBytes += info.size;
			if (info.size > limits.maxFileBytes || hashedBytes > limits.maxTotalBytes)
				throw localizationOperationError("limit_exceeded");
			const hash = createHash("sha256");
			const bytes = new Uint8Array(64 * 1024);
			let offset = 0;
			while (offset < info.size) {
				const result = await handle.read(
					bytes,
					0,
					Math.min(bytes.length, info.size - offset),
					offset
				);
				if (!result.bytesRead) throw localizationOperationError("io_failed");
				hash.update(bytes.subarray(0, result.bytesRead));
				offset += result.bytesRead;
			}
			const after = await handle.stat();
			if (info.size !== after.size || info.mtimeMs !== after.mtimeMs)
				throw localizationOperationError("io_failed");
			return { size: info.size, mtimeMs: info.mtimeMs, hash: hash.digest("hex") };
		} finally {
			await handle.close();
		}
	};
	const auditFile = async (path: string) => {
		if (planned.has(path)) return hashFile(path);
		const info = await stat(resolve(root, path));
		const previous = before?.get(path);
		const changed =
			before !== undefined &&
			(previous === undefined ||
				previous.size !== info.size ||
				previous.mtimeMs !== info.mtimeMs);
		return changed ? hashFile(path) : { size: info.size, mtimeMs: info.mtimeMs };
	};
	while (pending.length) {
		const directory = pending.pop();
		if (directory === undefined) break;
		const paths: string[] = [];
		for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
			if (++entriesSeen > limits.maxEntries)
				throw localizationOperationError("limit_exceeded");
			if (
				plan.auditExcludedDirectories.some(
					(name) => name.toLowerCase() === entry.name.toLowerCase()
				)
			)
				continue;
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			// The walk starts at the root and refuses links, so no audited path leaves the project.
			if (entry.isSymbolicLink()) throw localizationOperationError("unsafe_path");
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) paths.push(path);
		}
		for (let start = 0; start < paths.length; start += AUDIT_STAT_CONCURRENCY) {
			const batch = paths.slice(start, start + AUDIT_STAT_CONCURRENCY);
			const audited = await Promise.all(batch.map(auditFile));
			batch.forEach((path, index) => {
				const file = audited[index];
				if (file) files.set(path, file);
			});
		}
	}
	return files;
}
export function localizationFileChanges(
	before: ReadonlyMap<string, LocalizationAuditedFile>,
	after: ReadonlyMap<string, LocalizationAuditedFile>,
	plan: LocalizationOperationPlan
): readonly LocalizationFileChange[] {
	const planned = new Set(plan.files.map((file) => file.relativePath));
	return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
		const previous = before.get(path);
		const current = after.get(path);
		// An unplanned file whose size and modification time held was not read again.
		if (previous && current && current.hash === undefined) return [];
		const beforeHash = previous?.hash ?? null;
		const afterHash = current?.hash ?? null;
		if (previous?.hash !== undefined && beforeHash === afterHash) return [];
		return [
			{
				relativePath: path,
				beforeHash,
				afterHash,
				planned: planned.has(path),
				...(previous && previous.hash === undefined ? { beforeUnread: true as const } : {})
			}
		];
	});
}

export const LocalizationLogChunk = Schema.Struct({ offset: Schema.Int, text: Schema.String });
export type LocalizationLogChunk = typeof LocalizationLogChunk.Type;
/** Incremental 64-KiB reads; reuse the decoder across reads and flush it when the process exits. */
export async function readLocalizationLogChunk(
	path: string,
	offset: number,
	decoder = new TextDecoder()
): Promise<LocalizationLogChunk> {
	let handle: FileHandle;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if (isLocalizationFileMissing(error)) return { offset, text: "" };
		throw error;
	}
	try {
		const info = await handle.stat();
		if (info.size > 256 * 1024 * 1024) throw localizationOperationError("limit_exceeded");
		const bytes = new Uint8Array(Math.min(64 * 1024, Math.max(0, info.size - offset)));
		const read = await handle.read(bytes, 0, bytes.length, offset);
		return {
			offset: offset + read.bytesRead,
			text: decoder.decode(bytes.subarray(0, read.bytesRead), { stream: true })
		};
	} finally {
		await handle.close();
	}
}
