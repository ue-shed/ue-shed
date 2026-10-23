import { Effect } from "effect";
import {
	LocalizationIdentity,
	TextKey,
	TextNamespace,
	type CultureCode,
	type LocalizationTargetEvidence
} from "@ue-shed/localization";
import {
	checkLocalizationGroups,
	compareLocalizationFindings,
	compareReportedLocalizationFindings,
	enabledLocalizationChecks,
	localizationDuplicateSources,
	localizationDuplicatePlaces,
	localizationPropertiesWhereLocalizable,
	localizationPropertyKey,
	localizationRuleContext,
	invariantTextPlace,
	localizationTranslationVariants,
	reportableInvariantText,
	type LocalizationLineCheckContext
} from "./localization-checks.js";
import type {
	LocalizationCheckDiagnostic,
	LocalizationCheckOptions,
	LocalizationCustomFinding,
	LocalizationPolicyFinding,
	LocalizationQualityFinding
} from "./localization-quality-schema.js";
import { localizationPolicyRules } from "./localization-policy.js";
import { customLocalizationChecks } from "./localization-custom-checks.js";
import { acceptedFindingFilter } from "./localization-review.js";
import {
	LocalizationUnknownReason,
	localizationStates,
	type LocalizationLine
} from "./localization-schema.js";
import {
	consistentTranslationCandidate,
	sharedSourceCandidate
} from "./localization-text-shape.js";
import {
	BuiltInQualityFilter,
	WorkspaceQualityFilter,
	customQualityFilter,
	eligibleLocalizationChange,
	localizationFindingHash,
	workspaceQualityFilterOf,
	workspaceQualityItem,
	type LocalizationFindingGroup,
	type LocalizationFindingList,
	type LocalizationQuality
} from "./localization-workspace.js";
import { gatheredIdentity, gatheredIdentityKey, localizationLineUnits } from "./gathered-text.js";
import { IndexedPolicyData } from "./indexed-policy-data.js";
import { u32 } from "./joined-target-input.js";
import { runJoinedQuery } from "./joined-query-node.js";
import type { JoinedTargetReader } from "./joined-target-reader.js";
import { translateRuleDocument } from "./rules/translate.js";
import type { NativeFindings } from "./native-findings.js";
import type { GameTextRuleDocument } from "./game-text-rules.js";
import type { TextQualityRuleId } from "./quality-schema.js";
import { CheckSeverity } from "./localization-check-ids.js";
import {
	localizationRuleId,
	type InconsistentTranslationParams
} from "./localization-check-catalogue.js";
import type { TextCorpus, TextUnit, TextUnitId } from "./schema.js";
import { snapshotCheck } from "./snapshot-format.js";
import { decodeTextAudience } from "./text-audience.js";
import { encodeWtf8 } from "./wtf8.js";
import { GameTextIndexProgressReporter } from "./index-progress.js";
import { StageClock } from "./stage-clock.js";

/**
 * Lines hydrated and checked per scan page; the scan yields after each. Measured on 583,507
 * lines and 10 cultures, the longest event-loop stall was 0.5–0.7 s at 256 lines, 1.0 s at 512
 * and 2.6 s at 2048, for a scan 10% longer than at 2048 (114 s against 104 s). Yielding inside
 * 2048-line pages still stalled 2.0 s: hydrating the page is one synchronous block.
 */
const SCAN_PAGE_LINES = 256;
/**
 * Pages shrink while checking one takes longer than this, down to `MINIMUM_PAGE_LINES`, and grow
 * back to `SCAN_PAGE_LINES` when it is quick. On a shipped project 256-line pages took about
 * 0.5 s and some stretches of lines 1–1.8 s. A 200 ms budget with 16-line pages kept every stall
 * under 1 s but made the scan 60% longer: small pages decompress the same string blocks again.
 */
const PAGE_BUDGET_MS = 500;
const MINIMUM_PAGE_LINES = 64;

/** The next page's size after a page of `lines` took `elapsed` milliseconds. */
function nextPageLines(lines: number, elapsed: number): number {
	if (elapsed > PAGE_BUDGET_MS) return Math.max(MINIMUM_PAGE_LINES, lines >>> 1);
	if (elapsed < PAGE_BUDGET_MS / 4) return Math.min(SCAN_PAGE_LINES, lines * 2);
	return lines;
}
/** Positions hydrated per batch when a workspace reads many findings, as an export does. */
const ITEM_BATCH = 2048;

type Finding = LocalizationQualityFinding | LocalizationPolicyFinding | LocalizationCustomFinding;

/**
 * Check options of an indexed quality scan. Progress goes to `GameTextIndexProgressReporter`:
 * a `localization_quality` event before the scan with no lines checked, then after each page of
 * lines, the last with every line checked and the scan's finding count (accepted findings left
 * out).
 */
export type IndexedLocalizationQualityOptions = LocalizationCheckOptions;

/** Growable u32 column; scans append, then trim. */
function u32Builder() {
	let values = new Uint32Array(4096),
		length = 0;
	return {
		get length() {
			return length;
		},
		at: (index: number) => values[index]!,
		push(value: number) {
			if (length === values.length) {
				const next = new Uint32Array(values.length * 2);
				next.set(values);
				values = next;
			}
			values[length++] = value;
		}
	};
}

function fnv32(bytes: Uint8Array, start: number, end: number) {
	let hash = 0x811c9dc5;
	for (let index = start; index < end; index++)
		hash = Math.imul(hash ^ bytes[index]!, 0x01000193);
	return hash >>> 0;
}

