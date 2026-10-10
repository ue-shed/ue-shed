/** Standalone dictionary candidates. No production format or native dependency. */
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

export interface PackedStrings {
	readonly bytes: Buffer;
	readonly offsets: Uint32Array;
}
export const absentId = 0xffffffff;
export function packedStrings(values: readonly string[]): PackedStrings {
	const offsets = new Uint32Array(values.length + 1);
	let size = 0;
	for (let i = 0; i < values.length; i++) {
		offsets[i] = size;
		size += Buffer.byteLength(values[i]!);
	}
	const bytes = Buffer.allocUnsafe(size);
	let position = 0;
	for (const value of values) position += bytes.write(value, position, "utf8");
	offsets[values.length] = position;
	return { bytes, offsets };
}
export function stringBytes(strings: PackedStrings, id: number): Buffer {
	return strings.bytes.subarray(strings.offsets[id]!, strings.offsets[id + 1]!);
}
export function compareBytes(a: Uint8Array, b: Uint8Array) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return a.length - b.length;
}

/** MSD byte radix sort: IDs, histogram and scratch live outside V8's heap. */
export function sortBytes(strings: PackedStrings): Uint32Array {
	const order = Uint32Array.from({ length: strings.offsets.length - 1 }, (_, i) => i);
	const scratch = new Uint32Array(order.length);
	const stack = [[0, order.length, 0]];
	const counts = new Uint32Array(257),
		starts = new Uint32Array(257);
	while (stack.length) {
		let [begin, end, depth] = stack.pop()!;
		if (end! - begin! < 2) continue;
		for (;;) {
			counts.fill(0);
			for (let row = begin!; row < end!; row++) {
				const id = order[row]!,
					position = strings.offsets[id]! + depth!;
				counts[position < strings.offsets[id + 1]! ? strings.bytes[position]! + 1 : 0]!++;
			}
			let populated = 0,
				only = 0;
			for (let key = 0; key < 257; key++)
				if (counts[key]) {
					populated++;
					only = key;
				}
			if (populated === 1 && only !== 0) {
				depth!++;
				continue;
			}
			if (populated === 1) break;
			let next = begin!;
			for (let key = 0; key < 257; key++) {
				starts[key] = next;
				next += counts[key]!;
			}
			const cursors = starts.slice();
			for (let row = begin!; row < end!; row++) {
				const id = order[row]!,
					position = strings.offsets[id]! + depth!;
				const key = position < strings.offsets[id + 1]! ? strings.bytes[position]! + 1 : 0;
				scratch[cursors[key]!] = id;
				cursors[key]!++;
			}
			order.set(scratch.subarray(begin, end), begin);
			for (let key = 1; key < 257; key++)
				if (counts[key]! > 1)
					stack.push([starts[key]!, starts[key]! + counts[key]!, depth! + 1]);
			break;
		}
	}
	return order;
}
function putVarint(bytes: Buffer, position: number, value: number) {
	while (value >= 128) {
		bytes[position++] = (value & 127) | 128;
		value >>>= 7;
	}
	bytes[position++] = value;
	return position;
}
function getVarint(bytes: Buffer, cursor: { position: number }) {
	let value = 0,
		shift = 0;
	for (;;) {
		if (cursor.position >= bytes.length || shift > 28)
			throw new Error("Invalid front-code varint");
		const byte = bytes[cursor.position++]!;
		value += (byte & 127) * 2 ** shift;
		if (!(byte & 128)) return value;
		shift += 7;
	}
}
export function encodeFrontBlock(values: readonly Buffer[]) {
	const bytes = Buffer.allocUnsafe(values.reduce((n, value) => n + value.length + 10, 5));
	let position = putVarint(bytes, 0, values.length),
		previous: Buffer = Buffer.alloc(0);
	for (const value of values) {
		let prefix = 0;
		while (
			prefix < previous.length &&
			prefix < value.length &&
			previous[prefix] === value[prefix]
		)
			prefix++;
		position = putVarint(bytes, position, prefix);
		position = putVarint(bytes, position, value.length - prefix);
		position += value.copy(bytes, position, prefix);
		previous = value;
	}
	return bytes.subarray(0, position);
}
export function decodeFrontBlock(bytes: Buffer): Buffer[] {
	const cursor = { position: 0 },
		count = getVarint(bytes, cursor),
		values: Buffer[] = [];
	if (count > 64) throw new Error("Front block exceeds 64 strings");
	let previous = Buffer.alloc(0);
	for (let i = 0; i < count; i++) {
		const prefix = getVarint(bytes, cursor),
			suffix = getVarint(bytes, cursor);
		if (prefix > previous.length || cursor.position + suffix > bytes.length)
			throw new Error("Invalid front-code boundary");
		const value = Buffer.allocUnsafe(prefix + suffix);
		previous.copy(value, 0, 0, prefix);
		bytes.copy(value, prefix, cursor.position, cursor.position + suffix);
		cursor.position += suffix;
		values.push(value);
		previous = value;
	}
	if (cursor.position !== bytes.length) throw new Error("Trailing front-code bytes");
	return values;
}
export function compress(bytes: Uint8Array, level = 3) {
	const compressed = zstdCompressSync(bytes, {
		params: { [constants.ZSTD_c_compressionLevel]: level }
	});
	return compressed.length < bytes.length
		? { data: compressed, compressed: true }
		: { data: Buffer.from(bytes), compressed: false };
}
interface Frame {
	data: Buffer;
	compressed: boolean;
	first: number;
	count: number;
}
export interface FrontDictionary {
	readonly count: number;
	readonly blockSize: number;
	readonly fences: PackedStrings;
	readonly offsets: Uint32Array;
	readonly frameByBlock: Uint32Array;
	readonly frames: readonly Frame[];
	readonly storedBytes: number;
	readonly rawBytes: number;
	readonly indexBytes: number;
}
export function buildFront(
	strings: PackedStrings,
	order: Uint32Array,
	blockSize: number,
	level = 3
): FrontDictionary {
	if (![16, 32, 64].includes(blockSize)) throw new Error("Invalid block size");
	const count = order.length,
		blocks = Math.ceil(count / blockSize);
	const offsets = new Uint32Array(blocks),
		frameByBlock = new Uint32Array(blocks);
	const keys: Buffer[] = [],
		frames: Frame[] = [];
	let group: Buffer[] = [],
		bytes = 0,
		first = 0,
		rawPayload = 0;
	const flush = () => {
		if (!group.length) return;
		const raw = Buffer.concat(group, bytes);
		rawPayload += raw.length;
		frames.push({ ...compress(raw, level), first, count: group.length });
		group = [];
		bytes = 0;
	};
	for (let block = 0; block < blocks; block++) {
		const values: Buffer[] = [];
		for (let row = block * blockSize; row < Math.min(count, (block + 1) * blockSize); row++)
			values.push(stringBytes(strings, order[row]!));
		keys.push(values[0]!);
		const encoded = encodeFrontBlock(values);
		if (bytes + encoded.length > 256 * 1024) flush();
		if (!group.length) first = block;
		offsets[block] = bytes;
		frameByBlock[block] = frames.length;
		group.push(encoded);
		bytes += encoded.length;
	}
	flush();
	const fenceOffsets = new Uint32Array(keys.length + 1);
	let size = 0;
	for (let i = 0; i < keys.length; i++) {
		fenceOffsets[i] = size;
		size += keys[i]!.length;
	}
	fenceOffsets[keys.length] = size;
	const fences = { bytes: Buffer.concat(keys, size), offsets: fenceOffsets };
	const indexBytes =
		compress(fences.bytes, level).data.length +
		compress(new Uint8Array(fenceOffsets.buffer), 1).data.length +
		compress(new Uint8Array(offsets.buffer), 1).data.length +
		compress(new Uint8Array(frameByBlock.buffer), 1).data.length;
	// Snapshot directory entries for frames and four index columns, including alignment upper bound.
	const directoryBytes = 48 + (frames.length + 4) * 99;
	return {
		count,
		blockSize,
		fences,
		offsets,
		frameByBlock,
		frames,
		indexBytes,
		storedBytes: frames.reduce(
			(n, frame) => n + frame.data.length,
			indexBytes + directoryBytes
		),
		rawBytes:
			rawPayload +
			fences.bytes.length +
			fenceOffsets.byteLength +
			offsets.byteLength +
			frameByBlock.byteLength +
			directoryBytes
	};
}
function fenceBlock(dictionary: FrontDictionary, key: Buffer) {
	let low = 0,
		high = dictionary.fences.offsets.length - 1;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (compareBytes(stringBytes(dictionary.fences, middle), key) <= 0) low = middle + 1;
		else high = middle;
	}
	return low - 1;
}
function frontBlockReader(dictionary: FrontDictionary) {
	let frameId = -1,
		raw: Buffer = Buffer.alloc(0);
	const stats = { bytes: 0, frames: 0, blocks: 0 };
	return {
		stats,
		block(block: number): Buffer {
			const group = dictionary.frameByBlock[block]!;
			if (group !== frameId) {
				const frame = dictionary.frames[group]!;
				raw = frame.compressed ? zstdDecompressSync(frame.data) : frame.data;
				frameId = group;
				stats.bytes += frame.data.length;
				stats.frames++;
			}
			const frame = dictionary.frames[group]!;
			const end =
				block + 1 < frame.first + frame.count ? dictionary.offsets[block + 1]! : raw.length;
			stats.blocks++;
			return raw.subarray(dictionary.offsets[block], end);
		}
	};
}
export function frontReader(dictionary: FrontDictionary) {
	const reader = frontBlockReader(dictionary);
	let blockId = -1,
		values: Buffer[] = [];
	return {
		stats: reader.stats,
		block(block: number): readonly Buffer[] {
			if (block !== blockId) {
				values = decodeFrontBlock(reader.block(block));
				blockId = block;
			}
			return values;
		}
	};
}
/** Sorted requests visit each relevant block/frame at most once, in order. */
export function lookupFront(
	dictionary: FrontDictionary,
	requests: PackedStrings,
	order: Uint32Array
) {
	const result = new Uint32Array(order.length).fill(absentId),
		reader = frontBlockReader(dictionary);
	let blockId = -1,
		fence = -1,
		row = 0,
		count = 0,
		length = 0,
		raw: Buffer = Buffer.alloc(0);
	const cursor = { position: 0 },
		scratch = Buffer.allocUnsafe(1024 * 1024);
	const next = () => {
		if (row >= count) return false;
		const prefix = getVarint(raw, cursor),
			suffix = getVarint(raw, cursor);
		if (
			prefix > length ||
			prefix + suffix > scratch.length ||
			cursor.position + suffix > raw.length
		)
			throw new Error("Invalid front lookup boundary");
		raw.copy(scratch, prefix, cursor.position, cursor.position + suffix);
		cursor.position += suffix;
		length = prefix + suffix;
		row++;
		return true;
	};
	for (let i = 0; i < order.length; i++) {
		const key = stringBytes(requests, order[i]!);
		// Both streams are sorted: one pass over the sparse index, no repeated binary searches.
		while (
			fence + 1 < dictionary.fences.offsets.length - 1 &&
			compareBytes(stringBytes(dictionary.fences, fence + 1), key) <= 0
		)
			fence++;
		const block = fence;
		if (block < 0) continue;
		if (block !== blockId) {
			raw = reader.block(block);
			blockId = block;
			cursor.position = 0;
			count = getVarint(raw, cursor);
			row = 0;
			length = 0;
			if (count > 64) throw new Error("Invalid front lookup count");
			next();
		}
		while (compareBytes(scratch.subarray(0, length), key) < 0 && next()) {
			/* advance */
		}
		if (row && compareBytes(scratch.subarray(0, length), key) === 0)
			result[i] = block * dictionary.blockSize + row - 1;
	}
	return { result, stats: reader.stats };
}
export function frontRange(dictionary: FrontDictionary, prefix: Buffer) {
	const reader = frontReader(dictionary);
	const lower = (key: Buffer) => {
		const block = Math.max(0, fenceBlock(dictionary, key)),
			values = reader.block(block);
		let row = 0;
		while (row < values.length && compareBytes(values[row]!, key) < 0) row++;
		return Math.min(dictionary.count, block * dictionary.blockSize + row);
	};
	const upper = Buffer.from(prefix);
	let position = upper.length - 1;
	while (position >= 0 && upper[position] === 255) position--;
	const end =
		position < 0
			? dictionary.count
			: (upper[position]!++, lower(upper.subarray(0, position + 1)));
	return { start: lower(prefix), end, stats: reader.stats };
}

