import { Cache, Effect } from "effect";
import type { JoinedQueryData } from "./joined-query-data.test-support.js";
import { runJoinedQuery } from "./joined-query-node.js";
import { decodeWtf8, encodeWtf8 } from "./wtf8.js";
import { normalizeTextPath } from "./text-origin.js";

/** Immutable path and namespace projections. All corpus predicates use numeric or byte columns. */
export class QueryPlaces {
	readonly file: Uint32Array;
	readonly namespace: Uint32Array;
	readonly path: Uint32Array;
	readonly asset: Uint32Array;
	readonly fileLabels: Uint32Array;
	readonly folderStarts: Uint32Array;
	readonly folderLabels: Uint32Array;
	readonly folderKeys: Uint32Array;
	readonly namespaceValues: Uint32Array;
	readonly rank: Uint32Array;
	private readonly arenas: Record<string, { bytes: Buffer; offsets: Uint32Array }>;
	private readonly predicates;
	readonly data: JoinedQueryData;
	constructor(data: JoinedQueryData) {
		this.data = data;
		const c = (field: string) => data.column(`query.place.${field}`);
		const last = data.joined.reader.manifest.segments.at(-1),
			size = last ? last.start + last.count : 0;
		const index = (field: string) => {
			const key = `place-index:${field}`;
			let value = data.projection.columns.get(key);
			if (!value) {
				value = new Uint32Array(size);
				const ids = c(`${field}_ids`);
				for (let row = 0; row < ids.length; row++) value[ids[row]!] = row + 1;
				data.projection.columns.set(key, value);
			}
			return value;
		};
		this.file = index("file");
		this.namespace = index("namespace");
		this.path = index("path");
		this.asset = c("asset");
		this.fileLabels = c("file_values");
		this.folderStarts = c("folder_starts");
		this.folderLabels = c("folder_labels");
		this.folderKeys = c("folder_keys");
		this.namespaceValues = c("namespace_values");
		this.rank = c("rank");
		this.arenas = Object.fromEntries(
			["label", "path", "manifest"].map((field) => {
				const values = c(`${field}_bytes`);
				return [
					field,
					{
						bytes: Buffer.from(values.buffer, values.byteOffset, values.byteLength),
						offsets: c(`${field}_offsets`)
					}
				];
			})
		);
		this.predicates = runJoinedQuery(
			Cache.make({
				capacity: 16,
				lookup: (prefix: string) =>
					Effect.sync(() => {
						const wanted = Buffer.from(encodeWtf8(prefix));
						return Object.fromEntries(
							["path", "manifest"].map((name) => {
								const offsets = this.arenas[name]!.offsets,
									flags = new Uint8Array(offsets.length - 1);
								for (let row = 0; row < flags.length; row++)
									flags[row] = Number(this.startsWith(name, row, wanted));
								return [name, flags];
							})
						);
					})
			})
		);
	}
	bytes(name: string, row: number) {
		const arena = this.arenas[name]!;
		return arena.bytes.subarray(arena.offsets[row], arena.offsets[row + 1]);
	}
	startsWith(name: string, row: number, wanted: Buffer) {
		const bytes = this.bytes(name, row);
		return bytes.length >= wanted.length && bytes.subarray(0, wanted.length).equals(wanted);
	}
	label(row: number) {
		return decodeWtf8(this.bytes("label", row));
	}
	findLabel(value: string) {
		const wanted = Buffer.from(encodeWtf8(value)),
			offsets = this.arenas.label!.offsets;
		for (let row = 0; row + 1 < offsets.length; row++)
			if (this.bytes("label", row).equals(wanted)) return row;
		return -1;
	}
	prefix(value: string) {
		return runJoinedQuery(Cache.get(this.predicates, normalizeTextPath(value)));
	}
	coordinate(fileId: number, folder: boolean, depth?: number, parent?: Buffer) {
		const row = this.file[fileId]! - 1;
		if (!folder) return { key: this.asset[row]!, label: this.fileLabels[row]! };
		const start = this.folderStarts[row]!,
			end = this.folderStarts[row + 1]!;
		const position = depth === undefined ? end - 1 : start + depth - 1;
		if (
			position >= end ||
			(parent && !this.startsWith("label", this.folderKeys[end - 1]!, parent))
		)
			return { key: 0, label: 0 };
		return { key: this.folderKeys[position]!, label: this.folderLabels[position]! };
	}
}