/** Unit rows by ID through a hash of the ID column; never builds the unit list. */
function unitIndex(data: IndexedPolicyData) {
	/** Strings of the occurrences the column predicates read, by ID. */
	const decoded = new Map<number, string>();
	/** Gathered identity keys by namespace, key and String Table entry. */
	const gatheredKeys = new Map<string, string>();
	/** The shard of a global occurrence index. */
	const shardOf = (member: number) => {
		const starts = data.joined.meta.packageStarts;
		let low = 0,
			high = starts.length - 2;
		while (low < high) {
			const middle = (low + high + 1) >>> 1;
			if (starts[middle]! <= member) low = middle;
			else high = middle - 1;
		}
		return low;
	};
	/**
	 * Visits each occurrence `localizationLineUnits` keeps for the line, without building units:
	 * a resolved occurrence is kept when its gathered identity is the line's. Stops when `visit`
	 * returns true.
	 */
	const eachKept = (
		line: LocalizationLine,
		visit: (column: (field: string) => number) => boolean
	) => {
		if (line.origin.kind !== "corpus") return;
		const lineKey = line.identity && gatheredIdentityKey(line.identity);
		for (const id of line.origin.unitIds) {
			const row = find(id);
			if (row === undefined) continue;
			for (const member of data.members("raw", row)) {
				const shard = shardOf(member),
					index = member - data.joined.meta.packageStarts[shard]!;
				const column = (field: string) =>
					data.packageColumn(shard, `occurrence.${field}`)[index]!;
				if (column("identity") === 0) {
					const table = column("location") === 2;
					const memo = `${column("namespace")}\0${column("key")}\0${table}`;
					let gathered = gatheredKeys.get(memo);
					if (gathered === undefined) {
						// A resolved identity without a key is unresolved: kept, as "".
						const [namespace, key] = data.strings([column("namespace"), column("key")]);
						gathered =
							key === ""
								? ""
								: gatheredIdentityKey(gatheredIdentity(namespace!, key!, table));
						if (gatheredKeys.size >= MEMO_LIMIT) gatheredKeys.clear();
						gatheredKeys.set(memo, gathered);
					}
					if (gathered !== "" && gathered !== lineKey) continue;
				}
				if (visit(column)) return;
			}
		}
	};
	const idRows = data.column("query.raw.raw"),
		starts = data.column("query.raw.id_starts"),
		words = data.column("query.raw.id_utf8");
	const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength);
	const hashes = new Uint32Array(idRows.length);
	for (let row = 0; row < idRows.length; row++)
		hashes[row] = fnv32(bytes, starts[idRows[row]!]!, starts[idRows[row]! + 1]!);
	const order = Uint32Array.from(hashes.keys()).sort((a, b) => hashes[a]! - hashes[b]!);
	const find = (id: string): number | undefined => {
		const wanted = encodeWtf8(id),
			hash = fnv32(wanted, 0, wanted.length);
		let low = 0,
			high = order.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (hashes[order[middle]!]! < hash) low = middle + 1;
			else high = middle;
		}
		for (; low < order.length && hashes[order[low]!] === hash; low++) {
			const row = order[low]!,
				start = starts[idRows[row]!]!;
			if (starts[idRows[row]! + 1]! - start !== wanted.length) continue;
			let index = 0;
			while (index < wanted.length && bytes[start + index] === wanted[index]) index++;
			if (index === wanted.length) return row;
		}
		return undefined;
	};
	return {
		find,
		/** The units a line names, keyed the way `localizationLineUnits` looks them up. */
		forLine(line: LocalizationLine): ReadonlyMap<TextUnitId, TextUnit> {
			const units = new Map<TextUnitId, TextUnit>();
			if (line.origin.kind !== "corpus") return units;
			for (const id of line.origin.unitIds) {
				const row = find(id);
				if (row !== undefined) units.set(id, data.unit("raw", row));
			}
			return units;
		},
		idRow: (row: number) => idRows[row]!,
		/** Drops the string memos; pages and focus after the scan read few lines. */
		releaseMemos() {
			decoded.clear();
			gatheredKeys.clear();
		},
		/** Whether a kept occurrence has translator notes; as over `forLine`'s units. */
		occurrenceNotes(line: LocalizationLine): boolean {
			let found = false;
			eachKept(line, (column) => (found = text(column("notes")).trim().length > 0));
			return found;
		},
		/** The String Tables of the kept String Table entries, sorted; as over `forLine`'s units. */
		stringTables(line: LocalizationLine): string[] {
			const tables = new Set<string>();
			eachKept(line, (column) => {
				if (column("location") === 2) tables.add(text(column("object")));
				return false;
			});
			return [...tables].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		},
		/**
		 * The units a line names hold only culture-invariant occurrences and one of them is
		 * `reportableInvariantText`, read from the occurrence columns without building the units;
		 * as `localizationCultureInvariantUnits` and `reportableInvariantText` over `forLine`.
		 * Lines of thousands of invariant occurrences, such as a label every level repeats, are
		 * answered without building thousands of occurrences.
		 */
		cultureInvariant(
			line: LocalizationLine,
			localizableProperties: ReadonlySet<string>
		): boolean {
			if (line.origin.kind !== "corpus") return false;
			const starts = data.joined.meta.packageStarts;
			let found = false,
				reportable = false;
			for (const id of line.origin.unitIds) {
				const row = find(id);
				if (row === undefined) continue;
				for (const member of data.members("raw", row)) {
					let low = 0,
						high = starts.length - 2;
					while (low < high) {
						const middle = (low + high + 1) >>> 1;
						if (starts[middle]! <= member) low = middle;
						else high = middle - 1;
					}
					const shard = low,
						index = member - starts[shard]!;
					if (
						data.packageColumn(shard, "occurrence.identity")[index] !==
						CULTURE_INVARIANT
					)
						return false;
					found = true;
					reportable ||= placeReportable(shard, index, localizableProperties);
				}
			}
			return found && reportable;
		}
	};
	/** `reportableInvariantText` of one stored occurrence, its strings decoded once each. */
	function placeReportable(
		shard: number,
		index: number,
		localizableProperties: ReadonlySet<string>
	): boolean {
		const column = (field: string) => data.packageColumn(shard, `occurrence.${field}`)[index]!;
		const kind = column("location");
		if (kind === 2) return false;
		const audience = decodeTextAudience(column("audience")).audience;
		if (audience === "editor") return false;
		const objectPath = text(column("object")),
			propertyPath = text(column("property"));
		return reportableInvariantText(
			{
				audience,
				location:
					kind === 0
						? {
								kind: "asset_property",
								objectPath,
								classPath: text(column("class")),
								propertyPath
							}
						: { kind: "data_table_cell", objectPath, row: "", propertyPath }
			},
			localizableProperties
		);
	}
	function text(id: number): string {
		let value = decoded.get(id);
		if (value === undefined) {
			if (decoded.size >= MEMO_LIMIT) decoded.clear();
			decoded.set(id, (value = data.strings([id])[0]!));
		}
		return value;
	}
}

