import { randomUUID } from "node:crypto";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Schema } from "effect";
import {
	encodeStringBlock,
	decodeStringBlock,
	snapshotCheck,
	MAX_SNAPSHOT_BYTES
} from "./snapshot-format.js";
import {
	openSnapshotFile,
	writeSnapshotFile,
	snapshotNodeChecksum,
	type SnapshotFileReader,
	type SnapshotSourceColumn,
	type SnapshotLoadedDomain
} from "./snapshot-file.js";
import {
	absentId,
	StringArena,
	sortBytes,
	stringBytes,
	compareBytes,
	comparePacked,
	comparePackedKey,
	encodeA64,
	a64Cursor,
	decodeA64,
	decodeA64Into,
	packedStrings,
	type PackedStrings
} from "./shared-string-codec.js";

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const maximumSharedSegments = 256;
export const SharedSegment = Schema.Struct({
	file: Schema.String.check(Schema.isPattern(/^strings-[a-f0-9-]+\.snapshot$/u)),
	start: Natural,
	count: Natural,
	domain: Schema.String.check(Schema.isMaxLength(23)),
	domains: Schema.Array(Schema.String.check(Schema.isMaxLength(23))),
	utf8Bytes: Natural,
	bytes: Natural
});
export type SharedSegment = typeof SharedSegment.Type;
interface SparseIndex {
	fences: PackedStrings;
	offsets: Uint32Array;
	frames: Uint32Array;
	masks: Uint32Array;
}
export interface SharedLoadedDomain extends SnapshotLoadedDomain {
	/** Native bulk representation. Legacy raw-block getters expand only when explicitly accessed. */
	readonly utf8: Uint8Array;
	readonly offsets: Uint32Array | Float64Array;
}

function scanPacked(strings: PackedStrings, needle: string) {
	const count = strings.offsets.length - 1,
		lower = needle.toLowerCase();
	if (!lower.length) return count;
	const query = Buffer.from(lower),
		bytes = strings.bytes;
	let matches = 0;
	const ascii = query.every((byte) => byte < 128);
	if (ascii && !/[a-z]/u.test(lower)) {
		let row = 0,
			start = 0;
		for (
			let found = bytes.indexOf(query, start);
			found >= 0;
			found = bytes.indexOf(query, start)
		) {
			while (row < count && strings.offsets[row + 1]! <= found) row++;
			if (row === count) break;
			if (found + query.length <= strings.offsets[row + 1]!) {
				matches++;
				start = strings.offsets[row + 1]!;
			} else start = found + 1;
		}
		return matches;
	}
	const fold = (byte: number) => (byte >= 65 && byte <= 90 ? byte + 32 : byte);
	for (let row = 0; row < count; row++) {
		const start = strings.offsets[row]!,
			end = strings.offsets[row + 1]!;
		let found = false,
			unicode = false;
		for (let position = start; position < end; position++) {
			if (bytes[position]! >= 128) unicode = true;
			if (!ascii || fold(bytes[position]!) !== query[0] || position + query.length > end)
				continue;
			let equal = true;
			for (let i = 1; i < query.length; i++)
				if (fold(bytes[position + i]!) !== query[i]) {
					equal = false;
					break;
				}
			if (equal) {
				found = true;
				break;
			}
		}
		// Unicode lowercase can change byte lengths (for example İ -> i plus combining dot).
		if (found || (unicode && bytes.toString("utf8", start, end).toLowerCase().includes(lower)))
			matches++;
	}
	return matches;
}
function containing(starts: readonly number[], id: number) {
	let low = 0,
		high = starts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (starts[middle]! <= id) low = middle + 1;
		else high = middle;
	}
	return low - 1;
}