function mix(value: number) {
	value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
	value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
	return (value ^ (value >>> 16)) >>> 0;
}
export function hashBytes(value: Uint8Array): readonly [number, number] {
	let a = 0x811c9dc5,
		b = 0x9e3779b9;
	for (const byte of value) {
		a = Math.imul(a ^ byte, 0x01000193);
		b = Math.imul(b ^ byte, 0x85ebca6b);
	}
	return [mix(a), mix(b)];
}
function popcount(value: number) {
	value -= (value >>> 1) & 0x55555555;
	value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
	return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
interface HashLevel {
	bits: Uint32Array;
	ranks: Uint32Array;
	slots: number;
	base: number;
}
export interface PerfectDictionary {
	readonly levels: readonly HashLevel[];
	readonly ids: Uint32Array;
	readonly fingerprints: Uint8Array;
	readonly hashA: Uint32Array;
	readonly hashB: Uint32Array;
	readonly mphBytes: number;
	readonly storedBytes: number;
}
function positionFor(a: number, b: number, level: number, slots: number) {
	return mix(a ^ Math.imul(b, level * 2 + 1) ^ Math.imul(level + 1, 0x9e3779b9)) % slots;
}
function rank(level: HashLevel, position: number) {
	const word = position >>> 5,
		begin = (word >>> 4) * 16;
	let result = level.ranks[word >>> 4]!;
	for (let i = begin; i < word; i++) result += popcount(level.bits[i]!);
	return result + popcount(level.bits[word]! & ((2 ** (position & 31) - 1) >>> 0));
}
/** BBHash, gamma=1, rank samples every 512 bits, exact insertion-ID mapping. */
export function buildPerfect(strings: PackedStrings): PerfectDictionary {
	const count = strings.offsets.length - 1,
		hashA = new Uint32Array(count),
		hashB = new Uint32Array(count);
	for (let i = 0; i < count; i++) {
		const hash = hashBytes(stringBytes(strings, i));
		hashA[i] = hash[0];
		hashB[i] = hash[1];
	}
	let remaining = Uint32Array.from({ length: count }, (_, i) => i),
		base = 0;
	const levels: HashLevel[] = [],
		ids = new Uint32Array(count),
		fingerprints = new Uint8Array(count);
	while (remaining.length) {
		if (levels.length >= 64)
			throw new Error("BBHash could not separate keys; rebuild with a new byte-hash seed");
		const slots = Math.max(32, remaining.length),
			bits = new Uint32Array(Math.ceil(slots / 32)),
			collisions = new Uint32Array(bits.length),
			index = levels.length;
		for (const id of remaining) {
			const position = positionFor(hashA[id]!, hashB[id]!, index, slots),
				word = position >>> 5,
				bit = 1 << (position & 31);
			if (bits[word]! & bit) collisions[word]! |= bit;
			bits[word]! |= bit;
		}
		for (let word = 0; word < bits.length; word++) bits[word]! &= ~collisions[word]!;
		const ranks = new Uint32Array(Math.ceil(bits.length / 16));
		let assigned = 0;
		for (let word = 0; word < bits.length; word++) {
			if (!(word & 15)) ranks[word >>> 4] = assigned;
			assigned += popcount(bits[word]!);
		}
		const level = { bits, ranks, slots, base };
		levels.push(level);
		const next = new Uint32Array(remaining.length - assigned);
		let cursor = 0;
		for (const id of remaining) {
			const position = positionFor(hashA[id]!, hashB[id]!, index, slots);
			if (bits[position >>> 5]! & (1 << (position & 31))) {
				const slot = base + rank(level, position);
				ids[slot] = id;
				fingerprints[slot] = mix(hashB[id]! ^ hashA[id]!) & 255;
			} else next[cursor++] = id;
		}
		base += assigned;
		remaining = next;
	}
	const mphBytes = levels.reduce(
		(n, level) => n + level.bits.byteLength + level.ranks.byteLength + 16,
		0
	);
	// Mapping is essential: an MPHF's slot order is not insertion order.
	const storedBytes =
		mphBytes +
		compress(new Uint8Array(ids.buffer), 1).data.length +
		compress(fingerprints, 1).data.length +
		48 +
		(levels.length * 2 + 2) * 99;
	return { levels, ids, fingerprints, hashA, hashB, mphBytes, storedBytes };
}
export function perfectCandidate(dictionary: PerfectDictionary, a: number, b: number) {
	for (let i = 0; i < dictionary.levels.length; i++) {
		const level = dictionary.levels[i]!,
			position = positionFor(a, b, i, level.slots);
		if (level.bits[position >>> 5]! & (1 << (position & 31))) {
			const slot = level.base + rank(level, position);
			return dictionary.fingerprints[slot] === (mix(a ^ b) & 255)
				? dictionary.ids[slot]!
				: absentId;
		}
	}
	return absentId;
}

export interface HashDictionary {
	readonly fences: Uint32Array;
	readonly pages: readonly {
		hashes: ReturnType<typeof compress>;
		ids: ReturnType<typeof compress>;
	}[];
	readonly bloom: Uint8Array;
	readonly storedBytes: number;
}
export const baselineHash = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest().readUInt32LE(0);
function bloomStep(hash: number) {
	return (Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0) | 1;
}
export function hashMayContain(dictionary: HashDictionary, hash: number) {
	for (let i = 0; i < 7; i++) {
		const bit = ((hash + Math.imul(bloomStep(hash), i)) >>> 0) % (dictionary.bloom.length * 8);
		if (!(dictionary.bloom[bit >>> 3]! & (1 << (bit & 7)))) return false;
	}
	return true;
}
/** Current 8,192-row delta hash pages, insertion IDs and 20-bit seven-probe Bloom. */
export function buildHash(strings: PackedStrings): HashDictionary {
	const count = strings.offsets.length - 1,
		hashes = new Uint32Array(count),
		bloom = new Uint8Array(Math.max(8, Math.ceil((count * 20) / 8)));
	for (let i = 0; i < count; i++) {
		const hash = (hashes[i] = baselineHash(stringBytes(strings, i)));
		for (let probe = 0; probe < 7; probe++) {
			const bit = ((hash + Math.imul(bloomStep(hash), probe)) >>> 0) % (bloom.length * 8);
			bloom[bit >>> 3]! |= 1 << (bit & 7);
		}
	}
	const order = Uint32Array.from({ length: count }, (_, i) => i).sort(
		(a, b) => hashes[a]! - hashes[b]!
	);
	const fences = new Uint32Array(Math.ceil(count / 8192)),
		pages: HashDictionary["pages"][number][] = [];
	for (let start = 0; start < count; start += 8192) {
		const ids = order.slice(start, Math.min(count, start + 8192)),
			deltas = new Uint32Array(ids.length);
		fences[pages.length] = hashes[ids[0]!]!;
		for (let i = 0; i < ids.length; i++)
			deltas[i] = i ? (hashes[ids[i]!]! - hashes[ids[i - 1]!]!) >>> 0 : hashes[ids[i]!]!;
		pages.push({
			hashes: compress(new Uint8Array(deltas.buffer), 1),
			ids: compress(new Uint8Array(ids.buffer), 1)
		});
	}
	return {
		pages,
		fences,
		bloom,
		storedBytes: pages.reduce(
			(n, page) => n + page.hashes.data.length + page.ids.data.length,
			compress(bloom, 1).data.length +
				compress(new Uint8Array(fences.buffer), 1).data.length +
				48 +
				(pages.length * 2 + 2) * 99
		)
	};
}
function lowerBound(values: Uint32Array, value: number) {
	let low = 0,
		high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! < value) low = middle + 1;
		else high = middle;
	}
	return low;
}
export function lookupHash(
	dictionary: HashDictionary,
	strings: PackedStrings,
	requests: PackedStrings,
	hashes: Uint32Array
) {
	const order = Uint32Array.from({ length: hashes.length }, (_, i) => i).sort(
		(a, b) => hashes[a]! - hashes[b]!
	);
	const result = new Uint32Array(order.length).fill(absentId),
		pages = new Map<number, { hashes: Uint32Array; ids: Uint32Array }>();
	const stats = {
		bytes: compress(dictionary.bloom, 1).data.length,
		pages: 0,
		confirmations: 0,
		absentConfirmations: 0
	};
	for (const row of order) {
		const hash = hashes[row]!;
		if (!hashMayContain(dictionary, hash)) continue;
		for (
			let page = Math.max(0, lowerBound(dictionary.fences, hash) - 1);
			page < dictionary.pages.length && dictionary.fences[page]! <= hash;
			page++
		) {
			let decoded = pages.get(page);
			if (!decoded) {
				const payload = dictionary.pages[page]!;
				const h = payload.hashes.compressed
					? zstdDecompressSync(payload.hashes.data)
					: payload.hashes.data;
				const p = payload.ids.compressed
					? zstdDecompressSync(payload.ids.data)
					: payload.ids.data;
				const hashValues = new Uint32Array(
					h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)
				);
				for (let i = 1; i < hashValues.length; i++)
					hashValues[i] = (hashValues[i]! + hashValues[i - 1]!) >>> 0;
				decoded = {
					hashes: hashValues,
					ids: new Uint32Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength))
				};
				pages.set(page, decoded);
				stats.pages++;
				stats.bytes += payload.hashes.data.length + payload.ids.data.length;
			}
			for (
				let i = lowerBound(decoded.hashes, hash);
				i < decoded.hashes.length && decoded.hashes[i] === hash;
				i++
			) {
				stats.confirmations++;
				const id = decoded.ids[i]!;
				if (compareBytes(stringBytes(strings, id), stringBytes(requests, row)) === 0)
					result[row] = id;
				else stats.absentConfirmations++;
			}
		}
	}
	return { result, stats };
}
