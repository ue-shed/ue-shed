import { isUtf8 } from "node:buffer";
import { snapshotCheck } from "./snapshot-format.js";
export interface PackedStrings {
	readonly bytes: Buffer;
	readonly offsets: Uint32Array | Float64Array;
}
export const absentId = 0xffffffff;
export function packedStrings(values: readonly string[]): PackedStrings {
	const offsets = new Float64Array(values.length + 1);
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
	return Buffer.compare(a, b);
}
/** Native range comparison avoids allocating two Buffer views for every sorted probe. */
export function comparePacked(a: PackedStrings, ai: number, b: PackedStrings, bi: number) {
	return a.bytes.compare(
		b.bytes,
		b.offsets[bi],
		b.offsets[bi + 1],
		a.offsets[ai],
		a.offsets[ai + 1]
	);
}
export function comparePackedKey(a: PackedStrings, id: number, key: Uint8Array) {
	return a.bytes.compare(key, 0, key.length, a.offsets[id], a.offsets[id + 1]);
}

/** MSD byte radix sort: IDs, histogram and scratch live outside V8's heap. */
export function sortBytes(strings: PackedStrings, selected?: Uint32Array): Uint32Array {
	const order = selected ?? Uint32Array.from({ length: strings.offsets.length - 1 }, (_, i) => i);
	const scratch = new Uint32Array(order.length);
	const view = new DataView(
		strings.bytes.buffer,
		strings.bytes.byteOffset,
		strings.bytes.byteLength
	);
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
				// Long synthetic/source prefixes otherwise rescan the full partition per byte.
				const first = order[begin!]!;
				while (strings.offsets[first]! + depth! + 4 <= strings.offsets[first + 1]!) {
					const word = view.getUint32(strings.offsets[first]! + depth!, true);
					let same = true;
					for (let row = begin! + 1; row < end!; row++) {
						const id = order[row]!,
							position = strings.offsets[id]! + depth!;
						if (
							position + 4 > strings.offsets[id + 1]! ||
							view.getUint32(position, true) !== word
						) {
							same = false;
							break;
						}
					}
					if (!same) break;
					depth! += 4;
				}
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

/** Typed byte arena and offsets. Only a bounded input block holds JavaScript strings. */
export class StringArena {
	private bytes: Buffer;
	private offsets: Uint32Array | Float64Array;
	private size = 0;
	private count = 0;
	constructor(byteCapacity = 256 * 1024, stringCapacity = 4095) {
		snapshotCheck(
			Number.isSafeInteger(byteCapacity) &&
				byteCapacity >= 0 &&
				byteCapacity <= 16 * 1024 ** 3 &&
				Number.isSafeInteger(stringCapacity) &&
				stringCapacity >= 0 &&
				stringCapacity < absentId,
			"strings",
			"Invalid arena capacity"
		);
		this.bytes = Buffer.allocUnsafe(Math.max(1, byteCapacity));
		this.offsets =
			byteCapacity >= 0xffffffff
				? new Float64Array(stringCapacity + 1)
				: new Uint32Array(stringCapacity + 1);
	}
	add(value: Uint8Array) {
		snapshotCheck(
			value.length <= 1024 ** 2 && this.size + value.length <= 16 * 1024 ** 3,
			"strings",
			"String arena exceeds the 16 GiB byte cap"
		);
		if (this.size + value.length > this.bytes.length) {
			const next = Buffer.allocUnsafe(
				Math.min(16 * 1024 ** 3, Math.max(this.size + value.length, this.bytes.length * 2))
			);
			next.set(this.bytes.subarray(0, this.size));
			this.bytes = next;
		}
		if (this.count + 1 >= this.offsets.length) {
			const next =
				this.offsets instanceof Uint32Array
					? new Uint32Array(this.offsets.length * 2)
					: new Float64Array(this.offsets.length * 2);
			next.set(this.offsets);
			this.offsets = next;
		}
		if (this.size + value.length >= 0xffffffff && this.offsets instanceof Uint32Array)
			this.offsets = Float64Array.from(this.offsets);
		this.offsets[this.count++] = this.size;
		this.bytes.set(value, this.size);
		this.size += value.length;
	}
	finish(): PackedStrings {
		this.offsets[this.count] = this.size;
		return {
			bytes: this.bytes.subarray(0, this.size),
			offsets: this.offsets.subarray(0, this.count + 1)
		};
	}
}

function put(bytes: Buffer, position: number, value: number) {
	while (value >= 128) {
		bytes[position++] = (value & 127) | 128;
		value >>>= 7;
	}
	bytes[position++] = value;
	return position;
}
function get(bytes: Buffer, cursor: { position: number }) {
	let value = 0,
		shift = 0;
	for (;;) {
		snapshotCheck(cursor.position < bytes.length && shift <= 28, "front", "Invalid varint");
		const byte = bytes[cursor.position++]!;
		value += (byte & 127) * 2 ** shift;
		if (!(byte & 128)) {
			snapshotCheck(value <= 0xffffffff, "front", "Varint overflow");
			return value;
		}
		shift += 7;
	}
}
function nibble(byte: number) {
	if (byte >= 48 && byte <= 57) return byte - 48;
	if (byte >= 65 && byte <= 70) return byte - 55;
	if (byte >= 97 && byte <= 102) return byte - 87;
	return -1;
}

/** Tag 0: non-GUID front suffix; tags 1/2: 16 GUID bytes, optional case bitmap. */
export function encodeA64(values: readonly Buffer[]) {
	snapshotCheck(values.length > 0 && values.length <= 64, "front", "Invalid block count");
	const bytes = Buffer.allocUnsafe(values.reduce((n, value) => n + value.length + 12, 5));
	let position = put(bytes, 0, values.length),
		previous: Buffer = Buffer.alloc(0);
	for (const value of values) {
		let guid = value.length === 32,
			mask = 0;
		for (let i = 0; guid && i < 32; i++) {
			guid = nibble(value[i]!) >= 0;
			if (value[i]! >= 65 && value[i]! <= 70) mask = (mask | (1 << i)) >>> 0;
		}
		bytes[position++] = guid ? (mask ? 2 : 1) : 0;
		if (guid) {
			for (let i = 0; i < 32; i += 2)
				bytes[position++] = (nibble(value[i]!) << 4) | nibble(value[i + 1]!);
			if (mask) {
				bytes.writeUInt32LE(mask, position);
				position += 4;
			}
		} else {
			let prefix = 0;
			while (
				prefix < previous.length &&
				prefix < value.length &&
				previous[prefix] === value[prefix]
			)
				prefix++;
			position = put(bytes, position, prefix);
			position = put(bytes, position, value.length - prefix);
			position += value.copy(bytes, position, prefix);
		}
		previous = value;
	}
	return bytes.subarray(0, position);
}

/** One scratch buffer per block; callers can scan without allocating a string per key. */
export function a64Cursor(bytes: Buffer) {
	const cursor = { position: 0 },
		count = get(bytes, cursor);
	let scratch: Buffer = Buffer.allocUnsafe(Math.max(32, Math.min(bytes.length, 4096)));
	snapshotCheck(count > 0 && count <= 64, "front", "Invalid block count");
	let row = 0,
		length = 0;
	return {
		count,
		next(): Buffer | undefined {
			if (row === count) return undefined;
			snapshotCheck(cursor.position < bytes.length, "front", "Missing value tag");
			const tag = bytes[cursor.position++]!;
			snapshotCheck(tag <= 2, "front", "Invalid value tag");
			if (tag) {
				const end = cursor.position + 16 + (tag === 2 ? 4 : 0);
				snapshotCheck(end <= bytes.length, "front", "Truncated GUID");
				const mask = tag === 2 ? bytes.readUInt32LE(cursor.position + 16) : 0;
				for (let i = 0; i < 32; i++) {
					const value = bytes[cursor.position + (i >>> 1)]!;
					const digit = i & 1 ? value & 15 : value >>> 4;
					snapshotCheck(
						!(mask & (1 << i)) || digit >= 10,
						"front",
						"Invalid GUID case mask"
					);
					scratch[i] = digit < 10 ? digit + 48 : digit + (mask & (1 << i) ? 55 : 87);
				}
				cursor.position = end;
				length = 32;
			} else {
				const prefix = get(bytes, cursor),
					suffix = get(bytes, cursor);
				snapshotCheck(
					prefix <= length &&
						prefix + suffix <= 1024 ** 2 &&
						cursor.position + suffix <= bytes.length,
					"front",
					"Invalid front-code bounds"
				);
				if (prefix + suffix > scratch.length) {
					const next = Buffer.allocUnsafe(Math.max(prefix + suffix, scratch.length * 2));
					scratch.copy(next, 0, 0, prefix);
					scratch = next;
				}
				bytes.copy(scratch, prefix, cursor.position, cursor.position + suffix);
				cursor.position += suffix;
				length = prefix + suffix;
			}
			row++;
			if (row === count)
				snapshotCheck(cursor.position === bytes.length, "front", "Trailing block bytes");
			const value = scratch.subarray(0, length);
			snapshotCheck(isUtf8(value), "front", "Invalid UTF-8");
			return value;
		}
	};
}
export function decodeA64(bytes: Buffer) {
	const cursor = a64Cursor(bytes),
		values: Buffer[] = [];
	for (let value = cursor.next(); value; value = cursor.next()) values.push(Buffer.from(value));
	return values;
}
