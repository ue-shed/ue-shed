import { Effect, Schema } from "effect";
import {
	LocalizationTarget,
	FileProvenance,
	LocalizationError,
	LocalizationReviewFile
} from "@ue-shed/localization";
import { SharedIndex } from "./shared-index.js";
import { snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import { LocalizationKeyChangePair } from "./localization-key-changes.js";
import { localizationStates, LocalizationUnknownReason } from "./localization-schema.js";
import { TEXT_PROBLEMS } from "./text-problem-rules.js";
import { JoinedSourceCacheMeta } from "./joined-source-cache-contract.js";
import { u32 } from "./joined-target-input.js";
import type { SharedIndexReader } from "./shared-index.js";
import {
	JoinedSourcePatches,
	sourcePatchKind,
	spliceJoinedSources
} from "./joined-source-patches.js";

export const JoinedTargetMeta = Schema.Struct({
	version: Schema.Literals([3, 4]),
	count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	aliases: Schema.Record(Schema.String, Schema.String),
	chunks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	generation: Schema.String,
	base: Schema.optionalKey(Schema.String),
	patches: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	patchRows: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	sourcePatches: Schema.optionalKey(JoinedSourcePatches),
	sourceCache: Schema.optionalKey(JoinedSourceCacheMeta),
	input: Schema.Struct({
		projectRoot: Schema.String,
		target: LocalizationTarget,
		review: Schema.optionalKey(LocalizationReviewFile),
		keyChangePairs: Schema.optionalKey(Schema.Array(LocalizationKeyChangePair)),
		fileErrors: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
		fileProvenances: Schema.optionalKey(Schema.Record(Schema.String, FileProvenance)),
		fileDiagnostics: Schema.optionalKey(Schema.Record(Schema.String, LocalizationError))
	}),
	dependencies: Schema.Record(Schema.String, Schema.String),
	packageNames: Schema.Array(Schema.String),
	packageStarts: Schema.Array(Schema.Int),
	pairs: Schema.Array(LocalizationKeyChangePair),
	ambiguous: Schema.Int,
	oldCandidates: Schema.Int,
	reducedSourceChecking: Schema.Array(Schema.Boolean)
});
export interface JoinedTargetMeta extends Schema.Schema.Type<typeof JoinedTargetMeta> {}
export const readJoinedTarget = Effect.fn("JoinedTarget.read")(function* (
	reader: SharedIndexReader,
	stale = false
) {
	const rawLayer = yield* reader.layer("joined");
	if ((rawLayer.directory.entries.get("join.meta")?.rawLength ?? Infinity) > 16 * 1024 ** 2)
		return yield* Effect.fail(snapshotFailure("join.meta", "Metadata exceeds bound"));
	const meta = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JoinedTargetMeta))(
		new TextDecoder().decode(yield* rawLayer.section("join.meta"))
	);
	for (const kind of ["raw", "slice"] as const) {
		if (!meta.sourcePatches?.[kind]) continue;
		snapshotCheck(
			meta.version === 4 && meta.base !== undefined,
			"join.meta",
			"Invalid source patch version or base"
		);
		for (const field of ["sources", "source_start", "source_end"])
			snapshotCheck(
				!meta.patches?.[`query.${kind}.${field}`],
				"join.meta",
				"Overlapping source patches"
			);
	}
	if (!stale && meta.generation !== reader.manifest.generation)
		return yield* Effect.fail(
			snapshotFailure("join.meta", "Joined generation changed; refresh before querying")
		);
	const baseLayer = meta.base ? yield* reader.layer(meta.base) : rawLayer;
	if (meta.base)
		snapshotCheck(
			reader.manifest.active["joined-base"] === meta.base,
			"join.meta",
			"Base is not retained"
		);
	for (const canonical of Object.values(meta.aliases))
		if (!baseLayer.directory.entries.has(canonical))
			return yield* Effect.fail(snapshotFailure("join.meta", "Invalid column alias"));
	for (const names of Object.values(meta.chunks ?? {})) {
		snapshotCheck(names.length > 1, "join.meta", "Invalid column chunks");
		for (const name of names)
			snapshotCheck(
				baseLayer.directory.entries.has(name),
				"join.meta",
				"Missing column chunk"
			);
	}
	const patched = new Map<string, Uint32Array>();
	const chunked = new Map<string, Uint32Array>();
	const sourceLists = new Map<string, Uint32Array>();
	const original = Effect.fn("JoinedTarget.original")(function* (name: string) {
		const names = meta.chunks?.[name];
		if (!names) return yield* baseLayer.section(meta.aliases[name] ?? name);
		let values = chunked.get(name);
		if (!values) {
			const parts: Uint32Array[] = [];
			for (const field of names) parts.push(yield* u32(baseLayer, field));
			values = concatenateJoinedChunks(parts, name);
			chunked.set(name, values);
		}
		return values;
	});
	const section = Effect.fn("JoinedTarget.section")(function* (name: string) {
		if (name === "join.meta") return yield* rawLayer.section(name);
		const kind = sourcePatchKind(name, meta.sourcePatches);
		if (kind) {
			if (!sourceLists.has(name)) {
				const patch = meta.sourcePatches![kind]!;
				const prefix = `query.${kind}.`;
				const columns: Uint32Array[] = [];
				for (const field of ["source_start", "source_end", "sources"]) {
					const value = yield* original(prefix + field);
					snapshotCheck(value instanceof Uint32Array, name, "Invalid source column kind");
					columns.push(value);
				}
				const lists = spliceJoinedSources(
					columns[0]!,
					columns[1]!,
					columns[2]!,
					yield* u32(rawLayer, patch.rows),
					yield* u32(rawLayer, patch.starts),
					yield* u32(rawLayer, patch.values)
				);
				for (const [field, values] of Object.entries(lists))
					sourceLists.set(prefix + field, values);
			}
			return sourceLists.get(name)!;
		}
		const patch = meta.patches?.[name];
		if (!patch) return yield* original(name);
		let values = patched.get(name);
		if (!values) {
			const baseValues = yield* original(name);
			snapshotCheck(baseValues instanceof Uint32Array, name, "Invalid patch column kind");
			values = baseValues.slice();
			const rows = yield* u32(rawLayer, meta.patchRows?.[name] ?? "patch.rows"),
				replacements = yield* u32(rawLayer, patch);
			snapshotCheck(rows.length === replacements.length, patch, "Patch lengths differ");
			for (let i = 0; i < rows.length; i++) {
				snapshotCheck(
					rows[i]! < values.length && (i === 0 || rows[i]! > rows[i - 1]!),
					patch,
					"Invalid patch row"
				);
				values[rows[i]!] = replacements[i]!;
			}
			patched.set(name, values);
		}
		return values;
	});
	const layer = { ...baseLayer, section };
	for (const [name, key] of Object.entries(meta.dependencies))
		if (!stale && reader.manifest.active[name] !== key)
			return yield* Effect.fail(
				snapshotFailure("join.meta", "Joined inputs changed; refresh before querying")
			);
	return { reader, layer, rawLayer, baseLayer, meta };
});
export const openJoinedTarget = Effect.fn("JoinedTarget.open")(function* () {
	return yield* readJoinedTarget(yield* (yield* SharedIndex).open());
});
export type JoinedTargetReader = Effect.Success<ReturnType<typeof openJoinedTarget>>;

