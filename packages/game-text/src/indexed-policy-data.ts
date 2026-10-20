import {
	SavedAssetPackageTextEvent,
	type SavedAssetMissingGatherableText,
	type SavedAssetPackageTextRecord,
	type SavedAssetTextCoverageGap
} from "@ue-shed/unreal-assets";
import { decodeWtf8, encodeWtf8 } from "./wtf8.js";
import { relative, resolve } from "node:path";
import { Cache, Effect, Schema } from "effect";
import { textOccurrenceFromExtraction, textCorpusFromExtractionEvents } from "./corpus.js";
import { emptyPackageTextRecord } from "./package-text-record.js";
import {
	packageTextGapReasons,
	decodePackageTextColumns,
	decodeStoredCopy,
	occurrenceCopyCount
} from "./package-text-columns.js";
import { textCorpusWithExcludedPackages } from "./package-text-candidates.js";
import { comparePackageTextPathBytes } from "./package-text-order.js";
import { TextUnitId } from "./identifiers.js";
import { duplicateOccurrencePlace } from "./duplicate-sources.js";
import { hydrateJoinedTarget, type JoinedTargetReader } from "./joined-target-reader.js";
import { synchronousJoinedTarget } from "./joined-query-reader.js";
import { sourcePatchKind } from "./joined-source-patches.js";
import { runJoinedQuery } from "./joined-query-node.js";
import { snapshotCheck } from "./snapshot-format.js";
import { u32 } from "./joined-target-input.js";
import {
	MAX_CORPUS_REPORT_ITEMS,
	type TextCorpusDiagnosticSummary,
	type TextPackageCoverageSummary
} from "./corpus-summary.js";
import type { TextUnit, TextOccurrence, TextReviewSignal } from "./schema.js";
import type { SavedTextRepresentationCopy } from "./representation-copies.js";

import { decodeTextAudience, textAudienceFields } from "./text-audience.js";
import type { JoinedSourceCache } from "./joined-source-cache-contract.js";

type MutableDiagnosticCounts = {
	-readonly [K in keyof TextCorpusDiagnosticSummary["diagnosticCounts"]]: TextCorpusDiagnosticSummary["diagnosticCounts"][K];
};
type MutablePackageCounts = {
	-readonly [K in keyof TextPackageCoverageSummary["counts"]]: TextPackageCoverageSummary["counts"][K];
};

export const querySignals = [
	"shared",
	"duplicate_source",
	"long",
	"unresolved",
	"conflicting",
	"evidence_only",
	"compiled_copy_differs"
] as const satisfies readonly TextReviewSignal[];

/** The largest page hydrateJoinedTarget accepts. */
const MAX_HYDRATED_PAGE_LINES = 10000;
/** Bulk reads hydrate across gaps up to this many rows instead of starting a new page. */
const MAX_BRIDGED_ROW_GAP = 64;

const displayedLines = (joined: JoinedTargetReader) =>
	runJoinedQuery(
		Cache.make({
			capacity: 64,
			lookup: (row: number) =>
				Effect.scoped(hydrateJoinedTarget(joined, row, 1)).pipe(
					Effect.map((page) => page.lines[0]!)
				)
		})
	);

/** Immutable numeric/byte projections may outlive a reader; they contain no file handles. */
export interface JoinedQueryProjection {
	readonly columns: Map<string, Uint32Array>;
	readonly generation?: string;
	readonly base?: string;
	readonly key?: string;
	sourceSeed?: JoinedQueryProjection["sources"];
	sources?: JoinedSourceCache;
}

/** Copy only immutable physical columns still referenced by this generation. Patched and
 * derived columns remain private to each query; old readers keep their original buffers. */