/** Entries a scan's string memos keep before starting over. */
const MEMO_LIMIT = 65_536;

/** The occurrence identity column's code for culture-invariant text. */
const CULTURE_INVARIANT = 2;

/** Positions of rows outside the join. */
const NOT_JOINED = 0xffffffff;

const CONFLICTING_SOURCE = 1 << LocalizationUnknownReason.literals.indexOf("conflicting_source");

/**
 * Groups duplicate sources from line columns and shared strings, without hydrating lines. Only
 * the join's rows count, and identities that compare equal keep the join's order. Also returns
 * the rows of every shared line, for the translation pass.
 */
const duplicateSources = Effect.fn("GameText.localizationQuality.duplicates")(function* (
	data: IndexedPolicyData,
	cultures: readonly CultureCode[],
	joinPosition: Uint32Array
) {
	const column = (name: string) => runJoinedQuery(u32(data.joined.layer, name));
	const namespaces = column("line.namespace"),
		keys = column("line.key"),
		sources = column("line.source"),
		reasons = column("line.reasons"),
		occurrenceStart = column("line.occ_start"),
		occurrenceEnd = column("line.occ_end");
	const states = cultures.map((_, index) => column(`c${index}.state`));
	const outside = localizationStates.indexOf("outside_target");
	const groups = localizationDuplicateSources();
	const count = data.joined.meta.count;
	for (let start = 0; start < count; start += SCAN_PAGE_LINES) {
		const end = Math.min(count, start + SCAN_PAGE_LINES);
		const text = data.strings(Array.from(sources.subarray(start, end))),
			key = data.strings(Array.from(keys.subarray(start, end))),
			namespace = data.strings(Array.from(namespaces.subarray(start, end)));
		for (let row = start; row < end; row++) {
			const index = row - start;
			if (joinPosition[row] === NOT_JOINED) continue;
			// The same conditions as `localizationDuplicateCandidate` on a hydrated line.
			if (occurrenceEnd[row]! > occurrenceStart[row]! && key[index] === "") continue;
			if (text[index]!.trim().length === 0) continue;
			if (!sharedSourceCandidate(text[index]!)) continue;
			if (reasons[row]! & CONFLICTING_SOURCE) continue;
			if (states.every((state) => state[row] === outside)) continue;
			groups.add(
				text[index]!,
				LocalizationIdentity.make({
					namespace: TextNamespace.make(namespace[index]!),
					key: TextKey.make(key[index]!)
				}),
				joinPosition[row]!,
				row,
				() => {
					// The places `localizationDuplicatePlaces` finds, from the location columns.
					if (occurrenceEnd[row]! === occurrenceStart[row]!)
						return localizationDuplicatePlaces(data.line(row), []);
					const places: string[] = [];
					const members = data.column("occurrence.rows");
					for (let offset = occurrenceStart[row]!; offset < occurrenceEnd[row]!; offset++)
						places.push(data.occurrencePlace(members[offset]!));
					return places;
				}
			);
		}
		yield* Effect.yieldNow;
	}
	return groups.finish();
});

/** Rows whose translations the second pass reads before yielding. */
const TRANSLATION_PAGE_ROWS = 4096;

/**
 * The bounded second pass for `inconsistent_translation`: reads only the lines that share a
 * source, and only their state, facts and shipped translation columns, as line previews do;
 * hydrating these scattered rows as lines took a page per row. Each culture's shipped translation
 * is the pending PO text when the culture is `not_synced`, otherwise the archive translation, as
 * `localizationShippedTranslation` picks it on a hydrated line.
 */
