import { Effect } from "effect";
import { isDeepStrictEqual } from "node:util";
import { localizationReviewFingerprint } from "@ue-shed/localization";
import type { SharedIndexReader, SharedIndexWriter } from "./shared-index.js";
import type { SnapshotSourceColumn } from "./snapshot-file.js";
import { snapshotCheck } from "./snapshot-format.js";
import { readJoinedTarget } from "./joined-target-reader.js";
import { loadJoinFile, u32, type ColumnReader } from "./joined-target-input.js";
import { precedence, reasonBit, stateBit, type JoinedTargetInput } from "./joined-target.js";

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
				meta.input.fileErrors ?? {}
			],
			[input.projectRoot, input.target, input.review, input.fileErrors ?? {}]
		)
	)
		return fallback("generation-target-review-or-absence");
	const names = Object.keys(dependencies),
		oldNames = Object.keys(meta.dependencies);
	if (names.length !== oldNames.length || names.some((name) => !meta.dependencies[name]))
		return fallback("dependency-set");
	const changed = names.filter((name) => dependencies[name] !== meta.dependencies[name]);
	const poNames = Object.values(input.target.outputPaths.portableObjects);
	if (
		!changed.length ||
		changed.some((name) => !name.startsWith("package-text.") && !poNames.includes(name))
	)
		return fallback("unsupported-input");
	const packageChanges = new Map<number, number>();
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
			if (a[row] !== b[row]) packageChanges.set(meta.packageStarts[shard]! + row, b[row]!);
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
		"problems",
		"split_unit"
	])
		line[field] = yield* u32(layer, `line.${field}`);
	const affected = new Set<number>(),
		order = yield* u32(layer, "occurrence.rows");
	let resolvedCount = meta.count;
	while (resolvedCount && line.reasons![resolvedCount - 1]! & ((1 << 9) | (1 << 10)))
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
	const oldSources = new Set<number>(),
		newSources = new Set<number>();
	for (const row of packageLines) {
		oldSources.add(line.source![row]!);
	}
	for (const source of packageChanges.values()) newSources.add(source);
	const decodedIds = [...new Set([...oldSources, ...newSources])],
		decoded = yield* writer.strings(decodedIds);
	const sourceText = new Map(decodedIds.map((id, i) => [id, decoded[i]!]));
	// Short-source edits can alter duplicate/long-text findings on unrelated units.
	for (const source of new Set([...oldSources, ...newSources]))
		if (sourceText.get(source)!.length < 40 && packageChanges.size)
			return fallback("short-source");
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
	const manifest = yield* reader.layer(meta.dependencies[input.target.outputPaths.manifest!]!);
	const manifestSource = yield* u32(manifest, "entry.source");
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
			if (sources.size !== 1 || reasons & reasonBit("conflicting_source"))
				return fallback("source-conflict");
			source = [...sources][0]!;
			structural &= ~stateBit("changed_since_gather");
			if (
				line.manifest_start![row] !== line.manifest_end![row] &&
				source !== manifestSource[manifestRows[line.manifest_start![row]!]!]
			)
				structural |= stateBit("changed_since_gather");
			set("line.source", row, source);
			set("line.facts", row, structural);
		}
		let problems = line.problems![row]! & (1 | 2 | 32),
			translationProblem = false;
		for (let ci = 0; ci < input.target.cultures.length; ci++) {
			const culture = input.target.cultures[ci]!,
				prefix = `c${ci}.`;
			const oldFacts = yield* u32(layer, prefix + "facts"),
				oldReasons = yield* u32(layer, prefix + "reasons");
			const archiveRows = yield* u32(layer, prefix + "archive"),
				poRows = yield* u32(layer, prefix + "po");
			let facts =
				(oldFacts[row]! & ~(stateBit("changed_since_gather") | stateBit("not_synced"))) |
				(structural & stateBit("changed_since_gather"));
			const unknown = oldReasons[row]!,
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
			const state = precedence.find((code) => facts & (1 << code)) ?? 9;
			set(prefix + "facts", row, facts);
			set(prefix + "state", row, state);
			translationProblem ||=
				state === 1 || state === 2 || Boolean(facts & stateBit("not_synced"));
			if (state === 4) problems |= 4;
			if (state === 5) problems |= 8;
			if (input.review?.target === input.target.name && !(reasons & ((1 << 9) | (1 << 10)))) {
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
		if (translationProblem) problems |= 16;
		set("line.problems", row, problems || 64);
	}
	const priorRows = meta.patches
		? yield* u32(previous.rawLayer, "patch.rows")
		: new Uint32Array();
	const rows = Uint32Array.from(new Set([...priorRows, ...affected])).sort();
	if (rows.length > 8192) return fallback("overlay-bound");
	const fields = new Set([...Object.keys(meta.patches ?? {}), ...hot.keys()]),
		patches: Record<string, string> = {};
	const columns: SnapshotSourceColumn[] = [
		{ name: "patch.rows", kind: "u32", load: async () => rows }
	];
	for (const field of fields) {
		const current = yield* u32(layer, field),
			edits = hot.get(field);
		const values = Uint32Array.from(rows, (row) => edits?.get(row) ?? current[row]!);
		const name = `patch.${columns.length}`;
		patches[field] = name;
		columns.push({
			name,
			kind: field === "line.source" ? "stringIds" : "u32",
			...(field === "line.source" ? { domain: "source" } : undefined),
			load: async () => values
		});
	}
	const base = meta.base ?? reader.manifest.active.joined!;
	const bytes = new TextEncoder().encode(
		JSON.stringify({ ...meta, input, dependencies, base, patches })
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
