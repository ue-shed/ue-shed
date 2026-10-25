import type { JoinedTargetInput } from "./joined-target.js";
import { Effect, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { localizationReviewFingerprint } from "@ue-shed/localization";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import type { SnapshotSourceColumn } from "./snapshot-file.js";
import { snapshotCheck } from "./snapshot-format.js";
import { JoinedTargetMeta, readJoinedTarget } from "./joined-target-reader.js";
import { loadJoinFile, u32, type ColumnReader } from "./joined-target-input.js";
import { precedence, reasonBit, stateBit } from "./joined-target-reference.test-support.js";
import { decodeWtf8 } from "./wtf8.js";
import type { JoinedSourcePatches } from "./joined-source-patches.js";
import { longestSource } from "./source-metrics.js";

const same = (a: Uint32Array, b: Uint32Array) =>
	a.length === b.length &&
	Buffer.compare(
		Buffer.from(a.buffer, a.byteOffset, a.byteLength),
		Buffer.from(b.buffer, b.byteOffset, b.byteLength)
	) === 0;

/** Stable source/PO edits use one flat overlay. All other edits fall back to the merge join.
 * Generation changes invalidate numeric sort order. Absence candidates can change global key
 * matching, so they deliberately use a full rebuild. No overlay references another overlay.
 */
export const incrementJoinedTarget = Effect.fn("JoinedTarget.increment")(function* (
	input: JoinedTargetInput,
	key: string,
	dependencies: Readonly<Record<string, string>>,
	reader: SharedIndexReader,
	writer: SharedIndexWriter,
	onFallback: (reason: string) => void
) {
	const fallback = (reason: string) => {
		onFallback(reason);
		return null;
	};
	// Compaction can retire the overlay's base before its join is rebuilt. Check the
	// metadata generation before opening that base or any previous input layer.
	const raw = yield* reader.layer("joined");
	snapshotCheck(
		(raw.directory.entries.get("join.meta")?.rawLength ?? Infinity) <= 16 * 1024 ** 2,
		"join.meta",
		"Metadata exceeds bound"
	);
	const candidate = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JoinedTargetMeta))(
		new TextDecoder().decode(yield* raw.section("join.meta"))
	);
	if (
		candidate.generation !== reader.manifest.generation ||
		(candidate.base !== undefined && !Object.hasOwn(reader.manifest.layers, candidate.base))
	)
		return fallback("generation-or-retired-base");
	const previous = yield* readJoinedTarget(reader, true),
		{ meta, layer } = previous;
	if (
		meta.generation !== reader.manifest.generation ||
		meta.oldCandidates ||
		!isDeepStrictEqual(
			[
				meta.input.projectRoot,
				meta.input.target,
				meta.input.review,
				meta.input.keyChangePairs ?? [],
				meta.input.fileErrors ?? {}
			],
			[
				input.projectRoot,
				input.target,
				input.review,
				input.keyChangePairs ?? [],
				input.fileErrors ?? {}
			]
		)
	)
		return fallback("generation-target-review-or-absence");
	const names = Object.keys(dependencies),
		oldNames = Object.keys(meta.dependencies);
	if (names.length !== oldNames.length || names.some((name) => !meta.dependencies[name]))
		return fallback("dependency-set");
	const changed = names.filter((name) => dependencies[name] !== meta.dependencies[name]);
	if (changed.some((name) => !Object.hasOwn(reader.manifest.layers, meta.dependencies[name]!)))
		return fallback("retired-input");
	const poNames = Object.values(input.target.outputPaths.portableObjects);
	if (
		!changed.length ||
		changed.some((name) => !name.startsWith("package-text.") && !poNames.includes(name))
	)
		return fallback("unsupported-input");
	const packageChanges = new Map<number, number>();
	const previousPackageSources = new Map<number, number>();
	const packages = new Map<number, ColumnReader>();
	for (const name of changed.filter((name) => name.startsWith("package-text."))) {
		const shard = meta.packageNames.indexOf(name);
		if (shard < 0) return fallback("package-shard");
		const before = yield* reader.layer(meta.dependencies[name]!),
			after = yield* reader.layer(name);
		packages.set(shard, after);
		for (const field of before.directory.entries.keys()) {
			if (
				field === "shared.meta" ||
				field === "package.signature" ||
				field === "occurrence.source"
			)
				continue;
			// Package columns have no opaque metadata: every retained field affects semantics.
			const a = yield* u32(before, field),
				b = yield* u32(after, field);
			if (!same(a, b)) return fallback(`package-structure:${field}`);
		}
		const a = yield* u32(before, "occurrence.source"),
			b = yield* u32(after, "occurrence.source");
		if (a.length !== b.length) return fallback("package-source-count");
		for (let row = 0; row < a.length; row++)
			if (a[row] !== b[row]) {
				const occurrence = meta.packageStarts[shard]! + row;
				packageChanges.set(occurrence, b[row]!);
				previousPackageSources.set(occurrence, a[row]!);
				if (packageChanges.size > 8192) return fallback("source-edit-bound");
			}
	}
	const line: Record<string, Uint32Array> = {};
	for (const field of [
		"namespace",
		"key",
		"source",
		"occ_start",
		"occ_end",
		"manifest_start",
		"manifest_end",
		"reasons",
		"facts",
		"split_unit"
	])
		line[field] = yield* u32(layer, `line.${field}`);
	const affected = new Set<number>(),
		order = yield* u32(layer, "occurrence.rows");
	let resolvedCount = meta.count;
	while (resolvedCount && line.reasons![resolvedCount - 1]! & ((1 << 9) | (1 << 10) | (1 << 17)))
		resolvedCount--;
	for (let position = 0; position < order.length; position++)
		if (packageChanges.has(order[position]!)) {
			let low = 0,
				high = meta.count;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (line.occ_end![mid]! <= position) low = mid + 1;
				else high = mid;
			}
			if (low >= meta.count || line.occ_start![low]! > position)
				return fallback("occurrence-range");
			affected.add(low);
		}
	const packageLines = new Set(affected);
	const pos = new Map<number, Awaited<Effect.Success<ReturnType<typeof loadJoinFile>>>>();
	for (let ci = 0; ci < input.target.cultures.length; ci++) {
		const name = input.target.outputPaths.portableObjects[input.target.cultures[ci]!]!;
		if (!changed.includes(name)) continue;
		const before = yield* reader.layer(meta.dependencies[name]!),
			after = yield* loadJoinFile(reader, name);
		const previousMeta = JSON.parse(
			new TextDecoder().decode(yield* before.section("file.meta"))
		);
		if (previousMeta.hasSourceText !== after.hasSourceText) return fallback("po-source-mode");
		for (const field of ["namespace", "key", "ordinal"])
			if (!same(yield* u32(before, `entry.${field}`), after.columns[field]!))
				return fallback(`po-identity:${field}`);
		const beforeOptions = yield* u32(before, "entry.options");
		for (let row = 0; row < beforeOptions.length; row++)
			if ((beforeOptions[row]! & 16) !== (after.columns.options![row]! & 16))
				return fallback("po-context-mode");
		const dirty = new Uint8Array(beforeOptions.length);
		for (const field of Object.keys(after.columns)) {
			const a = yield* u32(before, `entry.${field}`),
				b = after.columns[field]!;
			if (a.length !== b.length) return fallback("po-column-count");
			for (let row = 0; row < a.length; row++) if (a[row] !== b[row]) dirty[row] = 1;
		}
		for (let row = 0; row < dirty.length; row++)
			if (dirty[row] && !(after.columns.options![row]! & 16)) {
				const ns = after.columns.namespace![row]!,
					identity = after.columns.key![row]!;
				let low = 0,
					high = resolvedCount;
				while (low < high) {
					const mid = (low + high) >>> 1;
					if (
						line.namespace![mid]! < ns ||
						(line.namespace![mid] === ns && line.key![mid]! < identity)
					)
						low = mid + 1;
					else high = mid;
				}
				if (line.namespace![low] === ns && line.key![low] === identity) affected.add(low);
			}
		pos.set(ci, after);
	}
	// Keep the patch bounded. Broad edits are cheaper and simpler as a full merge.
	if (affected.size > 8192) return fallback("affected-bound");
	const empty = (yield* writer.intern("identity", [""]))[0]!;
	const oldSources = new Set(previousPackageSources.values()),
		newSources = new Set(packageChanges.values());
	const decodedIds = [...new Set([...oldSources, ...newSources])],
		decoded = yield* writer.strings(decodedIds);
	const sourceText = new Map(decodedIds.map((id, i) => [id, decoded[i]!]));
	const sourceValue = Effect.fn("JoinedTarget.incrementSource")(function* (id: number) {
		let value = sourceText.get(id);
		if (value === undefined) {
			value = (yield* writer.strings([id]))[0]!;
			sourceText.set(id, value);
		}
		return value;
	});
	const hot = new Map<string, Map<number, number>>();
	const set = (field: string, row: number, value: number) => {
		let values = hot.get(field);
		if (!values) {
			values = new Map();
			hot.set(field, values);
		}
		values.set(row, value);
	};
	const packageColumn = Effect.fn("JoinedTarget.incrementPackage")(function* (
		occurrence: number,
		field: string
	) {
		let low = 0,
			high = meta.packageStarts.length - 1;
		while (low + 1 < high) {
			const mid = (low + high) >>> 1;
			if (meta.packageStarts[mid]! <= occurrence) low = mid;
			else high = mid;
		}
		let file = packages.get(low);
		if (!file) {
			file = yield* reader.layer(meta.packageNames[low]!);
			packages.set(low, file);
		}
		return (yield* u32(file, `occurrence.${field}`))[occurrence - meta.packageStarts[low]!]!;
	});
	const manifestRows = yield* u32(layer, "manifest.rows");
	const manifestKey = meta.dependencies[input.target.outputPaths.manifest ?? "<manifest>"];
	const manifestSource =
		manifestKey === undefined
			? new Uint32Array()
			: yield* u32(yield* reader.layer(manifestKey), "entry.source");
	for (const row of affected) {
		if (packageLines.has(row) && line.split_unit![row]) return fallback("split-unit");
		let source = line.source![row]!,
			reasons = line.reasons![row]!,
			structural = line.facts![row]!;
		const os = line.occ_start![row]!,
			oe = line.occ_end![row]!;
		if (packageLines.has(row) && os !== oe) {
			const sources = new Set<number>();
			let authored = false;
			for (let i = os; i < oe; i++)
				if ((yield* packageColumn(order[i]!, "identity")) !== 1) authored = true;
			for (let i = os; i < oe; i++) {
				// Reference/source mixtures and split package namespaces use the full merge.
				if ((yield* packageColumn(order[i]!, "identity")) === 1) {
					if (authored) continue;
					return fallback("reference-source");
				}
				sources.add(yield* packageColumn(order[i]!, "source"));
			}
			if (sources.size > 8192) return fallback("source-variant-bound");
			reasons &= ~reasonBit("conflicting_source");
			source = [...sources][0]!;
			let value = yield* sourceValue(source);
			if (sources.size > 1) {
				reasons |= reasonBit("conflicting_source");
				// The full join concatenates distinct sources in raw-unit locale order,
				// then package emission order within each unit. Numeric IDs are not that order.
				const starts = yield* u32(layer, "query.line.starts");
				const raws = yield* u32(layer, "query.slice.raw");
				const idStarts = yield* u32(layer, "query.raw.id_starts");
				const idValues = yield* u32(layer, "query.raw.id_utf8");
				const idBytes = new Uint8Array(
					idValues.buffer,
					idValues.byteOffset,
					idValues.byteLength
				);
				const slices = Array.from(
					{ length: starts[row + 1]! - starts[row]! },
					(_, index) => starts[row]! + index
				);
				const ids = new Map(
					slices.map((slice) => {
						const raw = raws[slice]!;
						return [
							slice,
							decodeWtf8(idBytes.subarray(idStarts[raw], idStarts[raw + 1]))
						];
					})
				);
				slices.sort((a, b) => ids.get(a)!.localeCompare(ids.get(b)!));
				const members = yield* u32(layer, "query.slice.members");
				const memberStarts = yield* u32(layer, "query.slice.member_start");
				const memberEnds = yield* u32(layer, "query.slice.member_end");
				const orderedSources = new Set<number>();
				for (const slice of slices)
					for (let offset = memberStarts[slice]!; offset < memberEnds[slice]!; offset++) {
						const member = members[offset]!;
						if ((yield* packageColumn(member, "identity")) !== 1)
							orderedSources.add(yield* packageColumn(member, "source"));
					}
				const values: string[] = [];
				for (const id of orderedSources) values.push(yield* sourceValue(id));
				value = values.join(" ");
				snapshotCheck(
					Buffer.byteLength(value) <= 1024 ** 2,
					"join.source",
					"Joined source exceeds bound"
				);
				source = (yield* writer.intern("source", [value]))[0]!;
			}
			const wasVisible = (yield* u32(layer, "line.source_visible"))[row]!;
			if (Number(value.trim() !== "") !== wasVisible) return fallback("source-visibility");
			set(
				"line.source_words",
				row,
				value.trim() === "" ? 0 : value.trim().split(/\s+/u).length
			);
			structural &= ~stateBit("changed_since_gather");
			if (
				sources.size === 1 &&
				line.manifest_start![row] !== line.manifest_end![row] &&
				source !== manifestSource[manifestRows[line.manifest_start![row]!]!]
			)
				structural |= stateBit("changed_since_gather");
			set("line.source", row, source);
			set("line.facts", row, structural);
			set("line.reasons", row, reasons);
		}
		for (let ci = 0; ci < input.target.cultures.length; ci++) {
			const culture = input.target.cultures[ci]!,
				prefix = `c${ci}.`;
			const oldFacts = yield* u32(layer, prefix + "facts"),
				oldReasons = yield* u32(layer, prefix + "reasons");
			const archiveRows = yield* u32(layer, prefix + "archive"),
				poRows = yield* u32(layer, prefix + "po");
			let facts =
				(oldFacts[row]! &
					~(
						stateBit("changed_since_gather") |
						stateBit("not_synced") |
						stateBit("unknown")
					)) |
				(structural & stateBit("changed_since_gather"));
			const unknown =
					(oldReasons[row]! & ~reasonBit("conflicting_source")) |
					(reasons & reasonBit("conflicting_source")),
				ai = archiveRows[row]! - 1,
				pi = poRows[row]! - 1;
			let archiveText = empty,
				poText = empty;
			if (ai >= 0) {
				const archive = yield* reader.layer(
					meta.dependencies[input.target.outputPaths.archives[culture]!]!
				);
				const options = yield* u32(archive, "entry.options");
				archiveText = (yield* u32(
					archive,
					options[ai]! & 128 ? "entry.source" : "entry.translation"
				))[ai]!;
			}
			let po = pos.get(ci);
			if (!po) {
				po = yield* loadJoinFile(
					reader,
					input.target.outputPaths.portableObjects[culture]!
				);
				pos.set(ci, po);
			}
			if (pi >= 0 && po.columns.options![pi]! & 64)
				poText =
					po.columns.options![pi]! & 128
						? po.columns.source![pi]!
						: po.columns.translation![pi]!;
			const archiveAvailable =
				Boolean(meta.dependencies[input.target.outputPaths.archives[culture]!]) ||
				input.fileErrors?.[input.target.outputPaths.archives[culture]!] === undefined ||
				input.fileErrors?.[input.target.outputPaths.archives[culture]!] === "file_missing";
			if (
				archiveAvailable &&
				!(
					unknown &
					(reasonBit("duplicate_archive_identity") | reasonBit("duplicate_po_identity"))
				) &&
				pi >= 0 &&
				poText !== empty &&
				poText !== archiveText
			)
				facts |= stateBit("not_synced");
			let operative = unknown;
			for (const [path, reason] of [
				[input.target.outputPaths.archives[culture]!, "missing_archive"],
				[input.target.outputPaths.portableObjects[culture]!, "missing_po"]
			] as const)
				if (
					!meta.dependencies[path] &&
					(!input.fileErrors?.[path] || input.fileErrors[path] === "file_missing")
				)
					operative &= ~reasonBit(reason);
			if (operative) facts |= stateBit("unknown");
			const state = precedence.find((code) => facts & (1 << code)) ?? 9;
			set(prefix + "facts", row, facts);
			set(prefix + "state", row, state);
			set(prefix + "reasons", row, unknown);
			if (
				input.review?.target === input.target.name &&
				!(reasons & ((1 << 9) | (1 << 10) | (1 << 17)))
			) {
				const recordRows = yield* u32(layer, prefix + "review_record"),
					record = input.review.records[recordRows[row]! - 1];
				if (record) {
					const shipped =
						facts & stateBit("not_synced")
							? pi >= 0
								? poText
								: null
							: ai >= 0
								? archiveText
								: null;
					const currentSource =
						line.manifest_start![row] !== line.manifest_end![row]
							? manifestSource[manifestRows[line.manifest_start![row]!]!]!
							: source;
					const values = yield* writer.strings(
						shipped === null ? [currentSource] : [currentSource, shipped]
					);
					set(
						prefix + "review",
						row,
						record.fingerprint ===
							localizationReviewFingerprint(
								values[0]!,
								shipped === null ? null : values[1]!
							)
							? 2
							: 3
					);
				}
			}
		}
	}
	const sourceEdits = {
		raw: new Map<number, readonly number[]>(),
		slice: new Map<number, readonly number[]>()
	};
	if (packageLines.size) {
		const starts = yield* u32(layer, "query.line.starts");
		const rawRows = yield* u32(layer, "query.slice.raw");
		for (const lineRow of packageLines)
			for (let sliceRow = starts[lineRow]!; sliceRow < starts[lineRow + 1]!; sliceRow++) {
				for (const [kind, queryRow] of [
					["raw", rawRows[sliceRow]!],
					["slice", sliceRow]
				] as const) {
					const prefix = `query.${kind}.`;
					const members = yield* u32(layer, prefix + "members");
					const memberStart = (yield* u32(layer, prefix + "member_start"))[queryRow]!;
					const memberEnd = (yield* u32(layer, prefix + "member_end"))[queryRow]!;
					const values = new Set<number>();
					for (let offset = memberStart; offset < memberEnd; offset++)
						values.add(yield* packageColumn(members[offset]!, "source"));
					if (values.size > 8192) return fallback("query-source-bound");
					const decoded: { source: number; value: string }[] = [];
					for (const source of values)
						decoded.push({ source, value: yield* sourceValue(source) });
					decoded.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
					const sourceStart = (yield* u32(layer, prefix + "source_start"))[queryRow]!;
					const sourceEnd = (yield* u32(layer, prefix + "source_end"))[queryRow]!;
					const sources = yield* u32(layer, prefix + "sources");
					const selected = decoded.map(({ source }) => source);
					if (
						selected.length !== sourceEnd - sourceStart ||
						selected.some((source, i) => source !== sources[sourceStart + i])
					)
						sourceEdits[kind].set(queryRow, selected);
					const longest = longestSource(decoded.map(({ value }) => value));
					const characters = longest.length;
					const words = longest.trim().split(/\s+/u).filter(Boolean).length;
					const visible = Number(decoded.some(({ value }) => value.trim() !== ""));
					if (visible !== (yield* u32(layer, prefix + "visible"))[queryRow])
						return fallback("query-source-visibility");
					set(prefix + "characters", queryRow, characters);
					set(prefix + "words", queryRow, words);
					const flags = (yield* u32(layer, prefix + "signals"))[queryRow]!;
					const conflict =
						(hot.get("line.reasons")?.get(lineRow) ?? line.reasons![lineRow]!) &
						reasonBit("conflicting_source");
					set(prefix + "signals", queryRow, (flags & ~16) | (conflict ? 16 : 0));
				}
			}
		for (const [member, source] of packageChanges)
			set("query.occurrence.sources", member, source);
		for (const edits of hot.values())
			if (edits.size > 8192) return fallback("query-overlay-bound");
	}
	const priorRows = meta.patches
		? yield* u32(previous.rawLayer, "patch.rows")
		: new Uint32Array();
	const rows = Uint32Array.from(new Set([...priorRows, ...affected])).sort();
	if (rows.length > 8192) return fallback("overlay-bound");
	const fields = new Set([...Object.keys(meta.patches ?? {}), ...hot.keys()]),
		patches: Record<string, string> = {},
		patchRows: Record<string, string> = {};
	const columns: SnapshotSourceColumn[] = [
		{ name: "patch.rows", kind: "u32", load: async () => rows }
	];
	let sourcePatches: JoinedSourcePatches = {};
	for (const kind of ["raw", "slice"] as const) {
		const prefix = `query.${kind}.`;
		const prior = meta.sourcePatches?.[kind];
		const selected = new Set([
			...(prior ? yield* u32(previous.rawLayer, prior.rows) : []),
			...sourceEdits[kind].keys()
		]);
		const starts = yield* u32(layer, prefix + "source_start");
		const ends = yield* u32(layer, prefix + "source_end");
		const sources = yield* u32(layer, prefix + "sources");
		// Migrate fixed-size source patches from earlier joins into the same flat list patch.
		if (meta.patches?.[prefix + "sources"]) {
			const indices = yield* u32(
				previous.rawLayer,
				meta.patchRows?.[prefix + "sources"] ?? "patch.rows"
			);
			for (const index of indices) {
				let low = 0,
					high = ends.length;
				while (low < high) {
					const mid = (low + high) >>> 1;
					if (ends[mid]! <= index) low = mid + 1;
					else high = mid;
				}
				if (low >= ends.length) return fallback("prior-source-range");
				selected.add(low);
			}
		}
		if (!selected.size) continue;
		if (selected.size > 8192) return fallback("query-source-overlay-bound");
		const sourceRows = Uint32Array.from(selected).sort();
		const offsets = new Uint32Array(sourceRows.length + 1);
		const values: number[] = [];
		for (let index = 0; index < sourceRows.length; index++) {
			const row = sourceRows[index]!;
			for (const id of sourceEdits[kind].get(row) ?? sources.subarray(starts[row], ends[row]))
				values.push(id);
			if (values.length > 8192) return fallback("query-source-value-bound");
			offsets[index + 1] = values.length;
		}
		const packed = Uint32Array.from(values);
		const name = `source-patch.${kind}`;
		sourcePatches = {
			...sourcePatches,
			[kind]: {
				rows: name + ".rows",
				starts: name + ".starts",
				values: name + ".values"
			}
		};
		columns.push(
			{ name: name + ".rows", kind: "u32", load: async () => sourceRows },
			{ name: name + ".starts", kind: "u32", load: async () => offsets },
			{
				name: name + ".values",
				kind: "stringIds",
				domain: "source",
				load: async () => packed
			}
		);
		for (const field of ["sources", "source_start", "source_end"])
			fields.delete(prefix + field);
	}
	for (const field of fields) {
		const current = yield* u32(layer, field),
			edits = hot.get(field);
		const fieldRows = field.startsWith("query.")
			? Uint32Array.from(
					new Set([
						...(meta.patches?.[field]
							? yield* u32(previous.rawLayer, meta.patchRows?.[field] ?? "patch.rows")
							: []),
						...(edits?.keys() ?? [])
					])
				).sort()
			: rows;
		if (fieldRows.length > 8192) return fallback("query-overlay-bound");
		const values = Uint32Array.from(fieldRows, (row) => edits?.get(row) ?? current[row]!);
		const name = `patch.${columns.length}`;
		patches[field] = name;
		if (field.startsWith("query.")) {
			patchRows[field] = `${name}.rows`;
			columns.push({ name: `${name}.rows`, kind: "u32", load: async () => fieldRows });
		}
		const sourceColumn = field === "line.source" || field.endsWith(".sources");
		columns.push({
			name,
			kind: sourceColumn ? "stringIds" : "u32",
			...(sourceColumn ? { domain: "source" } : undefined),
			load: async () => values
		});
	}
	const base = meta.base ?? reader.manifest.active.joined!;
	// Restoring the original inputs reuses the full base's content key. Publishing
	// an overlay there would overwrite its own retained base with the patch.
	if (key === base) return fallback("base-key-reuse");
	const bytes = new TextEncoder().encode(
		JSON.stringify({
			...meta,
			version: Object.keys(sourcePatches).length ? 4 : meta.version,
			input,
			dependencies,
			base,
			patches,
			patchRows,
			sourcePatches
		})
	);
	snapshotCheck(bytes.length <= 16 * 1024 ** 2, "join.meta", "Metadata exceeds bound");
	columns.push({ name: "join.meta", kind: "bytes", load: async () => bytes });
	const record = yield* writer.publishIds(
		"joined",
		key,
		{ columns },
		reader.manifest.generation,
		{ "joined-base": base }
	);
	return {
		rebuilt: true,
		strategy: "incremental" as const,
		affectedLines: affected.size,
		key,
		bytes: record.bytes + reader.manifest.layers[base]!.bytes,
		count: meta.count,
		keyChanges: meta.pairs.length
	};
});