/** Bulk callers retain the Phase 2 block/offset representation after A64 expansion. */
function expandDomain(packed: PackedStrings) {
	const starts: number[] = [],
		offsets: number[] = [0],
		count = packed.offsets.length - 1;
	let size = 0;
	for (let start = 0; start < count; ) {
		let end = start + 1;
		while (
			end < count &&
			8 + (end - start + 1) * 4 + packed.offsets[end + 1]! - packed.offsets[start]! <=
				256 * 1024
		)
			end++;
		starts.push(start);
		size += 8 + (end - start) * 4 + packed.offsets[end]! - packed.offsets[start]!;
		offsets.push(size);
		start = end;
	}
	snapshotCheck(
		size <= MAX_SNAPSHOT_BYTES,
		"domain",
		"Raw domain exceeds bulk load cap; use page reads"
	);
	const bytes = Buffer.allocUnsafe(size),
		view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
		blockStarts = Uint32Array.from(starts),
		blockOffsets = Float64Array.from(offsets);
	for (let block = 0; block < starts.length; block++) {
		const start = starts[block]!,
			end = starts[block + 1] ?? count,
			position = offsets[block]!,
			rows = end - start;
		view.setUint32(position, rows, true);
		for (let row = 0; row <= rows; row++)
			view.setUint32(
				position + 4 + row * 4,
				packed.offsets[start + row]! - packed.offsets[start]!,
				true
			);
		packed.bytes.copy(
			bytes,
			position + 8 + rows * 4,
			packed.offsets[start],
			packed.offsets[end]
		);
	}
	const string = (id: number) => {
		snapshotCheck(Number.isInteger(id) && id >= 0 && id < count, "domain", "Invalid domain ID");
		const block = containing(starts, id),
			position = offsets[block]!,
			local = id - starts[block]!,
			payload = position + 8 + view.getUint32(position, true) * 4;
		return bytes.toString(
			"utf8",
			payload + view.getUint32(position + 4 + local * 4, true),
			payload + view.getUint32(position + 8 + local * 4, true)
		);
	};
	return {
		bytes,
		blockOffsets,
		blockStarts,
		count,
		string,
		scanSubstring: (needle: string) => {
			let matches = 0;
			const lower = needle.toLowerCase();
			for (let id = 0; id < count; id++)
				if (string(id).toLowerCase().includes(lower)) matches++;
			return matches;
		}
	};
}