/** Logical query arenas span bounded physical sections at large scales. */
export function concatenateJoinedChunks(parts: readonly Uint32Array[], name: string): Uint32Array {
	const length = parts.reduce((sum, part) => sum + part.length, 0);
	snapshotCheck(
		Number.isSafeInteger(length) && length <= 0xffffffff,
		name,
		"Logical column exceeds u32 range"
	);
	const values = new Uint32Array(length);
	let offset = 0;
	for (const part of parts) {
		values.set(part, offset);
		offset += part.length;
	}
	return values;
}

/** Column-only census: checks every row, complete cultures, references, flags and facet coverage. */
export const inspectJoinedTarget = Effect.fn("JoinedTarget.inspect")(function* (
	joined: JoinedTargetReader
) {
	const { layer, meta, reader } = joined;
	const states: Record<string, Record<string, number>> = {};
	const last = reader.manifest.segments.at(-1),
		limit = last ? last.start + last.count : 0;
	const record = reader.manifest.layers[meta.base ?? reader.manifest.active.joined!]!;
	for (const [name, entry] of layer.directory.entries) {
		if (name === "join.meta" || name === "shared.meta") continue;
		const values = yield* layer.section(name);
		if (!/\.chunk\d+$/u.test(name) && (name.startsWith("line.") || /^c\d+\./u.test(name)))
			snapshotCheck(values.length === meta.count, name, "Incomplete line column");
		if (record.stringColumns[name])
			for (const id of values) snapshotCheck(id < limit, name, "ID outside dictionary");
		if (!sourcePatchKind(name, meta.sourcePatches))
			snapshotCheck(entry.count === values.length, name, "Count differs");
	}
	for (const name of new Set([
		...Object.keys(meta.aliases),
		...Object.keys(meta.chunks ?? {}),
		...Object.keys(meta.patches ?? {})
	])) {
		const values = yield* u32(layer, name);
		if (name.startsWith("line.") || /^c\d+\./u.test(name))
			snapshotCheck(values.length === meta.count, name, "Incomplete logical column");
		if (record.stringColumns[meta.aliases[name] ?? name])
			for (const id of values) snapshotCheck(id < limit, name, "ID outside dictionary");
	}
	const occurrences = yield* u32(layer, "occurrence.rows"),
		manifest = yield* u32(layer, "manifest.rows");
	const occurrenceCount = meta.packageStarts.at(-1)!;
	snapshotCheck(
		occurrences.length === occurrenceCount,
		"join.occurrences",
		"Missing occurrences"
	);
	for (const [name, values, length] of [
		["occurrence", occurrences, occurrenceCount],
		["manifest", manifest, manifest.length]
	] as const) {
		const seen = new Uint8Array(length);
		for (const row of values) {
			snapshotCheck(row < length && !seen[row], name, "Invalid row permutation");
			seen[row] = 1;
		}
	}
	for (const [prefix, maximum] of [
		["occ", occurrenceCount],
		["manifest", manifest.length]
	] as const) {
		const start = yield* u32(layer, `line.${prefix}_start`),
			end = yield* u32(layer, `line.${prefix}_end`);
		let position = 0;
		for (let row = 0; row < meta.count; row++) {
			snapshotCheck(
				start[row] === position && end[row]! >= position && end[row]! <= maximum,
				prefix,
				"Invalid input ranges"
			);
			position = end[row]!;
		}
		snapshotCheck(position === maximum, prefix, "Input rows not exhausted");
	}
	for (const [name, mask] of [
		["line.problems", (1 << TEXT_PROBLEMS.length) - 1],
		["line.reasons", (1 << LocalizationUnknownReason.literals.length) - 1],
		["line.facts", 1023]
	] as const)
		for (const value of yield* u32(layer, name))
			snapshotCheck((value & ~mask) === 0, name, "Unknown bits");
	for (let ci = 0; ci < meta.input.target.cultures.length; ci++) {
		const counts = Object.fromEntries(localizationStates.map((state) => [state, 0]));
		for (const code of yield* u32(layer, `c${ci}.state`)) {
			const state = localizationStates[code];
			snapshotCheck(state !== undefined, "join.state", "State outside enum");
			counts[state]!++;
		}
		states[meta.input.target.cultures[ci]!] = counts;
		for (const [field, mask] of [
			["facts", 1023],
			["reasons", (1 << LocalizationUnknownReason.literals.length) - 1],
			["review", 3]
		] as const)
			for (const value of yield* u32(layer, `c${ci}.${field}`))
				snapshotCheck((value & ~mask) === 0, field, "Unknown bits");
		for (const field of ["archive", "po"] as const) {
			const paths =
				field === "archive"
					? meta.input.target.outputPaths.archives
					: meta.input.target.outputPaths.portableObjects;
			const key = meta.dependencies[paths[meta.input.target.cultures[ci]!]!];
			const maximum = key
				? (yield* reader.layer(key)).directory.entries.get("entry.key")!.count
				: 0;
			for (const value of yield* u32(layer, `c${ci}.${field}`))
				snapshotCheck(value <= maximum, field, "Input row outside layer");
		}
		for (const value of yield* u32(layer, `c${ci}.review_record`))
			snapshotCheck(
				value <= (meta.input.review?.records.length ?? 0),
				"review",
				"Review row outside file"
			);
	}
	const pairDirections = new Uint8Array(meta.pairs.length);
	for (const value of yield* u32(layer, "line.key_change"))
		if (value) {
			const index = (value >>> 1) - 1;
			snapshotCheck(
				index >= 0 &&
					index < pairDirections.length &&
					!(pairDirections[index]! & (1 << (value & 1))),
				"key-change",
				"Invalid pair reference"
			);
			pairDirections[index]! |= 1 << (value & 1);
		}
	for (const value of pairDirections)
		snapshotCheck(value === 3, "key-change", "Incomplete key-change pair");
	const fileStart = yield* u32(layer, "line.file_start"),
		fileEnd = yield* u32(layer, "line.file_end"),
		files = yield* u32(layer, "facet.files");
	const origins = yield* u32(layer, "line.origins"),
		editing = yield* u32(layer, "line.editing");
	const facetedLines = origins.reduce(
		(count, bits, row) => count + Number(Boolean(bits || editing[row])),
		0
	);
	let fileCoveredLines = 0;
	for (let row = 0; row < meta.count; row++) {
		snapshotCheck(
			fileStart[row]! <= fileEnd[row]! && fileEnd[row]! <= files.length,
			"join.files",
			"Invalid file facet range"
		);
		if (fileStart[row] !== fileEnd[row]) fileCoveredLines++;
		const seen = new Set<number>();
		for (let index = fileStart[row]!; index < fileEnd[row]!; index++) {
			snapshotCheck(!seen.has(files[index]!), "join.files", "Duplicate file facet");
			seen.add(files[index]!);
		}
	}
	snapshotCheck(fileCoveredLines === facetedLines, "join.files", "Incomplete file facets");
	const fs = yield* u32(layer, "line.folder_start"),
		fe = yield* u32(layer, "line.folder_end"),
		folders = yield* u32(layer, "facet.folders");
	const folderCounts = new Map<number, number>();
	let coveredLines = 0;
	for (let row = 0; row < meta.count; row++) {
		snapshotCheck(
			fs[row]! <= fe[row]! && fe[row]! <= folders.length,
			"join.folders",
			"Facet range outside columns"
		);
		if (fs[row] !== fe[row]) coveredLines++;
		const unique = new Set<number>();
		for (let i = fs[row]!; i < fe[row]!; i++) {
			const id = folders[i]!;
			snapshotCheck(!unique.has(id), "join.folders", "Duplicate folder facet");
			unique.add(id);
			folderCounts.set(id, (folderCounts.get(id) ?? 0) + 1);
		}
	}
	snapshotCheck(
		coveredLines === facetedLines,
		"join.folders",
		"Facet coverage does not sum to lines"
	);
	const ids = [...folderCounts.keys()],
		labels = yield* reader.strings(ids);
	return {
		count: meta.count,
		states,
		keyChanges: meta.pairs.length,
		ambiguous: meta.ambiguous,
		keyless: (yield* u32(layer, "line.reasons")).reduce(
			(count, bits) => count + Number(Boolean(bits & ((1 << 9) | (1 << 10) | (1 << 17)))),
			0
		),
		folderCounts: Object.fromEntries(
			ids.map((id, row) => [labels[row]!, folderCounts.get(id)!])
		),
		facetMemberships: folders.length,
		coveredLines,
		fileMemberships: files.length,
		fileCoveredLines
	};
});
