import { Effect, Schema } from "effect";
import {
	LocalizationTarget,
	LocalizationReviewFile,
	ManifestEntry,
	ArchiveEntry,
	POEntry,
	LocalizationIdentity,
	TextKey,
	TextNamespace
} from "@ue-shed/localization";
import { SharedIndex } from "./shared-index.js";
import { snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import { decodeLocalizationSnapshot } from "./localization-columns.js";
import { LocalizationKeyChangePair } from "./localization-key-changes.js";
import {
	LocalizationLineId,
	LocalizationEvidenceLineId,
	localizationStates,
	LocalizationUnknownReason,
	type LocalizationLine,
	type LocalizationJoin
} from "./localization-schema.js";
import { TextUnitId } from "./identifiers.js";
import { u32, type ColumnReader } from "./joined-target-input.js";
import type { SharedIndexReader } from "./shared-index.js";

export const JoinedTargetMeta = Schema.Struct({
	version: Schema.Literal(3),
	count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	aliases: Schema.Record(Schema.String, Schema.String),
	generation: Schema.String,
	base: Schema.optionalKey(Schema.String),
	patches: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	input: Schema.Struct({
		projectRoot: Schema.String,
		target: LocalizationTarget,
		review: Schema.optionalKey(LocalizationReviewFile),
		fileErrors: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
	}),
	dependencies: Schema.Record(Schema.String, Schema.String),
	packageNames: Schema.Array(Schema.String),
	packageStarts: Schema.Array(Schema.Int),
	pairs: Schema.Array(LocalizationKeyChangePair),
	ambiguous: Schema.Int,
	oldCandidates: Schema.Int,
	reducedSourceChecking: Schema.Array(Schema.Boolean)
});
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
	const patched = new Map<string, Uint32Array>();
	const section = Effect.fn("JoinedTarget.section")(function* (name: string) {
		if (name === "join.meta") return yield* rawLayer.section(name);
		const patch = meta.patches?.[name];
		if (!patch) return yield* baseLayer.section(meta.aliases[name] ?? name);
		let values = patched.get(name);
		if (!values) {
			values = (yield* u32(baseLayer, meta.aliases[name] ?? name)).slice();
			const rows = yield* u32(rawLayer, "patch.rows"),
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

function occurrenceUnitId(
	values: Readonly<Record<string, string>>,
	numbers: Readonly<Record<string, number>>,
	projectRoot: string
) {
	// The package layer stores inventory paths; the corpus exposes project-relative host spelling.
	// Node path operations are loaded by this Node-only reader, never by the browser contract.
	const kind = numbers.identity!,
		key = values.key!;
	if (kind < 2 && key !== "")
		return `${kind === 0 ? "unreal" : "string-table"}:${encodeURIComponent(values.namespace!)}:${encodeURIComponent(key)}`;
	const suffix =
		numbers.location === 2
			? `entry:${values.row}`
			: numbers.location === 1
				? `row:${values.row}:property:${values.property}`
				: `property:${values.property}`;
	return `occurrence:${values.object}:${suffix}:${relative(projectRoot, resolve(projectRoot, values.package!))}`;
}
import { relative, resolve } from "node:path";

/** Bounded hydration uses input row references, retaining all original metadata and duplicates. */
export const hydrateJoinedTarget = Effect.fn("JoinedTarget.page")(function* (
	joined: JoinedTargetReader,
	start = 0,
	maximum = 50
) {
	snapshotCheck(
		Number.isSafeInteger(start) &&
			start >= 0 &&
			Number.isSafeInteger(maximum) &&
			maximum >= 0 &&
			maximum <= 10000,
		"join.page",
		"Invalid page range"
	);
	const { reader, layer, meta } = joined,
		target = meta.input.target;
	const end = Math.min(meta.count, start + maximum),
		columns: Record<string, Uint32Array> = {};
	for (const name of [
		"namespace",
		"key",
		"source",
		"occ_start",
		"occ_end",
		"manifest_start",
		"manifest_end",
		"key_change"
	])
		columns[name] = yield* u32(layer, `line.${name}`);
	const occurrenceRows = yield* u32(layer, "occurrence.rows"),
		manifestRows = yield* u32(layer, "manifest.rows");
	const decoded: Record<string, string[]> = {};
	for (const field of ["namespace", "key", "source"])
		decoded[field] = yield* reader.strings(Array.from(columns[field]!.subarray(start, end)));
	const opened = new Map<string, ColumnReader>();
	const occurrenceShards = new Map<number, Record<string, Uint32Array>>();
	const entryPages = new Map<
		string,
		Awaited<Effect.Success<ReturnType<typeof decodeLocalizationSnapshot>>>
	>();
	const file = Effect.fn("JoinedTarget.pageFile")(function* (name: string) {
		let value = opened.get(name);
		if (!value) {
			value = yield* reader.layer(meta.dependencies[name]!);
			opened.set(name, value);
		}
		return value;
	});
	const entry = Effect.fn("JoinedTarget.pageEntry")(function* (name: string, row: number) {
		const block = Math.floor(row / 256),
			key = `${name}:${block}`;
		let page = entryPages.get(key);
		if (!page) {
			page = yield* decodeLocalizationSnapshot(yield* file(name), block * 256, 256);
			if (entryPages.size >= 128) entryPages.delete(entryPages.keys().next().value!);
		} else entryPages.delete(key);
		entryPages.set(key, page);
		return page.entries[row - block * 256];
	});
	const occurrences = Effect.fn("JoinedTarget.pageOccurrences")(function* (shard: number) {
		let values = occurrenceShards.get(shard);
		if (!values) {
			values = {};
			for (const field of [
				"namespace",
				"key",
				"object",
				"property",
				"row",
				"identity",
				"location"
			])
				values[field] = yield* column(shard, `occurrence.${field}`);
			values.starts = yield* column(shard, "package.occurrence_start");
			values.paths = yield* column(shard, "package.path");
			occurrenceShards.set(shard, values);
		}
		return values;
	});
	const packageColumns = new Map<string, Uint32Array>();
	const column = Effect.fn("JoinedTarget.pageColumn")(function* (shard: number, name: string) {
		const cacheKey = `${shard}:${name}`;
		let value = packageColumns.get(cacheKey);
		if (!value) {
			value = yield* u32(yield* file(meta.packageNames[shard]!), name);
			packageColumns.set(cacheKey, value);
		}
		return value;
	});
	const marks: Record<string, Uint32Array>[] = [];
	for (let ci = 0; ci < target.cultures.length; ci++) {
		const values: Record<string, Uint32Array> = {};
		for (const field of [
			"state",
			"facts",
			"reasons",
			"archive",
			"po",
			"review",
			"review_record"
		])
			values[field] = yield* u32(layer, `c${ci}.${field}`);
		marks.push(values);
	}
	const lines: LocalizationLine[] = [];
	for (let row = start; row < end; row++) {
		const unitIds = new Set<string>();
		for (let i = columns.occ_start![row]!; i < columns.occ_end![row]!; i++) {
			const global = occurrenceRows[i]!;
			let shard = 0;
			while (meta.packageStarts[shard + 1]! <= global) shard++;
			const occurrence = global - meta.packageStarts[shard]!;
			const numbers: Record<string, number> = {},
				values: Record<string, string> = {};
			const input = yield* occurrences(shard);
			for (const field of ["namespace", "key", "identity", "location"])
				numbers[field] = input[field]![occurrence]!;
			if (numbers.identity! < 2) {
				const [namespace, key] = yield* reader.strings([numbers.namespace!, numbers.key!]);
				if (key !== "") {
					unitIds.add(
						`${numbers.identity === 0 ? "unreal" : "string-table"}:${encodeURIComponent(namespace!)}:${encodeURIComponent(key!)}`
					);
					continue;
				}
			}
			for (const field of ["object", "property", "row"])
				numbers[field] = input[field]![occurrence]!;
			const starts = input.starts!;
			let low = 0,
				high = starts.length - 1;
			while (low < high) {
				const mid = (low + high + 1) >>> 1;
				if (starts[mid]! <= occurrence) low = mid;
				else high = mid - 1;
			}
			numbers.package = input.paths![low]!;
			const fields = ["object", "property", "row", "package"];
			const strings = yield* reader.strings(fields.map((field) => numbers[field]!));
			for (let i = 0; i < fields.length; i++) values[fields[i]!] = strings[i]!;
			values.key = "";
			unitIds.add(occurrenceUnitId(values, numbers, meta.input.projectRoot));
		}
		const identity =
			unitIds.size && decoded.key![row - start] === ""
				? null
				: LocalizationIdentity.make({
						namespace: TextNamespace.make(decoded.namespace![row - start]!),
						key: TextKey.make(decoded.key![row - start]!)
					});
		const key =
			identity === null
				? `unresolved:${[...unitIds][0]}`
				: JSON.stringify([identity.namespace, identity.key]);
		const id = LocalizationLineId.make(`${target.name}:${key}`);
		const manifest: ManifestEntry[] = [];
		for (let i = columns.manifest_start![row]!; i < columns.manifest_end![row]!; i++) {
			manifest.push(
				yield* Schema.decodeUnknownEffect(ManifestEntry)(
					yield* entry(target.outputPaths.manifest!, manifestRows[i]!)
				)
			);
		}
		const cultures: LocalizationLine["cultures"][number][] = [];
		for (let ci = 0; ci < target.cultures.length; ci++) {
			const culture = target.cultures[ci]!,
				values = marks[ci]!;
			let archive: ArchiveEntry | null = null,
				po: POEntry | null = null;
			if (values.archive![row])
				archive = yield* Schema.decodeUnknownEffect(ArchiveEntry)(
					yield* entry(target.outputPaths.archives[culture]!, values.archive![row]! - 1)
				);
			if (values.po![row])
				po = yield* Schema.decodeUnknownEffect(POEntry)(
					yield* entry(target.outputPaths.portableObjects[culture]!, values.po![row]! - 1)
				);
			const state = localizationStates[values.state![row]!];
			snapshotCheck(state !== undefined, "join.state", "Invalid culture state");
			const facts = localizationStates.filter(
				(_, index) => values.facts![row]! & (1 << index)
			);
			const reviewStatus = values.review![row]!,
				record = meta.input.review?.records[values.review_record![row]! - 1];
			const review =
				reviewStatus < 2
					? { status: "not_reviewed" as const }
					: {
							status:
								reviewStatus === 2 ? ("current" as const) : ("changed" as const),
							flags: record!.flags,
							by: record!.by,
							at: record!.at
						};
			cultures.push({
				culture,
				state,
				facts,
				unknownReasons: LocalizationUnknownReason.literals.filter(
					(_, index) => values.reasons![row]! & (1 << index)
				),
				reducedSourceChecking: meta.reducedSourceChecking[ci]!,
				archive,
				po,
				poTranslation: facts.includes("not_synced") ? (po?.msgstr["0"] ?? "") : null,
				...(reviewStatus ? { review } : undefined)
			});
		}
		const change = columns.key_change![row]!,
			pair = meta.pairs[(change >>> 1) - 1];
		lines.push({
			id,
			identity,
			source: decoded.source![row - start]!,
			manifest,
			cultures,
			origin: unitIds.size
				? { kind: "corpus", unitIds: [...unitIds].sort().map((id) => TextUnitId.make(id)) }
				: {
						kind: "evidence",
						id: LocalizationEvidenceLineId.make(`evidence:${target.name}:${key}`)
					},
			...(pair
				? {
						keyChange: {
							direction: change & 1 ? ("from" as const) : ("to" as const),
							other: change & 1 ? pair.to : pair.from,
							match: pair.match,
							sourceChanged: pair.sourceChanged,
							previousSource: pair.previousSource,
							translations: pair.translations
						}
					}
				: undefined)
		});
	}
	return {
		schemaVersion: 1,
		target: target.name,
		nativeCulture: target.nativeCulture,
		cultures: target.cultures,
		lines
	} satisfies LocalizationJoin;
});

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
		if (name.startsWith("line.") || /^c\d+\./u.test(name))
			snapshotCheck(values.length === meta.count, name, "Incomplete line column");
		if (record.stringColumns[name])
			for (const id of values) snapshotCheck(id < limit, name, "ID outside dictionary");
		snapshotCheck(entry.count === values.length, name, "Count differs");
	}
	for (const name of new Set([
		...Object.keys(meta.aliases),
		...Object.keys(meta.patches ?? {})
	])) {
		const values = yield* u32(layer, name);
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
		["line.problems", 127],
		["line.reasons", 131071],
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
			["reasons", 131071],
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
	snapshotCheck(fileCoveredLines === meta.count, "join.files", "Incomplete file facets");
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
		coveredLines === meta.count,
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
			(count, bits) => count + Number(Boolean(bits & ((1 << 9) | (1 << 10)))),
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
