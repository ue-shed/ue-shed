import { Effect, Schema } from "effect";
import {
	SavedAssetBlueprintClasses,
	SavedAssetPackageTextEvent,
	type SavedAssetMissingGatherableText,
	type SavedAssetTextCoverageGap
} from "@ue-shed/unreal-assets";
import { snapshotStringTableBuilder, snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import { snapshotColumnsSource } from "./snapshot-file.js";
import type { SnapshotColumn } from "./snapshot-format.js";
import type { SnapshotReader } from "./snapshot-store.js";
import { encodeTextAudience } from "./text-audience.js";
import {
	PackageTextRecord,
	classifyFoldedTextAudience,
	foldRepresentationCopies,
	hasDifferingCopy,
	type PackageTextOccurrence,
	type SavedTextRepresentationCopy
} from "./representation-copies.js";
import { TextCopyKind } from "./schema.js";

export const packageTextGapReasons = [
	"unsupported_text_history",
	"legacy_container_element_without_type_information",
	"feature_unavailable_for_engine_version",
	"property_decoder_rejected"
] as const;
export const PackageTextStored = Schema.Struct({
	signature: Schema.String,
	path: Schema.String,
	// Records are stored with their representation copies folded (representation-copies.ts).
	evidence: Schema.Union([
		PackageTextRecord,
		Schema.Struct({ event: Schema.Literal("not_gatherable"), path: Schema.String }),
		SavedAssetPackageTextEvent.members[2]
	])
});
export type PackageTextStored = typeof PackageTextStored.Type;
const statuses = ["complete", "partial", "not_gatherable", "error"] as const;
const identities = ["resolved", "string_table", "culture_invariant", "missing_key"] as const;
const locations = ["asset_property", "data_table_cell", "string_table_entry"] as const;
const stringFields = {
	"package.path": "paths",
	"package.signature": "identity",
	"package.error": "paths",
	"occurrence.source": "source",
	"occurrence.notes": "source",
	"occurrence.namespace": "identity",
	"occurrence.key": "identity",
	"occurrence.object": "paths",
	"occurrence.property": "paths",
	"occurrence.class": "paths",
	"occurrence.row": "paths",
	"gap.object": "paths",
	"gap.property": "paths",
	"missing.namespace": "identity",
	"missing.key": "identity",
	"missing.source": "source",
	"missing.site": "paths",
	"copy.object": "paths",
	"copy.source": "source",
	// A copy's own class, empty when it is its place's (COPY_SAME_CLASS) or not a property.
	"copy.class": "paths",
	// The reader's `blueprintClasses` as JSON, or empty: one section, not one per field.
	"package.blueprints": "paths",
	// The summary's serialized package name (uasset-io 1.17), or empty when the reader omits it.
	"package.name": "paths",
	// The class of the package's main asset (uasset-io 1.17), or empty when the reader omits it.
	"package.asset_class": "paths"
} as const;
const copyKinds = TextCopyKind.literals;
const decodeBlueprintClasses = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(SavedAssetBlueprintClasses))
);
/** Bits of `occurrence.copies`: the place has folded copies, and one of them holds other text. */
export const OCCURRENCE_HAS_COPIES = 1;
export const OCCURRENCE_COPY_DIFFERS = 2;
/** `occurrence.copies` holds the place's copy count from this bit; its copies follow in order. */
const COPY_COUNT_SHIFT = 2;
/** `copy.kind`: the kind's index in its low two bits, then these flags. */
const COPY_KIND_MASK = 3;
/** A copy with its place's text; its `copy.source` is then empty. */
const COPY_SAME_SOURCE = 4;
/** The gather table's bit for the copy's own text: runtime, or editor-only. */
const COPY_GATHER_RUNTIME = 8;
const COPY_GATHER_EDITOR_ONLY = 16;
/** A property copy with its place's class; its `copy.class` is then empty. */
const COPY_SAME_CLASS = 32;

export function occurrenceCopyCount(flags: number): number {
	return flags >>> COPY_COUNT_SHIFT;
}

