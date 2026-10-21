import { Effect, Schema } from "effect";
import {
	LocalizationTarget,
	FileProvenance,
	LocalizationError,
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
import { keyedUnitId } from "./gathered-text.js";
import { TEXT_PROBLEMS } from "./text-problem-rules.js";
import { TEXT_OUT_OF_SCOPE_REASONS, textAudienceOfMask } from "./text-audience.js";
import { JoinedSourceCacheMeta } from "./joined-source-cache-contract.js";
import { u32, type ColumnReader } from "./joined-target-input.js";
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
		return keyedUnitId(kind === 1, values.namespace!, key, numbers.location === 2);
	const suffix =
		numbers.location === 2
			? `entry:${values.row}`
			: numbers.location === 1
				? `row:${values.row}:property:${values.property}`
				: `property:${values.property}`;
	return `occurrence:${values.object}:${suffix}:${relative(projectRoot, resolve(projectRoot, values.package!))}`;
}
import { relative, resolve } from "node:path";

type EvidenceEntry = Effect.Success<
	ReturnType<typeof decodeLocalizationSnapshot>
>["entries"][number];
/** The largest range decodeLocalizationSnapshot accepts. */
const MAX_EVIDENCE_RUN = 10000;
/** Prefetch runs read across gaps up to this many entries instead of starting a new run. */
const MAX_EVIDENCE_GAP = 64;
interface EvidenceEntryOf {
	readonly manifest: ManifestEntry;
	readonly archive: ArchiveEntry;
	readonly po: POEntry;
}
const OCCURRENCE_FIELDS = ["namespace", "key", "object", "property", "row", "identity", "location"];

/** The literals whose bits are set in `mask`, in order; a page builds these for every culture. */
function flagged<A>(literals: readonly A[], mask: number): A[] {
	const values: A[] = [];
	for (let index = 0; mask >>> index !== 0 && index < literals.length; index++)
		if (mask & (1 << index)) values.push(literals[index]!);
	return values;
}