const translationVariants = Effect.fn("GameText.localizationQuality.translations")(function* (
	data: IndexedPolicyData,
	shared: Parameters<typeof localizationTranslationVariants>[0],
	rows: readonly number[],
	rowSources: readonly string[],
	params: InconsistentTranslationParams
) {
	const target = data.joined.meta.input.target;
	const variants = localizationTranslationVariants(shared, target.nativeCulture, params);
	const outside = localizationStates.indexOf("outside_target"),
		notSynced = 1 << localizationStates.indexOf("not_synced");
	const cultures = target.cultures.flatMap((culture, index) =>
		culture === target.nativeCulture
			? []
			: [
					{
						culture,
						state: data.column(`c${index}.state`),
						facts: data.column(`c${index}.facts`),
						archive: data.column(`c${index}.archive`),
						po: data.column(`c${index}.po`),
						archives: target.outputPaths.archives[culture]!,
						portableObjects: target.outputPaths.portableObjects[culture]!
					}
				]
	);
	for (let start = 0; start < rows.length; start += TRANSLATION_PAGE_ROWS) {
		const ids: number[] = [],
			sources: string[] = [],
			names: CultureCode[] = [];
		for (
			let index = start;
			index < Math.min(rows.length, start + TRANSLATION_PAGE_ROWS);
			index++
		) {
			const row = rows[index]!,
				source = rowSources[index]!;
			if (!consistentTranslationCandidate(source, params)) continue;
			for (const culture of cultures) {
				if (culture.state[row] === outside) continue;
				const pending = (culture.facts[row]! & notSynced) !== 0,
					entry = pending ? culture.po[row]! : culture.archive[row]!;
				if (!entry) continue;
				const id = pending
					? data.translationId(culture.portableObjects, entry - 1, true)
					: data.translationId(culture.archives, entry - 1);
				if (id === undefined) continue;
				ids.push(id);
				sources.push(source);
				names.push(culture.culture);
			}
		}
		const translations = data.strings(ids);
		for (let index = 0; index < ids.length; index++)
			variants.addTranslation(sources[index]!, names[index]!, translations[index]!);
		yield* Effect.yieldNow;
	}
	return variants.finish();
});

/** Occurrences whose identity and owner columns the property pass reads before yielding. */
const PROPERTY_PAGE_ROWS = 16_384;

/**
 * `localizationLocalizableProperties` from the package occurrence columns, in two passes over
 * the identity, location and owner columns. The first counts culture-invariant occurrences by
 * owner (class or DataTable) and property. The second counts keyed and String Table occurrences,
 * only in owners the first found; their keys are decoded, as `textOccurrenceFromExtraction`
 * leaves a resolved identity without a key unresolved. Owner and property strings are decoded once
 * each.
 */
const localizableProperties = Effect.fn("GameText.localizationQuality.properties")(function* (
	data: IndexedPolicyData
) {
	const starts = data.joined.meta.packageStarts;
	const shardColumns = (shard: number) => ({
		audience: data.packageColumn(shard, "occurrence.audience"),
		identity: data.packageColumn(shard, "occurrence.identity"),
		location: data.packageColumn(shard, "occurrence.location"),
		classes: data.packageColumn(shard, "occurrence.class"),
		objects: data.packageColumn(shard, "occurrence.object"),
		properties: data.packageColumn(shard, "occurrence.property"),
		keys: data.packageColumn(shard, "occurrence.key")
	});
	/** A class ID times two, or a DataTable object ID times two plus one. */
	const ownerOf = (columns: ReturnType<typeof shardColumns>, row: number) =>
		columns.location[row] === 0 ? columns.classes[row]! * 2 : columns.objects[row]! * 2 + 1;
	const ownerStrings = new Map<number, string>(),
		propertyStrings = new Map<number, string>(),
		objectStrings = new Map<number, string>();
	const decode = (ids: Iterable<number>, into: Map<number, string>, owners: boolean) => {
		const missing = [...new Set(ids)].filter((id) => !into.has(id));
		const values = data.strings(
			owners ? missing.map((owner) => Math.floor(owner / 2)) : missing
		);
		missing.forEach((id, index) => into.set(id, values[index]!));
	};
	const keyOf = (owner: number, property: number) =>
		localizationPropertyKey(
			owner % 2 === 0
				? {
						kind: "asset_property",
						objectPath: "",
						classPath: ownerStrings.get(owner)!,
						propertyPath: propertyStrings.get(property)!
					}
				: {
						kind: "data_table_cell",
						objectPath: ownerStrings.get(owner)!,
						row: "",
						propertyPath: propertyStrings.get(property)!
					}
		)!;
	const invariant = new Map<string, number>(),
		localizable = new Map<string, number>(),
		invariantOwners = new Set<number>();
	for (const counting of ["invariant", "localizable"] as const)
		for (let shard = 0; shard + 1 < starts.length; shard++) {
			if (starts[shard + 1] === starts[shard]) continue;
			const columns = shardColumns(shard);
			for (let start = 0; start < columns.identity.length; start += PROPERTY_PAGE_ROWS) {
				const owners: number[] = [],
					names: number[] = [],
					keyIds: number[] = [],
					/** Invariant occurrences: object string ID, or -1 for editor text. */
					places: number[] = [];
				const end = Math.min(columns.identity.length, start + PROPERTY_PAGE_ROWS);
				for (let row = start; row < end; row++) {
					// String Table entries (location 2) have no property.
					const identity = columns.identity[row]!;
					if (columns.location[row]! > 1) continue;
					if (counting === "invariant" ? identity !== CULTURE_INVARIANT : identity > 1)
						continue;
					const owner = ownerOf(columns, row);
					if (counting === "localizable" && !invariantOwners.has(owner)) continue;
					if (counting === "invariant") {
						const editor =
							decodeTextAudience(columns.audience[row]!).audience === "editor";
						if (editor) continue;
						places.push(columns.objects[row]!);
					}
					owners.push(owner);
					names.push(columns.properties[row]!);
					keyIds.push(columns.keys[row]!);
				}
				decode(owners, ownerStrings, true);
				decode(names, propertyStrings, false);
				if (counting === "invariant") {
					decode(places, objectStrings, false);
					for (let index = 0; index < owners.length; index++) {
						const owner = owners[index]!,
							propertyPath = propertyStrings.get(names[index]!)!,
							objectPath = objectStrings.get(places[index]!)!;
						// Editor text was left out above; the audience no longer matters.
						const place = invariantTextPlace({
							audience: "unknown",
							location:
								owner % 2 === 0
									? {
											kind: "asset_property",
											objectPath,
											classPath: ownerStrings.get(owner)!,
											propertyPath
										}
									: { kind: "data_table_cell", objectPath, row: "", propertyPath }
						});
						if (!place) continue;
						invariantOwners.add(owner);
						const key = keyOf(owner, names[index]!);
						invariant.set(key, (invariant.get(key) ?? 0) + 1);
					}
				} else {
					const wanted = owners.flatMap((owner, index) =>
						invariant.has(keyOf(owner, names[index]!)) ? [index] : []
					);
					const keys = data.strings(wanted.map((index) => keyIds[index]!));
					wanted.forEach((index, position) => {
						if (keys[position] === "") return;
						const key = keyOf(owners[index]!, names[index]!);
						localizable.set(key, (localizable.get(key) ?? 0) + 1);
					});
				}
				yield* Effect.yieldNow;
			}
		}
	return localizationPropertiesWhereLocalizable(invariant, localizable);
});