function encodeStoredCopy(copy: SavedTextRepresentationCopy, place: PackageTextOccurrence) {
	const sameSource = copy.source === place.source;
	const placeClass =
		place.location.kind === "asset_property" ? place.location.class_path : undefined;
	const sameClass = copy.class_path !== undefined && copy.class_path === placeClass;
	return {
		code:
			copyKinds.indexOf(copy.kind) |
			(sameSource ? COPY_SAME_SOURCE : 0) |
			(copy.gather_editor_only === undefined
				? 0
				: copy.gather_editor_only
					? COPY_GATHER_EDITOR_ONLY
					: COPY_GATHER_RUNTIME) |
			(sameClass ? COPY_SAME_CLASS : 0),
		source: sameSource ? "" : copy.source,
		className: sameClass ? "" : (copy.class_path ?? "")
	};
}

/** One stored copy, with the text and class it shares with its place filled back in. */
export function decodeStoredCopy(
	code: number,
	objectPath: string,
	source: string,
	className: string,
	place: { readonly source: string; readonly classPath: string | undefined }
): SavedTextRepresentationCopy {
	const kind = copyKinds[code & COPY_KIND_MASK];
	snapshotCheck(kind !== undefined, "copy", "Invalid kind");
	const class_path = code & COPY_SAME_CLASS ? place.classPath : className || undefined;
	return {
		object_path: objectPath,
		kind,
		source: code & COPY_SAME_SOURCE ? place.source : source,
		...(class_path === undefined ? undefined : { class_path }),
		...(code & (COPY_GATHER_RUNTIME | COPY_GATHER_EDITOR_ONLY)
			? { gather_editor_only: Boolean(code & COPY_GATHER_EDITOR_ONLY) }
			: undefined)
	};
}
const fieldDomains = new Map<string, string>(Object.entries(stringFields));
const numberFields = [
	"package.status",
	"package.bytes_low",
	"package.bytes_high",
	"package.decode_errors",
	"package.occurrence_start",
	"package.gap_start",
	...packageTextGapReasons.map((reason) => `package.gap${packageTextGapReasons.indexOf(reason)}`),
	"package.gather",
	"package.gather_sites",
	"package.gather_missing",
	"package.missing_start",
	"occurrence.identity",
	"occurrence.location",
	"occurrence.editable",
	// The reader's gather-table bit (0 none, 1 runtime, 2 editor-only) and the audience it and the
	// policy table give the occurrence (encodeTextAudience), so joins never re-read path strings.
	"occurrence.gather",
	"occurrence.audience",
	// OCCURRENCE_HAS_COPIES | OCCURRENCE_COPY_DIFFERS and the copy count, so joins never read
	// copy strings. Copies are sparse rows in their places' order.
	"occurrence.copies",
	"copy.kind",
	"gap.reason"
];

