import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeStringBlock, encodeStringBlock, snapshotCheck } from "./snapshot-format.js";
import {
	openSnapshotFile,
	writeSnapshotFile,
	type SnapshotFileReader,
	type SnapshotSourceColumn,
	type SnapshotLoadedDomain
} from "./snapshot-file.js";

const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const SharedSegment = Schema.Struct({
	file: Schema.String.check(Schema.isPattern(/^strings-[a-f0-9-]+\.snapshot$/u)),
	start: Natural,
	count: Natural,
	domain: Schema.String.check(Schema.isMaxLength(23)),
	utf8Bytes: Natural,
	bytes: Natural,
	hashProbes: Schema.optionalKey(Schema.Literals([3, 7])),
	minBytes: Schema.optionalKey(Natural),
	maxBytes: Schema.optionalKey(Natural)
});
export type SharedSegment = typeof SharedSegment.Type;
const hash = (value: string) => createHash("sha256").update(value).digest().readUInt32LE(0);
const pageRows = 8192;
const maximumPendingBytes = 64 * 1024 ** 2;
const maximumPendingStrings = 250000;

function lowerBound(values: Uint32Array, id: number) {
	let low = 0,
		high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! < id) low = middle + 1;
		else high = middle;
	}
	return low;
}
function containing(values: readonly number[] | Uint32Array, id: number) {
	let low = 0,
		high = values.length;
	while (low + 1 < high) {
		const middle = (low + high) >>> 1;
		if (values[middle]! <= id) low = middle;
		else high = middle;
	}
	return low;
}

