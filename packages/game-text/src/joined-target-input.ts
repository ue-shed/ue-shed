import { relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import type { LocalizationTarget } from "@ue-shed/localization";
import { localizationGatherCoverage } from "./localization.js";
import { snapshotCheck, snapshotFailure } from "./snapshot-format.js";
import type { SharedIndexReader } from "./shared-index.js";
import type { SnapshotReader } from "./snapshot-store.js";
import type { PackedStrings } from "./shared-string-codec.js";
import type { TextOccurrence } from "./schema.js";
import { TextOccurrenceId } from "./identifiers.js";

export const absent = 0xffffffff;
export type ColumnReader = Pick<SnapshotReader, "section" | "strings">;
export const u32 = Effect.fn("JoinedTarget.u32")(function* (reader: ColumnReader, name: string) {
	const value = yield* reader.section(name);
	if (!(value instanceof Uint32Array))
		return yield* Effect.fail(snapshotFailure(name, "Expected u32 column"));
	return value;
});

/** Only rule-dependent segments expand. UTF-8 and offsets stay outside the JS heap. */
export class JoinStrings {
	private readonly loaded = new Map<number, PackedStrings>();
	readonly reader: SharedIndexReader;
	readonly empty: number;
	constructor(reader: SharedIndexReader, empty: number) {
		this.reader = reader;
		this.empty = empty;
	}
	segment(id: number) {
		const segments = this.reader.manifest.segments;
		let low = 0,
			high = segments.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (segments[mid]!.start <= id) low = mid + 1;
			else high = mid;
		}
		const index = low - 1;
		snapshotCheck(
			index >= 0 && id < segments[index]!.start + segments[index]!.count,
			"join.string",
			"ID outside dependency"
		);
		return index;
	}
	need(columns: readonly Uint32Array[]) {
		const selected = new Uint8Array(this.reader.manifest.segments.length);
		for (const values of columns)
			for (const id of values) if (id !== this.empty) selected[this.segment(id)] = 1;
		const loaded = this.loaded,
			reader = this.reader;
		return Effect.gen(function* () {
			for (let segment = 0; segment < selected.length; segment++)
				if (selected[segment] && !loaded.has(segment))
					loaded.set(segment, yield* reader.packedSegment(segment));
		});
	}
	bytes(id: number) {
		if (id === this.empty) return Buffer.alloc(0);
		const segment = this.segment(id),
			packed = this.loaded.get(segment);
		snapshotCheck(packed !== undefined, "join.string", "Segment was not requested");
		const local = id - this.reader.manifest.segments[segment]!.start;
		return packed.bytes.subarray(packed.offsets[local]!, packed.offsets[local + 1]!);
	}
	string(id: number) {
		return this.bytes(id).toString("utf8");
	}
}

const FileMeta = Schema.Struct({
	format: Schema.Literals(["manifest", "archive", "po"]),
	count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	poFormat: Schema.Literals(["Unreal", "Crowdin"]),
	hasSourceText: Schema.Boolean,
	pathPrefix: Schema.optionalKey(Schema.String)
});
export interface JoinFile {
	readonly name: string;
	readonly reader?: ColumnReader;
	readonly missing: boolean;
	readonly hasSourceText: boolean;
	readonly pathPrefix: string;
	readonly columns: Readonly<Record<string, Uint32Array>>;
	readonly order: Uint32Array;
}
export const loadJoinFile = Effect.fn("JoinedTarget.file")(function* (
	reader: SharedIndexReader,
	name: string,
	failure?: string
) {
	const columns: Record<string, Uint32Array> = {};
	if (!reader.manifest.active[name])
		return {
			name,
			missing: failure === undefined || failure === "file_missing",
			hasSourceText: false,
			pathPrefix: "",
			columns,
			order: new Uint32Array()
		} satisfies JoinFile;
	const file = yield* reader.layer(name);
	const meta = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FileMeta))(
		new TextDecoder().decode(yield* file.section("file.meta"))
	);
	for (const field of [
		"namespace",
		"key",
		"source",
		"source-extra",
		"translation",
		"options",
		"ordinal",
		"path",
		"notes",
		"metadata"
	])
		columns[field] = yield* u32(file, `entry.${field}`);
	for (const values of Object.values(columns))
		snapshotCheck(values.length === meta.count, "join.file", "Column lengths differ");
	const order = Uint32Array.from({ length: meta.count }, (_, index) => index);
	order.sort(
		(a, b) =>
			columns.namespace![a]! - columns.namespace![b]! ||
			columns.key![a]! - columns.key![b]! ||
			columns.ordinal![a]! - columns.ordinal![b]!
	);
	return {
		name,
		reader: file,
		missing: false,
		hasSourceText: meta.hasSourceText,
		pathPrefix: meta.pathPrefix ?? "",
		columns,
		order
	} satisfies JoinFile;
});

