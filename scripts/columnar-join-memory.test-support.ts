import { encodeWtf8 } from "../packages/game-text/src/wtf8.ts";
import { Effect, Layer } from "effect";
import {
	SharedIndex,
	type SharedIndexManifest,
	type SharedIndexReader,
	type SharedIndexWriter,
	type SharedLayerRecord
} from "../packages/game-text/src/shared-index.ts";
import type { SnapshotSource } from "../packages/game-text/src/snapshot-file.ts";
import {
	decodeStringBlock,
	encodeSnapshotDirectory,
	decodeSnapshotDirectory,
	snapshotAligned,
	snapshotChecksum,
	type SnapshotEntry
} from "../packages/game-text/src/snapshot-format.ts";
import { packedStrings } from "../packages/game-text/src/shared-string-codec.ts";
import type { ColdLayerSource } from "../packages/game-text/src/shared-string-sort.ts";

/** Pure store adapter for the differential join, using real layer producers and decoders.
 * Filesystem/checksum/lock/import lifecycle remains covered by the persisted regression suite.
 * This adapter changes storage only: it contains no gathering, joining or query rules.
 */
export function joinMemoryLayer() {
	const active: Record<string, string> = {},
		records: Record<string, SharedLayerRecord> = {};
	const segments: SharedIndexManifest["segments"][number][] = [];
	const root: SharedIndexManifest = {
		version: 2,
		generation: "fuzz",
		active,
		segments,
		layers: records
	};
	const values: string[] = [],
		ids = new Map<string, number>();
	const layers = new Map<
		string,
		{
			directory: ReturnType<typeof decodeSnapshotDirectory>;
			columns: Map<string, Uint8Array | Uint32Array>;
		}
	>();
	const intern = (_domain: string, strings: readonly string[]) =>
		Effect.sync(() => {
			const fresh = [...new Set(strings.filter((value) => !ids.has(value)))].sort((a, b) =>
				Buffer.compare(encodeWtf8(a), encodeWtf8(b))
			);
			if (fresh.length) {
				segments.push({
					file: `strings-${String(root.segments.length).padStart(8, "0")}.snapshot`,
					start: values.length,
					count: fresh.length,
					domain: _domain,
					domains: [_domain],
					bytes: 0,
					utf8Bytes: Buffer.byteLength(fresh.join(""))
				});
				for (const value of fresh) {
					ids.set(value, values.length);
					values.push(value);
				}
			}
			return Uint32Array.from(strings, (value) => ids.get(value)!);
		});
	const strings = (selected: readonly number[]) =>
		Effect.sync(() =>
			selected.map((id) => {
				const value = values[id];
				if (value === undefined) throw new Error(`Fuzz store: missing string ${id}`);
				return value;
			})
		);
	const publish = (name: string, key: string, source: SnapshotSource, remap: boolean) =>
		Effect.gen(function* () {
			const local = new Map<string, string[]>(),
				loaded = new Map<string, Uint8Array | Uint32Array>();
			for (const column of source.columns) {
				const data = yield* Effect.promise(column.load);
				loaded.set(column.name, data);
				if (column.kind === "strings") {
					if (!(data instanceof Uint8Array))
						throw new Error("Fuzz store: expected string bytes");
					const block = decodeStringBlock(data, column.name),
						entries = local.get(column.domain!) ?? [];
					for (let i = 0; i < block.count; i++) entries.push(block.string(i));
					local.set(column.domain!, entries);
				}
			}
			const mappings = new Map<string, Uint32Array>();
			if (remap)
				for (const [domain, entries] of local)
					mappings.set(domain, yield* intern(domain, entries));
			const columns = new Map<string, Uint8Array | Uint32Array>(),
				entries: SnapshotEntry[] = [];
			const selected = source.columns.filter(
				(column) =>
					column.kind !== "strings" &&
					!(
						local.has(column.name.replace(/\.starts$/u, "")) &&
						column.name.endsWith(".starts")
					)
			);
			let offset = 48 + selected.length * 96;
			for (const column of selected) {
				let data = loaded.get(column.name)!;
				if (remap && column.kind === "stringIds")
					data = Uint32Array.from(data, (id) => mappings.get(column.domain!)![id]!);
				columns.set(column.name, data);
				const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				entries.push({
					name: column.name,
					kind: data instanceof Uint32Array ? "u32" : "bytes",
					codec: 0,
					offset,
					storedLength: raw.length,
					rawLength: raw.length,
					count: data.length,
					checksum: snapshotChecksum(raw),
					domain: "",
					stringCount: 0
				});
				offset += snapshotAligned(raw.length);
			}
			const directory = decodeSnapshotDirectory(
				encodeSnapshotDirectory(entries, offset),
				offset
			);
			layers.set(key, { directory, columns });
			const record: SharedLayerRecord = {
				file: "layer-00000000.snapshot",
				key,
				storeGeneration: root.generation,
				segmentCount: root.segments.length,
				bytes: offset,
				stringColumns: {}
			};
			active[name] = key;
			records[key] = record;
			return record;
		});
	const batch = (entries: readonly ColdLayerSource[], removed: readonly string[] = []) =>
		Effect.gen(function* () {
			const published: SharedLayerRecord[] = [];
			for (const entry of entries)
				published.push(yield* publish(entry.name, entry.key, entry.source, true));
			for (const name of removed) delete active[name];
			return published;
		});
	const reader: SharedIndexReader = {
		manifest: root,
		strings,
		bytesSync: (id) => {
			const value = values[id];
			if (value === undefined) throw new Error(`Fuzz store: missing string ${id}`);
			return Buffer.from(encodeWtf8(value));
		},
		stringsSync: (ids) =>
			ids.map((id) => {
				const value = values[id];
				if (value === undefined) throw new Error(`Fuzz store: missing string ${id}`);
				return value;
			}),
		layerSync: (name) => {
			const layer = layers.get(root.active[name] ?? name);
			if (!layer) throw new Error(`Fuzz store: missing layer ${name}`);
			return {
				directory: layer.directory,
				section: (field) => {
					const column = layer.columns.get(field);
					if (!column) throw new Error(`Fuzz store: missing column ${field}`);
					return column;
				}
			};
		},
		layer: (name) =>
			Effect.sync(() => {
				const layer = layers.get(root.active[name] ?? name);
				if (!layer) throw new Error(`Fuzz store: missing layer ${name}`);
				return {
					directory: layer.directory,
					strings: (_domain: string, selected: readonly number[]) => strings(selected),
					section: (name: string) =>
						Effect.sync(() => {
							const column = layer.columns.get(name);
							if (!column) throw new Error(`Fuzz store: missing column ${name}`);
							return column;
						})
				};
			}),
		packedSegment: (index) =>
			Effect.sync(() => {
				const segment = root.segments[index]!;
				return packedStrings(values.slice(segment.start, segment.start + segment.count));
			}),
		domain: () => Effect.die("Fuzz store does not implement domain loading"),
		range: () => Effect.die("Fuzz store does not implement dictionary ranges"),
		metrics: () => ({
			readBytes: 0,
			blocksLoaded: 0,
			columnLoadMs: 0,
			idDecodeMs: 0,
			idValidateMs: 0,
			decodedBlocks: 0,
			decodedBytes: 0,
			decodedHits: 0,
			decodedMisses: 0
		})
	};
	const writer: SharedIndexWriter = {
		intern,
		strings,
		manifest: () => root,
		publish: (name, key, source) => publish(name, key, source, true),
		publishIds: (name, key, source) => publish(name, key, source, false),
		publishBatch: batch,
		publishCold: batch,
		compact: () => Effect.die("Fuzz store does not implement compaction"),
		metrics: () => ({
			readBytes: 0,
			indexReadBytes: 0,
			appendedBytes: 0,
			lookupStrings: 0,
			reusedStrings: 0,
			probePasses: 0,
			sortMs: 0,
			probeMs: 0,
			appendMs: 0,
			segments: root.segments.length,
			timings: {
				collectMs: 0,
				reuseMs: 0,
				layerEncodeMs: 0,
				layerVerifyMs: 0,
				garbageMs: 0,
				rootPublishMs: 0
			}
		})
	};
	return Layer.succeed(
		SharedIndex,
		SharedIndex.of({
			open: Effect.succeed(reader),
			writer: Effect.succeed(writer),
			inspect: Effect.succeed(root),
			cached: (key) => Effect.sync(() => root.layers[key]!)
		})
	);
}
