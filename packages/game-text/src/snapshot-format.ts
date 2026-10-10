import { Schema } from "effect";

/** Disposable v3 layout, still inside the game-text-v1 cache namespace. */
export const SNAPSHOT_VERSION = 3;
export const SNAPSHOT_HEADER_BYTES = 48;
export const SNAPSHOT_DIRECTORY_BYTES = 96;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 ** 3;
export const MAX_SNAPSHOT_SECTION_BYTES = 128 * 1024 ** 2;
export const MAX_SNAPSHOT_SECTIONS = 1048576;
export const MAX_SNAPSHOT_STRINGS = 64_000_000;
export const MAX_SNAPSHOT_STRING_BYTES = 1024 * 1024;
export const SNAPSHOT_STRING_BLOCK_BYTES = 256 * 1024;
const MAX_BLOCK_STRINGS = MAX_SNAPSHOT_SECTION_BYTES / 4 - 2;
const magic = new TextEncoder().encode("UESHT003");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isString = Schema.is(Schema.String);
const kinds = ["bytes", "u8", "u32", "stringIds", "strings"] as const;
export type SnapshotKind = (typeof kinds)[number];
export class SnapshotFormatError extends Schema.TaggedErrorClass<SnapshotFormatError>()(
	"SnapshotFormatError",
	{ section: Schema.String, message: Schema.String, recovery: Schema.String }
) {}
export function snapshotFailure(section: string, message: string): SnapshotFormatError {
	return new SnapshotFormatError({
		section,
		message,
		recovery: "Rebuild this disposable Game Text snapshot from its inputs."
	});
}
export function snapshotCheck(
	condition: boolean,
	section: string,
	message: string
): asserts condition {
	if (!condition) throw snapshotFailure(section, message);
}
function bounded(value: number, maximum: number, section: string) {
	snapshotCheck(
		Number.isSafeInteger(value) && value >= 0 && value <= maximum,
		section,
		"Length or count exceeds cap"
	);
}
export const snapshotAligned = (value: number) => Math.ceil(value / 4) * 4;
export interface SnapshotColumn {
	readonly name: string;
	readonly kind: SnapshotKind;
	readonly values: Uint8Array | Uint32Array;
	/** Local IDs in this string domain. */
	readonly domain?: string;
	readonly stringCount?: number;
}
export interface SnapshotEntry {
	readonly name: string;
	readonly kind: SnapshotKind;
	readonly codec: 0 | 1;
	readonly offset: number;
	readonly storedLength: number;
	readonly rawLength: number;
	readonly count: number;
	readonly checksum: number;
	readonly domain: string;
	readonly stringCount: number;
}
export interface SnapshotDirectory {
	readonly fileLength: number;
	readonly version: number;
	readonly entries: ReadonlyMap<string, SnapshotEntry>;
}
export interface SnapshotCodecOptions {
	readonly checksum?: (bytes: Uint8Array) => number;
	readonly utf8Valid?: (bytes: Uint8Array) => boolean;
	/** Only for replaying saved v2 benchmark sections, never store activation. */
	readonly allowLegacy?: boolean;
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});
export function snapshotChecksum(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}
export function snapshotPayload(column: SnapshotColumn): Uint8Array {
	const width = column.kind === "u32" || column.kind === "stringIds" ? 4 : 1;
	snapshotCheck(
		width === 4 ? column.values instanceof Uint32Array : column.values instanceof Uint8Array,
		column.name,
		"Column type does not match kind"
	);
	const bytes = new Uint8Array(
		column.values.buffer,
		column.values.byteOffset,
		column.values.byteLength
	);
	bounded(bytes.length, MAX_SNAPSHOT_SECTION_BYTES, column.name);
	if (column.kind === "stringIds") {
		bounded(column.stringCount ?? -1, MAX_SNAPSHOT_STRINGS, column.name);
		for (const id of column.values)
			snapshotCheck(id < column.stringCount!, column.name, "String ID out of bounds");
	}
	if (column.kind === "strings") decodeStringBlock(bytes, column.name);
	return bytes;
}
/** Byte-sized blocks include local offsets; bulk reads may retain a contiguous domain. */
export function encodeStringBlock(values: readonly string[]): Uint8Array {
	snapshotCheck(
		values.length > 0 && values.length <= MAX_BLOCK_STRINGS,
		"strings",
		"Invalid block count"
	);
	const start = 4 + (values.length + 1) * 4;
	let upper = start;
	for (const value of values) {
		snapshotCheck(isString(value), "strings", "Expected a string");
		bounded(value.length, MAX_SNAPSHOT_STRING_BYTES, "strings");
		upper += value.length * 3;
	}
	const bytes = new Uint8Array(Math.min(upper, MAX_SNAPSHOT_SECTION_BYTES));
	const view = new DataView(bytes.buffer);
	view.setUint32(0, values.length, true);
	let position = 0;
	for (let i = 0; i < values.length; i++) {
		view.setUint32(4 + i * 4, position, true);
		const value = values[i]!;
		const result = encoder.encodeInto(value, bytes.subarray(start + position));
		snapshotCheck(result.read === value.length, "strings", "String block exceeds section cap");
		bounded(result.written, MAX_SNAPSHOT_STRING_BYTES, "strings");
		position += result.written;
	}
	view.setUint32(4 + values.length * 4, position, true);
	return bytes.slice(0, start + position);
}
export function decodeStringBlock(
	bytes: Uint8Array,
	section = "strings",
	options: SnapshotCodecOptions = {}
) {
	snapshotCheck(bytes.length >= 8, section, "Truncated string block");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(0, true);
	snapshotCheck(count > 0 && count <= MAX_BLOCK_STRINGS, section, "Invalid string count");
	const start = 4 + (count + 1) * 4;
	snapshotCheck(start <= bytes.length, section, "Truncated offsets");
	snapshotCheck(
		view.getUint32(4, true) === 0 &&
			view.getUint32(4 + count * 4, true) === bytes.length - start,
		section,
		"Invalid string endpoints"
	);
	const payload = bytes.subarray(start);
	try {
		if (options.utf8Valid)
			snapshotCheck(options.utf8Valid(payload), section, "Invalid UTF-8 or split code point");
		else decoder.decode(payload);
	} catch {
		throw snapshotFailure(section, "Invalid UTF-8 or split code point");
	}
	for (let i = 0; i < count; i++) {
		const a = view.getUint32(4 + i * 4, true),
			b = view.getUint32(8 + i * 4, true);
		snapshotCheck(
			a <= b && b <= payload.length && b - a <= MAX_SNAPSHOT_STRING_BYTES,
			section,
			"String offset or length out of bounds"
		);
		snapshotCheck(
			b === payload.length || (payload[b]! & 0xc0) !== 0x80,
			section,
			"Invalid UTF-8 or split code point"
		);
	}
	return {
		count,
		string(id: number) {
			bounded(id, count - 1, section);
			return decoder.decode(
				bytes.subarray(
					start + view.getUint32(4 + id * 4, true),
					start + view.getUint32(8 + id * 4, true)
				)
			);
		}
	};
}
export function snapshotStringTableBuilder(
	domain = "hot",
	targetBytes = SNAPSHOT_STRING_BLOCK_BYTES
) {
	snapshotCheck(
		Number.isSafeInteger(targetBytes) &&
			targetBytes >= 8 &&
			targetBytes <= MAX_SNAPSHOT_SECTION_BYTES,
		domain,
		"Invalid block byte target"
	);
	const ids = new Map<string, number>();
	const values: string[] = [];
	return {
		intern(value: string) {
			snapshotCheck(isString(value), domain, "Expected a string");
			const existing = ids.get(value);
			if (existing !== undefined) return existing;
			bounded(values.length + 1, MAX_SNAPSHOT_STRINGS, domain);
			bounded(value.length, MAX_SNAPSHOT_STRING_BYTES, domain);
			bounded(encoder.encode(value).length, MAX_SNAPSHOT_STRING_BYTES, domain);
			const id = values.length;
			ids.set(value, id);
			values.push(value);
			return id;
		},
		get count() {
			return values.length;
		},
		*finish(): Generator<SnapshotColumn> {
			const starts: number[] = [];
			let start = 0;
			while (start < values.length) {
				let end = start,
					bytes = 8;
				while (end < values.length) {
					const next = encoder.encode(values[end]!).length + 4;
					if (end > start && bytes + next > targetBytes) break;
					bytes += next;
					end++;
				}
				starts.push(start);
				yield {
					name: `${domain}.b${starts.length - 1}`,
					kind: "strings",
					domain,
					stringCount: values.length,
					values: encodeStringBlock(values.slice(start, end))
				};
				start = end;
			}
			if (starts.length)
				yield { name: `${domain}.starts`, kind: "u32", values: Uint32Array.from(starts) };
		}
	};
}
export function encodeSnapshotDirectory(
	entries: readonly SnapshotEntry[],
	fileLength: number,
	options: SnapshotCodecOptions = {}
) {
	const checksum = options.checksum ?? snapshotChecksum;
	bounded(fileLength, MAX_SNAPSHOT_BYTES, "header");
	snapshotCheck(
		entries.length > 0 && entries.length <= MAX_SNAPSHOT_SECTIONS,
		"directory",
		"Section count out of bounds"
	);
	const bytes = new Uint8Array(SNAPSHOT_HEADER_BYTES + entries.length * SNAPSHOT_DIRECTORY_BYTES);
	bytes.set(magic);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, SNAPSHOT_VERSION, true);
	view.setUint32(12, entries.length, true);
	view.setBigUint64(16, BigInt(fileLength), true);
	view.setUint32(24, bytes.length, true);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!,
			p = SNAPSHOT_HEADER_BYTES + i * SNAPSHOT_DIRECTORY_BYTES;
		bounded(entry.offset, MAX_SNAPSHOT_BYTES, entry.name);
		bounded(entry.rawLength, MAX_SNAPSHOT_SECTION_BYTES, entry.name);
		bounded(entry.storedLength, MAX_SNAPSHOT_SECTION_BYTES, entry.name);
		bounded(entry.count, MAX_SNAPSHOT_SECTION_BYTES, entry.name);
		bounded(entry.stringCount, MAX_SNAPSHOT_STRINGS, entry.name);
		snapshotCheck(
			/^[a-z][a-z0-9_.-]{0,30}$/u.test(entry.name),
			"directory",
			"Invalid section name"
		);
		snapshotCheck(
			entry.domain === "" || /^[a-z][a-z0-9_.-]{0,22}$/u.test(entry.domain),
			entry.name,
			"Invalid domain name"
		);
		bytes.set(encoder.encode(entry.name), p);
		view.setUint32(p + 32, kinds.indexOf(entry.kind), true);
		view.setUint32(p + 36, entry.codec, true);
		view.setBigUint64(p + 40, BigInt(entry.offset), true);
		view.setUint32(p + 48, entry.storedLength, true);
		view.setUint32(p + 52, entry.rawLength, true);
		view.setUint32(p + 56, entry.count, true);
		view.setUint32(p + 60, entry.checksum, true);
		bytes.set(encoder.encode(entry.domain), p + 64);
		view.setUint32(p + 88, entry.stringCount, true);
	}
	view.setUint32(28, checksum(bytes.subarray(48)), true);
	view.setUint32(32, checksum(bytes.subarray(0, 32)), true);
	decodeSnapshotDirectory(bytes, fileLength, options);
	return bytes;
}
/** Validate the fixed header before allocating even the directory. */
export function snapshotDirectoryLength(header: Uint8Array, options: SnapshotCodecOptions = {}) {
	const checksum = options.checksum ?? snapshotChecksum;
	snapshotCheck(header.length === 48, "header", "Truncated header");
	snapshotCheck(
		magic.every((value, index) => header[index] === value) ||
			(options.allowLegacy === true &&
				new TextDecoder().decode(header.subarray(0, 8)) === "UESHT002"),
		"header",
		"Invalid magic"
	);
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	snapshotCheck(
		view.getUint32(8, true) === SNAPSHOT_VERSION ||
			(options.allowLegacy === true && view.getUint32(8, true) === 2),
		"header",
		"Unsupported format version"
	);
	snapshotCheck(header[7] === 48 + view.getUint32(8, true), "header", "Magic/version mismatch");
	snapshotCheck(
		view.getUint32(32, true) === checksum(header.subarray(0, 32)),
		"header",
		"Header checksum mismatch"
	);
	snapshotCheck(
		header.subarray(36).every((value) => value === 0),
		"header",
		"Unsupported header flags"
	);
	const count = view.getUint32(12, true);
	snapshotCheck(
		count > 0 && count <= MAX_SNAPSHOT_SECTIONS,
		"directory",
		"Section count out of bounds"
	);
	const length = 48 + count * 96;
	snapshotCheck(
		view.getUint32(24, true) === length,
		"directory",
		"Directory length out of bounds"
	);
	bounded(Number(view.getBigUint64(16, true)), MAX_SNAPSHOT_BYTES, "header");
	return length;
}
export function decodeSnapshotDirectory(
	bytes: Uint8Array,
	fileLength: number,
	options: SnapshotCodecOptions = {}
): SnapshotDirectory {
	const checksum = options.checksum ?? snapshotChecksum;
	const length = snapshotDirectoryLength(bytes.subarray(0, 48), options);
	snapshotCheck(
		bytes.length === length && length <= fileLength,
		"directory",
		"Truncated directory"
	);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	snapshotCheck(
		Number(view.getBigUint64(16, true)) === fileLength,
		"header",
		"File length mismatch"
	);
	snapshotCheck(
		view.getUint32(28, true) === checksum(bytes.subarray(48)),
		"directory",
		"Directory checksum mismatch"
	);
	const entries = new Map<string, SnapshotEntry>();
	const domains = new Map<string, number>();
	let position = length;
	const readName = (p: number, width: number) => {
		const part = bytes.subarray(p, p + width),
			zero = part.indexOf(0);
		snapshotCheck(
			zero >= 0 && part.subarray(zero).every((value) => value === 0),
			"directory",
			"Invalid name padding"
		);
		return String.fromCharCode(...part.subarray(0, zero));
	};
	for (let p = 48; p < length; p += 96) {
		const name = readName(p, 32),
			domain = readName(p + 64, 24);
		snapshotCheck(
			/^[a-z][a-z0-9_.-]{0,30}$/u.test(name) && !entries.has(name),
			"directory",
			"Invalid or duplicate section name"
		);
		const kind = kinds[view.getUint32(p + 32, true)],
			codec = view.getUint32(p + 36, true);
		snapshotCheck(
			kind !== undefined && (codec === 0 || codec === 1),
			name,
			"Unknown kind or codec"
		);
		const offset = Number(view.getBigUint64(p + 40, true)),
			storedLength = view.getUint32(p + 48, true),
			rawLength = view.getUint32(p + 52, true),
			count = view.getUint32(p + 56, true),
			stringCount = view.getUint32(p + 88, true);
		bounded(rawLength, MAX_SNAPSHOT_SECTION_BYTES, name);
		bounded(storedLength, MAX_SNAPSHOT_SECTION_BYTES, name);
		snapshotCheck(
			codec === 0 ? storedLength === rawLength : storedLength < rawLength,
			name,
			"Invalid compression lengths"
		);
		snapshotCheck(
			offset === position && snapshotAligned(storedLength) <= fileLength - offset,
			name,
			"Section offset, alignment or bounds invalid"
		);
		snapshotCheck(
			rawLength === count * (kind === "u32" || kind === "stringIds" ? 4 : 1),
			name,
			"Column count does not match length"
		);
		snapshotCheck(view.getUint32(p + 92, true) === 0, name, "Unsupported directory flags");
		if (kind === "strings" || kind === "stringIds") {
			snapshotCheck(
				/^[a-z][a-z0-9_.-]{0,22}$/u.test(domain),
				name,
				"Missing or invalid string domain"
			);
			snapshotCheck(
				stringCount > 0 && stringCount <= MAX_SNAPSHOT_STRINGS,
				name,
				"String count out of bounds"
			);
			snapshotCheck(
				!domains.has(domain) || domains.get(domain) === stringCount,
				name,
				"Inconsistent domain count"
			);
			domains.set(domain, stringCount);
		} else snapshotCheck(domain === "" && stringCount === 0, name, "Unexpected string domain");
		entries.set(name, {
			name,
			kind,
			codec,
			offset,
			storedLength,
			rawLength,
			count,
			checksum: view.getUint32(p + 60, true),
			domain,
			stringCount
		});
		position += snapshotAligned(storedLength);
	}
	snapshotCheck(position === fileLength, "header", "Trailing bytes");
	const version = view.getUint32(8, true);
	for (const [domain, count] of domains) {
		const blocks = [...entries.values()].filter(
			(entry) => entry.kind === "strings" && entry.domain === domain
		);
		const starts = entries.get(`${domain}.starts`);
		snapshotCheck(
			blocks.length > 0 &&
				(version === 2
					? blocks.length === Math.ceil(count / 1024)
					: starts?.kind === "u32" && starts.count === blocks.length),
			domain,
			"Missing string block index"
		);
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index]!;
			snapshotCheck(
				block.name === `${domain}.b${index}`,
				domain,
				"Invalid string block index"
			);
			if (index)
				snapshotCheck(
					block.offset ===
						blocks[index - 1]!.offset +
							snapshotAligned(blocks[index - 1]!.storedLength),
					domain,
					"Noncontiguous string domain"
				);
		}
	}
	return { fileLength, entries, version };
}
export function decodeSnapshotSection(
	entry: SnapshotEntry,
	bytes: Uint8Array,
	options: SnapshotCodecOptions = {}
) {
	snapshotCheck(bytes.length === entry.rawLength, entry.name, "Decoded length mismatch");
	snapshotCheck(
		(options.checksum ?? snapshotChecksum)(bytes) === entry.checksum,
		entry.name,
		"Section checksum mismatch"
	);
	if (entry.kind === "strings") {
		decodeStringBlock(bytes, entry.name, options);
		return bytes;
	}
	if (entry.kind === "bytes" || entry.kind === "u8") return bytes;
	snapshotCheck(
		new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 && bytes.byteOffset % 4 === 0,
		entry.name,
		"Unaligned or non-little-endian host"
	);
	const values = new Uint32Array(bytes.buffer, bytes.byteOffset, entry.count);
	if (entry.kind === "stringIds")
		for (const id of values)
			snapshotCheck(id < entry.stringCount, entry.name, "String ID out of bounds");
	return values;
}