export const occurrenceFields = [
	"source",
	"notes",
	"namespace",
	"key",
	"object",
	"property",
	"class",
	"row",
	"identity",
	"location",
	"editable"
] as const;
export interface JoinPackages {
	readonly names: readonly string[];
	readonly starts: readonly number[];
	readonly occurrence: Record<(typeof occurrenceFields)[number], Uint32Array>;
	readonly packageRow: Uint32Array;
	readonly paths: Uint32Array;
	readonly status: Uint32Array;
	readonly hash: Uint32Array;
	readonly order: Uint32Array;
	readonly coverage: Uint32Array;
	readonly strings: JoinStrings;
	readonly projectRoot: string;
}
export const normalizedPackagePath = (path: string) =>
	path.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase();
export function pathHash(path: string) {
	let hash = 2166136261;
	for (let index = 0; index < path.length; index++)
		hash = Math.imul(hash ^ path.charCodeAt(index), 16777619);
	return hash >>> 0;
}
export function packagePath(packages: JoinPackages, row: number) {
	return relative(
		packages.projectRoot,
		resolve(packages.projectRoot, packages.strings.string(packages.paths[row]!))
	);
}
export function packageStatus(packages: JoinPackages, path: string): number | undefined {
	const hash = pathHash(path),
		order = packages.order;
	let low = 0,
		high = order.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (packages.hash[order[mid]!]! < hash) low = mid + 1;
		else high = mid;
	}
	let status: number | undefined;
	for (; low < order.length && packages.hash[order[low]!] === hash; low++) {
		const row = order[low]!;
		if (normalizedPackagePath(packagePath(packages, row)) !== path) continue;
		const next = packages.status[row]!;
		if (status === 3 || (status === 1 && next === 0)) continue;
		status = next;
	}
	return status;
}
export function occurrenceLocation(
	packages: JoinPackages,
	row: number
): TextOccurrence["location"] {
	const { occurrence: c, strings } = packages;
	const objectPath = strings.string(c.object[row]!);
	if (c.location[row] === 2)
		return { kind: "string_table_entry", objectPath, entryKey: strings.string(c.row[row]!) };
	const propertyPath = strings.string(c.property[row]!);
	return c.location[row] === 1
		? { kind: "data_table_cell", objectPath, propertyPath, row: strings.string(c.row[row]!) }
		: {
				kind: "asset_property",
				objectPath,
				propertyPath,
				classPath: strings.string(c.class[row]!)
			};
}
export function unitId(packages: JoinPackages, row: number, namespace: string, key: string) {
	const c = packages.occurrence,
		kind = c.identity[row]!;
	if (kind < 2 && key !== "")
		return `${kind === 0 ? "unreal" : "string-table"}:${encodeURIComponent(namespace)}:${encodeURIComponent(key)}`;
	const location = occurrenceLocation(packages, row);
	const suffix =
		location.kind === "string_table_entry"
			? `entry:${location.entryKey}`
			: location.kind === "data_table_cell"
				? `row:${location.row}:property:${location.propertyPath}`
				: `property:${location.propertyPath}`;
	return `occurrence:${location.objectPath}:${suffix}:${packagePath(packages, packages.packageRow[row]!)}`;
}
export const loadJoinPackages = Effect.fn("JoinedTarget.packages")(function* (
	reader: SharedIndexReader,
	strings: JoinStrings,
	projectRoot: string,
	target: LocalizationTarget
) {
	const names = Object.keys(reader.manifest.active)
		.filter((name) => name.startsWith("package-text."))
		.sort();
	const shards: { columns: Record<string, Uint32Array>; count: number }[] = [];
	const starts: number[] = [];
	let occurrenceCount = 0,
		packageCount = 0;
	for (const name of names) {
		const file = yield* reader.layer(name),
			columns: Record<string, Uint32Array> = {};
		for (const field of [
			"package.path",
			"package.status",
			"package.decode_errors",
			"package.occurrence_start",
			"package.gap0",
			"package.gap1",
			"package.gap2",
			"package.gap3",
			...occurrenceFields.map((field) => `occurrence.${field}`)
		])
			columns[field] = yield* u32(file, field);
		const count = columns["package.path"]!.length;
		snapshotCheck(
			columns["package.occurrence_start"]!.length === count + 1,
			"join.packages",
			"Invalid range column"
		);
		starts.push(occurrenceCount);
		occurrenceCount += columns["occurrence.source"]!.length;
		packageCount += count;
		shards.push({ columns, count });
	}
	starts.push(occurrenceCount);
	// SAFETY: The closed occurrenceFields tuple initializes every required field with u32s.
	const occurrence = Object.fromEntries(
		occurrenceFields.map((field) => [field, new Uint32Array(occurrenceCount)])
	) as JoinPackages["occurrence"];
	const paths = new Uint32Array(packageCount),
		status = new Uint32Array(packageCount),
		packageRow = new Uint32Array(occurrenceCount),
		hash = new Uint32Array(packageCount),
		coverage = new Uint32Array(occurrenceCount);
	let pkg = 0,
		offset = 0;
	for (const shard of shards) {
		paths.set(shard.columns["package.path"]!, pkg);
		for (const field of occurrenceFields)
			occurrence[field].set(shard.columns[`occurrence.${field}`]!, offset);
		for (let row = 0; row < shard.count; row++, pkg++) {
			const c = shard.columns;
			let next = c["package.status"]![row]!;
			// Preserve today's diagnostic precedence, including not_gatherable -> partial.
			if (
				next === 2 ||
				(next !== 3 &&
					["package.gap0", "package.gap1", "package.gap2", "package.gap3"].some(
						(field) => c[field]![row]! > 0
					))
			)
				next = 1;
			status[pkg] = next;
			const start = c["package.occurrence_start"]![row]!,
				end = c["package.occurrence_start"]![row + 1]!;
			snapshotCheck(
				start <= end && end <= c["occurrence.source"]!.length,
				"join.packages",
				"Invalid occurrence range"
			);
			packageRow.fill(pkg, offset + start, offset + end);
		}
		offset += shard.columns["occurrence.source"]!.length;
	}
	yield* strings.need([paths, occurrence.class]);
	const packages: JoinPackages = {
		names,
		starts,
		occurrence,
		packageRow,
		paths,
		status,
		hash,
		order: Uint32Array.from({ length: packageCount }, (_, row) => row),
		coverage,
		strings,
		projectRoot
	};
	let previousPackage = absent;
	let ratings = new Map<number, number>();
	let currentPath = "";
	for (let row = 0; row < packageCount; row++)
		hash[row] = pathHash(normalizedPackagePath(packagePath(packages, row)));
	packages.order.sort((a, b) => hash[a]! - hash[b]! || a - b);
	for (let row = 0; row < occurrenceCount; row++) {
		const packageIndex = packageRow[row]!;
		if (packageIndex !== previousPackage) {
			previousPackage = packageIndex;
			ratings = new Map();
			currentPath = packagePath(packages, packageIndex);
		}
		const kind = occurrence.location[row]!,
			classId = occurrence.class[row]!,
			key = classId * 3 + kind;
		let rating = ratings.get(key);
		if (rating === undefined) {
			const location: TextOccurrence["location"] =
				kind === 2
					? { kind: "string_table_entry", objectPath: "", entryKey: "" }
					: kind === 1
						? { kind: "data_table_cell", objectPath: "", propertyPath: "", row: "" }
						: {
								kind: "asset_property",
								objectPath: "",
								propertyPath: "",
								classPath: strings.string(classId)
							};
			const result = localizationGatherCoverage(target, {
				id: TextOccurrenceId.make("join"),
				packageFile: currentPath,
				source: "",
				devNotes: "",
				identity: { status: "unresolved", reason: "missing_key" },
				location,
				editCapability: "read_only"
			});
			rating =
				result.status === "unknown"
					? 2 +
						[
							"gather_settings_unavailable",
							"class_hierarchy_unavailable",
							"asset_class_unavailable",
							"path_not_project_relative"
						].indexOf(result.reason)
					: result.status === "inside"
						? 1
						: 0;
			ratings.set(key, rating);
		}
		coverage[row] = rating;
	}
	return packages;
});