/** Bounded shard transformation. Every authored string is an ID, including sample coordinates. */
export function packageTextColumns(records: readonly PackageTextStored[]) {
	const tables = new Map(
		["source", "identity", "paths"].map((domain) => [
			domain,
			snapshotStringTableBuilder(domain)
		])
	);
	for (const table of tables.values()) table.intern("");
	const values = new Map<string, number[]>(
		[...Object.keys(stringFields), ...numberFields].map((name) => [name, []])
	);
	const number = (field: string, value: number) => values.get(field)!.push(value);
	const string = (field: keyof typeof stringFields, value: string) =>
		number(field, tables.get(stringFields[field])!.intern(value));
	let occurrenceCount = 0,
		gapCount = 0,
		missingCount = 0;
	for (const stored of records) {
		// Idempotent: records from the reader fold here, stored records are already folded.
		const record =
			stored.evidence.event === "text_package_record"
				? foldRepresentationCopies(stored.evidence)
				: stored.evidence;
		string("package.path", stored.path);
		string("package.signature", stored.signature);
		string("package.error", record.event === "error" ? JSON.stringify(record) : "");
		string(
			"package.name",
			record.event === "text_package_record" ? (record.packageName ?? "") : ""
		);
		string(
			"package.asset_class",
			record.event === "text_package_record" ? (record.assetClass ?? "") : ""
		);
		const status = record.event === "text_package_record" ? record.status : record.event;
		number("package.status", statuses.indexOf(status));
		const bytes = record.event === "text_package_record" ? record.fileBytes : 0;
		number("package.bytes_low", bytes >>> 0);
		number("package.bytes_high", Math.floor(bytes / 2 ** 32));
		number(
			"package.decode_errors",
			record.event === "text_package_record" ? record.decodeErrors : 0
		);
		number("package.occurrence_start", occurrenceCount);
		number("package.gap_start", gapCount);
		number("package.missing_start", missingCount);
		string(
			"package.blueprints",
			record.event === "text_package_record" && record.blueprintClasses?.length
				? JSON.stringify(record.blueprintClasses)
				: ""
		);
		const gather = record.event === "text_package_record" ? record.gatherCoverage : undefined;
		number("package.gather", Number(gather !== undefined));
		number("package.gather_sites", gather?.runtimeSites ?? 0);
		number("package.gather_missing", gather?.missing ?? 0);
		for (const reason of packageTextGapReasons)
			number(
				`package.gap${packageTextGapReasons.indexOf(reason)}`,
				record.event === "text_package_record" ? record.gapCounts[reason] : 0
			);
		if (record.event !== "text_package_record") continue;
		for (const occurrence of record.occurrences) {
			const identity = occurrence.identity,
				location = occurrence.location;
			string("occurrence.source", occurrence.source);
			string("occurrence.notes", occurrence.dev_notes);
			string(
				"occurrence.namespace",
				identity.status === "resolved"
					? identity.namespace
					: identity.status === "string_table"
						? identity.table_id
						: ""
			);
			string("occurrence.key", identity.status === "unresolved" ? "" : identity.key);
			string("occurrence.object", location.object_path);
			string(
				"occurrence.property",
				location.kind === "string_table_entry" ? "" : location.property_path
			);
			string(
				"occurrence.class",
				location.kind === "asset_property" ? location.class_path : ""
			);
			string(
				"occurrence.row",
				location.kind === "data_table_cell"
					? location.row
					: location.kind === "string_table_entry"
						? location.entry_key
						: ""
			);
			number(
				"occurrence.identity",
				identities.indexOf(
					identity.status === "unresolved" ? identity.reason : identity.status
				)
			);
			number("occurrence.location", locations.indexOf(location.kind));
			number("occurrence.editable", Number(occurrence.edit_capability === "source_editable"));
			number(
				"occurrence.gather",
				occurrence.gather_editor_only === undefined
					? 0
					: occurrence.gather_editor_only
						? 2
						: 1
			);
			number(
				"occurrence.audience",
				encodeTextAudience(classifyFoldedTextAudience(occurrence))
			);
			number(
				"occurrence.copies",
				occurrence.copies === undefined
					? 0
					: (occurrence.copies.length << COPY_COUNT_SHIFT) |
							OCCURRENCE_HAS_COPIES |
							(hasDifferingCopy(occurrence) ? OCCURRENCE_COPY_DIFFERS : 0)
			);
			for (const copy of occurrence.copies ?? []) {
				const stored = encodeStoredCopy(copy, occurrence);
				string("copy.object", copy.object_path);
				string("copy.source", stored.source);
				string("copy.class", stored.className);
				number("copy.kind", stored.code);
			}
			occurrenceCount++;
		}
		for (const sample of record.gapSamples) {
			string("gap.object", sample.object_path);
			string("gap.property", sample.property_path);
			number("gap.reason", packageTextGapReasons.indexOf(sample.reason));
			gapCount++;
		}
		for (const sample of gather?.missingSamples ?? []) {
			string("missing.namespace", sample.namespace);
			string("missing.key", sample.key);
			string("missing.source", sample.source);
			string("missing.site", sample.site);
			missingCount++;
		}
	}
	number("package.occurrence_start", occurrenceCount);
	number("package.gap_start", gapCount);
	number("package.missing_start", missingCount);
	const columns: SnapshotColumn[] = [...tables.values()].flatMap((table) => [...table.finish()]);
	for (const [name, rows] of values) {
		const domain = fieldDomains.get(name);
		columns.push(
			domain
				? {
						name,
						kind: "stringIds",
						domain,
						stringCount: tables.get(domain)!.count,
						values: Uint32Array.from(rows)
					}
				: { name, kind: "u32", values: Uint32Array.from(rows) }
		);
	}
	return snapshotColumnsSource(columns);
}