/**
 * Localization quality over a joined index. Lines are checked in bounded pages and dropped;
 * findings are kept as columns. Pages, focus and proposals re-check only the rows they show, with
 * the same persisted native findings and corpus group checks. The scan yields between pages, so a host
 * keeps serving other requests and can interrupt it.
 *
 * `joinRows` are the join's lines as rows of `joined`, in the join's order: the rows the query's
 * `localizationLines` returns for the target. Only they are checked, as only they are in the join.
 */
export const indexedLocalizationQuality = Effect.fn("GameText.localizationQuality")(function* (
	joined: JoinedTargetReader,
	corpus: Pick<TextCorpus, "status" | "coverage">,
	evidence: LocalizationTargetEvidence,
	joinRows: Uint32Array,
	ruleDocument: GameTextRuleDocument | undefined,
	options: IndexedLocalizationQualityOptions,
	native: NativeFindings
) {
	const reportProgress = yield* GameTextIndexProgressReporter;
	const report = (completed: number, findings: number) =>
		reportProgress({
			phase: "localization_quality",
			completed,
			total: joinRows.length,
			findings
		});
	report(0, 0);
	const stages = new StageClock();
	const data = new IndexedPolicyData(joined);
	const target = data.joined.meta.input.target;
	const join = {
		target: target.name,
		nativeCulture: target.nativeCulture,
		cultures: target.cultures
	};
	const evaluated = yield* native.findingsEvaluate(translateRuleDocument(ruleDocument, options));
	const enabled = enabledLocalizationChecks(join, evidence, options, ruleDocument);
	const policy =
		ruleDocument !== undefined && ruleDocument.schemaVersion !== 1
			? localizationPolicyRules(target.cultures, ruleDocument)
			: undefined;
	const keep = acceptedFindingFilter(options.review);
	const customChecks = customLocalizationChecks(ruleDocument);
	const count = data.joined.meta.count,
		lineCount = joinRows.length;
	const joinPosition = new Uint32Array(count).fill(NOT_JOINED);
	for (let position = 0; position < lineCount; position++)
		joinPosition[joinRows[position]!] = position;
	const duplicates = yield* duplicateSources(data, target.cultures, joinPosition);
	const ruleContext = localizationRuleContext(ruleDocument);
	const context: LocalizationLineCheckContext = {
		target: target.name,
		nativeCulture: target.nativeCulture,
		options,
		enabled,
		duplicates: duplicates.shared,
		translations: enabled.includes("inconsistent_translation")
			? yield* translationVariants(
					data,
					duplicates.shared,
					duplicates.rows,
					duplicates.rowSources,
					ruleContext.checks.inconsistent_translation.params
				)
			: new Map(),
		...ruleContext,
		localizableProperties: enabled.includes("culture_invariant_text")
			? yield* localizableProperties(data)
			: new Set(),
		cultureInvariant: (line) => units.cultureInvariant(line, context.localizableProperties)
	};
	stages.mark("prepare");
	const units = unitIndex(data);
	yield* Effect.yieldNow;
	stages.mark("units");

	// Report order is line ID order, ties in join order. Decoding every line ID takes about 0.7 s
	// at 583,507 lines, so it yields per page; the unit index above and the sort below take about
	// 0.25 s and 0.1 s.
	const ids: string[] = [];
	for (let start = 0; start < lineCount; start += SCAN_PAGE_LINES) {
		const end = Math.min(lineCount, start + SCAN_PAGE_LINES);
		for (let position = start; position < end; position++)
			ids[position] = data.lineId(joinRows[position]!);
		yield* Effect.yieldNow;
	}
	const collator = new Intl.Collator();
	// Stable, so lines whose IDs compare equal keep the join's order.
	const sorted = Array.from({ length: lineCount }, (_, position) => position).sort((a, b) =>
		collator.compare(ids[a]!, ids[b]!)
	);
	yield* Effect.yieldNow;
	/** Rows by rank in report order. */
	const order = Uint32Array.from(sorted, (position) => joinRows[position]!);
	/**
	 * Lines whose ID compares equal to the previous line's, as canonically equivalent keys do.
	 * The report interleaves such lines by culture and check, so each run of them is one block,
	 * checked and stored together and known by its first rank. Nearly every block is one line.
	 */
	const tied = new Uint8Array(lineCount);
	for (let start = 1; start < lineCount; start += SCAN_PAGE_LINES * 16) {
		const end = Math.min(lineCount, start + SCAN_PAGE_LINES * 16);
		for (let rank = start; rank < end; rank++)
			if (collator.compare(ids[sorted[rank - 1]!]!, ids[sorted[rank]!]!) === 0)
				tied[rank] = 1;
		yield* Effect.yieldNow;
	}
	// A suspended generator keeps its locals; release the IDs before the long scan.
	ids.length = 0;
	sorted.length = 0;
	const rankOf = new Uint32Array(count);
	for (let rank = 0; rank < lineCount; rank++) rankOf[order[rank]!] = rank;
	stages.mark("order");
	const blockEnd = (first: number) => {
		let end = first + 1;
		while (end < lineCount && tied[end]) end++;
		return end;
	};
	const lineOf = (lines: readonly LocalizationLine[], finding: Finding) =>
		lines.length === 1 ? lines[0]! : lines.find((line) => line.id === finding.lineId)!;

	/**
	 * One block's findings in report order, and each line's check diagnostics. As the report does,
	 * built-ins sort first and policy findings follow rule by rule over the lines; accepted findings
	 * then leave and the rest sort as reported. Both sorts are stable.
	 */
	const readFindings = Effect.fn("GameText.localizationQuality.readFindings")(function* (
		rows: readonly number[]
	) {
		const result = new Map<
			number,
			Effect.Success<ReturnType<NativeFindings["findingsLines"]>>[number]
		>();
		for (let start = 0; start < rows.length; start += 5000)
			for (const line of yield* native.findingsLines(
				evaluated.key,
				rows.slice(start, start + 5000)
			))
				result.set(line.row, line);
		return result;
	});
	const check = (
		lines: readonly LocalizationLine[],
		rows: readonly number[],
		checked: Effect.Success<ReturnType<typeof readFindings>>
	) => {
		const builtIns: LocalizationQualityFinding[] = [];
		const diagnostics: LocalizationCheckDiagnostic[][] = [];
		const selected = <F extends { readonly culture: CultureCode }>(findings: readonly F[]) =>
			findings.filter((finding) => !options.culture || finding.culture === options.culture);
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]!,
				nativeLine = checked.get(rows[index]!)!;
			builtIns.push(...selected(nativeLine.builtIns));
			checkLocalizationGroups(
				line,
				() => localizationLineUnits(line, units.forLine(line)),
				context,
				builtIns
			);
			diagnostics.push(selected(nativeLine.diagnostics));
		}
		const family = (name: "policy" | "custom") => {
			const findings = rows.flatMap((row) => selected<Finding>(checked.get(row)![name]));
			const rules =
				name === "policy"
					? (policy?.rules ?? []).map(({ rule }) => rule.id)
					: customChecks.map((custom) => custom.id);
			return findings.sort((a, b) => rules.indexOf(a.ruleId) - rules.indexOf(b.ruleId));
		};
		const findings: Finding[] = [
			...builtIns.sort(compareLocalizationFindings),
			...family("policy"),
			...family("custom")
		];
		const visible = keep
			? findings.filter((finding) => keep(lineOf(lines, finding), finding))
			: findings;
		return { findings: visible.sort(compareReportedLocalizationFindings), diagnostics };
	};

	const cultureIndex = new Map(target.cultures.map((culture, index) => [culture, index]));
	const severityIndex = new Map(
		CheckSeverity.literals.map((severity, index) => [severity, index])
	);
	/** The built-in filters, then each custom check's, in the rule file's order. */
	const filters: readonly WorkspaceQualityFilter[] = [
		...BuiltInQualityFilter.literals,
		...customChecks.map((custom) => customQualityFilter(custom.id))
	];
	const filterIndex = new Map(filters.map((filter, index) => [filter, index]));
	const ruleIds: TextQualityRuleId[] = [];
	const ruleIndex = new Map<string, number>();
	const ruleOf = (id: TextQualityRuleId) => {
		let index = ruleIndex.get(id);
		if (index === undefined) {
			index = ruleIds.push(id) - 1;
			ruleIndex.set(id, index);
		}
		return index;
	};
	// Facts per finding: culture (bits 0-11), fix eligible (12), filter (13-31). The rule has a
	// column of its own, so a rule file may hold as many rules and custom checks as it likes.
	const pack = (finding: Finding) => {
		const culture = cultureIndex.get(finding.culture)!,
			filter = filterIndex.get(workspaceQualityFilterOf(finding))!;
		snapshotCheck(
			culture < 4096 && filter < 2 ** 19,
			"quality.findings",
			"Too many cultures or filters"
		);
		return (
			(culture | (eligibleLocalizationChange(finding) ? 1 << 12 : 0) | (filter << 13)) >>> 0
		);
	};
	type Code = LocalizationCheckDiagnostic["code"];
	const limitCounts = new Map<string, Map<Code, { count: number; first: number }>>();
	const recordLimit = (scope: string, code: Code, seen: number) => {
		let codes = limitCounts.get(scope);
		if (!codes) limitCounts.set(scope, (codes = new Map()));
		const entry = codes.get(code);
		if (!entry) codes.set(code, { count: 1, first: seen });
		else {
			entry.count++;
			entry.first = Math.min(entry.first, seen);
		}
	};

	/** The blocks starting at these ranks, hydrated in one page: their lines in rank order. */
	const blockLines = (firsts: readonly number[]) => {
		const rows: number[] = [];
		for (const first of firsts)
			for (let rank = first, end = blockEnd(first); rank < end; rank++)
				rows.push(order[rank]!);
		const lines = data.lines(rows);
		let next = 0;
		return firsts.map((first) => {
			const size = blockEnd(first) - first;
			return size === 1 ? [lines[next++]!] : lines.slice(next, (next += size));
		});
	};
	const storedFacts = u32Builder(),
		/** Each finding's severity, as its index in `CheckSeverity.literals`. */
		storedSeverity = u32Builder(),
		/** Each finding's rule, as its index in `ruleIds`. */
		storedRule = u32Builder(),
		storedFirst = u32Builder(),
		storedSecond = u32Builder(),
		/** Stored findings the rule file's source terminology reports in full, ascending. */
		storedReported = u32Builder();
	const blockStart = new Uint32Array(lineCount),
		blockSize = new Uint32Array(lineCount);
	let checkedLines = 0;
	/** Checks one page of blocks, then reports progress. */
	const checkBlocks = (firsts: readonly number[]) =>
		Effect.gen(function* () {
			const hydrating = performance.now();
			const blocks = blockLines(firsts);
			const rows = firsts.map((first) => Array.from(order.subarray(first, blockEnd(first))));
			const checked = yield* readFindings(rows.flat());
			stages.add("scan.hydrate", performance.now() - hydrating);
			for (let block = 0; block < firsts.length; block++) {
				const lines = blocks[block]!,
					rank = firsts[block]!;
				const checking = performance.now();
				const { findings, diagnostics } = check(lines, rows[block]!, checked);
				stages.add("scan.check", performance.now() - checking);
				blockStart[rank] = storedFacts.length;
				blockSize[rank] = findings.length;
				for (const finding of findings) {
					const [first, second] = localizationFindingHash(finding);
					if (
						finding.kind === "placeholder_text" &&
						finding.unreportedMatches?.length === 0
					)
						storedReported.push(storedFacts.length);
					storedFacts.push(pack(finding));
					storedSeverity.push(severityIndex.get(finding.severity)!);
					storedRule.push(ruleOf(finding.ruleId));
					storedFirst.push(first);
					storedSecond.push(second);
				}
				for (let index = 0; index < lines.length; index++)
					for (let position = 0; position < diagnostics[index]!.length; position++) {
						const diagnostic = diagnostics[index]![position]!,
							seen = (rank + index) * 2 ** 20 + position;
						recordLimit("", diagnostic.code, seen);
						recordLimit(diagnostic.culture, diagnostic.code, seen);
					}
				checkedLines += lines.length;
			}
			report(checkedLines, storedFacts.length);
		});
	// One-line blocks in storage order, so each page hydrates adjacent rows. Which page a line
	// is checked in does not change its findings or their order.
	let page: number[] = [],
		pageLines = SCAN_PAGE_LINES;
	const checkPage = () =>
		Effect.gen(function* () {
			const started = performance.now();
			yield* checkBlocks(page);
			pageLines = nextPageLines(pageLines, performance.now() - started);
			page = [];
		});
	for (let row = 0; row < count; row++) {
		if (joinPosition[row] === NOT_JOINED) continue;
		const rank = rankOf[row]!;
		if (tied[rank] || (rank + 1 < lineCount && tied[rank + 1])) continue;
		page.push(rank);
		if (page.length < pageLines) continue;
		yield* checkPage();
		yield* Effect.yieldNow;
	}
	// Then the rare blocks of several lines.
	for (let rank = 0; rank + 1 < lineCount; rank++) {
		if (tied[rank] || !tied[rank + 1]) continue;
		page.push(rank);
		if (page.length < pageLines) continue;
		yield* checkPage();
		yield* Effect.yieldNow;
	}
	if (page.length) yield* checkBlocks(page);
	units.releaseMemos();
	// The whole scan, including its yields; scan.hydrate and scan.check are parts of it.
	stages.mark("scan");
	page = [];

	const total = storedFacts.length;
	const facts = new Uint32Array(total),
		severities = new Uint8Array(total),
		rules = new Uint32Array(total),
		first = new Uint32Array(total),
		second = new Uint32Array(total),
		blockOf = new Uint32Array(total),
		blockPosition = new Uint32Array(lineCount);
	// One byte a finding, only when some placeholder is reported in full by the source rules.
	const storedIsReported = storedReported.length === 0 ? undefined : new Uint8Array(total);
	for (let index = 0; index < storedReported.length; index++)
		storedIsReported![storedReported.at(index)] = 1;
	const reportedBySource = storedIsReported && new Uint8Array(total);
	const groupSizes = new Map<number, number>();
	const ruleCount = Math.max(1, ruleIds.length);
	snapshotCheck(ruleCount < 2 ** 18, "quality.findings", "Too many rules");
	/** Facts, rule, severity and whether the source reports it, in one exact integer. */
	const groupKey = (position: number) =>
		((facts[position]! * ruleCount + rules[position]!) * 3 + severities[position]!) * 2 +
		(reportedBySource?.[position] ?? 0);
	let position = 0;
	for (let rank = 0; rank < lineCount; rank++) {
		if (tied[rank]) continue;
		blockPosition[rank] = position;
		const end = blockStart[rank]! + blockSize[rank]!;
		for (let stored = blockStart[rank]!; stored < end; stored++, position++) {
			facts[position] = storedFacts.at(stored);
			severities[position] = storedSeverity.at(stored);
			rules[position] = storedRule.at(stored);
			first[position] = storedFirst.at(stored);
			second[position] = storedSecond.at(stored);
			blockOf[position] = rank;
			if (reportedBySource) reportedBySource[position] = storedIsReported![stored]!;
			const key = groupKey(position);
			groupSizes.set(key, (groupSizes.get(key) ?? 0) + 1);
			if ((position & 0xffff) === 0xffff) yield* Effect.yieldNow;
		}
	}
	// Group numeric positions by immutable scan facts. Workspace pages count groups and select
	// by rank inside them, instead of revisiting millions of findings for every selection.
	const groups: LocalizationFindingGroup[] = [];
	const groupByKey = new Map<number, { positions: Uint32Array; next: number }>();
	for (const [key, size] of groupSizes) {
		const factAndRule = Math.floor(key / 6),
			fact = Math.floor(factAndRule / ruleCount);
		const positions = new Uint32Array(size);
		groups.push({
			culture: target.cultures[fact & 0xfff]!,
			filter: filters[fact >>> 13]!,
			severity: CheckSeverity.literals[Math.floor(key / 2) % 3]!,
			ruleId: ruleIds[factAndRule % ruleCount]!,
			eligible: ((fact >>> 12) & 1) === 1,
			reportedBySource: key % 2 === 1,
			positions
		});
		groupByKey.set(key, { positions, next: 0 });
		if ((groups.length & 0x7ff) === 0) yield* Effect.yieldNow;
	}
	for (let position = 0; position < total; position++) {
		const group = groupByKey.get(groupKey(position))!;
		group.positions[group.next++] = position;
		if ((position & 0xffff) === 0xffff) yield* Effect.yieldNow;
	}
	stages.mark("columns");
	yield* Effect.annotateCurrentSpan({
		"game_text.quality.lines": lineCount,
		"game_text.quality.findings": total,
		...stages.attributes("game_text.quality.stage_ms")
	});
	const limits = new Map(
		[...limitCounts].map(([scope, codes]) => [
			scope,
			[...codes]
				.sort(([, a], [, b]) => a.first - b.first)
				.map(([code, { count }]) => ({ code, count }))
		])
	);

	/** Re-checks the blocks behind positions; each finding must hash as it did in the scan. */
	const hydrate = (positions: readonly number[]) =>
		Effect.gen(function* () {
			const firsts = [...new Set(positions.map((position) => blockOf[position]!))];
			const blocks = blockLines(firsts);
			const nativeChecked = yield* readFindings(
				firsts.flatMap((first) => Array.from(order.subarray(first, blockEnd(first))))
			);
			const checked = new Map(
				firsts.map((rank, block) => [
					rank,
					{
						lines: blocks[block]!,
						findings: check(
							blocks[block]!,
							Array.from(order.subarray(rank, blockEnd(rank))),
							nativeChecked
						).findings
					}
				])
			);
			return positions.map((position) => {
				const block = blockOf[position]!,
					{ lines, findings } = checked.get(block)!;
				const finding = findings[position - blockPosition[block]!];
				const hash = finding && localizationFindingHash(finding);
				snapshotCheck(
					finding !== undefined &&
						hash !== undefined &&
						hash[0] === first[position] &&
						hash[1] === second[position],
					"quality.findings",
					"A line no longer yields the finding its index recorded"
				);
				return workspaceQualityItem(finding, lineOf(lines, finding));
			});
		});
	let lineOfRaw: Uint32Array | undefined;
	const rowOfUnit = (id: TextUnitId) => {
		const raw = units.find(id);
		if (raw === undefined) return undefined;
		if (!lineOfRaw) {
			// Later lines win, as a map built over the join's lines would.
			const starts = data.column("query.line.starts"),
				sliceRaw = data.column("query.slice.raw");
			let size = 0;
			for (const raw of sliceRaw) size = Math.max(size, raw + 1);
			lineOfRaw = new Uint32Array(size);
			for (const row of joinRows)
				for (let slice = starts[row]!; slice < starts[row + 1]!; slice++)
					lineOfRaw[sliceRaw[slice]!] = row + 1;
		}
		const row = lineOfRaw[units.idRow(raw)];
		return row ? row - 1 : undefined;
	};
	const lineOfUnit = (id: TextUnitId) => {
		const row = rowOfUnit(id);
		return row === undefined ? undefined : data.line(row);
	};
	const sourceKeyOfUnit = (id: TextUnitId) => {
		const row = rowOfUnit(id);
		if (row === undefined) return undefined;
		// Corpus lines with an empty key have a null identity, as the hydrated line does.
		return data.strings([data.column("line.key")[row]!])[0] || undefined;
	};
	const findings: LocalizationFindingList = {
		length: total,
		groups,
		culture: (position) => target.cultures[facts[position]! & 0xfff]!,
		filter: (position) => filters[facts[position]! >>> 13]!,
		severity: (position) => CheckSeverity.literals[severities[position]!]!,
		ruleId: (position) => ruleIds[rules[position]!]!,
		eligible: (position) => ((facts[position]! >>> 12) & 1) === 1,
		reportedBySource: (position) => reportedBySource?.[position] === 1,
		find(id, culture) {
			const match = /^localization-finding:([0-9a-f]{8})([0-9a-f]{8})$/u.exec(id);
			if (!match) return undefined;
			const wantedFirst = Number.parseInt(match[1]!, 16),
				wantedSecond = Number.parseInt(match[2]!, 16);
			for (let position = 0; position < total; position++)
				if (
					first[position] === wantedFirst &&
					second[position] === wantedSecond &&
					(!culture || findings.culture(position) === culture)
				)
					return position;
			return undefined;
		},
		items: (positions) =>
			Effect.gen(function* () {
				const items = [];
				for (let start = 0; start < positions.length; start += ITEM_BATCH)
					items.push(...(yield* hydrate(positions.slice(start, start + ITEM_BATCH))));
				return items;
			}),
		limits: (culture) => limits.get(culture ?? "") ?? []
	};
	return {
		findings,
		metadata: {
			join,
			rules: [
				...(ruleDocument !== undefined && ruleDocument.schemaVersion !== 1
					? (ruleDocument.localizationRules ?? []).map((rule) => rule.id)
					: []),
				...enabled.map(localizationRuleId),
				...customChecks.map((custom) => custom.id)
			],
			...(customChecks.length
				? {
						customChecks: customChecks.map(({ id, label }) => ({ ruleId: id, label }))
					}
				: undefined),
			unsupportedRuleCultures: policy?.diagnostics.length ?? 0,
			status: corpus.status,
			coverage: corpus.coverage,
			lineOfUnit,
			sourceKeyOfUnit
		}
	} satisfies LocalizationQuality;
});
