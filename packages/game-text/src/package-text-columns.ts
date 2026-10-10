import { Effect, Schema } from "effect";
import {
	SavedAssetPackageTextRecord,
	SavedAssetPackageTextEvent,
	type SavedAssetTextCoverageGap,
	type SavedAssetTextOccurrence
} from "@ue-shed/unreal-assets";
import { snapshotStringTableBuilder, snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import { snapshotColumnsSource } from "./snapshot-file.js";
import type { SnapshotColumn } from "./snapshot-format.js";
import type { SnapshotReader } from "./snapshot-store.js";

export const packageTextGapReasons = [
	"unsupported_text_history",
	"legacy_container_element_without_type_information",
	"feature_unavailable_for_engine_version",
	"property_decoder_rejected"
] as const;
export const PackageTextStored = Schema.Struct({
	signature: Schema.String,
	path: Schema.String,
	evidence: Schema.Union([
		SavedAssetPackageTextRecord,
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
	"gap.property": "paths"
} as const;
const fieldDomains = new Map<string, string>(Object.entries(stringFields));
const numberFields = [
	"package.status",
	"package.bytes_low",
	"package.bytes_high",
	"package.decode_errors",
	"package.occurrence_start",
	"package.gap_start",
	...packageTextGapReasons.map((reason) => `package.gap${packageTextGapReasons.indexOf(reason)}`),
	"occurrence.identity",
	"occurrence.location",
	"occurrence.editable",
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
		gapCount = 0;
	for (const stored of records) {
		const record = stored.evidence;
		string("package.path", stored.path);
		string("package.signature", stored.signature);
		string("package.error", record.event === "error" ? JSON.stringify(record) : "");
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
			occurrenceCount++;
		}
		for (const sample of record.gapSamples) {
			string("gap.object", sample.object_path);
			string("gap.property", sample.property_path);
			number("gap.reason", packageTextGapReasons.indexOf(sample.reason));
			gapCount++;
		}
	}
	number("package.occurrence_start", occurrenceCount);
	number("package.gap_start", gapCount);
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
				const occurrences: SavedAssetTextOccurrence[] = [],
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
							: "read_only"
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
						}
					}
				});
			}
			return records;
		},
		catch: (cause) => snapshotFailure("package-text", String(cause))
	});
});