/** Immutable A64 segments; positioned reads retain the generation's physical handles. */
export class SharedStringFiles {
	readonly files: SnapshotFileReader[] = [];
	readonly segments: SharedSegment[];
	readBytes = 0;
	indexReadBytes = 0;
	appendedBytes = 0;
	blocksLoaded = 0;
	lookupStrings = 0;
	reusedStrings = 0;
	probePasses = 0;
	sortMs = 0;
	probeMs = 0;
	appendMs = 0;
	readonly timings = {
		collectMs: 0,
		reuseMs: 0,
		layerEncodeMs: 0,
		layerVerifyMs: 0,
		garbageMs: 0,
		rootPublishMs: 0
	};
	private readonly indexes = new Map<number, SparseIndex>();
	private readonly frames = new Map<string, Buffer>();
	private frameBytes = 0;
	private readonly decoded = new Map<string, PackedStrings>();
	private decodedBytes = 0;
	private decodedHits = 0;
	private decodedMisses = 0;
	cacheMetrics() {
		return {
			decodedBlocks: this.decoded.size,
			decodedBytes: this.decodedBytes,
			decodedHits: this.decodedHits,
			decodedMisses: this.decodedMisses
		};
	}
	private closed = false;
	private readonly trackRead = (bytes: number) => {
		this.readBytes += bytes;
	};
	readonly directory: string;
	constructor(directory: string, segments: readonly SharedSegment[]) {
		this.directory = directory;
		this.segments = [...segments];
	}
	get count() {
		const last = this.segments.at(-1);
		return last ? last.start + last.count : 0;
	}
	async open() {
		try {
			let next = 0;
			for (const segment of this.segments) {
				snapshotCheck(
					segment.start === next && segment.count > 0 && next + segment.count < absentId,
					"segments",
					"Invalid ID range"
				);
				const reader = await openSnapshotFile(join(this.directory, segment.file), {
					onRead: this.trackRead
				});
				this.files.push(reader);
				snapshotCheck(
					reader.directory.fileLength === segment.bytes &&
						reader.directory.entries.has("front.fences"),
					"segments",
					"Segment size or codec differs"
				);
				next += segment.count;
			}
			return this;
		} catch (cause) {
			await this.close();
			throw cause;
		}
	}
	private async index(segment: number) {
		snapshotCheck(!this.closed, "front", "Shared string scope is closed");
		let index = this.indexes.get(segment);
		if (index) return index;
		const reader = this.files[segment]!;
		const load = async (name: string) => {
			this.indexReadBytes += reader.directory.entries.get(name)?.storedLength ?? 0;
			return reader.load(name);
		};
		const fences = await load("front.fences"),
			offsets = await load("front.offsets"),
			frames = await load("front.frames"),
			masks = await load("front.masks");
		snapshotCheck(
			fences instanceof Uint8Array &&
				offsets instanceof Uint32Array &&
				frames instanceof Uint32Array &&
				masks instanceof Uint32Array,
			"front",
			"Invalid index kinds"
		);
		const block = decodeStringBlock(fences),
			arena = new StringArena();
		for (let i = 0; i < block.count; i++) arena.add(block.bytes(i));
		const keys = arena.finish(),
			count = Math.ceil(this.segments[segment]!.count / 64);
		snapshotCheck(
			block.count === count &&
				offsets.length === count &&
				frames.length === count &&
				masks.length === count,
			"front",
			"Invalid sparse index length"
		);
		for (let i = 0; i < count; i++) {
			snapshotCheck(
				i
					? frames[i] === frames[i - 1] || frames[i] === frames[i - 1]! + 1
					: frames[i] === 0,
				"front",
				"Invalid frame sequence"
			);
			snapshotCheck(
				reader.directory.entries.has(`front.b${frames[i]}`) &&
					(i > 0 && frames[i] === frames[i - 1]
						? offsets[i]! > offsets[i - 1]!
						: offsets[i] === 0),
				"front",
				"Invalid frame boundary"
			);
			if (i)
				snapshotCheck(
					compareBytes(stringBytes(keys, i - 1), stringBytes(keys, i)) < 0,
					"front",
					"Unsorted fences"
				);
		}
		index = { fences: keys, offsets, frames, masks };
		this.indexes.set(segment, index);
		return index;
	}
	private async block(segment: number, block: number) {
		const index = await this.index(segment);
		snapshotCheck(block >= 0 && block < index.offsets.length, "front", "Invalid block ID");
		const frame = index.frames[block]!,
			key = `${segment}:${frame}`;
		let bytes = this.frames.get(key);
		if (!bytes) {
			const loaded = await this.files[segment]!.load(`front.b${frame}`);
			snapshotCheck(loaded instanceof Uint8Array, "front", "Invalid frame");
			bytes = Buffer.from(loaded.buffer, loaded.byteOffset, loaded.byteLength);
			this.blocksLoaded++;
			if (this.frameBytes + bytes.length > 32 * 1024 ** 2) {
				this.frames.clear();
				this.frameBytes = 0;
			}
			this.frames.set(key, bytes);
			this.frameBytes += bytes.length;
		}
		const start = index.offsets[block]!,
			end = index.frames[block + 1] === frame ? index.offsets[block + 1]! : bytes.length;
		snapshotCheck(start < end && end <= bytes.length, "front", "Invalid block bounds");
		const payload = bytes.subarray(start, end);
		snapshotCheck(
			payload[0] === Math.min(64, this.segments[segment]!.count - block * 64),
			"front",
			"Block count differs"
		);
		return payload;
	}
	async strings(ids: readonly number[]): Promise<string[]> {
		return (await this.bytes(ids)).map((value) => value.toString("utf8"));
	}
	/** Prior IDs are sorted ranks: decode each block directly into the external byte arena. */
	async collectSorted(ids: Uint32Array, arena: StringArena) {
		snapshotCheck(!this.closed, "strings", "Shared string scope is closed");
		for (let row = 0; row < ids.length; row++)
			snapshotCheck(
				ids[row]! < this.count && (!row || ids[row - 1]! <= ids[row]!),
				"strings",
				"Invalid sorted shared IDs"
			);
		const starts = this.segments.map((segment) => segment.start);
		let position = 0;
		while (position < ids.length) {
			const segment = containing(starts, ids[position]!),
				block = (ids[position]! - starts[segment]!) >>> 6,
				base = starts[segment]! + block * 64,
				cursor = a64Cursor(await this.block(segment, block));
			let rank = 0;
			for (let value = cursor.next(); value; value = cursor.next()) {
				while (ids[position] === base + rank) {
					arena.add(value);
					position++;
				}
				rank++;
			}
		}
	}
	/** Bounded batches reuse exact bytes without a UTF-8 decode/re-encode round trip. */
	async bytes(ids: readonly number[]): Promise<Buffer[]> {
		snapshotCheck(!this.closed, "strings", "Shared string scope is closed");
		const starts = this.segments.map((s) => s.start),
			groups = new Map<string, { segment: number; block: number; rows: number[] }>();
		for (let row = 0; row < ids.length; row++) {
			const id = ids[row]!;
			snapshotCheck(
				Number.isInteger(id) && id >= 0 && id < this.count,
				"strings",
				"Invalid shared ID"
			);
			const segment = containing(starts, id),
				block = (id - starts[segment]!) >>> 6,
				key = `${segment}:${block}`;
			const group = groups.get(key) ?? { segment, block, rows: [] };
			group.rows.push(row);
			groups.set(key, group);
		}
		const output: Buffer[] = [];
		output.length = ids.length;
		for (const group of groups.values()) {
			const key = `${group.segment}:${group.block}`;
			let values = this.decoded.get(key);
			if (!values) {
				this.decodedMisses++;
				const cursor = a64Cursor(await this.block(group.segment, group.block)),
					arena = new StringArena(1024, 64);
				for (let value = cursor.next(); value; value = cursor.next()) arena.add(value);
				values = arena.finish();
				const size = values.bytes.buffer.byteLength + values.offsets.buffer.byteLength;
				if (size <= 32 * 1024 ** 2) {
					while (this.decodedBytes + size > 32 * 1024 ** 2) {
						const oldest = this.decoded.keys().next().value!;
						const entry = this.decoded.get(oldest)!;
						this.decodedBytes -=
							entry.bytes.buffer.byteLength + entry.offsets.buffer.byteLength;
						this.decoded.delete(oldest);
					}
					this.decoded.set(key, values);
					this.decodedBytes += size;
				}
			} else {
				this.decodedHits++;
				this.decoded.delete(key);
				this.decoded.set(key, values);
			}
			snapshotCheck(
				values.offsets.length - 1 ===
					Math.min(64, this.segments[group.segment]!.count - group.block * 64),
				"front",
				"Block count differs"
			);
			for (const row of group.rows)
				output[row] = stringBytes(values, (ids[row]! - starts[group.segment]!) & 63);
		}
		return output;
	}
	/** One sorted probe pass per immutable segment. Exact byte equality, no fingerprints. */
	async internPacked(
		domain: string,
		values: PackedStrings,
		reuse?: Uint32Array,
		ordered = false
	) {
		snapshotCheck(!this.closed, "intern", "Shared string scope is closed");
		const output = reuse ?? new Uint32Array(values.offsets.length - 1).fill(absentId);
		const pending = new Uint32Array(output.length);
		let pendingCount = 0;
		for (let id = 0; id < output.length; id++)
			if (output[id] === absentId) pending[pendingCount++] = id;
		this.reusedStrings += output.length - pendingCount;
		if (!pendingCount) return output;
		const sortStarted = performance.now();
		const pendingIds = pending.subarray(0, pendingCount);
		if (ordered)
			for (let row = 1; row < pendingIds.length; row++)
				snapshotCheck(
					comparePacked(values, pendingIds[row - 1]!, values, pendingIds[row]!) <= 0,
					"intern",
					"Ordered input is not byte sorted"
				);
		const order = ordered ? pendingIds : sortBytes(values, pendingIds);
		this.sortMs += performance.now() - sortStarted;
		const unique = new Uint32Array(order.length);
		let size = 0,
			previousId = -1;
		for (const id of order) {
			if (previousId < 0 || comparePacked(values, previousId, values, id) !== 0) {
				unique[size++] = id;
				previousId = id;
			}
		}
		const requests = unique.subarray(0, size);
		const requested = requests.reduce((n, id) => n + Number(output[id] === absentId), 0);
		this.lookupStrings += requested;
		const segments = Array.from({ length: this.segments.length }, (_, segment) => segment).sort(
			(a, b) =>
				Number(this.segments[b]!.domains.includes(domain)) -
					Number(this.segments[a]!.domains.includes(domain)) || b - a
		);
		const probeStarted = performance.now();
		for (const segment of segments) {
			if (!requests.some((id) => output[id] === absentId)) break;
			const index = await this.index(segment);
			const first = stringBytes(index.fences, 0);
			const tail = decodeA64(await this.block(segment, index.offsets.length - 1));
			const last = tail.at(-1)!;
			let low = 0,
				high = requests.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (comparePackedKey(values, requests[middle]!, first) < 0) low = middle + 1;
				else high = middle;
			}
			const begin = low;
			low = begin;
			high = requests.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (comparePackedKey(values, requests[middle]!, last) <= 0) low = middle + 1;
				else high = middle;
			}
			const selected = requests.subarray(begin, low);
			if (!selected.length) continue;
			const firstPending = selected.find((id) => output[id] === absentId);
			if (firstPending === undefined) continue;
			low = 0;
			high = index.offsets.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (comparePacked(index.fences, middle, values, firstPending) <= 0)
					low = middle + 1;
				else high = middle;
			}
			this.probePasses++;
			let fence = low - 1,
				blockId = -1,
				cursor: ReturnType<typeof a64Cursor> | undefined,
				current: Buffer | undefined,
				rank = 0;
			for (const id of selected) {
				if (output[id] !== absentId) continue;
				while (
					fence + 1 < index.offsets.length &&
					comparePacked(index.fences, fence + 1, values, id) <= 0
				)
					fence++;
				if (fence < 0) continue;
				if (blockId !== fence) {
					cursor = a64Cursor(await this.block(segment, fence));
					blockId = fence;
					rank = 0;
					current = cursor.next();
				}
				while (current && comparePackedKey(values, id, current) > 0) {
					current = cursor!.next();
					rank++;
				}
				if (current && comparePackedKey(values, id, current) === 0)
					output[id] = this.segments[segment]!.start + fence * 64 + rank;
			}
		}
		this.probeMs += performance.now() - probeStarted;
		const missing = new Uint32Array(order.length);
		let count = 0;
		const base = this.count;
		for (const id of requests) {
			if (output[id] !== absentId) continue;
			missing[count] = id;
			output[id] = base + count++;
		}
		if (count) {
			await this.append(domain, values, missing.subarray(0, count));
		}
		let representative = 0;
		for (const id of order) {
			while (
				representative + 1 < requests.length &&
				comparePacked(values, requests[representative + 1]!, values, id) <= 0
			)
				representative++;
			output[id] = output[requests[representative]!]!;
		}
		return output;
	}
	async intern(domain: string, values: readonly string[]) {
		return this.internPacked(domain, packedStrings(values));
	}
	async copyUnique(domain: string, values: readonly string[]) {
		return this.intern(domain, values);
	}
	async flush() {
		/* Every call publishes immutable sorted ranks immediately. */
	}
	async ownership(segment: number) {
		if (this.segments[segment]!.domains.length === 1) return undefined;
		const owners = new Uint32Array(this.segments[segment]!.count);
		for (let start = 0; start < owners.length; start += 8 * 1024 ** 2) {
			const page = await this.files[segment]!.load(`front.o${start / (8 * 1024 ** 2)}`);
			snapshotCheck(
				page instanceof Uint32Array &&
					page.length === Math.min(8 * 1024 ** 2, owners.length - start),
				"front",
				"Invalid owner page"
			);
			owners.set(page, start);
		}
		for (const owner of owners)
			snapshotCheck(owner < this.segments[segment]!.domains.length, "front", "Invalid owner");
		return owners;
	}
	/** Compaction preserves one sorted segment per owning domain. Borrowed IDs remain shared. */
	async merged(values: PackedStrings, owners: Uint32Array, domains: readonly string[]) {
		const count = values.offsets.length - 1,
			counts = new Uint32Array(domains.length),
			starts = new Uint32Array(domains.length + 1);
		for (let row = 0; row < count; row++) counts[owners[row]!]!++;
		for (let domain = 0; domain < domains.length; domain++)
			starts[domain + 1] = starts[domain]! + counts[domain]!;
		const positions = starts.slice(),
			order = new Uint32Array(count),
			inverse = new Uint32Array(count);
		for (let row = 0; row < count; row++) order[positions[owners[row]!]!++] = row;
		for (let domain = 0; domain < domains.length; domain++) {
			const selected = sortBytes(values, order.subarray(starts[domain], starts[domain + 1])),
				base = this.count;
			for (let rank = 0; rank < selected.length; rank++)
				inverse[selected[rank]!] = base + rank;
			if (selected.length) await this.append(domains[domain]!, values, selected);
		}
		return inverse;
	}
	private async append(
		domain: string,
		values: PackedStrings,
		order: Uint32Array,
		owners?: Uint32Array,
		domains: readonly string[] = [domain]
	) {
		async function* keys() {
			for (const id of order)
				yield { bytes: stringBytes(values, id), owner: owners?.[id] ?? 0 };
		}
		return this.appendOrdered(domain, order.length, keys(), domains);
	}
	/** Cold sorting already assigned the ranks; encode the disk merge without collecting it. */
	async appendOrdered(
		domain: string,
		count: number,
		keys: AsyncIterable<{ bytes: Buffer; owner: number }>,
		domains: readonly string[] = [domain]
	) {
		const appendStarted = performance.now();
		snapshotCheck(!this.closed, "append", "Shared string scope is closed");
		snapshotCheck(
			this.count + count < absentId && domains.length <= 4096,
			"segments",
			"Dictionary bounds exceeded"
		);
		const start = this.count,
			blocks = Math.ceil(count / 64),
			offsets = new Uint32Array(blocks),
			frames = new Uint32Array(blocks),
			masks = new Uint32Array(blocks),
			fences: string[] = [],
			columns: SnapshotSourceColumn[] = [];
		let frameBytes = 0,
			frameId = 0,
			utf8Bytes = 0;
		let group: Buffer[] = [];
		const flushFrame = () => {
			if (!group.length) return;
			const raw = Buffer.concat(group, frameBytes);
			const compressed = zstdCompressSync(raw, {
				params: {
					[constants.ZSTD_c_compressionLevel]:
						domain === "paths" ? 9 : domain === "identity" ? 6 : 3
				}
			});
			const data = compressed.length < raw.length ? compressed : raw;
			const codec: 0 | 1 = data === raw ? 0 : 1;
			const preparedBytes = {
				data,
				rawLength: raw.length,
				checksum: snapshotNodeChecksum(raw),
				codec
			};
			columns.push({
				name: `front.b${frameId++}`,
				kind: "bytes",
				preparedBytes,
				load: async () =>
					preparedBytes.codec
						? zstdDecompressSync(preparedBytes.data)
						: preparedBytes.data
			});
			group = [];
			frameBytes = 0;
		};
		let block = 0,
			seen = 0,
			mask = 0;
		let blockKeys: Buffer[] = [];
		const finishBlock = () => {
			const encoded = encodeA64(blockKeys);
			if (frameBytes && frameBytes + encoded.length > 256 * 1024) {
				flushFrame();
			}
			offsets[block] = frameBytes;
			frames[block] = frameId;
			masks[block] = mask >>> 0;
			frameBytes += encoded.length;
			group.push(encoded);
			fences.push(blockKeys[0]!.toString("utf8"));
			block++;
			blockKeys = [];
			mask = 0;
		};
		const ownerRanks = domains.length > 1 ? new Uint32Array(count) : undefined;
		for await (const key of keys) {
			snapshotCheck(seen < count, "front", "Too many sorted keys");
			blockKeys.push(Buffer.from(key.bytes));
			utf8Bytes += key.bytes.length;
			mask |= 1 << key.owner;
			if (ownerRanks) ownerRanks[seen] = key.owner;
			seen++;
			if (blockKeys.length === 64) finishBlock();
		}
		snapshotCheck(seen === count, "front", "Missing sorted keys");
		if (blockKeys.length) finishBlock();
		flushFrame();
		if (ownerRanks)
			for (let start = 0; start < count; start += 8 * 1024 ** 2) {
				const begin = start,
					end = Math.min(count, start + 8 * 1024 ** 2);
				columns.push({
					name: `front.o${start / (8 * 1024 ** 2)}`,
					kind: "u32",
					load: async () => ownerRanks.subarray(begin, end)
				});
			}
		columns.push(
			{ name: "front.fences", kind: "bytes", load: async () => encodeStringBlock(fences) },
			{ name: "front.offsets", kind: "u32", load: async () => offsets },
			{ name: "front.frames", kind: "u32", load: async () => frames },
			{ name: "front.masks", kind: "u32", load: async () => masks }
		);
		const file = `strings-${randomUUID()}.snapshot`,
			result = await writeSnapshotFile(
				join(this.directory, file),
				{ columns },
				(column) => column.compressionLevel ?? 1
			);
		const reader = await openSnapshotFile(join(this.directory, file), {
			onRead: this.trackRead
		});
		try {
			await reader.verify();
		} catch (cause) {
			await reader.close();
			throw cause;
		}
		this.files.push(reader);
		this.segments.push({
			file,
			start,
			count,
			domain,
			domains: [...domains],
			utf8Bytes,
			bytes: result.fileLength
		});
		this.appendedBytes += result.fileLength;
		this.appendMs += performance.now() - appendStarted;
	}
	async domain(domain: string): Promise<readonly SharedLoadedDomain[]> {
		snapshotCheck(!this.closed, "domain", "Shared string scope is closed");
		const result: SharedLoadedDomain[] = [];
		for (let segment = 0; segment < this.segments.length; segment++) {
			const meta = this.segments[segment]!,
				owner = meta.domains.indexOf(domain);
			if (owner < 0) continue;
			const index = await this.index(segment),
				arena = new StringArena(0, 0),
				before = this.readBytes,
				ownership = await this.ownership(segment);
			if (!ownership) {
				snapshotCheck(
					meta.utf8Bytes + (meta.count + 1) * (meta.utf8Bytes < 0xffffffff ? 4 : 8) <=
						MAX_SNAPSHOT_BYTES,
					"domain",
					"Raw domain exceeds bulk load cap; use pages"
				);
				const packed: PackedStrings = {
					bytes: Buffer.allocUnsafe(meta.utf8Bytes),
					offsets:
						meta.utf8Bytes < 0xffffffff
							? new Uint32Array(meta.count + 1)
							: new Float64Array(meta.count + 1)
				};
				for (let block = 0; block < index.masks.length; block++)
					decodeA64Into(await this.block(segment, block), packed, block * 64);
				snapshotCheck(
					packed.offsets[meta.count] === meta.utf8Bytes,
					"front",
					"Domain UTF-8 size differs"
				);
				result.push(this.loadedDomain(packed, this.readBytes - before));
				continue;
			}
			for (let block = 0; block < index.masks.length; block++) {
				if (!(index.masks[block]! & (1 << owner))) continue;
				const cursor = a64Cursor(await this.block(segment, block));
				let row = 0;
				for (let value = cursor.next(); value; value = cursor.next()) {
					if (!ownership || ownership[block * 64 + row] === owner) arena.add(value);
					row++;
				}
			}
			result.push(this.loadedDomain(arena.finish(), this.readBytes - before));
		}
		return result;
	}
	/** A full segment retains global rank offsets, including mixed-domain ownership. */
	async packedSegment(segment: number): Promise<PackedStrings> {
		const meta = this.segments[segment];
		snapshotCheck(!this.closed && meta !== undefined, "segment", "Invalid segment");
		const index = await this.index(segment);
		const packed: PackedStrings = {
			bytes: Buffer.allocUnsafe(meta.utf8Bytes),
			offsets:
				meta.utf8Bytes < 0xffffffff
					? new Uint32Array(meta.count + 1)
					: new Float64Array(meta.count + 1)
		};
		for (let block = 0; block < index.masks.length; block++)
			decodeA64Into(await this.block(segment, block), packed, block * 64);
		snapshotCheck(packed.offsets[meta.count] === meta.utf8Bytes, "segment", "Size differs");
		return packed;
	}
	private loadedDomain(packed: PackedStrings, storedBytes: number): SharedLoadedDomain {
		let legacy: ReturnType<typeof expandDomain> | undefined;
		const compatibility = () => (legacy ??= expandDomain(packed));
		return {
			utf8: packed.bytes,
			offsets: packed.offsets,
			get bytes() {
				return compatibility().bytes;
			},
			get blockOffsets() {
				return compatibility().blockOffsets;
			},
			get blockStarts() {
				return compatibility().blockStarts;
			},
			count: packed.offsets.length - 1,
			string: (id) => {
				snapshotCheck(
					Number.isInteger(id) && id >= 0 && id < packed.offsets.length - 1,
					"domain",
					"Invalid domain ID"
				);
				return packed.bytes.toString("utf8", packed.offsets[id], packed.offsets[id + 1]);
			},
			scanSubstring: (needle) => scanPacked(packed, needle),
			timings: {
				storedBytes,
				readMs: 0,
				decompressMs: 0,
				verifyMs: 0,
				copyMs: 0,
				readBatches: 0
			}
		};
	}
	async range(prefix: string) {
		snapshotCheck(!this.closed, "range", "Shared string scope is closed");
		const lower = Buffer.from(prefix),
			upper = Buffer.from(lower);
		let last = upper.length - 1;
		while (last >= 0 && upper[last] === 255) last--;
		if (last >= 0) upper[last]!++;
		const ranges: { start: number; end: number }[] = [];
		for (let segment = 0; segment < this.segments.length; segment++) {
			const index = await this.index(segment),
				meta = this.segments[segment]!;
			const bound = async (key: Buffer) => {
				let low = 0,
					high = index.offsets.length;
				while (low < high) {
					const mid = (low + high) >>> 1;
					if (compareBytes(stringBytes(index.fences, mid), key) <= 0) low = mid + 1;
					else high = mid;
				}
				const block = Math.max(0, low - 1),
					values = decodeA64(await this.block(segment, block));
				let row = 0;
				while (row < values.length && compareBytes(values[row]!, key) < 0) row++;
				return meta.start + Math.min(meta.count, block * 64 + row);
			};
			ranges.push({
				start: await bound(lower),
				end: last < 0 ? meta.start + meta.count : await bound(upper.subarray(0, last + 1))
			});
		}
		return ranges;
	}
	async close() {
		this.closed = true;
		for (const file of this.files) await file.close();
		this.indexes.clear();
		this.frames.clear();
		this.decoded.clear();
	}
}