/** Positioned Node adapter. The owning Effect scope closes all immutable segment handles. */
export class SharedStringFiles {
	readonly files: SnapshotFileReader[] = [];
	readonly segments: SharedSegment[];
	readBytes = 0;
	indexReadBytes = 0;
	appendedBytes = 0;
	blocksLoaded = 0;
	// Keep this callback outside producer scopes: sibling load closures capture pending arrays.
	private readonly trackRead = (bytes: number) => {
		this.readBytes += bytes;
	};
	private readonly indexes = new Map<number, Uint32Array>();
	private readonly fences = new Map<number, Uint32Array>();
	private readonly blooms = new Map<number, Uint8Array>();
	private bloomBytes = 0;
	private readonly pages = new Map<string, { hashes: Uint32Array; ids: Uint32Array }>();
	private readonly blocks = new Map<string, ReturnType<typeof decodeStringBlock>>();
	private blockBytes = 0;
	private pending = new Map<string, number>();
	private stringsPending: string[] = [];
	private pendingBytes = 0;
	private pendingDomain = "";
	private closed = false;
	readonly directory: string;
	constructor(directory: string, segments: readonly SharedSegment[]) {
		this.directory = directory;
		this.segments = [...segments];
	}
	get count() {
		const last = this.segments.at(-1);
		return (last ? last.start + last.count : 0) + this.stringsPending.length;
	}
	async open() {
		try {
			let next = 0;
			for (const segment of this.segments) {
				snapshotCheck(
					segment.start === next && segment.count > 0,
					"segments",
					"Invalid ID range"
				);
				const reader = await openSnapshotFile(join(this.directory, segment.file), {
					onRead: this.trackRead
				});
				this.files.push(reader);
				snapshotCheck(
					reader.directory.fileLength === segment.bytes,
					"segments",
					"Segment size differs"
				);
				snapshotCheck(
					reader.directory.entries.get("text.b0")?.stringCount === segment.count,
					"segments",
					"Segment count differs"
				);
				next += segment.count;
			}
			return this;
		} catch (cause) {
			await this.close();
			throw cause;
		}
	}
	private async load(segment: number, name: string, index = false) {
		snapshotCheck(!this.closed, name, "Shared string scope is closed");
		const reader = this.files[segment]!;
		const bytes = reader.directory.entries.get(name)?.storedLength ?? 0;
		if (index) this.indexReadBytes += bytes;
		return reader.load(name);
	}
	async strings(ids: readonly number[]): Promise<string[]> {
		snapshotCheck(!this.closed, "strings", "Shared string scope is closed");
		const groups = new Map<
			string,
			{ segment: number; block: number; rows: number[]; local: number[] }
		>();
		const output: string[] = [];
		output.length = ids.length;
		const starts = this.segments.map((segment) => segment.start);
		for (let row = 0; row < ids.length; row++) {
			const id = ids[row]!;
			snapshotCheck(
				Number.isInteger(id) && id >= 0 && id < this.count,
				"strings",
				"Invalid shared ID"
			);
			const segment = containing(starts, id),
				meta = this.segments[segment];
			if (!meta || id >= meta.start + meta.count) {
				output[row] = this.stringsPending[id - (this.count - this.stringsPending.length)]!;
				continue;
			}
			let index = this.indexes.get(segment);
			if (!index) {
				const value = await this.load(segment, "text.starts");
				snapshotCheck(
					value instanceof Uint32Array && value[0] === 0,
					"strings",
					"Invalid block index"
				);
				index = value;
				this.indexes.set(segment, index);
			}
			const local = id - meta.start,
				block = containing(index, local);
			const key = `${segment}:${block}`;
			let group = groups.get(key);
			if (!group) {
				group = { segment, block, rows: [], local: [] };
				groups.set(key, group);
			}
			group.rows.push(row);
			group.local.push(local - index[block]!);
		}
		for (const [key, group] of groups) {
			let block = this.blocks.get(key);
			if (!block) {
				const bytes = await this.load(group.segment, `text.b${group.block}`);
				this.blocksLoaded++;
				snapshotCheck(bytes instanceof Uint8Array, "strings", "Invalid string block");
				block = decodeStringBlock(bytes);
				if (this.blockBytes + bytes.length > 32 * 1024 ** 2) {
					this.blocks.clear();
					this.blockBytes = 0;
				}
				this.blocks.set(key, block);
				this.blockBytes += bytes.length;
			}
			for (let row = 0; row < group.rows.length; row++)
				output[group.rows[row]!] = block.string(group.local[row]!);
		}
		return output;
	}
	async domain(domain: string): Promise<readonly SnapshotLoadedDomain[]> {
		snapshotCheck(!this.closed, "domain", "Shared string scope is closed");
		const result: SnapshotLoadedDomain[] = [];
		for (let i = 0; i < this.segments.length; i++)
			if (this.segments[i]!.domain === domain)
				result.push(await this.files[i]!.domain("text"));
		return result;
	}
	/** Batched exact lookup: small fence column, bounded hash pages, then string equality. */
	async intern(domain: string, values: readonly string[]) {
		snapshotCheck(!this.closed, "intern", "Shared string scope is closed");
		if (this.pendingDomain !== domain) await this.flush();
		this.pendingDomain = domain;
		const output = new Uint32Array(values.length);
		const missing = new Map<string, { hash: number; bytes: number; rows: number[] }>();
		for (let row = 0; row < values.length; row++) {
			const value = values[row]!;
			const existing = this.pending.get(value);
			if (existing !== undefined) output[row] = existing;
			else {
				const group = missing.get(value);
				if (group) group.rows.push(row);
				else
					missing.set(value, {
						hash: hash(value),
						bytes: Buffer.byteLength(value),
						rows: [row]
					});
			}
		}
		const order = Array.from({ length: this.segments.length }, (_, index) => index).sort(
			(a, b) =>
				Number(this.segments[b]!.domain === domain) -
					Number(this.segments[a]!.domain === domain) || b - a
		);
		for (const segment of order) {
			if (!missing.size) break;
			const meta = this.segments[segment]!;
			let possible = false;
			for (const request of missing.values())
				if (
					request.bytes >= (meta.minBytes ?? 0) &&
					request.bytes <= (meta.maxBytes ?? 1024 ** 2)
				) {
					possible = true;
					break;
				}
			if (!possible) continue;
			let bloom = this.blooms.get(segment);
			if (!bloom) {
				const value = await this.load(segment, "hash.bloom", true);
				snapshotCheck(value instanceof Uint8Array, "hash", "Invalid bloom");
				bloom = value;
				while (this.bloomBytes + bloom.length > 128 * 1024 ** 2 && this.blooms.size) {
					const oldest = this.blooms.keys().next().value!;
					this.bloomBytes -= this.blooms.get(oldest)!.length;
					this.blooms.delete(oldest);
				}
				this.blooms.set(segment, bloom);
				this.bloomBytes += bloom.length;
			}
			let fenceValue = this.fences.get(segment);
			if (!fenceValue) {
				const value = await this.load(segment, "hash.fences", true);
				snapshotCheck(value instanceof Uint32Array, "hash", "Invalid fences");
				fenceValue = value;
				this.fences.set(segment, fenceValue);
			}
			const requests = new Map<number, { value: string; hash: number }[]>();
			for (const [value, request] of missing) {
				if (
					request.bytes < (this.segments[segment]!.minBytes ?? 0) ||
					request.bytes > (this.segments[segment]!.maxBytes ?? 1024 ** 2)
				)
					continue;
				const probes = this.segments[segment]!.hashProbes ?? 3;
				if (!bloomContains(request.hash, bloom, probes)) continue;
				// Equal hashes can straddle a page; search every page with the matching range.
				let page = Math.max(0, lowerBound(fenceValue, request.hash) - 1);
				for (; page < fenceValue.length && fenceValue[page]! <= request.hash; page++) {
					const group = requests.get(page) ?? [];
					group.push({ value, hash: request.hash });
					requests.set(page, group);
				}
			}
			for (const [page, requestsInPage] of requests) {
				const key = `${segment}:${page}`;
				let payload = this.pages.get(key);
				if (!payload) {
					const hashes = await this.load(segment, `hash.p${page}`, true);
					const ids = await this.load(segment, `id.p${page}`, true);
					snapshotCheck(
						hashes instanceof Uint32Array &&
							ids instanceof Uint32Array &&
							hashes.length === ids.length,
						"hash",
						"Invalid hash page"
					);
					for (let row = 1; row < hashes.length; row++)
						hashes[row] = hashes[row]! + hashes[row - 1]!;
					payload = { hashes, ids };
					if (this.pages.size >= 1024) this.pages.delete(this.pages.keys().next().value!);
					this.pages.set(key, payload);
				}
				const candidates: { value: string; id: number }[] = [];
				for (const request of requestsInPage) {
					let index = lowerBound(payload.hashes, request.hash);
					while (
						index < payload.hashes.length &&
						payload.hashes[index] === request.hash
					) {
						const id = payload.ids[index++]!;
						snapshotCheck(
							id >= this.segments[segment]!.start &&
								id < this.segments[segment]!.start + this.segments[segment]!.count,
							"hash",
							"Hash ID outside segment"
						);
						candidates.push({ value: request.value, id });
					}
				}
				const decoded = await this.strings(candidates.map((candidate) => candidate.id));
				for (let row = 0; row < candidates.length; row++) {
					const candidate = candidates[row]!,
						request = missing.get(candidate.value);
					if (request && decoded[row] === candidate.value) {
						for (const index of request.rows) output[index] = candidate.id;
						missing.delete(candidate.value);
					}
				}
			}
		}
		for (const [value, request] of missing) {
			const bytes = Buffer.byteLength(value);
			snapshotCheck(
				bytes <= 1024 * 1024 && this.count < 0xffffffff,
				"strings",
				"String or ID exceeds cap"
			);
			if (
				this.pendingBytes + bytes + value.length * 2 + 128 > maximumPendingBytes ||
				this.pending.size >= maximumPendingStrings
			) {
				await this.flush();
				this.pendingDomain = domain;
			}
			const id = this.count;
			this.stringsPending.push(value);
			this.pending.set(value, id);
			this.pendingBytes += bytes + value.length * 2 + 128;
			for (const row of request.rows) output[row] = id;
		}
		return output;
	}
	async flush() {
		if (!this.stringsPending.length) return;
		const strings = this.stringsPending;
		const start = this.count - strings.length;
		const columns: SnapshotSourceColumn[] = [];
		const starts: number[] = [];
		let utf8Bytes = 0,
			minBytes = Infinity,
			maxBytes = 0;
		for (let row = 0; row < strings.length; ) {
			const begin = row;
			let bytes = 8;
			while (row < strings.length) {
				const length = Buffer.byteLength(strings[row]!);
				if (row > begin && bytes + length + 4 > 256 * 1024) break;
				bytes += length + 4;
				utf8Bytes += length;
				minBytes = Math.min(minBytes, length);
				maxBytes = Math.max(maxBytes, length);
				row++;
			}
			const end = row;
			starts.push(begin);
			columns.push({
				name: `text.b${starts.length - 1}`,
				kind: "strings",
				domain: "text",
				stringCount: strings.length,
				compressionLevel:
					this.pendingDomain === "paths" ? 9 : this.pendingDomain === "identity" ? 6 : 3,
				load: async () => encodeStringBlock(strings.slice(begin, end))
			});
		}
		columns.push({
			name: "text.starts",
			kind: "u32",
			load: async () => Uint32Array.from(starts)
		});
		const hashes = Uint32Array.from(strings, hash);
		const bloom = new Uint8Array(Math.max(8, Math.ceil((strings.length * 20) / 8)));
		for (const value of hashes) {
			const second = bloomStep(value);
			for (let index = 0; index < 7; index++) {
				const bit = ((value + Math.imul(second, index)) >>> 0) % (bloom.length * 8);
				bloom[bit >>> 3]! |= 1 << (bit & 7);
			}
		}
		columns.push({ name: "hash.bloom", kind: "u8", load: async () => bloom });
		const order = Uint32Array.from({ length: strings.length }, (_, row) => row).sort(
			(a, b) => hashes[a]! - hashes[b]!
		);
		const fences: number[] = [];
		for (let row = 0; row < order.length; row += pageRows) {
			const begin = row,
				end = Math.min(order.length, row + pageRows),
				page = fences.length;
			fences.push(hashes[order[row]!]!);
			columns.push({
				name: `hash.p${page}`,
				kind: "u32",
				load: async () =>
					Uint32Array.from(order.subarray(begin, end), (id, index) =>
						index
							? (hashes[id]! - hashes[order[begin + index - 1]!]!) >>> 0
							: hashes[id]!
					)
			});
			columns.push({
				name: `id.p${page}`,
				kind: "u32",
				load: async () => Uint32Array.from(order.subarray(begin, end), (id) => start + id)
			});
		}
		columns.push({
			name: "hash.fences",
			kind: "u32",
			load: async () => Uint32Array.from(fences)
		});
		const file = `strings-${randomUUID()}.snapshot`;
		const directory = await writeSnapshotFile(
			join(this.directory, file),
			{ columns },
			(column) => column.compressionLevel ?? 1
		);
		const reader = await openSnapshotFile(join(this.directory, file), {
			onRead: this.trackRead
		});
		await reader.verify();
		this.files.push(reader);
		this.segments.push({
			file,
			start,
			count: strings.length,
			domain: this.pendingDomain,
			utf8Bytes,
			bytes: directory.fileLength,
			hashProbes: 7,
			minBytes,
			maxBytes
		});
		this.appendedBytes += directory.fileLength;
		this.pending.clear();
		this.stringsPending = [];
		this.pendingBytes = 0;
	}
	/** Compaction copies a proven unique old store; no hash probes are needed for that copy. */
	async copyUnique(domain: string, values: readonly string[]) {
		if (this.pendingDomain !== domain) await this.flush();
		this.pendingDomain = domain;
		const ids = new Uint32Array(values.length);
		for (let row = 0; row < values.length; row++) {
			const value = values[row]!,
				bytes = Buffer.byteLength(value);
			if (
				this.pendingBytes + bytes + value.length * 2 + 128 > maximumPendingBytes ||
				this.stringsPending.length >= maximumPendingStrings
			) {
				await this.flush();
				this.pendingDomain = domain;
			}
			ids[row] = this.count;
			this.stringsPending.push(value);
			this.pendingBytes += bytes + value.length * 2 + 128;
		}
		return ids;
	}
	async close() {
		this.closed = true;
		for (const file of this.files) await file.close();
		this.pages.clear();
		this.blocks.clear();
		this.pending.clear();
		this.blooms.clear();
		this.fences.clear();
		this.indexes.clear();
		this.stringsPending = [];
	}
}

function bloomStep(hash: number) {
	return (Math.imul(hash ^ (hash >>> 16), 0x85ebca6b) >>> 0) | 1;
}
function bloomContains(hash: number, bloom: Uint8Array, probes: number) {
	const second = bloomStep(hash);
	for (let index = 0; index < probes; index++) {
		const bit = ((hash + Math.imul(second, index)) >>> 0) % (bloom.length * 8);
		if (!(bloom[bit >>> 3]! & (1 << (bit & 7)))) return false;
	}
	return true;
}
