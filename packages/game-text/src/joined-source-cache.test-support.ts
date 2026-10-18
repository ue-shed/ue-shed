import { Effect } from "effect";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { encodeWtf8 } from "./wtf8.js";
import { snapshotCheck } from "./snapshot-format.js";
import { snapshotNodeChecksum, type SnapshotSourceColumn } from "./snapshot-file.js";
import type { SharedIndexWriter } from "./shared-index.js";
import type { JoinStrings } from "./joined-target-input.js";
import { validatePackedStrings } from "./shared-string-codec.js";

import {
	maximumSourceCacheBytes,
	JoinedSourceCacheMeta,
	type JoinedSourceCache
} from "./joined-source-cache-contract.js";
export {
	maximumSourceCacheBytes,
	JoinedSourceCacheMeta,
	type JoinedSourceCache
} from "./joined-source-cache-contract.js";
const sourceTrigramBytes = 128 ** 3 / 8;

export function simpleSourceBytes(bytes: Uint8Array): boolean {
	for (const byte of bytes) if (byte >= 128 || (byte >= 65 && byte <= 90)) return false;
	return true;
}

/** Exact membership for three ASCII bytes; each source boundary is kept separate. */
export function addSourceTrigrams(index: Uint8Array, bytes: Uint8Array) {
	for (let position = 2; position < bytes.length; position++) {
		const gram = (bytes[position - 2]! << 14) | (bytes[position - 1]! << 7) | bytes[position]!;
		index[gram >>> 3]! |= 1 << (gram & 7);
	}
}

/** A missing gram rejects only lowercase ASCII sources. Other sources retain exact folding. */
export function rejectSourceTrigrams(index: Uint8Array, terms: readonly Uint8Array[]): boolean {
	for (const term of terms)
		for (let position = 2; position < term.length; position++) {
			const gram = (term[position - 2]! << 14) | (term[position - 1]! << 7) | term[position]!;
			if (!(index[gram >>> 3]! & (1 << (gram & 7)))) return true;
		}
	return false;
}

