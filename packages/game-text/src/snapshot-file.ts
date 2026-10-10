import { open, type FileHandle } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import * as zlib from "node:zlib";
import { Schema } from "effect";
import {
	decodeSnapshotDirectory,
	decodeSnapshotSection,
	encodeSnapshotDirectory,
	MAX_SNAPSHOT_BYTES,
	MAX_SNAPSHOT_SECTIONS,
	snapshotAligned,
	snapshotCheck,
	snapshotDirectoryLength,
	snapshotFailure,
	snapshotPayload,
	type SnapshotColumn,
	type SnapshotDirectory,
	type SnapshotEntry
} from "./snapshot-format.js";

export function snapshotNodeChecksum(bytes: Uint8Array): number {
	let checksum = 0;
	for (let offset = 0; offset < bytes.length; offset += 8 * 1024 * 1024)
		checksum = zlib.crc32(bytes.subarray(offset, offset + 8 * 1024 * 1024), checksum);
	return checksum;
}
const codecOptions = { checksum: snapshotNodeChecksum, utf8Valid: isUtf8 };
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function verifiedString(bytes: Uint8Array, id: number) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(0, true),
		payload = 4 + (count + 1) * 4;
	snapshotCheck(id >= 0 && id < count, "strings", "String ID out of bounds");
	return textDecoder.decode(
		bytes.subarray(
			payload + view.getUint32(4 + id * 4, true),
			payload + view.getUint32(8 + id * 4, true)
		)
	);
}
export interface SnapshotSourceColumn extends Omit<SnapshotColumn, "values"> {
	/** A measured producer policy for cold domains; omitted uses the store default. */
	readonly compressionLevel?: number;
	readonly load: () => Promise<Uint8Array | Uint32Array>;
}
export interface SnapshotSource {
	readonly columns: readonly SnapshotSourceColumn[];
}
export type SnapshotCompressionLevel = number | ((column: SnapshotSourceColumn) => number);
export function snapshotColumnsSource(columns: readonly SnapshotColumn[]): SnapshotSource {
	return {
		columns: columns.map(({ values, ...column }) => ({ ...column, load: async () => values }))
	};
}
async function readAt(handle: FileHandle, length: number, position: number, section: string) {
	const bytes = new Uint8Array(length);
	for (let offset = 0; offset < length; ) {
		const { bytesRead } = await handle.read(
			bytes,
			offset,
			Math.min(64 * 1024 * 1024, length - offset),
			position + offset
		);
		snapshotCheck(bytesRead > 0, section, "File truncated during positioned read");
		offset += bytesRead;
	}
	return bytes;
}
async function writeAt(handle: FileHandle, bytes: Uint8Array, position: number) {
	for (let offset = 0; offset < bytes.length; ) {
		const { bytesWritten } = await handle.write(
			bytes,
			offset,
			Math.min(8 * 1024 * 1024, bytes.length - offset),
			position + offset
		);
		snapshotCheck(bytesWritten > 0, "publish", "Short write");
		offset += bytesWritten;
	}
}
/** Writes one raw section and at most its compressed copy, never a whole-file buffer. */
export async function writeSnapshotFile(
	path: string,
	source: SnapshotSource,
	level: SnapshotCompressionLevel = 1,
	sample?: () => void
) {
	const entries: SnapshotEntry[] = [];
	let position = 48 + source.columns.length * 96;
	snapshotCheck(
		source.columns.length > 0 && source.columns.length <= MAX_SNAPSHOT_SECTIONS,
		"directory",
		"Section count out of bounds"
	);
	const handle = await open(path, "wx");
	try {
		await writeAt(handle, new Uint8Array(position), 0);
		for (const column of source.columns) {
			await writeColumn(column);
		}
		const directory = encodeSnapshotDirectory(entries, position, codecOptions);
		await writeAt(handle, directory, 0);
		await handle.sync();
		return decodeSnapshotDirectory(directory, position, codecOptions);
	} finally {
		await handle.close();
	}
	async function writeColumn(column: SnapshotSourceColumn) {
		const values = await column.load();
		const raw = snapshotPayload({ ...column, values });
		const compressionLevel = Schema.is(Schema.Number)(level) ? level : level(column);
		const compressed =
			compressionLevel === 0
				? raw
				: zlib.zstdCompressSync(raw, {
						params: { [zlib.constants.ZSTD_c_compressionLevel]: compressionLevel }
					});
		sample?.();
		const stored = compressed.length < raw.length ? compressed : raw;
		snapshotCheck(
			position + snapshotAligned(stored.length) <= MAX_SNAPSHOT_BYTES,
			column.name,
			"Snapshot exceeds cap"
		);
		const entry: SnapshotEntry = {
			name: column.name,
			kind: column.kind,
			codec: stored === raw ? 0 : 1,
			offset: position,
			storedLength: stored.length,
			rawLength: raw.length,
			count: values.length,
			checksum: snapshotNodeChecksum(raw),
			domain: column.domain ?? "",
			stringCount: column.stringCount ?? 0
		};
		entries.push(entry);
		await writeAt(handle, stored, position);
		const padding = snapshotAligned(stored.length) - stored.length;
		if (padding) await writeAt(handle, new Uint8Array(padding), position + stored.length);
		position += snapshotAligned(stored.length);
	}
}
export interface SnapshotLoadedDomain {
	readonly bytes: Uint8Array;
	readonly blockOffsets: Float64Array;
	readonly blockStarts: Uint32Array;
	readonly count: number;
	readonly timings: {
		readonly readMs: number;
		readonly decompressMs: number;
		readonly verifyMs: number;
		readonly copyMs: number;
		readonly storedBytes: number;
		readonly readBatches: number;
	};
	readonly string: (id: number) => string;
	/** Plain Unicode lowercase substring scan. Returns a count, without retaining JS strings. */
	readonly scanSubstring: (needle: string) => number;
}
function blockForId(starts: Uint32Array, id: number) {
	let low = 0,
		high = starts.length;
	while (low + 1 < high) {
		const mid = (low + high) >>> 1;
		if (starts[mid]! <= id) low = mid;
		else high = mid;
	}
	return low;
}
export interface SnapshotFileReader {
	readonly directory: SnapshotDirectory;
	readonly load: (name: string) => Promise<Uint8Array | Uint32Array>;
	readonly strings: (domain: string, ids: readonly number[]) => Promise<string[]>;
	readonly domain: (domain: string) => Promise<SnapshotLoadedDomain>;
	readonly verify: () => Promise<void>;
	readonly close: () => Promise<void>;
}
/** Caller owns the handle lifetime; the Effect store binds it to a Scope. */
export async function openSnapshotFile(
	path: string,
	options: { readonly allowLegacy?: boolean; readonly bulkReadBytes?: number } = {}
): Promise<SnapshotFileReader> {
	const handle = await open(path, "r");
	let closed = false;
	try {
		const size = (await handle.stat()).size;
		snapshotCheck(
			Number.isSafeInteger(size) && size >= 48 && size <= MAX_SNAPSHOT_BYTES,
			"header",
			"File length exceeds cap"
		);
		const header = await readAt(handle, 48, 0, "header");
		const readOptions = { ...codecOptions, ...options };
		const length = snapshotDirectoryLength(header, readOptions);
		snapshotCheck(length <= size, "directory", "Truncated directory");
		const bytes = new Uint8Array(length);
		bytes.set(header);
		bytes.set(await readAt(handle, length - 48, 48, "directory"), 48);
		const directory = decodeSnapshotDirectory(bytes, size, readOptions);
		const entry = (name: string) => {
			snapshotCheck(!closed, name, "Reader scope is closed");
			const value = directory.entries.get(name);
			snapshotCheck(value !== undefined, name, "Missing section");
			return value;
		};
		const unpack = (value: SnapshotEntry, stored: Uint8Array) => {
			if (value.codec === 0) return stored;
			try {
				return zlib.zstdDecompressSync(stored, {
					maxOutputLength: value.rawLength,
					chunkSize: Math.max(64, value.rawLength)
				});
			} catch (cause) {
				throw snapshotFailure(
					value.name,
					`Cannot decompress bounded section: ${String(cause)}`
				);
			}
		};
		const checkPadding = (value: SnapshotEntry, stored: Uint8Array) => {
			snapshotCheck(
				stored.subarray(value.storedLength).every((byte) => byte === 0),
				value.name,
				"Nonzero section padding"
			);
		};
		const load = async (name: string) => {
			const value = entry(name);
			const stored = await readAt(
				handle,
				snapshotAligned(value.storedLength),
				value.offset,
				name
			);
			checkPadding(value, stored);
			return decodeSnapshotSection(
				value,
				unpack(value, stored.subarray(0, value.storedLength)),
				codecOptions
			);
		};
		const indexes = new Map<string, Uint32Array>();
		const domainEntries = new Map<string, SnapshotEntry[]>();
		for (const value of directory.entries.values())
			if (value.kind === "strings") {
				const blocks = domainEntries.get(value.domain) ?? [];
				blocks.push(value);
				domainEntries.set(value.domain, blocks);
			}
		const index = async (domain: string) => {
			entry(`${domain}.b0`);
			const cached = indexes.get(domain);
			if (cached) return cached;
			const blocks = domainEntries.get(domain)!;
			const starts =
				directory.version === 2
					? Uint32Array.from(blocks, (_, i) => i * 1024)
					: await load(`${domain}.starts`);
			snapshotCheck(
				starts instanceof Uint32Array && starts.length === blocks.length && starts[0] === 0,
				domain,
				"Invalid block start IDs"
			);
			for (let i = 1; i < starts.length; i++)
				snapshotCheck(
					starts[i]! > starts[i - 1]! && starts[i]! < blocks[0]!.stringCount,
					domain,
					"Invalid block start IDs"
				);
			indexes.set(domain, starts);
			return starts;
		};
		const checkBlockCount = (
			domain: string,
			starts: Uint32Array,
			block: number,
			raw: Uint8Array
		) => {
			const count = domainEntries.get(domain)![0]!.stringCount;
			snapshotCheck(
				new DataView(raw.buffer, raw.byteOffset).getUint32(0, true) ===
					(starts[block + 1] ?? count) - starts[block]!,
				domain,
				"String block count mismatch"
			);
		};
		return {
			directory,
			load,
			async strings(domain, ids) {
				const first = entry(`${domain}.b0`);
				const starts = await index(domain);
				const blocks = new Map<number, { id: number; row: number }[]>();
				for (let row = 0; row < ids.length; row++) {
					const id = ids[row]!;
					snapshotCheck(
						Number.isSafeInteger(id) && id >= 0 && id < first.stringCount,
						domain,
						"String ID out of bounds"
					);
					const block = blockForId(starts, id);
					const rows = blocks.get(block) ?? [];
					rows.push({ id: id - starts[block]!, row });
					blocks.set(block, rows);
				}
				const result = Array.from({ length: ids.length }, () => "");
				for (const [block, rows] of blocks) {
					const name = `${domain}.b${block}`;
					const values = await load(name);
					snapshotCheck(values instanceof Uint8Array, name, "Invalid string block kind");
					checkBlockCount(domain, starts, block, values);
					for (const { id, row } of rows) result[row] = verifiedString(values, id);
				}
				return result;
			},
			async domain(domain) {
				const starts = await index(domain);
				const blocks = domainEntries.get(domain)!;
				const count = blocks[0]!.stringCount;
				const offsets = new Float64Array(blocks.length + 1);
				for (let i = 0; i < blocks.length; i++)
					offsets[i + 1] = offsets[i]! + blocks[i]!.rawLength;
				// Compressed file length does not bound a domain's decoded allocation.
				snapshotCheck(
					offsets[blocks.length]! <= MAX_SNAPSHOT_BYTES,
					domain,
					"Raw domain exceeds bulk load cap; use page reads"
				);
				const bound = options.bulkReadBytes ?? 64 * 1024 * 1024;
				snapshotCheck(
					Number.isSafeInteger(bound) && bound > 0 && bound <= 64 * 1024 * 1024,
					domain,
					"Invalid bulk read bound"
				);
				const bytes = new Uint8Array(offsets[blocks.length]!);
				const timings = {
					readMs: 0,
					decompressMs: 0,
					verifyMs: 0,
					copyMs: 0,
					storedBytes: 0,
					readBatches: 0
				};
				for (let first = 0; first < blocks.length; ) {
					let last = first + 1;
					while (
						last < blocks.length &&
						blocks[last]!.offset +
							snapshotAligned(blocks[last]!.storedLength) -
							blocks[first]!.offset <=
							bound
					)
						last++;
					const begin = blocks[first]!.offset;
					const end =
						blocks[last - 1]!.offset + snapshotAligned(blocks[last - 1]!.storedLength);
					let tick = performance.now();
					const stored = await readAt(handle, end - begin, begin, domain);
					timings.readMs += performance.now() - tick;
					timings.storedBytes += stored.length;
					timings.readBatches++;
					for (let i = first; i < last; i++) {
						const block = blocks[i]!,
							at = block.offset - begin;
						checkPadding(
							block,
							stored.subarray(at, at + snapshotAligned(block.storedLength))
						);
						tick = performance.now();
						const raw = unpack(block, stored.subarray(at, at + block.storedLength));
						timings.decompressMs += performance.now() - tick;
						tick = performance.now();
						decodeSnapshotSection(block, raw, codecOptions);
						checkBlockCount(domain, starts, i, raw);
						timings.verifyMs += performance.now() - tick;
						tick = performance.now();
						bytes.set(raw, offsets[i]!);
						timings.copyMs += performance.now() - tick;
					}
					first = last;
				}
				const view = new DataView(bytes.buffer);
				const stringAt = (block: number, id: number) => {
					const at = offsets[block]!;
					const payload = at + 4 + (view.getUint32(at, true) + 1) * 4;
					return textDecoder.decode(
						bytes.subarray(
							payload + view.getUint32(at + 4 + id * 4, true),
							payload + view.getUint32(at + 8 + id * 4, true)
						)
					);
				};
				return {
					bytes,
					blockOffsets: offsets,
					blockStarts: starts,
					count,
					timings,
					string(id) {
						snapshotCheck(
							Number.isSafeInteger(id) && id >= 0 && id < count,
							domain,
							"String ID out of bounds"
						);
						const block = blockForId(starts, id);
						return stringAt(block, id - starts[block]!);
					},
					scanSubstring(needle) {
						const lower = needle.toLowerCase();
						let matches = 0;
						for (let block = 0; block < blocks.length; block++) {
							const length = (starts[block + 1] ?? count) - starts[block]!;
							for (let id = 0; id < length; id++)
								if (stringAt(block, id).toLowerCase().includes(lower)) matches++;
						}
						return matches;
					}
				};
			},
			async verify() {
				for (const name of directory.entries.keys()) {
					const value = await load(name),
						block = directory.entries.get(name)!;
					if (block.kind === "strings") {
						const starts = await index(block.domain);
						snapshotCheck(
							value instanceof Uint8Array,
							name,
							"Invalid string block kind"
						);
						checkBlockCount(
							block.domain,
							starts,
							Number(name.slice(name.lastIndexOf(".b") + 2)),
							value
						);
					}
				}
			},
			async close() {
				if (!closed) {
					closed = true;
					await handle.close();
				}
			}
		};
	} catch (cause) {
		await handle.close();
		throw cause;
	}
}
export function snapshotFileSource(reader: SnapshotFileReader): SnapshotSource {
	return {
		columns: [...reader.directory.entries.values()].map((entry) => {
			const column = {
				name: entry.name,
				kind: entry.kind,
				load: () => reader.load(entry.name)
			};
			return entry.domain
				? { ...column, domain: entry.domain, stringCount: entry.stringCount }
				: column;
		})
	};
}