/** Small-input oracle and affected-shard refresh decoder; production queries consume the columns. */
export const decodePackageTextColumns = Effect.fn("PackageText.decodeColumns")(function* (
	reader: Pick<SnapshotReader, "section" | "strings">
) {
	const columns = new Map<string, Uint32Array>();
	const strings = new Map<string, Map<number, string>>();
	for (const name of [...Object.keys(stringFields), ...numberFields]) {
		const values = yield* reader.section(name);
		if (!(values instanceof Uint32Array))
			return yield* Effect.fail(snapshotFailure(name, "Expected u32"));
		columns.set(name, values);
		const domain = fieldDomains.get(name);
		if (domain !== undefined) {
			const ids = [...new Set(values)];
			const decoded = yield* reader.strings(domain, ids);
			strings.set(name, new Map(ids.map((id, row) => [id, decoded[row]!])));
		}
	}
	return yield* Effect.try({
		try: () => {
			const value = (name: string, row: number) => {
				const result = columns.get(name)?.[row];
				snapshotCheck(result !== undefined, name, "Row outside column");
				return result;
			};
			const string = (name: string, row: number) => {
				const result = strings.get(name)?.get(value(name, row));
				snapshotCheck(result !== undefined, name, "Missing string ID");
				return result;
			};
			const records: PackageTextStored[] = [];
			const copyCount = columns.get("copy.kind")!.length;
			let copyRow = 0;
			for (let row = 0; row < columns.get("package.path")!.length; row++) {
				const path = string("package.path", row),
					signature = string("package.signature", row);
				const status = statuses[value("package.status", row)];
				snapshotCheck(status !== undefined, "package.status", "Invalid status");
				if (status === "not_gatherable") {
					records.push({ path, signature, evidence: { event: "not_gatherable", path } });
					continue;
				}
				if (status === "error") {
					const evidence = Schema.decodeUnknownSync(
						Schema.fromJsonString(SavedAssetPackageTextEvent)
					)(string("package.error", row));
					snapshotCheck(evidence.event === "error", "package.error", "Invalid failure");
					records.push({ path, signature, evidence });
					continue;
				}
				const occurrences: PackageTextOccurrence[] = [],
					gapSamples: SavedAssetTextCoverageGap[] = [];
				const start = value("package.occurrence_start", row),
					end = value("package.occurrence_start", row + 1);
				snapshotCheck(
					start <= end && end <= columns.get("occurrence.source")!.length,
					"occurrence",
					"Invalid range"
				);
				for (let index = start; index < end; index++) {
					const identity = identities[value("occurrence.identity", index)];
					const location = locations[value("occurrence.location", index)];
					snapshotCheck(
						identity !== undefined && location !== undefined,
						"occurrence",
						"Invalid discriminator"
					);
					const namespace = string("occurrence.namespace", index),
						key = string("occurrence.key", index);
					const copies: SavedTextRepresentationCopy[] = [];
					const flags = value("occurrence.copies", index),
						copyEnd = copyRow + occurrenceCopyCount(flags);
					snapshotCheck(
						copyEnd <= copyCount && (flags === 0) === (copyEnd === copyRow),
						"copy",
						"Invalid copy count"
					);
					for (; copyRow < copyEnd; copyRow++)
						copies.push(
							decodeStoredCopy(
								value("copy.kind", copyRow),
								string("copy.object", copyRow),
								string("copy.source", copyRow),
								string("copy.class", copyRow),
								{
									source: string("occurrence.source", index),
									classPath:
										location === "asset_property"
											? string("occurrence.class", index)
											: undefined
								}
							)
						);
					const object_path = string("occurrence.object", index),
						property_path = string("occurrence.property", index);
					occurrences.push({
						source: string("occurrence.source", index),
						dev_notes: string("occurrence.notes", index),
						identity:
							identity === "resolved"
								? { status: identity, namespace, key }
								: identity === "string_table"
									? { status: identity, table_id: namespace, key }
									: { status: "unresolved", reason: identity },
						location:
							location === "asset_property"
								? {
										kind: location,
										object_path,
										property_path,
										class_path: string("occurrence.class", index)
									}
								: location === "data_table_cell"
									? {
											kind: location,
											object_path,
											property_path,
											row: string("occurrence.row", index)
										}
									: {
											kind: location,
											object_path,
											entry_key: string("occurrence.row", index)
										},
						edit_capability: value("occurrence.editable", index)
							? "source_editable"
							: "read_only",
						...(value("occurrence.gather", index) === 0
							? undefined
							: { gather_editor_only: value("occurrence.gather", index) === 2 }),
						...(copies.length ? { copies } : undefined)
					});
				}
				const gapStart = value("package.gap_start", row),
					gapEnd = value("package.gap_start", row + 1);
				snapshotCheck(
					gapStart <= gapEnd && gapEnd - gapStart <= 3,
					"gap",
					"Invalid sample range"
				);
				for (let index = gapStart; index < gapEnd; index++) {
					const reason = packageTextGapReasons[value("gap.reason", index)];
					snapshotCheck(reason !== undefined, "gap", "Invalid reason");
					gapSamples.push({
						object_path: string("gap.object", index),
						property_path: string("gap.property", index),
						reason
					});
				}
				const missingStart = value("package.missing_start", row),
					missingEnd = value("package.missing_start", row + 1);
				snapshotCheck(
					missingStart <= missingEnd && missingEnd - missingStart <= 3,
					"missing",
					"Invalid sample range"
				);
				const missingSamples: SavedAssetMissingGatherableText[] = [];
				for (let index = missingStart; index < missingEnd; index++)
					missingSamples.push({
						namespace: string("missing.namespace", index),
						key: string("missing.key", index),
						source: string("missing.source", index),
						site: string("missing.site", index)
					});
				const blueprints = string("package.blueprints", row);
				const packageName = string("package.name", row);
				const assetClass = string("package.asset_class", row);
				const blueprintClasses =
					blueprints === "" ? [] : decodeBlueprintClasses(blueprints);
				records.push({
					path,
					signature,
					evidence: {
						event: "text_package_record",
						schema_version: 1,
						path,
						status,
						fileBytes:
							value("package.bytes_low", row) +
							value("package.bytes_high", row) * 2 ** 32,
						decodeErrors: value("package.decode_errors", row),
						occurrences,
						gapSamples,
						gapCounts: {
							unsupported_text_history: value("package.gap0", row),
							legacy_container_element_without_type_information: value(
								"package.gap1",
								row
							),
							feature_unavailable_for_engine_version: value("package.gap2", row),
							property_decoder_rejected: value("package.gap3", row)
						},
						...(value("package.gather", row) === 1
							? {
									gatherCoverage: {
										runtimeSites: value("package.gather_sites", row),
										missing: value("package.gather_missing", row),
										missingSamples
									}
								}
							: undefined),
						...(blueprintClasses.length ? { blueprintClasses } : undefined),
						...(packageName === "" ? undefined : { packageName }),
						...(assetClass === "" ? undefined : { assetClass })
					}
				});
			}
			snapshotCheck(copyRow === copyCount, "copy", "Copy outside its place");
			return records;
		},
		catch: (cause) =>
			snapshotFailure("package-text", "The saved package text columns are invalid.", cause)
	});
});