/** A bounded optional query accelerator, published atomically with its owning full join. */
export const prepareJoinedSourceCache = Effect.fn("JoinedTarget.sourceCache")(function* (
	writer: SharedIndexWriter,
	strings: JoinStrings,
	columns: readonly Uint32Array[],
	options: { readonly minimumEntries?: number; readonly maximumBytes?: number } = {}
) {
	let maximum = -1;
	for (const values of columns) for (const id of values) if (id > maximum) maximum = id;
	const selected = new Uint8Array(maximum + 1);
	let count = 0;
	for (const values of columns)
		for (const id of values)
			if (!selected[id]) {
				selected[id] = 1;
				count++;
			}
	if (!count || count < (options.minimumEntries ?? 8192)) return undefined;
	const ids = new Uint32Array(count),
		starts = new Uint32Array(count + 1);
	let row = 0;
	for (let id = 0; id < selected.length; id++) if (selected[id]) ids[row++] = id;
	const last = strings.reader.manifest.segments.at(-1),
		publishedCount = last ? last.start + last.count : 0;
	// Published IDs are read from their segments, which the caller may not have loaded.
	yield* strings.need([ids.filter((id) => id < publishedCount)]);
	const appended = new Map<number, Uint8Array>();
	for (let start = 0; start < ids.length; start += 8192) {
		const fresh = Array.from(ids.subarray(start, start + 8192)).filter(
			(id) => id >= publishedCount
		);
		if (!fresh.length) continue;
		const values = yield* writer.strings(fresh);
		for (let index = 0; index < fresh.length; index++)
			appended.set(fresh[index]!, encodeWtf8(values[index]!));
	}
	const bytesAt = (id: number) => appended.get(id) ?? strings.bytes(id);
	const bound = Math.min(
		options.maximumBytes ?? maximumSourceCacheBytes,
		maximumSourceCacheBytes
	);
	let length = 0;
	for (let index = 0; index < ids.length; index++) {
		starts[index] = length;
		length += bytesAt(ids[index]!).length;
		if (length + ids.byteLength + starts.byteLength + sourceTrigramBytes + count > bound)
			return undefined;
	}
	starts[count] = length;
	const bytes = new Uint8Array(length),
		simple = new Uint8Array(count),
		trigrams = new Uint8Array(sourceTrigramBytes);
	for (let index = 0; index < ids.length; index++) {
		const value = bytesAt(ids[index]!);
		bytes.set(value, starts[index]!);
		if (simpleSourceBytes(value)) {
			simple[index] = 1;
			addSourceTrigrams(trigrams, value);
		}
	}
	const compressed = zstdCompressSync(bytes, {
		params: { [constants.ZSTD_c_compressionLevel]: 1 }
	});
	const data = compressed.length < bytes.length ? compressed : bytes,
		codec: 0 | 1 = data === bytes ? 0 : 1;
	const storedBound =
		data.length +
		ids.byteLength +
		starts.byteLength +
		trigrams.byteLength +
		simple.byteLength +
		5 * 99;
	if (storedBound > 16 * 1024 ** 2) return undefined;
	const preparedBytes = {
		data,
		rawLength: bytes.length,
		checksum: snapshotNodeChecksum(bytes),
		codec
	};
	const meta = {
		version: 1 as const,
		count,
		bytes: length,
		trigramVersion: 1 as const,
		flagsVersion: 1 as const
	};
	const sourceColumns: SnapshotSourceColumn[] = [
		{ name: "query.source.ids", kind: "stringIds", domain: "source", load: async () => ids },
		{ name: "query.source.starts", kind: "u32", load: async () => starts },
		{
			name: "query.source.bytes",
			kind: "bytes",
			preparedBytes,
			load: async () => (codec ? zstdDecompressSync(data) : data)
		},
		{ name: "query.source.trigrams", kind: "bytes", load: async () => trigrams },
		{ name: "query.source.simple", kind: "bytes", load: async () => simple }
	];
	yield* Effect.annotateCurrentSpan({
		"join.sourceCache.entries": count,
		"join.sourceCache.rawBytes":
			length + ids.byteLength + starts.byteLength + trigrams.byteLength + simple.byteLength,
		"join.sourceCache.storedBoundBytes": storedBound
	});
	return { meta, columns: sourceColumns };
});

/** CRCs are checked by the snapshot reader; validate the optional projection's relationships. */
export function readJoinedSourceCache(
	meta: JoinedSourceCacheMeta,
	ids: Uint32Array,
	starts: Uint32Array,
	bytes: Uint8Array,
	maximumId: number,
	trigrams?: Uint8Array,
	flags?: Uint8Array
): JoinedSourceCache {
	const section = "query.source";
	snapshotCheck(
		ids.length === meta.count &&
			starts.length === ids.length + 1 &&
			bytes.length === meta.bytes &&
			starts[0] === 0 &&
			starts[ids.length] === bytes.length &&
			bytes.length +
				ids.byteLength +
				starts.byteLength +
				(trigrams?.byteLength ?? 0) +
				(flags?.byteLength ?? 0) <=
				maximumSourceCacheBytes &&
			(meta.trigramVersion === undefined || trigrams?.length === sourceTrigramBytes) &&
			(meta.flagsVersion === undefined || flags?.length === ids.length),
		section,
		"Invalid source cache lengths"
	);
	const index = new Uint32Array(maximumId),
		simple = flags ?? new Uint8Array(ids.length),
		packed = {
			bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			offsets: starts
		};
	validatePackedStrings(packed, section);
	for (let row = 0; row < ids.length; row++) {
		const id = ids[row]!,
			start = starts[row]!,
			end = starts[row + 1]!;
		snapshotCheck(
			id < maximumId && !index[id] && start <= end && end <= bytes.length,
			section,
			"Invalid source cache ID or range"
		);
		index[id] = row + 1;
		if (flags) snapshotCheck(flags[row]! <= 1, section, "Invalid source cache flag");
		else simple[row] = Number(simpleSourceBytes(bytes.subarray(start, end)));
	}
	return {
		packed,
		index,
		ids,
		simple,
		...(trigrams ? { trigrams } : undefined)
	};
}
