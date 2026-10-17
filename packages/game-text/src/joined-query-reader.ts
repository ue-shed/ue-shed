import { Effect } from "effect";
import { snapshotCheck, snapshotFailure, isSnapshotFormatError } from "./snapshot-format.js";
import { isSnapshotStoreError } from "./snapshot-store.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import { runJoinedQuery } from "./joined-query-node.js";
import { concatenateJoinedChunks } from "./joined-target-reader.js";
import { sourcePatchKind, spliceJoinedSources } from "./joined-source-patches.js";

const read = <A>(operation: string, run: () => A) =>
	Effect.try({
		try: run,
		catch: (cause) =>
			isSnapshotFormatError(cause) || isSnapshotStoreError(cause)
				? cause
				: snapshotFailure(operation, `The joined index could not read ${operation}.`, cause)
	});

const synchronousViews = new WeakMap<JoinedTargetReader, JoinedTargetReader>();

/** The existing synchronous query API uses the same pinned handles, codecs and column cache.
 * No Effect runtime crosses an asynchronous boundary during a page or focus request. Each
 * pinned reader has one view, so its chunk and patch caches are shared by every caller.
 */
export function synchronousJoinedTarget(joined: JoinedTargetReader): JoinedTargetReader {
	let view = synchronousViews.get(joined);
	if (!view) {
		view = makeSynchronousJoinedTarget(joined);
		synchronousViews.set(joined, view);
		// A view of a view is itself.
		synchronousViews.set(view, view);
	}
	return view;
}

function makeSynchronousJoinedTarget(joined: JoinedTargetReader): JoinedTargetReader {
	const layerSync = joined.reader.layerSync,
		stringsSync = joined.reader.stringsSync;
	snapshotCheck(
		layerSync !== undefined && stringsSync !== undefined,
		"query.reader",
		"The index adapter does not support synchronous queries"
	);
	const layer = (name: string) =>
		read("query.layer", () => {
			const opened = layerSync(name);
			return {
				directory: opened.directory,
				section: (field: string) => read(field, () => opened.section(field)),
				strings: (_domain: string, ids: readonly number[]) =>
					read("query.strings", () => stringsSync(ids))
			};
		});
	const raw = layerSync("joined"),
		base = joined.meta.base ? layerSync(joined.meta.base) : raw;
	const patched = new Map<string, Uint32Array>();
	const chunked = new Map<string, Uint32Array>();
	const sourceLists = new Map<string, Uint32Array>();
	const original = (name: string) => {
		const names = joined.meta.chunks?.[name];
		if (!names) return base.section(joined.meta.aliases[name] ?? name);
		let values = chunked.get(name);
		if (!values) {
			const parts = names.map((field) => {
				const part = base.section(field);
				snapshotCheck(part instanceof Uint32Array, field, "Invalid chunk column kind");
				return part;
			});
			values = concatenateJoinedChunks(parts, name);
			chunked.set(name, values);
		}
		return values;
	};
	const section = (name: string) =>
		read(name, () => {
			if (name === "join.meta") return raw.section(name);
			const kind = sourcePatchKind(name, joined.meta.sourcePatches);
			if (kind) {
				if (!sourceLists.has(name)) {
					const patch = joined.meta.sourcePatches![kind]!;
					const prefix = `query.${kind}.`;
					const columns = ["source_start", "source_end", "sources"].map((field) => {
						const value = original(prefix + field);
						snapshotCheck(
							value instanceof Uint32Array,
							name,
							"Invalid source column kind"
						);
						return value;
					});
					const patches = [patch.rows, patch.starts, patch.values].map((field) => {
						const value = raw.section(field);
						snapshotCheck(
							value instanceof Uint32Array,
							name,
							"Invalid source patch kind"
						);
						return value;
					});
					const lists = spliceJoinedSources(
						columns[0]!,
						columns[1]!,
						columns[2]!,
						patches[0]!,
						patches[1]!,
						patches[2]!
					);
					for (const [field, values] of Object.entries(lists))
						sourceLists.set(prefix + field, values);
				}
				return sourceLists.get(name)!;
			}
			const patch = joined.meta.patches?.[name];
			if (!patch) return original(name);
			let values = patched.get(name);
			if (values) return values;
			const source = original(name),
				rows = raw.section(joined.meta.patchRows?.[name] ?? "patch.rows"),
				replacements = raw.section(patch);
			snapshotCheck(
				source instanceof Uint32Array &&
					rows instanceof Uint32Array &&
					replacements instanceof Uint32Array,
				name,
				"Invalid patch column kind"
			);
			snapshotCheck(rows.length === replacements.length, patch, "Patch lengths differ");
			values = source.slice();
			for (let row = 0; row < rows.length; row++) {
				snapshotCheck(
					rows[row]! < values.length && (row === 0 || rows[row]! > rows[row - 1]!),
					patch,
					"Invalid patch row"
				);
				values[rows[row]!] = replacements[row]!;
			}
			patched.set(name, values);
			return values;
		});
	return {
		...joined,
		reader: {
			...joined.reader,
			layer,
			strings: (ids) => read("query.strings", () => stringsSync(ids))
		},
		layer: { ...joined.layer, section },
		rawLayer: runJoinedQuery(layer("joined")),
		baseLayer: runJoinedQuery(layer(joined.meta.base ?? "joined"))
	};
}
