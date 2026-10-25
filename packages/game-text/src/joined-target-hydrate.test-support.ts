import { Effect } from "effect";
import {
	ManifestEntry,
	ArchiveEntry,
	POEntry,
	LocalizationIdentity,
	TextKey,
	TextNamespace
} from "@ue-shed/localization";
import { snapshotCheck } from "./snapshot-format.js";
import { decodeLocalizationSnapshot } from "./localization-columns.js";
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
import { TEXT_OUT_OF_SCOPE_REASONS, textAudienceOfMask } from "./text-audience.js";
import { u32, type ColumnReader } from "./joined-target-input.js";

import { relative, resolve } from "node:path";
import type { JoinedTargetReader } from "./joined-target-reader.js";

/*
 * Whole-line hydration of a joined layer, for the reference oracles and the join tests that
 * compare whole lines. Production reads lines through the engine.
 */
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