/** Bounded hydration uses input row references, retaining all original metadata and duplicates.
 * Columns, evidence entries and strings are read once per page; the loop over lines is plain
 * synchronous code, so a large page pays no Effect or schema overhead per entry. */
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
		"key_change",
		"audience"
	])
		columns[name] = yield* u32(layer, `line.${name}`);
	const occurrenceRows = yield* u32(layer, "occurrence.rows"),
		manifestRows = yield* u32(layer, "manifest.rows");
	const decoded: Record<string, string[]> = {};
	for (const field of ["namespace", "key", "source"])
		decoded[field] = yield* reader.strings(Array.from(columns[field]!.subarray(start, end)));
	const opened = new Map<string, ColumnReader>();
	const file = Effect.fn("JoinedTarget.pageFile")(function* (name: string) {
		let value = opened.get(name);
		if (!value) {
			value = yield* reader.layer(meta.dependencies[name]!);
			opened.set(name, value);
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

	// Each evidence file's entries decode in sorted runs, once per page: decoding entry by entry
	// re-reads the file's metadata and string blocks for every entry of every culture.
	const wanted = new Map<string, number[]>();
	const want = (name: string, row: number) => {
		const rows = wanted.get(name) ?? [];
		rows.push(row);
		wanted.set(name, rows);
	};
	for (let row = start; row < end; row++) {
		for (let i = columns.manifest_start![row]!; i < columns.manifest_end![row]!; i++)
			want(target.outputPaths.manifest!, manifestRows[i]!);
		for (let ci = 0; ci < target.cultures.length; ci++) {
			const culture = target.cultures[ci]!,
				values = marks[ci]!;
			if (values.archive![row])
				want(target.outputPaths.archives[culture]!, values.archive![row]! - 1);
			if (values.po![row])
				want(target.outputPaths.portableObjects[culture]!, values.po![row]! - 1);
		}
	}
	const evidence = new Map<string, { format: string; rows: Map<number, EvidenceEntry> }>();
	for (const [name, rows] of wanted) {
		const sorted = [...new Set(rows)].sort((a, b) => a - b),
			byRow = new Map<number, EvidenceEntry>();
		let format = "";
		for (let index = 0; index < sorted.length; ) {
			const first = sorted[index]!;
			let last = index;
			while (
				last + 1 < sorted.length &&
				sorted[last + 1]! - first < MAX_EVIDENCE_RUN &&
				sorted[last + 1]! - sorted[last]! <= MAX_EVIDENCE_GAP
			)
				last++;
			const run = yield* decodeLocalizationSnapshot(
				yield* file(name),
				first,
				sorted[last]! - first + 1
			);
			format = run.format;
			for (let picked = index; picked <= last; picked++)
				byRow.set(sorted[picked]!, run.entries[sorted[picked]! - first]!);
			index = last + 1;
		}
		evidence.set(name, { format, rows: byRow });
	}
	/** A prefetched entry of a file in the given format. */
	const entry = <F extends keyof EvidenceEntryOf>(
		name: string,
		row: number,
		format: F
	): EvidenceEntryOf[F] => {
		const read = evidence.get(name),
			value = read?.rows.get(row);
		snapshotCheck(
			read?.format === format && value !== undefined,
			"join.page",
			"Missing or mismatched evidence entry"
		);
		// SAFETY: decodeLocalizationSnapshot builds every entry of a file in that file's format,
		// which the check above matched.
		// Verified by: packages/game-text/src/index-refresh.test.ts
		// ("retains readers across refresh steps updating selected inputs and review")
		return value as EvidenceEntryOf[F];
	};

	// Package shards' occurrence columns, and the strings that name units, read once per page.
	const shards = new Map<number, Record<string, Uint32Array>>();
	const located: { readonly input: Record<string, Uint32Array>; readonly row: number }[] = [];
	for (let row = start; row < end; row++)
		for (let i = columns.occ_start![row]!; i < columns.occ_end![row]!; i++) {
			const global = occurrenceRows[i]!;
			let shard = 0;
			while (meta.packageStarts[shard + 1]! <= global) shard++;
			let input = shards.get(shard);
			if (!input) {
				const packageFile = yield* file(meta.packageNames[shard]!);
				input = {};
				for (const field of OCCURRENCE_FIELDS)
					input[field] = yield* u32(packageFile, `occurrence.${field}`);
				input.starts = yield* u32(packageFile, "package.occurrence_start");
				input.paths = yield* u32(packageFile, "package.path");
				shards.set(shard, input);
			}
			located.push({ input, row: global - meta.packageStarts[shard]! });
		}
	// Keyed Unreal and String Table occurrences name their unit by namespace and key; the rest
	// by object, property, row and package path.
	const keyIds: number[] = [];
	for (const { input, row } of located)
		if (input.identity![row]! < 2) keyIds.push(input.namespace![row]!, input.key![row]!);
	const keyStrings = yield* reader.strings(keyIds);
	const unitOf: string[] = [],
		pathIds: number[] = [],
		pathOccurrences: number[] = [];
	for (let index = 0, keyed = 0; index < located.length; index++) {
		const { input, row } = located[index]!,
			identity = input.identity![row]!;
		if (identity < 2) {
			const namespace = keyStrings[keyed++]!,
				key = keyStrings[keyed++]!;
			if (key !== "") {
				unitOf.push(
					keyedUnitId(identity === 1, namespace, key, input.location![row] === 2)
				);
				continue;
			}
		}
		const starts = input.starts!;
		let low = 0,
			high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (starts[mid]! <= row) low = mid;
			else high = mid - 1;
		}
		pathIds.push(
			input.object![row]!,
			input.property![row]!,
			input.row![row]!,
			input.paths![low]!
		);
		pathOccurrences.push(index);
		unitOf.push("");
	}
	const pathStrings = yield* reader.strings(pathIds);
	for (let index = 0; index < pathOccurrences.length; index++) {
		const { input, row } = located[pathOccurrences[index]!]!;
		unitOf[pathOccurrences[index]!] = occurrenceUnitId(
			{
				object: pathStrings[index * 4]!,
				property: pathStrings[index * 4 + 1]!,
				row: pathStrings[index * 4 + 2]!,
				package: pathStrings[index * 4 + 3]!,
				key: ""
			},
			{ identity: input.identity![row]!, location: input.location![row]! },
			meta.input.projectRoot
		);
	}

	const lines: LocalizationLine[] = [];
	for (let row = start, occurrence = 0; row < end; row++) {
		const unitIds = new Set<string>();
		for (let i = columns.occ_start![row]!; i < columns.occ_end![row]!; i++)
			unitIds.add(unitOf[occurrence++]!);
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
		for (let i = columns.manifest_start![row]!; i < columns.manifest_end![row]!; i++)
			manifest.push(entry(target.outputPaths.manifest!, manifestRows[i]!, "manifest"));
		const cultures: LocalizationLine["cultures"][number][] = [];
		for (let ci = 0; ci < target.cultures.length; ci++) {
			const culture = target.cultures[ci]!,
				values = marks[ci]!;
			const archive = values.archive![row]
				? entry(target.outputPaths.archives[culture]!, values.archive![row]! - 1, "archive")
				: null;
			const po = values.po![row]
				? entry(target.outputPaths.portableObjects[culture]!, values.po![row]! - 1, "po")
				: null;
			const state = localizationStates[values.state![row]!];
			snapshotCheck(state !== undefined, "join.state", "Invalid culture state");
			const facts = flagged(localizationStates, values.facts![row]!);
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
				unknownReasons: flagged(LocalizationUnknownReason.literals, values.reasons![row]!),
				reducedSourceChecking: meta.reducedSourceChecking[ci]!,
				archive,
				po,
				poTranslation: facts.includes("not_synced") ? (po?.msgstr["0"] ?? "") : null,
				...(reviewStatus ? { review } : undefined)
			});
		}
		const change = columns.key_change![row]!,
			pair = meta.pairs[(change >>> 1) - 1];
		const audience = columns.audience![row]!,
			outOfScope = TEXT_OUT_OF_SCOPE_REASONS[(audience >>> 4) - 1];
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
				: undefined),
			audience: textAudienceOfMask(audience),
			...(outOfScope === undefined ? undefined : { outOfScope })
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
