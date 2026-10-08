import { createHash } from "node:crypto";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Result, Schema } from "effect";
import { localizationOperationError, localizationRelativePath } from "./operation-plan.js";
import {
	LocalizationFileChange,
	LocalizationOperationError,
	type LocalizationOperationPlan
} from "./operation-schema.js";

const FileError = Schema.Struct({ code: Schema.String });
export function isLocalizationFileMissing(cause: unknown): boolean {
	const result = Schema.decodeUnknownResult(FileError)(cause);
	return Result.isSuccess(result) && result.success.code === "ENOENT";
}
export function localizationIOFailure(cause: unknown): LocalizationOperationError {
	return cause instanceof LocalizationOperationError
		? cause
		: localizationOperationError("io_failed");
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

/** Durable project inputs/outputs, excluding named engine scratch/build directories at any depth. */
export async function snapshotLocalizationProject(
	root: string,
	plan: LocalizationOperationPlan
): Promise<ReadonlyMap<string, string>> {
	const hashes = new Map<string, string>();
	const pending = [""];
	let totalBytes = 0;
	let entriesSeen = 0;
	while (pending.length) {
		const directory = pending.pop();
		if (directory === undefined) break;
		for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
			if (++entriesSeen > 100_000) throw localizationOperationError("limit_exceeded");
			if (
				plan.auditExcludedDirectories.some(
					(name) => name.toLowerCase() === entry.name.toLowerCase()
				)
			)
				continue;
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink()) throw localizationOperationError("unsafe_path");
			if (entry.isDirectory()) {
				pending.push(path);
				continue;
			}
			if (!entry.isFile()) continue;
			await validateLocalizationOutputPath(root, path);
			const handle = await open(resolve(root, path), "r");
			try {
				const info = await handle.stat();
				totalBytes += info.size;
				if (info.size > 512 * 1024 * 1024 || totalBytes > 2 * 1024 * 1024 * 1024)
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
				hashes.set(path, hash.digest("hex"));
			} finally {
				await handle.close();
			}
		}
	}
	return hashes;
}
export function localizationFileChanges(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
	plan: LocalizationOperationPlan
): readonly LocalizationFileChange[] {
	const planned = new Set(plan.files.map((file) => file.relativePath));
	return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
		const beforeHash = before.get(path) ?? null;
		const afterHash = after.get(path) ?? null;
		return beforeHash === afterHash
			? []
			: [{ relativePath: path, beforeHash, afterHash, planned: planned.has(path) }];
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