export function reuseJoinedQueryProjection(
	joined: JoinedTargetReader,
	previous?: JoinedQueryProjection
): JoinedQueryProjection {
	const generation = joined.reader.manifest.generation,
		key = joined.reader.manifest.active.joined!,
		base = joined.meta.base ?? key;
	const columns = new Map<string, Uint32Array>();
	const compatible = previous?.generation === generation && previous.base === base;
	if (compatible) {
		const retained = new Set([base, ...Object.values(joined.meta.dependencies)]);
		for (const [name, values] of previous.columns) {
			if (!name.startsWith("layer:")) continue;
			const end = name.lastIndexOf("\0");
			if (retained.has(name.slice(6, end))) columns.set(name, values);
		}
	}
	return {
		generation,
		base,
		key,
		columns,
		...(compatible && previous.sources ? { sourceSeed: previous.sources } : undefined)
	};
}

/** Decoded columns and derived projections per pinned reader; they live as long as it does. */
const readerProjections = new WeakMap<JoinedTargetReader, JoinedQueryProjection>();

/** Numeric and bounded evidence inputs for configurable quality policies. No search predicates. */
export class IndexedPolicyData {
	private emptyStringIds: ReadonlySet<number> | undefined;
	/** Project-relative package files by shard and package row. */
	private readonly packageFiles = new Map<number, string>();
	/**
	 * Columns by logical name, and package columns by shard and field. Checks read them for
	 * every line and occurrence; building the physical key each time cost more than the read.
	 */
	private readonly named = new Map<string, Uint32Array>();
	private readonly shardColumns: Map<string, Uint32Array>[] = [];
	/** Evidence file columns by file and field. */
	private readonly fileColumns = new Map<string, Map<string, Uint32Array>>();
	readonly joined: JoinedTargetReader;
	private readonly columns: Map<string, Uint32Array>;
	readonly projection: JoinedQueryProjection;
	private readonly displayedLines: ReturnType<typeof displayedLines>;
	constructor(joined: JoinedTargetReader, projection?: JoinedQueryProjection) {
		this.joined = synchronousJoinedTarget(joined);
		// Policy scans of one pinned reader share decoded columns and evidence rows.
		const shared = readerProjections.get(joined);
		this.projection = projection ?? shared ?? { columns: new Map() };
		if (!shared) readerProjections.set(joined, this.projection);
		this.columns = this.projection.columns;
		this.displayedLines = displayedLines(this.joined);
	}
	column(name: string) {
		const known = this.named.get(name);
		if (known) return known;
		// Unpatched aliases share one buffer. A patched logical column must not replace
		// the base buffer still used by other aliases in this pinned generation.
		const key =
			this.joined.meta.patches?.[name] ||
			sourcePatchKind(name, this.joined.meta.sourcePatches)
				? `patch:${name}`
				: `layer:${this.joined.meta.base ?? this.joined.reader.manifest.active.joined}\0${this.joined.meta.aliases[name] ?? name}`;
		let value = this.columns.get(key);
		if (!value) {
			value = runJoinedQuery(u32(this.joined.layer, name));
			this.columns.set(key, value);
		}
		this.named.set(name, value);
		return value;
	}
	strings(ids: readonly number[]) {
		return this.joined.reader.stringsSync!(ids);
	}
	isEmptyString(id: number) {
		if (!this.emptyStringIds) {
			const starts = this.joined.reader.manifest.segments.map((segment) => segment.start);
			const first = this.strings(starts);
			// Sorted immutable segments put an empty string first, at that segment's global ID.
			this.emptyStringIds = new Set(starts.filter((_, row) => first[row] === ""));
		}
		return this.emptyStringIds.has(id);
	}
	packageColumn(shard: number, field: string) {
		const fields = (this.shardColumns[shard] ??= new Map());
		const known = fields.get(field);
		if (known) return known;
		const dependency = this.joined.meta.dependencies[this.joined.meta.packageNames[shard]!]!;
		const key = `layer:${dependency}\0${field}`;
		let value = this.columns.get(key);
		if (!value) {
			const opened = this.joined.reader.layerSync!(this.joined.meta.packageNames[shard]!);
			const column = opened.section(field);
			snapshotCheck(column instanceof Uint32Array, field, "Expected u32 column");
			value = column;
			this.columns.set(key, value);
		}
		fields.set(field, value);
		return value;
	}
	/** The package shard holding a global occurrence row, and the row within it. */
	occurrenceShard(global: number) {
		// The last shard starting at or before the row, past any empty shards.
		const starts = this.joined.meta.packageStarts;
		let shard = 0,
			high = starts.length - 1;
		while (shard < high) {
			const middle = (shard + high + 1) >>> 1;
			if (starts[middle]! <= global) shard = middle;
			else high = middle - 1;
		}
		return { shard, row: global - starts[shard]! };
	}
	/** The project-relative package file of a shard's occurrence row, as `TextOccurrence` has it. */
	occurrencePackageFile(shard: number, row: number): string {
		const packageStarts = this.packageColumn(shard, "package.occurrence_start");
		let low = 0,
			high = packageStarts.length - 2;
		while (low < high) {
			const mid = (low + high + 1) >>> 1;
			if (packageStarts[mid]! <= row) low = mid;
			else high = mid - 1;
		}
		// Occurrences of one package share its file; resolving the path is most of the lookup.
		const memo = shard * 2 ** 32 + low;
		let file = this.packageFiles.get(memo);
		if (file === undefined) {
			const path = this.strings([this.packageColumn(shard, "package.path")[low]!])[0]!;
			const projectRoot = this.joined.meta.input.projectRoot;
			file = relative(projectRoot, resolve(projectRoot, path));
			this.packageFiles.set(memo, file);
		}
		return file;
	}
	/**
	 * `duplicateOccurrencePlace` of a stored occurrence, from its location columns and package
	 * file alone; building the whole occurrence also decodes its text and classifies its audience.
	 */
	occurrencePlace(global: number): string {
		const { shard, row } = this.occurrenceShard(global);
		const kind = this.packageColumn(shard, "occurrence.location")[row]!;
		const [objectPath, propertyPath, name] = this.strings([
			this.packageColumn(shard, "occurrence.object")[row]!,
			this.packageColumn(shard, "occurrence.property")[row]!,
			this.packageColumn(shard, "occurrence.row")[row]!
		]);
		return duplicateOccurrencePlace({
			packageFile: this.occurrencePackageFile(shard, row),
			location:
				kind === 0
					? {
							kind: "asset_property",
							objectPath: objectPath!,
							classPath: "",
							propertyPath: propertyPath!
						}
					: kind === 1
						? {
								kind: "data_table_cell",
								objectPath: objectPath!,
								row: name!,
								propertyPath: propertyPath!
							}
						: { kind: "string_table_entry", objectPath: objectPath!, entryKey: name! }
		});
	}
	occurrence(global: number): TextOccurrence {
		const { shard, row } = this.occurrenceShard(global);
		const c = (field: string) => this.packageColumn(shard, `occurrence.${field}`)[row]!;
		const fields = [
			"source",
			"notes",
			"namespace",
			"key",
			"object",
			"property",
			"class",
			"row"
		];
		const values = this.strings(fields.map(c));
		const s = (field: string) => values[fields.indexOf(field)]!;
		const identity = c("identity"),
			location = c("location"),
			gather = c("gather");
		const occurrence = textOccurrenceFromExtraction({
			packageFile: this.occurrencePackageFile(shard, row),
			occurrence: {
				source: s("source"),
				dev_notes: s("notes"),
				identity:
					identity === 0
						? { status: "resolved", namespace: s("namespace"), key: s("key") }
						: identity === 1
							? { status: "string_table", table_id: s("namespace"), key: s("key") }
							: {
									status: "unresolved",
									reason: identity === 2 ? "culture_invariant" : "missing_key"
								},
				location:
					location === 0
						? {
								kind: "asset_property",
								object_path: s("object"),
								property_path: s("property"),
								class_path: s("class")
							}
						: location === 1
							? {
									kind: "data_table_cell",
									object_path: s("object"),
									property_path: s("property"),
									row: s("row")
								}
							: {
									kind: "string_table_entry",
									object_path: s("object"),
									entry_key: s("row")
								},
				edit_capability: c("editable") ? "source_editable" : "read_only",
				...(gather === 0 ? undefined : { gather_editor_only: gather === 2 })
			}
		});
		// The audience the index stored and filters by.
		const decoded = { ...occurrence, ...textAudienceFields(decodeTextAudience(c("audience"))) };
		if (c("copies") === 0) return decoded;
		// Copies are provenance most readers never look at, such as checks over every line, and
		// their paths are scattered through the string store: decode them on first access.
		const load = () =>
			this.copies(shard, row, s("source")).map((copy) => ({
				objectPath: copy.object_path,
				kind: copy.kind,
				source: copy.source
			}));
		let copies: ReturnType<typeof load> | undefined;
		return {
			...decoded,
			get copies() {
				return (copies ??= load());
			}
		};
	}
	/** The representation copies folded into one stored occurrence, in the reader's order. */
	private copies(shard: number, row: number, placeSource: string): SavedTextRepresentationCopy[] {
		const kinds = this.packageColumn(shard, "copy.kind"),
			objects = this.packageColumn(shard, "copy.object"),
			sources = this.packageColumn(shard, "copy.source");
		const start = this.copyStarts(shard)[row]!,
			end = start + occurrenceCopyCount(this.packageColumn(shard, "occurrence.copies")[row]!);
		snapshotCheck(start < end && end <= kinds.length, "copy", "Invalid copy range");
		const values = this.strings([
			...objects.subarray(start, end),
			...sources.subarray(start, end)
		]);
		return Array.from({ length: end - start }, (_, index) =>
			decodeStoredCopy(
				kinds[start + index]!,
				values[index]!,
				values[end - start + index]!,
				// The public copy keeps no class; the stored audience already rolled it up.
				"",
				{ source: placeSource, classPath: undefined }
			)
		);
	}
	/** Each occurrence's first copy row in a shard, from the copy counts; built on first focus. */
	private copyStarts(shard: number) {
		const dependency = this.joined.meta.dependencies[this.joined.meta.packageNames[shard]!]!;
		const key = `layer:${dependency}\0copy-starts`;
		let starts = this.columns.get(key);
		if (!starts) {
			const flags = this.packageColumn(shard, "occurrence.copies");
			starts = new Uint32Array(flags.length + 1);
			for (let row = 0; row < flags.length; row++)
				starts[row + 1] = starts[row]! + occurrenceCopyCount(flags[row]!);
			this.columns.set(key, starts);
		}
		return starts;
	}
	members(kind: "raw" | "slice", row: number) {
		const prefix = `query.${kind}.`;
		return this.column(prefix + "members").subarray(
			this.column(prefix + "member_start")[row]!,
			this.column(prefix + "member_end")[row]!
		);
	}
	id(row: number): TextUnit["id"] {
		const starts = this.column("query.raw.id_starts"),
			bytes = this.column("query.raw.id_utf8");
		return TextUnitId.make(
			decodeWtf8(
				new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(
					starts[row],
					starts[row + 1]
				)
			)
		);
	}
	lineId(row: number) {
		const starts = this.column("query.line.id_starts"),
			bytes = this.column("query.line.id_utf8");
		return decodeWtf8(
			new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(
				starts[row],
				starts[row + 1]
			)
		);
	}
	unit(kind: "raw" | "slice", row: number): TextUnit {
		const prefix = `query.${kind}.`;
		const occurrences = Array.from(this.members(kind, row), (member) =>
			this.occurrence(member)
		);
		const values = this.strings(
			Array.from(
				this.column(prefix + "sources").subarray(
					this.column(prefix + "source_start")[row]!,
					this.column(prefix + "source_end")[row]!
				)
			)
		);
		return {
			id: this.id(this.column(prefix + "raw")[row]!),
			identity: occurrences[0]!.identity,
			source:
				values.length === 1
					? { status: "consistent", value: values[0]! }
					: { status: "conflicting", values },
			occurrences
		};
	}
	line(row: number): Effect.Success<ReturnType<typeof hydrateJoinedTarget>>["lines"][number] {
		return runJoinedQuery(Cache.get(this.displayedLines, row));
	}
	/** Bulk reads hydrate rows in storage order, in pages of adjacent rows, then return them in
	 * the requested (display) order. One page per row costs minutes on a large target because
	 * every page re-reads shared string blocks. Bypasses the displayed-line cache, which only
	 * serves paged browsing. */
	lines(rows: ArrayLike<number>): ReturnType<IndexedPolicyData["line"]>[] {
		const sorted = Uint32Array.from(new Set(Array.from(rows))).sort();
		const byRow = new Map<number, ReturnType<IndexedPolicyData["line"]>>();
		for (let index = 0; index < sorted.length; ) {
			const start = sorted[index]!;
			let last = index;
			// A page may span small gaps: reading a few unrequested rows beats another page.
			while (
				last + 1 < sorted.length &&
				sorted[last + 1]! - start < MAX_HYDRATED_PAGE_LINES &&
				sorted[last + 1]! - sorted[last]! <= MAX_BRIDGED_ROW_GAP
			)
				last++;
			const page = runJoinedQuery(
				Effect.scoped(hydrateJoinedTarget(this.joined, start, sorted[last]! - start + 1))
			);
			for (let picked = index; picked <= last; picked++)
				byRow.set(sorted[picked]!, page.lines[sorted[picked]! - start]!);
			index = last + 1;
		}
		return Array.from(rows, (row) => byRow.get(row)!);
	}
	fileColumn(name: string, field: string): Uint32Array {
		let fields = this.fileColumns.get(name);
		if (!fields) this.fileColumns.set(name, (fields = new Map()));
		const known = fields.get(field);
		if (known) return known;
		const key = `layer:${this.joined.meta.dependencies[name]}\0entry.${field}`;
		let value = this.columns.get(key);
		if (!value) {
			const opened = this.joined.reader.layerSync!(this.joined.meta.dependencies[name]!);
			const column = opened.section(`entry.${field}`);
			snapshotCheck(column instanceof Uint32Array, field, "Expected localization column");
			this.columns.set(key, column);
			value = column;
		}
		fields.set(field, value);
		return value;
	}
	translationId(name: string, row: number, po = false): number | undefined {
		const options = this.fileColumn(name, "options")[row]!;
		if (po && !(options & 64)) return undefined;
		return this.fileColumn(name, options & 128 ? "source" : "translation")[row]!;
	}
	/** Rebuilds the stored coverage evidence of one inspected package, without its occurrences. */
	private packageRecord(shard: number, row: number, path: string): SavedAssetPackageTextRecord {
		const record = emptyPackageTextRecord(path);
		const gapCounts = { ...record.gapCounts };
		for (let index = 0; index < packageTextGapReasons.length; index++)
			gapCounts[packageTextGapReasons[index]!] = this.packageColumn(
				shard,
				`package.gap${index}`
			)[row]!;
		const gapStarts = this.packageColumn(shard, "package.gap_start");
		const gapSamples: SavedAssetTextCoverageGap[] = [];
		for (let gap = gapStarts[row]!; gap < gapStarts[row + 1]!; gap++) {
			const values = this.strings([
				this.packageColumn(shard, "gap.object")[gap]!,
				this.packageColumn(shard, "gap.property")[gap]!
			]);
			gapSamples.push({
				reason: packageTextGapReasons[this.packageColumn(shard, "gap.reason")[gap]!]!,
				object_path: values[0]!,
				property_path: values[1]!
			});
		}
		const missingStarts = this.packageColumn(shard, "package.missing_start");
		const missingSamples: SavedAssetMissingGatherableText[] = [];
		for (let index = missingStarts[row]!; index < missingStarts[row + 1]!; index++) {
			const [namespace, key, source, site] = this.strings([
				this.packageColumn(shard, "missing.namespace")[index]!,
				this.packageColumn(shard, "missing.key")[index]!,
				this.packageColumn(shard, "missing.source")[index]!,
				this.packageColumn(shard, "missing.site")[index]!
			]);
			missingSamples.push({ namespace: namespace!, key: key!, source: source!, site: site! });
		}
		return {
			...record,
			status: this.packageColumn(shard, "package.status")[row] === 1 ? "partial" : "complete",
			decodeErrors: this.packageColumn(shard, "package.decode_errors")[row]!,
			gapCounts,
			gapSamples,
			...(this.packageColumn(shard, "package.gather")[row] === 1
				? {
						gatherCoverage: {
							runtimeSites: this.packageColumn(shard, "package.gather_sites")[row]!,
							missing: this.packageColumn(shard, "package.gather_missing")[row]!,
							missingSamples
						}
					}
				: undefined)
		};
	}
	metadata() {
		let discoveredPackages = 0,
			inspectedPackages = 0,
			partialPackages = 0,
			failedPackages = 0,
			unsupportedTextProperties = 0,
			missingGatherableText = 0,
			diagnosticCount = 0,
			notGatherablePackages = 0,
			resolvedOccurrences = 0;
		for (let shard = 0; shard < this.joined.meta.packageNames.length; shard++) {
			const statuses = this.packageColumn(shard, "package.status");
			const histories = this.packageColumn(shard, "package.gap0");
			const missing = this.packageColumn(shard, "package.gather_missing");
			const starts = this.packageColumn(shard, "package.gap_start");
			const missingStarts = this.packageColumn(shard, "package.missing_start");
			const reasons = this.packageColumn(shard, "gap.reason");
			discoveredPackages += statuses.length;
			for (let row = 0; row < statuses.length; row++) {
				if (statuses[row]! < 2) inspectedPackages++;
				if (statuses[row] === 3) {
					failedPackages++;
					diagnosticCount++;
				}
				if (statuses[row] === 2) {
					notGatherablePackages++;
					diagnosticCount++;
				}
				// Gaps in complete packages are detail; the reader's status decides coverage.
				if (statuses[row] !== 1) continue;
				partialPackages++;
				diagnosticCount++;
				unsupportedTextProperties += histories[row]!;
				missingGatherableText += missing[row]!;
				diagnosticCount += missingStarts[row + 1]! - missingStarts[row]!;
				for (let gap = starts[row]!; gap < starts[row + 1]!; gap++)
					if (reasons[gap] === 0) diagnosticCount++;
			}
			const identities = this.packageColumn(shard, "occurrence.identity"),
				keys = this.packageColumn(shard, "occurrence.key");
			for (let row = 0; row < identities.length; row++)
				if (identities[row]! < 2 && !this.isEmptyString(keys[row]!)) resolvedOccurrences++;
		}
		const textOccurrences = this.column("query.raw.members").length;
		return {
			status:
				partialPackages || failedPackages ? ("partial" as const) : ("complete" as const),
			diagnosticCount,
			notGatherablePackages,
			coverage: {
				discoveredPackages,
				inspectedPackages,
				partialPackages,
				failedPackages,
				textUnits: this.column("query.raw.representative").length,
				textOccurrences,
				resolvedOccurrences,
				unresolvedOccurrences: textOccurrences - resolvedOccurrences,
				unsupportedTextProperties,
				...(missingGatherableText > 0 ? { missingGatherableText } : undefined)
			}
		};
	}
	/** Explicit bulk export includes lossless package metadata, without decoding occurrence text. */
	metadataReport() {
		const diagnosticCounts: MutableDiagnosticCounts = {
			package_inspection_failed: 0,
			package_partially_decoded: 0,
			unsupported_text_history: 0
		};
		const counts: MutablePackageCounts = { complete: 0, partial: 0, failed: 0 };
		const starts = new Uint32Array(this.joined.meta.packageNames.length + 1);
		for (let shard = 0; shard + 1 < starts.length; shard++)
			starts[shard + 1] = starts[shard]! + this.packageColumn(shard, "package.status").length;
		const locate = (global: number) => {
			let low = 0,
				high = starts.length - 2;
			while (low < high) {
				const mid = (low + high + 1) >>> 1;
				if (starts[mid]! <= global) low = mid;
				else high = mid - 1;
			}
			return { shard: low, row: global - starts[low]! };
		};
		const state = (shard: number, row: number) => {
			const status = this.packageColumn(shard, "package.status")[row]!;
			return status === 2
				? "not_gatherable"
				: status === 3
					? "failed"
					: status === 1
						? "partial"
						: "complete";
		};
		const order = this.column("query.package.order");
		for (const global of order) {
			const { shard, row } = locate(global),
				status = state(shard, row);
			if (status === "not_gatherable") {
				counts.not_gatherable = (counts.not_gatherable ?? 0) + 1;
				diagnosticCounts.package_not_gatherable =
					(diagnosticCounts.package_not_gatherable ?? 0) + 1;
			} else counts[status]++;
			if (status === "failed") diagnosticCounts.package_inspection_failed++;
			if (status !== "partial") continue;
			diagnosticCounts.package_partially_decoded++;
			const gaps = this.packageColumn(shard, "package.gap_start"),
				reasons = this.packageColumn(shard, "gap.reason"),
				missing = this.packageColumn(shard, "package.missing_start");
			for (let gap = gaps[row]!; gap < gaps[row + 1]!; gap++)
				if (reasons[gap] === 0) diagnosticCounts.unsupported_text_history++;
			if (missing[row + 1]! > missing[row]!)
				diagnosticCounts.gatherable_text_not_decoded =
					(diagnosticCounts.gatherable_text_not_decoded ?? 0) +
					missing[row + 1]! -
					missing[row]!;
		}
		const path = (shard: number, row: number) =>
			relative(
				this.joined.meta.input.projectRoot,
				resolve(
					this.joined.meta.input.projectRoot,
					this.strings([this.packageColumn(shard, "package.path")[row]!])[0]!
				)
			);
		const packages: TextPackageCoverageSummary["packages"][number][] = [];
		const diagnostics: TextCorpusDiagnosticSummary["diagnostics"][number][] = [];
		for (const excluded of [false, true])
			for (const global of order) {
				if (packages.length >= MAX_CORPUS_REPORT_ITEMS) break;
				const { shard, row } = locate(global),
					status = state(shard, row);
				if (status !== "complete" && (status === "not_gatherable") === excluded)
					packages.push({ packageFile: path(shard, row), status });
			}
		for (const wanted of ["failed", "partial", "not_gatherable"] as const)
			for (const global of order) {
				if (diagnostics.length >= MAX_CORPUS_REPORT_ITEMS) break;
				const { shard, row } = locate(global);
				if (state(shard, row) !== wanted) continue;
				const packageFile = path(shard, row);
				if (wanted === "not_gatherable")
					diagnostics.push({
						code: "package_not_gatherable",
						packageFile,
						message:
							"Excluded because Unreal does not gather this package. Its text payload was not inspected."
					});
				else if (wanted === "failed") {
					const error = Schema.decodeUnknownSync(
						Schema.fromJsonString(SavedAssetPackageTextEvent.members[2])
					)(this.strings([this.packageColumn(shard, "package.error")[row]!])[0]!);
					diagnostics.push(
						...textCorpusFromExtractionEvents({
							projectRoot: this.joined.meta.input.projectRoot,
							events: [
								{
									...error,
									path: resolve(this.joined.meta.input.projectRoot, packageFile)
								}
							]
						}).diagnostics.slice(0, MAX_CORPUS_REPORT_ITEMS - diagnostics.length)
					);
				} else
					diagnostics.push(
						...textCorpusFromExtractionEvents({
							projectRoot: this.joined.meta.input.projectRoot,
							events: [
								this.packageRecord(
									shard,
									row,
									resolve(this.joined.meta.input.projectRoot, packageFile)
								)
							]
						}).diagnostics.slice(0, MAX_CORPUS_REPORT_ITEMS - diagnostics.length)
					);
			}
		const diagnosticCount = Object.values(diagnosticCounts).reduce(
			(sum, count) => sum + count,
			0
		);
		return {
			diagnostics,
			diagnosticCounts,
			diagnosticCount,
			diagnosticsOmitted: diagnosticCount - diagnostics.length,
			packageCoverage: {
				counts,
				packages,
				omitted:
					counts.partial + counts.failed + (counts.not_gatherable ?? 0) - packages.length
			}
		};
	}
	/** Explicit bulk export includes lossless package metadata, without decoding occurrence text. */
	exportMetadata() {
		const joined = this.joined;
		const records = runJoinedQuery(
			Effect.gen(function* () {
				const result: Effect.Success<ReturnType<typeof decodePackageTextColumns>> = [];
				for (const name of joined.meta.packageNames) {
					const layer = yield* joined.reader.layer(name);
					const packageCount = (yield* u32(layer, "package.path")).length;
					result.push(
						...(yield* decodePackageTextColumns({
							...layer,
							section: (field) =>
								field.startsWith("occurrence.") || field.startsWith("copy.")
									? Effect.succeed(new Uint32Array())
									: field === "package.occurrence_start"
										? Effect.succeed(new Uint32Array(packageCount + 1))
										: layer.section(field)
						}))
					);
				}
				return result;
			}).pipe(Effect.scoped)
		);
		records.sort((left, right) =>
			comparePackageTextPathBytes(encodeWtf8(left.path), encodeWtf8(right.path))
		);
		const projectRoot = this.joined.meta.input.projectRoot;
		const metadata = textCorpusFromExtractionEvents({
			projectRoot,
			discoveredPackages: records.length,
			events: records.flatMap((record) =>
				record.evidence.event === "not_gatherable"
					? []
					: [{ ...record.evidence, path: resolve(projectRoot, record.path) }]
			)
		});
		return textCorpusWithExcludedPackages(
			metadata,
			records
				.filter((record) => record.evidence.event === "not_gatherable")
				.map((record) => relative(projectRoot, resolve(projectRoot, record.path)))
		);
	}
	/** Diagnostics hydrate only the packages represented by a focused unit. */
	diagnostics(members: Uint32Array) {
		const result = new Map<
			string,
			ReturnType<typeof textCorpusFromExtractionEvents>["diagnostics"][number]
		>();
		const seen = new Set<string>();
		for (const global of members) {
			let shard = 0;
			while (this.joined.meta.packageStarts[shard + 1]! <= global) shard++;
			const row = global - this.joined.meta.packageStarts[shard]!;
			const starts = this.packageColumn(shard, "package.occurrence_start");
			let packageRow = 0;
			while (starts[packageRow + 1]! <= row) packageRow++;
			const key = `${shard}:${packageRow}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const projectRoot = this.joined.meta.input.projectRoot;
			const path = this.strings([this.packageColumn(shard, "package.path")[packageRow]!])[0]!;
			const corpus = textCorpusFromExtractionEvents({
				projectRoot,
				events: [this.packageRecord(shard, packageRow, resolve(projectRoot, path))]
			});
			for (const diagnostic of corpus.diagnostics)
				result.set(
					`${diagnostic.code}:${diagnostic.packageFile}:${diagnostic.objectPath ?? ""}:${diagnostic.propertyPath ?? ""}`,
					diagnostic
				);
		}
		return [...result.values()];
	}
}
