import { Effect } from "effect";
import type { SharedIndexWriter } from "./shared-index.js";
import type { JoinPackages, JoinFile } from "./joined-target-input.js";
import { normalizeTextPath, textFileKey, textFolderLabel } from "./text-origin.js";
import { StringArena } from "./shared-string-codec.js";
import { encodeWtf8 } from "./wtf8.js";
import { HostSliceClock, sortRowsInSlices } from "./host-slices.js";

// Each string lookup is one synchronous read; this bounds how long one batch holds the host.
const stringBatch = 1024;

/** Persist predicates and UTF-16 label ranks; queries decode only the returned group labels. */
export const joinedQueryPlaces = Effect.fn("JoinedTarget.queryPlaces")(function* (
	writer: SharedIndexWriter,
	packages: JoinPackages,
	manifest: JoinFile,
	line: Record<string, Uint32Array>,
	query: Record<string, Uint32Array>,
	files: Uint32Array
) {
	const result: Record<string, Uint32Array> = {};
	const clock = new HostSliceClock();
	const table = new Map<string, number>(),
		labels: string[] = [];
	const intern = (value: string) => {
		let id = table.get(value);
		if (id === undefined) {
			id = labels.length;
			labels.push(value);
			table.set(value, id);
		}
		return id;
	};
	intern("");
	const vectors = (name: string, ids: Uint32Array, values: Uint32Array) => {
		result[`query.place.${name}_ids`] = ids;
		result[`query.place.${name}_values`] = values;
	};
	const unique = (columns: readonly Uint32Array[]) =>
		Effect.gen(function* () {
			// Filesystem writers may have interned IDs in an unpublished append segment.
			let maximum = -1;
			for (const values of columns) for (const id of values) if (id > maximum) maximum = id;
			const seen = new Uint8Array(maximum + 1);
			let count = 0;
			for (const values of columns)
				for (const id of values)
					if (!seen[id]) {
						seen[id] = 1;
						count++;
					}
			const ids = new Uint32Array(count);
			let row = 0;
			for (let id = 0; id < seen.length; id++) if (seen[id]) ids[row++] = id;
			const arena = new StringArena(),
				positions = new Uint32Array(maximum + 1);
			for (let start = 0; start < ids.length; start += stringBatch) {
				const values = yield* writer.strings(
					Array.from(ids.subarray(start, start + stringBatch))
				);
				for (let offset = 0; offset < values.length; offset++) {
					positions[ids[start + offset]!] = start + offset;
					arena.add(Buffer.from(encodeWtf8(values[offset]!)));
					if (clock.step()) yield* Effect.yieldNow;
				}
			}
			const packed = arena.finish();
			return yield* sortRowsInSlices(
				ids,
				(a, b) => {
					const left = positions[a]!,
						right = positions[b]!;
					return Buffer.compare(
						packed.bytes.subarray(packed.offsets[left], packed.offsets[left + 1]),
						packed.bytes.subarray(packed.offsets[right], packed.offsets[right + 1])
					);
				},
				clock
			);
		});
	const ids = yield* unique([files, query["query.raw.files"]!, query["query.slice.files"]!]);
	const asset = new Uint32Array(ids.length),
		fileLabel = new Uint32Array(ids.length);
	const starts = new Uint32Array(ids.length + 1),
		folders: number[] = [],
		folderKeys: number[] = [];
	for (let start = 0; start < ids.length; start += stringBatch) {
		const values = yield* writer.strings(Array.from(ids.subarray(start, start + stringBatch)));
		for (let index = 0; index < values.length; index++) {
			const row = start + index,
				value = values[index]!;
			fileLabel[row] = intern(value);
			asset[row] = intern(textFileKey(value));
			starts[row] = folders.length;
			const segments = textFolderLabel(value).split("/");
			for (let depth = 1; depth <= segments.length; depth++) {
				const label = segments.slice(0, depth).join("/");
				folders.push(intern(label));
				folderKeys.push(intern(normalizeTextPath(label)));
			}
			if (clock.step()) yield* Effect.yieldNow;
		}
	}
	starts[ids.length] = folders.length;
	vectors("file", ids, fileLabel);
	result["query.place.asset"] = asset;
	result["query.place.folder_starts"] = starts;
	result["query.place.folder_labels"] = Uint32Array.from(folders);
	result["query.place.folder_keys"] = Uint32Array.from(folderKeys);
	const namespaces = yield* unique([line.namespace!, query["query.raw.namespace"]!]);
	const namespaceValues = new Uint32Array(namespaces.length);
	for (let start = 0; start < namespaces.length; start += stringBatch) {
		const values = yield* writer.strings(
			Array.from(namespaces.subarray(start, start + stringBatch))
		);
		for (let row = 0; row < values.length; row++)
			namespaceValues[start + row] = intern(values[row]!);
	}
	vectors("namespace", namespaces, namespaceValues);
	const scannedKeys = new Uint32Array(packages.paths.length);
	for (let start = 0; start < packages.paths.length; start += stringBatch) {
		const values = yield* writer.strings(
			Array.from(packages.paths.subarray(start, start + stringBatch))
		);
		for (let row = 0; row < values.length; row++)
			scannedKeys[start + row] = intern(textFileKey(values[row]!));
	}
	result["query.place.scanned_keys"] = scannedKeys;
	const rank = new Uint32Array(labels.length);
	// Interned labels are distinct, so the stable sliced sort gives the native sort's order.
	const order = yield* sortRowsInSlices(
		Uint32Array.from({ length: labels.length }, (_, row) => row),
		(a, b) => (labels[a]! < labels[b]! ? -1 : labels[a]! > labels[b]! ? 1 : 0),
		clock
	);
	for (let row = 0; row < order.length; row++) {
		rank[order[row]!] = row;
		if (clock.step()) yield* Effect.yieldNow;
	}
	result["query.place.rank"] = rank;
	const pack = (name: string, arena: StringArena) => {
		const packed = arena.finish(),
			bytes = new Uint32Array(Math.ceil(packed.bytes.length / 4));
		new Uint8Array(bytes.buffer).set(packed.bytes);
		result[`query.place.${name}_bytes`] = bytes;
		result[`query.place.${name}_offsets`] = Uint32Array.from(packed.offsets);
	};
	const arena = new StringArena();
	for (const value of labels) {
		arena.add(Buffer.from(encodeWtf8(value)));
		if (clock.step()) yield* Effect.yieldNow;
	}
	pack("label", arena);
	// Paths are normalized in bounded batches. Their byte arena does not retain decoded strings.
	const pathIds = yield* unique([packages.paths, packages.occurrence.object]);
	const pathArena = new StringArena();
	for (let start = 0; start < pathIds.length; start += stringBatch) {
		const values = yield* writer.strings(
			Array.from(pathIds.subarray(start, start + stringBatch))
		);
		for (const value of values) {
			pathArena.add(Buffer.from(encodeWtf8(normalizeTextPath(value))));
			if (clock.step()) yield* Effect.yieldNow;
		}
	}
	result["query.place.path_ids"] = pathIds;
	result["query.place.occurrence_object"] = packages.occurrence.object;
	result["query.place.occurrence_package"] = Uint32Array.from(
		packages.packageRow,
		(row) => packages.paths[row]!
	);
	pack("path", pathArena);
	const manifestArena = new StringArena();
	const paths = manifest.columns.path ?? new Uint32Array();
	for (let start = 0; start < paths.length; start += stringBatch) {
		const values = yield* writer.strings(
			Array.from(paths.subarray(start, start + stringBatch))
		);
		for (let row = 0; row < values.length; row++) {
			const prefix =
				manifest.columns.options![start + row]! & 1024 ? manifest.pathPrefix : "";
			manifestArena.add(Buffer.from(encodeWtf8(normalizeTextPath(prefix + values[row]!))));
		}
	}
	pack("manifest", manifestArena);
	return result;
});
