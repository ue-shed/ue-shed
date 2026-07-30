import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
	decodeAuthoringTableSnapshot,
	decodeSavedWorld,
	SavedWorld,
	SavedWorldProgress,
	type AuthoringTableSnapshot
} from "@ue-shed/protocol";
import { Config, Context, Duration, Effect, Layer, Option, Schema, Stream, Tuple } from "effect";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 5 * 60_000;

export { decodeSavedWorld, SavedWorld, SavedWorldProgress } from "@ue-shed/protocol";

export class AssetReaderError extends Schema.TaggedErrorClass<AssetReaderError>()(
	"AssetReaderError",
	{
		kind: Schema.Literals(["timeout", "process", "contract", "discovery", "resource_limit"]),
		operation: Schema.Literals([
			"authoring",
			"catalog",
			"extract_text",
			"extract_texture",
			"inspect",
			"discovery",
			"scan",
			"saved_world"
		]),
		message: Schema.String,
		retrySafe: Schema.Boolean,
		path: Schema.optional(Schema.String),
		exitCode: Schema.optional(Schema.Number)
	}
) {}

export interface AssetReaderOptions {
	readonly assetPath: string;
}

export interface SavedTableCatalogOptions {
	readonly cachePath?: string;
	readonly projectRoot: string;
	readonly concurrency?: number;
}

/**
 * One batched project scan. The class and name filters are header-only selection rules evaluated
 * inside the reader, so unselected packages are never fully read or decoded. A package is selected
 * when it matches any rule; with no rules every package is selected.
 */
export interface SavedAssetScanOptions {
	/** Select packages exporting a class under this path prefix, e.g. `/Script/EnhancedInput.`. */
	readonly classPrefixes?: readonly string[];
	/**
	 * Select packages whose serialized class object's name ends with this suffix. This finds
	 * conventionally named native subclasses, not a resolved Unreal inheritance hierarchy.
	 */
	readonly classNameSuffixes?: readonly string[];
	/** Select packages exporting this class, as a full path or a bare class name. */
	readonly classes?: readonly string[];
	readonly concurrency?: number;
	/**
	 * Reuse header results for packages whose size and mtime are unchanged. Requires
	 * `depth: "header"`. The cache is scoped to the class filters it was written with, so a caller
	 * with different filters must name a different path.
	 */
	readonly cachePath?: string;
	/**
	 * `"header"` stops at the package summary and export table, answering "what classes are in this
	 * project" from the one header read the filters already need. `"full"` decodes every property
	 * stream and re-reads the whole file. Defaults to `"full"`.
	 */
	readonly depth?: "header" | "full";
	/** Stream a complete package-and-sidecar signature inventory alongside selected assets. */
	readonly inventory?: boolean;
	/** Refuse the scan when enumeration finds more packages than this, before any decode. */
	readonly maximumAssets?: number;
	/**
	 * Select packages whose name table contains this entry, e.g. the `TextProperty` type name.
	 * Header scans retain only matching requested names, so this can reuse the header cache.
	 */
	readonly names?: readonly string[];
	/** Roots to enumerate, relative to the project root or absolute. Defaults to `Content`. */
	readonly paths?: readonly string[];
	readonly projectRoot: string;
}

/**
 * Runs one compact domain projection. When `paths` is omitted the reader selects its own
 * candidates from package headers; an explicit empty list is intentionally a no-op and never
 * falls back to `Content`.
 */
export interface SavedAssetExtractionOptions {
	readonly concurrency?: number;
	readonly maximumAssets?: number;
	readonly paths?: readonly string[];
	readonly projectRoot: string;
}

/** Reads saved actors belonging to exactly one conventional or World Partition map. */
export interface SavedWorldReadOptions {
	readonly concurrency?: number;
	/** Refuse the map before decode when it has more selected packages than this. */
	readonly maximumAssets?: number;
	/** A `.umap` path inside `projectRoot`, relative to it or absolute. */
	readonly mapPath: string;
	readonly projectRoot: string;
}

export interface AssetReaderConfiguration {
	readonly catalogTimeoutMs: number;
	readonly executable: string;
	readonly timeoutMs: number;
}

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * A cheap, deterministic fingerprint input for a saved package. It deliberately avoids opening
 * package headers: callers can invalidate a persisted inspection without re-reading every asset.
 */
export const SavedAssetManifestEntry = Schema.Struct({
	kind: Schema.Literals(["package", "sidecar"]),
	modifiedMs: Schema.Number,
	path: Schema.String,
	size: nonNegativeInt
});
export type SavedAssetManifestEntry = Schema.Schema.Type<typeof SavedAssetManifestEntry>;

export interface AssetReaderShape {
	readonly catalogProgress?: () => Effect.Effect<SavedTableCatalogProgress>;
	readonly discoverAssets: (
		projectRoot: string
	) => Effect.Effect<readonly string[], AssetReaderError>;
	readonly discoverTables: (
		options: SavedTableCatalogOptions
	) => Effect.Effect<SavedTableCatalog, AssetReaderError>;
	/** Streams compact FText and StringTable evidence without generic inspection payloads. */
	readonly extractProjectText: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextExtractionEvent, AssetReaderError>;
	/** Streams compact Texture2D facts without generic inspection payloads. */
	readonly extractProjectTextures: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextureExtractionEvent, AssetReaderError>;
	readonly readAsset: (
		assetPath: string
	) => Effect.Effect<SavedAssetInspection, AssetReaderError>;
	readonly readTable: (
		assetPath: string
	) => Effect.Effect<AuthoringTableSnapshot, AssetReaderError>;
	/** Reads one saved map's actors without requiring a live Unreal connection. */
	readonly readSavedWorld: (
		options: SavedWorldReadOptions
	) => Effect.Effect<SavedWorld, AssetReaderError>;
	/**
	 * Inspects every selected package under one project in a single reader process. Prefer this
	 * over `discoverAssets` plus `readAsset` per path for any project-wide scan.
	 */
	readonly scanProject: (
		options: SavedAssetScanOptions
	) => Effect.Effect<SavedAssetScan, AssetReaderError>;
	readonly scanProgress: () => Effect.Effect<SavedAssetScanProgress>;
	readonly savedWorldProgress: () => Effect.Effect<SavedWorldProgress>;
	readonly source: () => Effect.Effect<"configured" | "path">;
}

/** Optional members a test layer may omit; `makeAssetReaderTestLayer` supplies the defaults. */
type AssetReaderTestDefaults =
	| "catalogProgress"
	| "extractProjectText"
	| "extractProjectTextures"
	| "readSavedWorld"
	| "savedWorldProgress"
	| "scanProgress"
	| "scanProject";

export type AssetReaderTestShape = Omit<AssetReaderShape, AssetReaderTestDefaults> &
	Partial<Pick<AssetReaderShape, AssetReaderTestDefaults>>;

export class AssetReader extends Context.Service<AssetReader, AssetReaderShape>()(
	"@ue-shed/unreal-assets/AssetReader"
) {}

interface ProcessFailure {
	readonly code?: number | string;
	readonly killed?: boolean;
	readonly stdout?: string;
	readonly stderr?: string;
	readonly message?: string;
}

export type SavedPropertyValue =
	| { readonly value_kind: "bool"; readonly value: boolean }
	| { readonly value_kind: "int" | "uint"; readonly value: number }
	| { readonly value_kind: "float" | "double"; readonly value: number | null }
	| {
			readonly value_kind: "name" | "enum" | "string" | "guid" | "soft_object_path";
			readonly value: string;
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "none";
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "base";
			readonly namespace: string;
			readonly key: string;
	  }
	| { readonly value_kind: "object_ref"; readonly value: string | null }
	| {
			readonly value_kind: "data_table_row_handle";
			readonly table_object_path: string | null;
			readonly row_name: string;
	  }
	| {
			readonly value_kind: "vector";
			readonly x: number | null;
			readonly y: number | null;
			readonly z: number | null;
	  }
	| { readonly value_kind: "int_point"; readonly x: number; readonly y: number }
	| {
			readonly value_kind: "rotator";
			readonly pitch: number | null;
			readonly yaw: number | null;
			readonly roll: number | null;
	  }
	| {
			readonly value_kind: "color";
			readonly r: number;
			readonly g: number;
			readonly b: number;
			readonly a: number;
	  }
	| {
			readonly value_kind: "linear_color";
			readonly r: number | null;
			readonly g: number | null;
			readonly b: number | null;
			readonly a: number | null;
	  }
	| { readonly value_kind: "array" | "set"; readonly values: readonly SavedPropertyValue[] }
	| {
			readonly value_kind: "map";
			readonly entries: readonly {
				readonly key: SavedPropertyValue;
				readonly value: SavedPropertyValue;
			}[];
	  }
	| { readonly value_kind: "struct"; readonly properties: readonly SavedProperty[] }
	| { readonly value_kind: "raw"; readonly reason: string; readonly size: number };

export type SavedProperty = SavedPropertyValue & {
	readonly name: string;
	readonly type: string;
};

const SavedPropertyValue: Schema.Codec<SavedPropertyValue> = Schema.suspend(
	() => SavedPropertyValueUnion
).annotate({ identifier: "SavedPropertyValue" });

const SavedProperty: Schema.Codec<SavedProperty> = Schema.suspend(() =>
	SavedPropertyValueUnion.mapMembers(
		Tuple.map(Schema.fieldsAssign({ name: Schema.String, type: Schema.String }))
	)
).annotate({ identifier: "SavedProperty" });

const stringKinds = ["name", "enum", "string", "guid", "soft_object_path"] as const;
// `serde_json` serializes Unreal's NaN and infinity values as JSON null. Keep that explicit at
// this boundary so one uncommon property cannot invalidate its whole package inspection.
const savedFloatingPoint = Schema.NullOr(Schema.Number);

const SavedPropertyValueUnion = Schema.Union([
	Schema.Struct({ value_kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({ value_kind: Schema.Literals(["int", "uint"]), value: Schema.Number }),
	Schema.Struct({ value_kind: Schema.Literals(["float", "double"]), value: savedFloatingPoint }),
	Schema.Struct({ value_kind: Schema.Literals(stringKinds), value: Schema.String }),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("none")
	}),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("base"),
		namespace: Schema.String,
		key: Schema.String
	}),
	Schema.Struct({
		value_kind: Schema.Literal("object_ref"),
		value: Schema.NullOr(Schema.String)
	}),
	Schema.Struct({
		row_name: Schema.String,
		table_object_path: Schema.NullOr(Schema.String),
		value_kind: Schema.Literal("data_table_row_handle")
	}),
	Schema.Struct({
		value_kind: Schema.Literal("vector"),
		x: savedFloatingPoint,
		y: savedFloatingPoint,
		z: savedFloatingPoint
	}),
	Schema.Struct({
		value_kind: Schema.Literal("int_point"),
		x: Schema.Number,
		y: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literal("rotator"),
		pitch: savedFloatingPoint,
		yaw: savedFloatingPoint,
		roll: savedFloatingPoint
	}),
	Schema.Struct({
		value_kind: Schema.Literal("color"),
		r: Schema.Number,
		g: Schema.Number,
		b: Schema.Number,
		a: Schema.Number
	}),
	Schema.Struct({
		value_kind: Schema.Literal("linear_color"),
		r: savedFloatingPoint,
		g: savedFloatingPoint,
		b: savedFloatingPoint,
		a: savedFloatingPoint
	}),
	Schema.Struct({
		value_kind: Schema.Literals(["array", "set"]),
		values: Schema.Array(SavedPropertyValue)
	}),
	Schema.Struct({
		value_kind: Schema.Literal("map"),
		entries: Schema.Array(Schema.Struct({ key: SavedPropertyValue, value: SavedPropertyValue }))
	}),
	Schema.Struct({
		value_kind: Schema.Literal("struct"),
		properties: Schema.Array(SavedProperty)
	}),
	Schema.Struct({
		value_kind: Schema.Literal("raw"),
		reason: Schema.String,
		size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	})
]);

export const SavedAssetDecodeError = Schema.Struct({
	object_path: Schema.String,
	class_path: Schema.optional(Schema.String),
	kind: Schema.Literals([
		"malformed_data",
		"resource_limit",
		"unsupported_format",
		"unsupported_version",
		"unsupported_capability"
	]),
	message: Schema.String
});
export type SavedAssetDecodeError = Schema.Schema.Type<typeof SavedAssetDecodeError>;

export const SavedAssetInspection = Schema.Struct({
	schema_version: Schema.Literal(8),
	status: Schema.Literals(["ok", "partial"]),
	path: Schema.String,
	package: Schema.Struct({
		name: Schema.String,
		version: Schema.Struct({
			legacy_file: Schema.Number,
			legacy_ue3: Schema.Number,
			ue4: Schema.Number,
			ue5: Schema.Number,
			licensee: Schema.Number
		}),
		package_flags: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		summary_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		total_header_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
	}),
	assets: Schema.Array(
		Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("StringTable"),
				object_path: Schema.String,
				string_table_namespace: Schema.String,
				string_table_entries: Schema.Array(
					Schema.Struct({ key: Schema.String, source: Schema.String })
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("UObject"),
				object_path: Schema.String,
				class_path: Schema.String,
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				tail_bytes: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
			}),
			Schema.Struct({
				kind: Schema.Literals(["DataAsset", "PrimaryDataAsset"]),
				object_path: Schema.String,
				class_path: Schema.String,
				object_guid: Schema.optional(Schema.String),
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("CurveTable"),
				object_path: Schema.String,
				class_path: Schema.String,
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				row_count: nonNegativeInt,
				curve_rows: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						keys: Schema.Array(
							Schema.Struct({ time: savedFloatingPoint, value: savedFloatingPoint })
						)
					})
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("Skeleton"),
				object_path: Schema.String,
				class_path: Schema.String,
				object_guid: Schema.optional(Schema.String),
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				bones: Schema.Array(
					Schema.Struct({ name: Schema.String, parent_index: Schema.Int })
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("Enum"),
				object_path: Schema.String,
				class_path: Schema.String,
				enum_cpp_form: Schema.String,
				enum_entries: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						value: Schema.Int,
						display_name: Schema.optional(Schema.String)
					})
				),
				row_count: nonNegativeInt
			}),
			Schema.Struct({
				kind: Schema.Literal("Struct"),
				object_path: Schema.String,
				class_path: Schema.String,
				struct_flags: nonNegativeInt,
				struct_fields: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						type: Schema.String,
						referenced_path: Schema.optional(Schema.String),
						display_name: Schema.optional(Schema.String)
					})
				),
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				row_count: nonNegativeInt
			}),
			Schema.Struct({
				kind: Schema.Literals(["DataTable", "CompositeDataTable"]),
				object_path: Schema.String,
				row_struct: Schema.optional(Schema.String),
				parent_tables: Schema.optional(Schema.Array(Schema.String)),
				row_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
				rows: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						properties: Schema.Array(SavedProperty)
					})
				)
			})
		])
	),
	decode_errors: Schema.Array(SavedAssetDecodeError).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	)
}).annotate({ identifier: "SavedAssetInspection" });
export type SavedAssetInspection = Schema.Schema.Type<typeof SavedAssetInspection>;

const decodeInspection = Schema.decodeUnknownEffect(SavedAssetInspection);

export const SavedAssetCatalogInspection = Schema.Struct({
	assets: Schema.Array(
		Schema.Struct({
			kind: Schema.String,
			object_path: Schema.String,
			parent_tables: Schema.Array(Schema.String).pipe(
				Schema.withDecodingDefaultKey(Effect.succeed([]))
			),
			row_struct: Schema.optional(Schema.String)
		})
	),
	decode_errors: Schema.Array(SavedAssetDecodeError).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	),
	package: Schema.Struct({ name: Schema.String }),
	path: Schema.String,
	schema_version: Schema.Literal(8),
	status: Schema.Literals(["ok", "partial"])
});
export type SavedAssetCatalogInspection = Schema.Schema.Type<typeof SavedAssetCatalogInspection>;

export const SavedTableDescriptor = Schema.Struct({
	assetPath: Schema.String,
	authority: Schema.Struct({ kind: Schema.Literal("project_files"), packageName: Schema.String }),
	completeness: Schema.Literals(["complete", "partial"]),
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rowStruct: Schema.String,
	schema: Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
});
export type SavedTableDescriptor = Schema.Schema.Type<typeof SavedTableDescriptor>;

export const SavedTableCatalog = Schema.Struct({
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			path: Schema.String,
			retrySafe: Schema.Boolean
		})
	),
	projectRoot: Schema.String,
	scannedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tables: Schema.Array(SavedTableDescriptor)
});
export type SavedTableCatalog = Schema.Schema.Type<typeof SavedTableCatalog>;

export const SavedTableCatalogProgress = Schema.Struct({
	cacheHits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	phase: Schema.Literals(["idle", "enumerating", "scanning", "writing_cache", "ready", "failed"]),
	processedAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	tablesFound: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	totalAssets: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
});
export type SavedTableCatalogProgress = Schema.Schema.Type<typeof SavedTableCatalogProgress>;

interface CatalogProgressStore {
	current: SavedTableCatalogProgress;
}

/** One export as the package header knows it. No property stream was decoded to produce this. */
export const SavedAssetHeaderExport = Schema.Struct({
	/**
	 * Trailing segment of `class_path`, e.g. `DataTable` for `/Script/Engine.DataTable`. This is
	 * class identity read from the header, not the decoded-asset taxonomy of `kind` at full depth.
	 */
	class_name: Schema.optional(Schema.String),
	class_path: Schema.optional(Schema.String),
	object_path: Schema.String
});
export type SavedAssetHeaderExport = Schema.Schema.Type<typeof SavedAssetHeaderExport>;

/**
 * One package projected through the scan's class and name filters at header depth. `exports` holds
 * the matching exports (or every export without filters); `matched_names` retains only requested
 * name-table entries that selected this package.
 */
export const SavedAssetHeader = Schema.Struct({
	exports: Schema.Array(SavedAssetHeaderExport).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	),
	matched_names: Schema.optionalKey(Schema.Array(Schema.String)),
	package: Schema.Struct({ name: Schema.String }),
	path: Schema.String,
	schema_version: Schema.Literal(8)
});
export type SavedAssetHeader = Schema.Schema.Type<typeof SavedAssetHeader>;

const savedAssetFullScanEntryFields = {
	depth: Schema.Literal("full"),
	fileBytes: nonNegativeInt,
	inspection: SavedAssetInspection
};

const savedAssetHeaderScanEntryFields = {
	depth: Schema.Literal("header"),
	fileBytes: nonNegativeInt,
	header: SavedAssetHeader
};

/**
 * One selected package from a batched scan, with the package file size the reader already stat-ed.
 *
 * Discriminated on `depth`: a `full` entry carries a decoded `inspection`, a `header` entry carries
 * only the `header` projection. Narrow on `depth` before reaching for either.
 */
export const SavedAssetScanEntry = Schema.Union([
	Schema.Struct(savedAssetFullScanEntryFields),
	Schema.Struct(savedAssetHeaderScanEntryFields)
]);
export type SavedAssetScanEntry = Schema.Schema.Type<typeof SavedAssetScanEntry>;

export type SavedAssetFullScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "full" }>;
export type SavedAssetHeaderScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "header" }>;

/** Narrows to entries carrying a decoded `inspection`, i.e. the result of a `depth: "full"` scan. */
export function isFullScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetFullScanEntry {
	return entry.depth === "full";
}

/** Narrows to entries carrying only a `header` projection, i.e. a `depth: "header"` scan. */
export function isHeaderScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetHeaderScanEntry {
	return entry.depth === "header";
}

const savedAssetScanFailureFields = {
	code: Schema.String,
	message: Schema.String,
	path: Schema.String,
	retrySafe: Schema.Boolean
};

/** One package the reader could not inspect. The scan continues past it. */
export const SavedAssetScanFailure = Schema.Struct(savedAssetScanFailureFields);
export type SavedAssetScanFailure = Schema.Schema.Type<typeof SavedAssetScanFailure>;

const ScanFailureLine = Schema.Struct({
	event: Schema.Literal("error"),
	...savedAssetScanFailureFields
});

const savedAssetScanSummaryFields = {
	/** Packages answered from the header cache rather than re-read. Always 0 without `cachePath`. */
	cacheHits: nonNegativeInt,
	depth: Schema.Literals(["header", "full"]),
	diagnostics: Schema.Array(
		Schema.Struct({
			code: Schema.String,
			message: Schema.String,
			path: Schema.String,
			retrySafe: Schema.Boolean
		})
	),
	emittedAssets: nonNegativeInt,
	failedAssets: nonNegativeInt,
	inventoryComplete: Schema.optionalKey(Schema.Boolean),
	inventoryFiles: Schema.optionalKey(nonNegativeInt),
	partialAssets: nonNegativeInt,
	projectRoot: Schema.String,
	roots: Schema.Array(Schema.String),
	scannedAssets: nonNegativeInt,
	schema_version: Schema.Literal(8),
	skippedAssets: nonNegativeInt
};

export const SavedAssetScanSummary = Schema.Struct(savedAssetScanSummaryFields);
export type SavedAssetScanSummary = Schema.Schema.Type<typeof SavedAssetScanSummary>;

export const SavedAssetScanProgress = Schema.Struct({
	cacheHits: nonNegativeInt,
	emittedAssets: nonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "ready", "failed"]),
	processedAssets: nonNegativeInt,
	totalAssets: nonNegativeInt
});
export type SavedAssetScanProgress = Schema.Schema.Type<typeof SavedAssetScanProgress>;

export interface SavedAssetScan {
	readonly assets: readonly SavedAssetScanEntry[];
	readonly failures: readonly SavedAssetScanFailure[];
	/** Present only when the scan requested `inventory: true`. Sort by path before fingerprinting. */
	readonly inventory?: readonly SavedAssetManifestEntry[];
	readonly summary: SavedAssetScanSummary;
}

const TextExtractionIdentity = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("resolved"),
		namespace: Schema.String,
		key: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("unresolved"),
		reason: Schema.Literals(["culture_invariant", "missing_key"])
	})
]);

const TextExtractionLocation = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("data_table_cell"),
		object_path: Schema.String,
		row: Schema.String,
		property_path: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("string_table_entry"),
		object_path: Schema.String,
		entry_key: Schema.String
	}),
	Schema.Struct({
		kind: Schema.Literal("asset_property"),
		object_path: Schema.String,
		class_path: Schema.String,
		property_path: Schema.String
	})
]);

export const SavedAssetTextOccurrence = Schema.Struct({
	source: Schema.String,
	identity: TextExtractionIdentity,
	location: TextExtractionLocation,
	edit_capability: Schema.Literals(["source_editable", "read_only"])
});
export type SavedAssetTextOccurrence = Schema.Schema.Type<typeof SavedAssetTextOccurrence>;

export const SavedAssetTextCoverageGap = Schema.Struct({
	object_path: Schema.String,
	property_path: Schema.String,
	reason: Schema.Literal("unsupported_text_history")
});
export type SavedAssetTextCoverageGap = Schema.Schema.Type<typeof SavedAssetTextCoverageGap>;

const SavedAssetProjectionDiagnostic = Schema.Struct({
	object_path: Schema.String,
	class_path: Schema.optionalKey(Schema.String),
	code: Schema.Literals([
		"malformed_data",
		"resource_limit",
		"unsupported_format",
		"unsupported_version",
		"unsupported_capability"
	]),
	message: Schema.String
});

const savedAssetProjectionPackageFields = {
	fileBytes: nonNegativeInt,
	path: Schema.String,
	schema_version: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(SavedAssetProjectionDiagnostic)
};

const TextExtractionOccurrenceLine = Schema.Struct({
	event: Schema.Literal("text_occurrence"),
	schema_version: Schema.Literal(1),
	path: Schema.String,
	fileBytes: nonNegativeInt,
	occurrence: SavedAssetTextOccurrence
});

const TextExtractionCoverageGapLine = Schema.Struct({
	event: Schema.Literal("text_coverage_gap"),
	schema_version: Schema.Literal(1),
	path: Schema.String,
	coverage_gap: SavedAssetTextCoverageGap
});

const TextExtractionPackageLine = Schema.Struct({
	event: Schema.Literal("text_package"),
	...savedAssetProjectionPackageFields,
	occurrences: nonNegativeInt,
	coverage_gaps: nonNegativeInt
});

const TextExtractionSummaryLine = Schema.Struct({
	event: Schema.Literal("text_summary"),
	...savedAssetScanSummaryFields,
	depth: Schema.Literal("text")
});

export const SavedAssetTextExtractionEvent = Schema.Union([
	TextExtractionOccurrenceLine,
	TextExtractionCoverageGapLine,
	TextExtractionPackageLine,
	TextExtractionSummaryLine,
	ScanFailureLine
]);
export type SavedAssetTextExtractionEvent = Schema.Schema.Type<
	typeof SavedAssetTextExtractionEvent
>;

const TextureExtractionDimensions = Schema.Struct({
	width: nonNegativeInt,
	height: nonNegativeInt
});

const TextureExtractionEvidence = <S extends Schema.Top>(value: S) =>
	Schema.Union([
		Schema.Struct({
			status: Schema.Literal("available"),
			source: Schema.Literals(["serialized", "file"]),
			value
		}),
		Schema.Struct({
			status: Schema.Literal("unavailable"),
			reason: Schema.Literals(["not_serialized", "wrong_value_kind", "missing_source"])
		})
	]);

export const SavedAssetTextureRecord = Schema.Struct({
	object_path: Schema.String,
	package_file_bytes: TextureExtractionEvidence(nonNegativeInt),
	dimensions: TextureExtractionEvidence(TextureExtractionDimensions),
	source_format: TextureExtractionEvidence(Schema.String),
	source_mips: TextureExtractionEvidence(nonNegativeInt),
	compression: TextureExtractionEvidence(Schema.String),
	s_rgb: TextureExtractionEvidence(Schema.Boolean),
	texture_group: TextureExtractionEvidence(Schema.String),
	mip_generation: TextureExtractionEvidence(Schema.String)
});
export type SavedAssetTextureRecord = Schema.Schema.Type<typeof SavedAssetTextureRecord>;

const TextureExtractionRecordLine = Schema.Struct({
	event: Schema.Literal("texture_record"),
	schema_version: Schema.Literal(1),
	path: Schema.String,
	record: SavedAssetTextureRecord
});

const TextureExtractionPackageLine = Schema.Struct({
	event: Schema.Literal("texture_package"),
	...savedAssetProjectionPackageFields,
	records: nonNegativeInt
});

const TextureExtractionSummaryLine = Schema.Struct({
	event: Schema.Literal("texture_summary"),
	...savedAssetScanSummaryFields,
	depth: Schema.Literal("texture")
});

export const SavedAssetTextureExtractionEvent = Schema.Union([
	TextureExtractionRecordLine,
	TextureExtractionPackageLine,
	TextureExtractionSummaryLine,
	ScanFailureLine
]);
export type SavedAssetTextureExtractionEvent = Schema.Schema.Type<
	typeof SavedAssetTextureExtractionEvent
>;

const decodeSavedWorldProgressLine = Schema.decodeUnknownOption(
	Schema.Struct({ event: Schema.Literal("saved_world_progress"), ...SavedWorldProgress.fields })
);

const ScanAssetLine = Schema.Union([
	Schema.Struct({ event: Schema.Literal("asset"), ...savedAssetFullScanEntryFields }),
	Schema.Struct({ event: Schema.Literal("asset"), ...savedAssetHeaderScanEntryFields })
]);

const ScanInventoryLine = Schema.Struct({
	event: Schema.Literal("inventory"),
	...SavedAssetManifestEntry.fields
});

const ScanSummaryLine = Schema.Struct({
	event: Schema.Literal("summary"),
	...savedAssetScanSummaryFields
});

const decodeScanAssetLine = Schema.decodeUnknownResult(ScanAssetLine);
const decodeScanFailureLine = Schema.decodeUnknownResult(ScanFailureLine);
const decodeScanInventoryLine = Schema.decodeUnknownResult(ScanInventoryLine);
const decodeScanSummaryLine = Schema.decodeUnknownResult(ScanSummaryLine);
const decodeTextExtractionEvent = Schema.decodeUnknownResult(SavedAssetTextExtractionEvent);
const decodeTextureExtractionEvent = Schema.decodeUnknownResult(SavedAssetTextureExtractionEvent);
const decodeScanProgressLine = Schema.decodeUnknownOption(
	Schema.Struct({
		event: Schema.Literal("scan_progress"),
		...SavedAssetScanProgress.fields
	})
);

interface ScanProgressStore {
	current: SavedAssetScanProgress;
}

interface SavedWorldProgressStore {
	current: SavedWorldProgress;
}

const idleScanProgress = (): SavedAssetScanProgress => ({
	cacheHits: 0,
	emittedAssets: 0,
	phase: "idle",
	processedAssets: 0,
	totalAssets: 0
});

const idleCatalogProgress = (): SavedTableCatalogProgress => ({
	cacheHits: 0,
	phase: "idle",
	processedAssets: 0,
	tablesFound: 0,
	totalAssets: 0
});

const idleSavedWorldProgress = (): SavedWorldProgress => ({
	actorsFound: 0,
	phase: "idle",
	processedPackages: 0,
	totalPackages: 0
});

export const decodeSavedAssetCatalogInspection = Schema.decodeUnknownEffect(
	SavedAssetCatalogInspection
);

export function savedTableDescriptorsFromInspection(
	inspection: SavedAssetCatalogInspection
): readonly SavedTableDescriptor[] {
	return inspection.assets.flatMap((asset): SavedTableDescriptor[] => {
		if (asset.kind !== "DataTable" && asset.kind !== "CompositeDataTable") return [];
		return [
			{
				assetPath: inspection.path,
				authority: { kind: "project_files", packageName: inspection.package.name },
				completeness: inspection.status === "partial" ? "partial" : "complete",
				kind: asset.kind === "DataTable" ? "data_table" : "composite_data_table",
				objectPath: asset.object_path,
				parentTables: asset.parent_tables,
				rowStruct: asset.row_struct ?? "",
				schema: {
					reason: "Saved row-structure schema has not been resolved for this table.",
					status: "unavailable"
				}
			}
		];
	});
}

export function decodeSavedAssetInspection(input: unknown) {
	return decodeInspection(input);
}

function invokeReader(
	configuration: AssetReaderConfiguration,
	assetPath: string,
	operation: "authoring" | "inspect"
): Effect.Effect<string, AssetReaderError> {
	const args = [operation, assetPath, "--format", "json"];
	return Effect.tryPromise({
		try: async (signal) => {
			try {
				const result = await execFileAsync(configuration.executable, args, {
					encoding: "utf8",
					maxBuffer: MAX_OUTPUT_BYTES,
					signal,
					timeout: configuration.timeoutMs,
					windowsHide: true
				});
				return result.stdout;
			} catch (cause) {
				const failure = cause as ProcessFailure;
				if (failure.code === 6 && failure.stdout) return failure.stdout;
				throw cause;
			}
		},
		catch: (cause) => {
			const failure = cause as ProcessFailure;
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation,
				message: timedOut
					? `Asset reader timed out after ${configuration.timeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Asset reader failed",
				path: assetPath,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function scanArguments(options: SavedAssetScanOptions, pathList?: string): string[] {
	const args = [
		"scan",
		options.projectRoot,
		"--format",
		"json",
		"--concurrency",
		String(Math.max(1, options.concurrency ?? 8))
	];
	if (options.depth !== undefined) args.push("--depth", options.depth);
	if (options.cachePath !== undefined) args.push("--cache", options.cachePath);
	if (options.inventory === true) args.push("--inventory");
	if (options.maximumAssets !== undefined) {
		args.push("--maximum-assets", String(options.maximumAssets));
	}
	if (pathList === undefined) {
		for (const path of options.paths ?? []) args.push("--path", path);
	} else args.push("--path-list", pathList);
	for (const value of options.classes ?? []) args.push("--class", value);
	for (const value of options.classPrefixes ?? []) args.push("--class-prefix", value);
	for (const value of options.classNameSuffixes ?? []) {
		args.push("--class-name-suffix", value);
	}
	for (const value of options.names ?? []) args.push("--name", value);
	return args;
}

interface ScanInvocation {
	readonly arguments: readonly string[];
	readonly removePathList: () => Promise<void>;
}

async function preparePathListInvocation(options: {
	readonly arguments: (pathList?: string) => readonly string[];
	readonly paths: readonly string[] | undefined;
}): Promise<ScanInvocation> {
	const paths = options.paths ?? [];
	if (paths.length === 0) {
		return { arguments: options.arguments(), removePathList: async () => undefined };
	}
	const directory = await mkdtemp(join(tmpdir(), "ue-shed-scan-paths-"));
	const pathList = join(directory, "paths.json");
	try {
		await writeFile(pathList, JSON.stringify(paths), "utf8");
		return {
			arguments: options.arguments(pathList),
			removePathList: () => rm(directory, { force: true, recursive: true })
		};
	} catch (cause) {
		await rm(directory, { force: true, recursive: true }).catch(() => undefined);
		throw cause;
	}
}

/**
 * Keeps an index-derived package list out of the OS command line. A target list can be thousands
 * of absolute paths on a real project; on Windows that otherwise fails before the reader starts.
 */
async function prepareScanInvocation(options: SavedAssetScanOptions): Promise<ScanInvocation> {
	return preparePathListInvocation({
		arguments: (pathList) => scanArguments(options, pathList),
		paths: options.paths
	});
}

type SavedAssetProjectionKind = "text" | "texture";

const STRING_TABLE_CLASS = "/Script/Engine.StringTable";
const TEXT_PROPERTY_NAME = "TextProperty";
const TEXTURE2D_CLASS = "/Script/Engine.Texture2D";

function projectionArguments(
	options: SavedAssetExtractionOptions,
	projection: SavedAssetProjectionKind,
	pathList?: string
): readonly string[] {
	const args = [
		"scan",
		options.projectRoot,
		"--format",
		"json",
		"--concurrency",
		String(Math.max(1, options.concurrency ?? 8)),
		"--projection",
		projection
	];
	if (options.maximumAssets !== undefined) {
		args.push("--maximum-assets", String(options.maximumAssets));
	}
	if (pathList !== undefined) {
		args.push("--path-list", pathList);
	} else if (options.paths !== undefined) {
		for (const path of options.paths) args.push("--path", path);
	} else if (projection === "text") {
		args.push("--class", STRING_TABLE_CLASS, "--name", TEXT_PROPERTY_NAME);
	} else {
		args.push("--class", TEXTURE2D_CLASS);
	}
	return args;
}

async function prepareProjectionInvocation(
	options: SavedAssetExtractionOptions,
	projection: SavedAssetProjectionKind
): Promise<ScanInvocation> {
	return preparePathListInvocation({
		arguments: (pathList) => projectionArguments(options, projection, pathList),
		paths: options.paths
	});
}

function savedWorldArguments(options: SavedWorldReadOptions): string[] {
	const args = [
		"saved-world",
		options.projectRoot,
		options.mapPath,
		"--format",
		"json",
		"--concurrency",
		String(Math.max(1, options.concurrency ?? 8))
	];
	if (options.maximumAssets !== undefined) {
		args.push("--maximum-assets", String(options.maximumAssets));
	}
	return args;
}

interface SavedWorldFailure extends ProcessFailure {
	readonly contract?: string;
	readonly discovery?: boolean;
	readonly resourceLimit?: boolean;
}

function invokeSavedWorldReader(
	configuration: AssetReaderConfiguration,
	options: SavedWorldReadOptions,
	progress: SavedWorldProgressStore
): Effect.Effect<SavedWorld, AssetReaderError> {
	return Effect.tryPromise({
		try: (signal) =>
			new Promise<string>((resolvePromise, rejectPromise) => {
				progress.current = { ...idleSavedWorldProgress(), phase: "enumerating" };
				const child = spawn(configuration.executable, savedWorldArguments(options), {
					signal,
					timeout: configuration.catalogTimeoutMs,
					windowsHide: true
				});
				let stdout = "";
				let stderr = "";
				let stderrLine = "";
				let settled = false;
				const rejectOnce = (failure: SavedWorldFailure) => {
					if (settled) return;
					settled = true;
					progress.current = { ...progress.current, phase: "failed" };
					child.kill();
					rejectPromise(failure);
				};
				const consumeStderrLine = (line: string) => {
					if (line.trim().length === 0) return;
					try {
						const decoded = decodeSavedWorldProgressLine(JSON.parse(line) as unknown);
						if (Option.isSome(decoded)) {
							const { event: _event, ...current } = decoded.value;
							progress.current = current;
							return;
						}
					} catch {
						// Preserve non-progress stderr below as the process diagnostic.
					}
					stderr += `${line}\n`;
				};
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					stdout += chunk;
					if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
						rejectOnce({ message: "Saved world output exceeded 64 MiB" });
					}
				});
				child.stderr.on("data", (chunk: string) => {
					stderrLine += chunk;
					const lines = stderrLine.split(/\r?\n/);
					stderrLine = lines.pop() ?? "";
					for (const line of lines) consumeStderrLine(line);
				});
				child.once("error", (cause) => rejectOnce({ message: cause.message }));
				child.once("close", (code, childSignal) => {
					if (stderrLine.length > 0) consumeStderrLine(stderrLine);
					if (settled) return;
					settled = true;
					if (code === 0 || code === 6) {
						progress.current = { ...progress.current, phase: "ready" };
						resolvePromise(stdout);
						return;
					}
					progress.current = { ...progress.current, phase: "failed" };
					rejectPromise({
						...(typeof code === "number" ? { code } : {}),
						discovery: code === 4,
						killed: childSignal !== null,
						message: `Saved world reader exited ${code ?? childSignal ?? "without a status"}`,
						resourceLimit: code === 7,
						stderr
					});
				});
			}),
		catch: (cause) => {
			const failure = cause as SavedWorldFailure;
			if (failure.contract !== undefined) {
				return new AssetReaderError({
					kind: "contract",
					operation: "saved_world",
					message: failure.contract,
					path: options.mapPath,
					retrySafe: false
				});
			}
			if (failure.resourceLimit === true) {
				return new AssetReaderError({
					kind: "resource_limit",
					operation: "saved_world",
					message:
						failure.message ?? "Saved world exceeded the maximum external actor limit",
					path: options.mapPath,
					retrySafe: false,
					exitCode: 7
				});
			}
			if (failure.discovery === true) {
				return new AssetReaderError({
					kind: "discovery",
					operation: "saved_world",
					message:
						failure.stderr?.trim() ||
						failure.message ||
						"Saved world could not be read",
					path: options.mapPath,
					retrySafe: true,
					exitCode: 4
				});
			}
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation: "saved_world",
				message: timedOut
					? `Saved world reader timed out after ${configuration.catalogTimeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Saved world reader failed",
				path: options.mapPath,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	}).pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath: options.mapPath,
				operation: "saved_world",
				stdout,
				decode: decodeSavedWorld
			})
		),
		Effect.withSpan("unreal_assets.read_saved_world", {
			attributes: { "unreal.project_root": options.projectRoot }
		})
	);
}

interface ScanFailure extends ProcessFailure {
	readonly contract?: string;
	readonly discovery?: boolean;
	readonly resourceLimit?: boolean;
}

/** Pulls a structured reader error of one kind out of accumulated stderr. */
function structuredErrorMessage(stderr: string, kind: string): string | undefined {
	for (const line of stderr.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as { kind?: string; message?: string; status?: string };
			if (parsed.status === "error" && parsed.kind === kind) return parsed.message;
		} catch {
			// Non-JSON stderr is reported verbatim by the caller instead.
		}
	}
	return undefined;
}

interface ProjectionDecodeResult<A> {
	readonly _tag: "Failure" | "Success";
	readonly failure?: unknown;
	readonly success?: A;
}

class ProjectionReaderFailure extends Error {
	constructor(
		readonly kind: "contract" | "discovery" | "process" | "resource_limit",
		message: string,
		readonly exitCode?: number
	) {
		super(message);
	}
}

function projectionReaderError(
	cause: unknown,
	options: SavedAssetExtractionOptions,
	projection: SavedAssetProjectionKind
): AssetReaderError {
	const operation = projection === "text" ? "extract_text" : "extract_texture";
	if (cause instanceof ProjectionReaderFailure) {
		return new AssetReaderError({
			kind: cause.kind,
			operation,
			message: cause.message,
			path: options.projectRoot,
			retrySafe: cause.kind === "discovery" || cause.kind === "process",
			...(cause.exitCode === undefined ? {} : { exitCode: cause.exitCode })
		});
	}
	return new AssetReaderError({
		kind: "process",
		operation,
		message: cause instanceof Error ? cause.message : String(cause),
		path: options.projectRoot,
		retrySafe: false
	});
}

async function* projectionEvents<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly decode: (input: unknown) => ProjectionDecodeResult<A>;
	readonly extraction: SavedAssetExtractionOptions;
	readonly projection: SavedAssetProjectionKind;
}): AsyncGenerator<A> {
	const invocation = await prepareProjectionInvocation(options.extraction, options.projection);
	const child = spawn(options.configuration.executable, invocation.arguments, {
		timeout: options.configuration.catalogTimeoutMs,
		windowsHide: true
	});
	let closed = false;
	let stderr = "";
	let stderrLine = "";
	const appendStderr = (line: string) => {
		if (stderr.length < MAX_OUTPUT_BYTES) stderr += `${line}\n`;
	};
	const closedPromise = new Promise<{
		readonly code: number | null;
		readonly signal: string | null;
	}>((resolvePromise, rejectPromise) => {
		child.once("error", (cause) =>
			rejectPromise(new ProjectionReaderFailure("process", cause.message))
		);
		child.once("close", (code, signal) => {
			closed = true;
			resolvePromise({ code, signal });
		});
	});
	try {
		if (child.stdout === null || child.stderr === null) {
			throw new ProjectionReaderFailure(
				"process",
				"Asset reader did not expose stdout and stderr"
			);
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderrLine += chunk;
			const lines = stderrLine.split(/\r?\n/);
			stderrLine = lines.pop() ?? "";
			for (const line of lines) appendStderr(line);
		});

		let stdoutLine = "";
		for await (const chunk of child.stdout) {
			stdoutLine += chunk;
			if (Buffer.byteLength(stdoutLine, "utf8") > MAX_OUTPUT_BYTES) {
				throw new ProjectionReaderFailure(
					"contract",
					"A compact extraction output line exceeded 64 MiB"
				);
			}
			const lines = stdoutLine.split(/\r?\n/);
			stdoutLine = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim().length === 0) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line) as unknown;
				} catch (cause) {
					throw new ProjectionReaderFailure(
						"contract",
						`Invalid compact extraction output line: ${String(cause)}`
					);
				}
				const decoded = options.decode(parsed);
				if (decoded._tag === "Failure" || decoded.success === undefined) {
					throw new ProjectionReaderFailure(
						"contract",
						`Invalid compact extraction event: ${String(decoded.failure)}`
					);
				}
				yield decoded.success;
			}
		}
		if (stdoutLine.trim().length > 0) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(stdoutLine) as unknown;
			} catch (cause) {
				throw new ProjectionReaderFailure(
					"contract",
					`Invalid compact extraction output line: ${String(cause)}`
				);
			}
			const decoded = options.decode(parsed);
			if (decoded._tag === "Failure" || decoded.success === undefined) {
				throw new ProjectionReaderFailure(
					"contract",
					`Invalid compact extraction event: ${String(decoded.failure)}`
				);
			}
			yield decoded.success;
		}

		const { code, signal } = await closedPromise;
		if (stderrLine.length > 0) appendStderr(stderrLine);
		if (code === 0 || code === 6) return;
		if (code === 7) {
			throw new ProjectionReaderFailure(
				"resource_limit",
				structuredErrorMessage(stderr, "resource_limit") ??
					"Compact extraction exceeded the maximum asset limit",
				code
			);
		}
		if (code === 4) {
			throw new ProjectionReaderFailure(
				"discovery",
				structuredErrorMessage(stderr, "io") ??
					"Compact extraction could not enumerate the project",
				code
			);
		}
		throw new ProjectionReaderFailure(
			"process",
			stderr.trim() || `Compact extraction exited ${code ?? signal ?? "without a status"}`,
			code ?? undefined
		);
	} finally {
		if (!closed && !child.killed) child.kill();
		await invocation.removePathList();
	}
}

function invokeProjectionReader<A>(options: {
	readonly configuration: AssetReaderConfiguration;
	readonly decode: (input: unknown) => ProjectionDecodeResult<A>;
	readonly extraction: SavedAssetExtractionOptions;
	readonly projection: SavedAssetProjectionKind;
}): Stream.Stream<A, AssetReaderError> {
	return Stream.fromAsyncIterable(projectionEvents(options), (cause) =>
		projectionReaderError(cause, options.extraction, options.projection)
	).pipe(
		Stream.withSpan(`unreal_assets.extract_${options.projection}`, {
			attributes: { "unreal.project_root": options.extraction.projectRoot }
		})
	);
}

/**
 * Runs one batched scan in a single reader process, decoding newline-delimited JSON as it
 * arrives. Replaces one process per package with one process per scan.
 */
function invokeScanReader(
	configuration: AssetReaderConfiguration,
	options: SavedAssetScanOptions,
	progress: ScanProgressStore
): Effect.Effect<SavedAssetScan, AssetReaderError> {
	return Effect.tryPromise({
		try: async (signal) => {
			const invocation = await prepareScanInvocation(options);
			try {
				return await new Promise<SavedAssetScan>((resolvePromise, rejectPromise) => {
					progress.current = { ...idleScanProgress(), phase: "enumerating" };
					const child = spawn(configuration.executable, invocation.arguments, {
						signal,
						timeout: configuration.catalogTimeoutMs,
						windowsHide: true
					});
					const assets: SavedAssetScanEntry[] = [];
					const failures: SavedAssetScanFailure[] = [];
					const inventory: SavedAssetManifestEntry[] = [];
					let summary: SavedAssetScanSummary | undefined;
					let stdoutLine = "";
					let stderrLine = "";
					let stderr = "";
					let settled = false;
					const rejectOnce = (failure: ScanFailure) => {
						if (settled) return;
						settled = true;
						progress.current = { ...progress.current, phase: "failed" };
						child.kill();
						rejectPromise(failure);
					};
					const consumeAssetLine = (line: string) => {
						if (settled || line.trim().length === 0) return;
						let parsed: unknown;
						try {
							parsed = JSON.parse(line) as unknown;
						} catch (cause) {
							rejectOnce({ contract: `Invalid scan output line: ${String(cause)}` });
							return;
						}
						const event = (parsed as { event?: unknown }).event;
						if (event === "asset") {
							const decoded = decodeScanAssetLine(parsed);
							if (decoded._tag === "Failure") {
								rejectOnce({ contract: `Invalid scan asset: ${decoded.failure}` });
								return;
							}
							const { event: _assetEvent, ...entry } = decoded.success;
							assets.push(entry);
							return;
						}
						if (event === "error") {
							const decoded = decodeScanFailureLine(parsed);
							if (decoded._tag === "Failure") {
								rejectOnce({ contract: `Invalid scan error: ${decoded.failure}` });
								return;
							}
							const { event: _event, ...failure } = decoded.success;
							failures.push(failure);
							return;
						}
						if (event === "inventory") {
							const decoded = decodeScanInventoryLine(parsed);
							if (decoded._tag === "Failure") {
								rejectOnce({
									contract: `Invalid scan inventory: ${decoded.failure}`
								});
								return;
							}
							const { event: _event, ...entry } = decoded.success;
							inventory.push(entry);
							return;
						}
						if (event === "summary") {
							const decoded = decodeScanSummaryLine(parsed);
							if (decoded._tag === "Failure") {
								rejectOnce({
									contract: `Invalid scan summary: ${decoded.failure}`
								});
								return;
							}
							const { event: _event, ...decodedSummary } = decoded.success;
							summary = decodedSummary;
							return;
						}
						rejectOnce({ contract: `Unknown scan event ${JSON.stringify(event)}` });
					};
					const consumeStderrLine = (line: string) => {
						if (line.trim().length === 0) return;
						try {
							const decoded = decodeScanProgressLine(JSON.parse(line) as unknown);
							if (Option.isSome(decoded)) {
								const { event: _event, ...current } = decoded.value;
								progress.current = current;
								return;
							}
						} catch {
							// Preserve non-progress stderr below as the process diagnostic.
						}
						stderr += `${line}\n`;
					};
					child.stdout.setEncoding("utf8");
					child.stderr.setEncoding("utf8");
					child.stdout.on("data", (chunk: string) => {
						stdoutLine += chunk;
						if (Buffer.byteLength(stdoutLine, "utf8") > MAX_OUTPUT_BYTES) {
							rejectOnce({ message: "A single scan output line exceeded 64 MiB" });
							return;
						}
						const lines = stdoutLine.split(/\r?\n/);
						stdoutLine = lines.pop() ?? "";
						for (const line of lines) consumeAssetLine(line);
					});
					child.stderr.on("data", (chunk: string) => {
						stderrLine += chunk;
						const lines = stderrLine.split(/\r?\n/);
						stderrLine = lines.pop() ?? "";
						for (const line of lines) consumeStderrLine(line);
					});
					child.once("error", (cause) => rejectOnce({ message: cause.message }));
					child.once("close", (code, childSignal) => {
						if (stdoutLine.length > 0) consumeAssetLine(stdoutLine);
						if (stderrLine.length > 0) consumeStderrLine(stderrLine);
						if (settled) return;
						settled = true;
						if (code === 7) {
							progress.current = { ...progress.current, phase: "failed" };
							rejectPromise({
								code,
								message:
									structuredErrorMessage(stderr, "resource_limit") ??
									"Scan exceeded the maximum asset limit",
								resourceLimit: true
							});
							return;
						}
						// The reader exits 4 when a scan root cannot be enumerated, which is a
						// misconfigured project rather than a reader fault.
						if (code === 4) {
							progress.current = { ...progress.current, phase: "failed" };
							rejectPromise({
								code,
								discovery: true,
								message:
									structuredErrorMessage(stderr, "io") ??
									"Scan could not enumerate the project"
							});
							return;
						}
						// The reader exits 6 when some package was partial or unreadable. The scan
						// still produced every package it could read, so that is a partial success.
						if (code !== 0 && code !== 6) {
							progress.current = { ...progress.current, phase: "failed" };
							rejectPromise({
								...(typeof code === "number" ? { code } : {}),
								killed: childSignal !== null,
								message: `Asset scan exited ${code ?? childSignal ?? "without a status"}`,
								stderr
							});
							return;
						}
						if (summary === undefined) {
							progress.current = { ...progress.current, phase: "failed" };
							rejectPromise({ contract: "Scan output ended without a summary line" });
							return;
						}
						progress.current = { ...progress.current, phase: "ready" };
						resolvePromise({ assets, failures, inventory, summary });
					});
				});
			} finally {
				await invocation.removePathList();
			}
		},
		catch: (cause) => {
			const failure = cause as ScanFailure;
			if (failure.contract !== undefined) {
				return new AssetReaderError({
					kind: "contract",
					operation: "scan",
					message: failure.contract,
					path: options.projectRoot,
					retrySafe: false
				});
			}
			if (failure.resourceLimit === true) {
				return new AssetReaderError({
					kind: "resource_limit",
					operation: "scan",
					message: failure.message ?? "Scan exceeded the maximum asset limit",
					path: options.projectRoot,
					retrySafe: false,
					exitCode: 7
				});
			}
			if (failure.discovery === true) {
				return new AssetReaderError({
					kind: "discovery",
					operation: "scan",
					message: failure.message ?? "Scan could not enumerate the project",
					path: options.projectRoot,
					retrySafe: true,
					exitCode: 4
				});
			}
			const timedOut = failure.killed === true || failure.code === "ETIMEDOUT";
			return new AssetReaderError({
				kind: timedOut ? "timeout" : "process",
				operation: "scan",
				message: timedOut
					? `Asset scan timed out after ${configuration.catalogTimeoutMs}ms`
					: failure.stderr?.trim() || failure.message || "Asset scan failed",
				path: options.projectRoot,
				retrySafe: timedOut,
				...(typeof failure.code === "number" ? { exitCode: failure.code } : {})
			});
		}
	});
}

function decodeOutput<A>(options: {
	readonly assetPath: string;
	readonly operation: "authoring" | "catalog" | "inspect" | "saved_world";
	readonly stdout: string;
	readonly decode: (input: unknown) => Effect.Effect<A, unknown>;
}): Effect.Effect<A, AssetReaderError> {
	return Effect.try({
		try: () => JSON.parse(options.stdout) as unknown,
		catch: (cause) =>
			new AssetReaderError({
				kind: "contract",
				operation: options.operation,
				message: `Invalid ${options.operation} output: ${String(cause)}`,
				path: options.assetPath,
				retrySafe: false
			})
	}).pipe(
		Effect.flatMap((input) =>
			options.decode(input).pipe(
				Effect.mapError(
					(cause) =>
						new AssetReaderError({
							kind: "contract",
							operation: options.operation,
							message: `Invalid ${options.operation} output: ${String(cause)}`,
							path: options.assetPath,
							retrySafe: false
						})
				)
			)
		)
	);
}

function readSavedTableWith(
	configuration: AssetReaderConfiguration,
	assetPath: string
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError> {
	return invokeReader(configuration, assetPath, "authoring").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath,
				operation: "authoring",
				stdout,
				decode: decodeAuthoringTableSnapshot
			})
		)
	);
}

function readSavedAssetWith(
	configuration: AssetReaderConfiguration,
	assetPath: string
): Effect.Effect<SavedAssetInspection, AssetReaderError> {
	return invokeReader(configuration, assetPath, "inspect").pipe(
		Effect.flatMap((stdout) =>
			decodeOutput({
				assetPath,
				operation: "inspect",
				stdout,
				decode: decodeSavedAssetInspection
			})
		)
	);
}

function discoverSavedAssetsWith(projectRoot: string): Effect.Effect<string[], AssetReaderError> {
	const contentRoot = join(projectRoot, "Content");
	return Effect.tryPromise({
		try: async () => {
			const found: string[] = [];
			const visit = async (directory: string): Promise<void> => {
				const entries = await readdir(directory, { withFileTypes: true });
				entries.sort((left, right) => left.name.localeCompare(right.name));
				for (const entry of entries) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) await visit(path);
					else if (
						entry.isFile() &&
						[".uasset", ".umap"].includes(extname(entry.name).toLowerCase())
					)
						found.push(path);
				}
			};
			await visit(contentRoot);
			return found;
		},
		catch: (cause) =>
			new AssetReaderError({
				kind: "discovery",
				operation: "discovery",
				message: `Could not discover saved assets: ${String(cause)}`,
				path: contentRoot,
				retrySafe: true
			})
	});
}

const DATA_TABLE_CLASS = "/Script/Engine.DataTable";
const COMPOSITE_DATA_TABLE_CLASS = "/Script/Engine.CompositeDataTable";

const HEADER_SCHEMA_UNAVAILABLE = {
	reason: "Catalog metadata is header-only; open the table to decode its saved schema.",
	status: "unavailable"
} as const;

/**
 * Republishes scan progress as catalog progress, so a caller polling `catalogProgress` keeps
 * working now that the catalog is a projection of the generic scan.
 *
 * `tablesFound` counts emitted *packages*, not tables. A package exporting two DataTables advances
 * it by one. It drives a progress indicator, not a result count.
 */
function catalogProgressBridge(catalog: CatalogProgressStore): ScanProgressStore {
	let latest = idleScanProgress();
	return {
		get current(): SavedAssetScanProgress {
			return latest;
		},
		set current(next: SavedAssetScanProgress) {
			latest = next;
			catalog.current = {
				cacheHits: next.cacheHits,
				phase: next.phase,
				processedAssets: next.processedAssets,
				tablesFound: next.emittedAssets,
				totalAssets: next.totalAssets
			};
		}
	};
}

export const SAVED_TABLE_SCAN_CLASSES = [DATA_TABLE_CLASS, COMPOSITE_DATA_TABLE_CLASS] as const;

function tableDescriptorsFrom(entry: SavedAssetScanEntry): SavedTableDescriptor[] {
	if (!isHeaderScanEntry(entry)) return [];
	return entry.header.exports.flatMap((exported) => {
		const kind =
			exported.class_path === COMPOSITE_DATA_TABLE_CLASS
				? ("composite_data_table" as const)
				: exported.class_path === DATA_TABLE_CLASS
					? ("data_table" as const)
					: undefined;
		if (kind === undefined) return [];
		return [
			{
				assetPath: entry.header.path,
				authority: {
					kind: "project_files" as const,
					packageName: entry.header.package.name
				},
				// Header depth reads no property stream, so the row struct and parent tables stay
				// unknown until a table is opened. The dedicated catalog reader was no different.
				completeness: "partial" as const,
				kind,
				objectPath: exported.object_path,
				parentTables: [],
				rowStruct: "",
				schema: HEADER_SCHEMA_UNAVAILABLE
			}
		];
	});
}

/** A pure DataTable projection of a header scan. No filesystem or process operation occurs here. */
export function savedTableCatalogFromScan(scan: SavedAssetScan): SavedTableCatalog {
	return {
		diagnostics: [
			...scan.summary.diagnostics,
			...scan.failures.map(({ code, message, path, retrySafe }) => ({
				code,
				message,
				path,
				retrySafe
			}))
		],
		projectRoot: scan.summary.projectRoot,
		scannedAssets: scan.summary.scannedAssets,
		tables: scan.assets
			.flatMap(tableDescriptorsFrom)
			.sort((left, right) => left.objectPath.localeCompare(right.objectPath))
	};
}

/**
 * Discovers saved DataTables as a projection of the generic header-depth scan.
 *
 * This used to be a dedicated `catalog` subcommand that enumerated the project a second time with
 * its own cache. Selecting the DataTable classes at header depth answers the same question from the
 * shared scan, measurably faster, and leaves one project enumeration instead of two.
 */
function discoverSavedTablesWith(
	configuration: AssetReaderConfiguration,
	options: SavedTableCatalogOptions,
	progress: CatalogProgressStore
): Effect.Effect<SavedTableCatalog, AssetReaderError> {
	return invokeScanReader(
		configuration,
		{
			...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
			classes: SAVED_TABLE_SCAN_CLASSES,
			...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
			depth: "header",
			projectRoot: options.projectRoot
		},
		catalogProgressBridge(progress)
	).pipe(
		Effect.map(savedTableCatalogFromScan),
		Effect.withSpan("unreal_assets.discover_saved_tables", {
			attributes: { "unreal.project_root": options.projectRoot }
		})
	);
}

function makeAssetReader(
	configuration: AssetReaderConfiguration & { readonly source: "configured" | "path" },
	progress: CatalogProgressStore,
	scanStore: ScanProgressStore,
	savedWorldStore: SavedWorldProgressStore
): AssetReaderShape {
	const catalogProgress = Effect.fn("AssetReader.catalogProgress")(() =>
		Effect.sync(() => progress.current)
	);
	const scanProgress = Effect.fn("AssetReader.scanProgress")(() =>
		Effect.sync(() => scanStore.current)
	);
	const savedWorldProgress = Effect.fn("AssetReader.savedWorldProgress")(() =>
		Effect.sync(() => savedWorldStore.current)
	);
	const scanProject = Effect.fn("AssetReader.scanProject")(function* (
		options: SavedAssetScanOptions
	) {
		return yield* invokeScanReader(configuration, options, scanStore).pipe(
			Effect.withSpan("unreal_assets.scan_project", {
				attributes: { "unreal.project_root": options.projectRoot }
			})
		);
	});
	const extractProjectText = (options: SavedAssetExtractionOptions) =>
		options.paths?.length === 0
			? Stream.empty
			: invokeProjectionReader({
					configuration,
					decode: decodeTextExtractionEvent,
					extraction: options,
					projection: "text"
				});
	const extractProjectTextures = (options: SavedAssetExtractionOptions) =>
		options.paths?.length === 0
			? Stream.empty
			: invokeProjectionReader({
					configuration,
					decode: decodeTextureExtractionEvent,
					extraction: options,
					projection: "texture"
				});
	const discoverAssets = Effect.fn("AssetReader.discoverAssets")(function* (projectRoot: string) {
		return yield* discoverSavedAssetsWith(projectRoot);
	});
	const readAsset = Effect.fn("AssetReader.readAsset")(function* (assetPath: string) {
		return yield* readSavedAssetWith(configuration, assetPath);
	});
	const readTable = Effect.fn("AssetReader.readTable")(function* (assetPath: string) {
		return yield* readSavedTableWith(configuration, assetPath);
	});
	const readSavedWorld = Effect.fn("AssetReader.readSavedWorld")(function* (
		options: SavedWorldReadOptions
	) {
		return yield* invokeSavedWorldReader(configuration, options, savedWorldStore);
	});
	const discoverTables = Effect.fn("AssetReader.discoverTables")(function* (
		options: SavedTableCatalogOptions
	) {
		return yield* discoverSavedTablesWith(configuration, options, progress);
	});
	const source = Effect.fn("AssetReader.source")(() => Effect.succeed(configuration.source));
	return AssetReader.of({
		catalogProgress,
		discoverAssets,
		discoverTables,
		extractProjectText,
		extractProjectTextures,
		readAsset,
		readSavedWorld,
		readTable,
		scanProgress,
		scanProject,
		savedWorldProgress,
		source
	});
}

export function assetReaderLayer(
	configuration: Partial<AssetReaderConfiguration> = {}
): Layer.Layer<AssetReader> {
	return Layer.sync(AssetReader, () =>
		makeAssetReader(
			{
				catalogTimeoutMs: configuration.catalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
				executable: configuration.executable ?? "uasset",
				source: configuration.executable === undefined ? "path" : "configured",
				timeoutMs: configuration.timeoutMs ?? DEFAULT_TIMEOUT_MS
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		)
	);
}

const readerExecutable = Config.option(Config.string("UE_SHED_UASSET_EXECUTABLE"));
const readerTimeout = Config.duration("UE_SHED_UASSET_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_TIMEOUT_MS))
);
const readerCatalogTimeout = Config.duration("UE_SHED_UASSET_CATALOG_TIMEOUT").pipe(
	Config.withDefault(Duration.millis(DEFAULT_CATALOG_TIMEOUT_MS))
);

export const AssetReaderLive = Layer.effect(
	AssetReader,
	Effect.gen(function* () {
		const executable = yield* readerExecutable;
		return makeAssetReader(
			{
				catalogTimeoutMs: Duration.toMillis(yield* readerCatalogTimeout),
				executable: Option.getOrElse(executable, () => "uasset"),
				source: Option.isSome(executable) ? "configured" : "path",
				timeoutMs: Duration.toMillis(yield* readerTimeout)
			},
			{ current: idleCatalogProgress() },
			{ current: idleScanProgress() },
			{ current: idleSavedWorldProgress() }
		);
	})
);

export function makeAssetReaderTestLayer(service: AssetReaderTestShape): Layer.Layer<AssetReader> {
	return Layer.succeed(
		AssetReader,
		AssetReader.of({
			catalogProgress:
				service.catalogProgress ?? (() => Effect.succeed(idleCatalogProgress())),
			extractProjectText:
				service.extractProjectText ??
				((options) =>
					Stream.fail(
						new AssetReaderError({
							kind: "process",
							operation: "extract_text",
							message: "This test asset reader does not stub extractProjectText.",
							path: options.projectRoot,
							retrySafe: false
						})
					)),
			extractProjectTextures:
				service.extractProjectTextures ??
				((options) =>
					Stream.fail(
						new AssetReaderError({
							kind: "process",
							operation: "extract_texture",
							message: "This test asset reader does not stub extractProjectTextures.",
							path: options.projectRoot,
							retrySafe: false
						})
					)),
			savedWorldProgress:
				service.savedWorldProgress ?? (() => Effect.succeed(idleSavedWorldProgress())),
			scanProgress: service.scanProgress ?? (() => Effect.succeed(idleScanProgress())),
			readSavedWorld:
				service.readSavedWorld ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "saved_world",
						message: "This test asset reader does not stub readSavedWorld.",
						path: options.mapPath,
						retrySafe: false
					})),
			scanProject:
				service.scanProject ??
				((options) =>
					new AssetReaderError({
						kind: "process",
						operation: "scan",
						message: "This test asset reader does not stub scanProject.",
						path: options.projectRoot,
						retrySafe: false
					})),
			...service
		})
	);
}

export function readSavedTable(
	options: AssetReaderOptions
): Effect.Effect<AuthoringTableSnapshot, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readTable(options.assetPath));
}

export function readSavedAsset(
	options: AssetReaderOptions
): Effect.Effect<SavedAssetInspection, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readAsset(options.assetPath));
}

export function discoverSavedAssets(
	projectRoot: string
): Effect.Effect<readonly string[], AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverAssets(projectRoot));
}

export function discoverSavedTables(
	options: SavedTableCatalogOptions
): Effect.Effect<SavedTableCatalog, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.discoverTables(options));
}

export function scanSavedProject(
	options: SavedAssetScanOptions
): Effect.Effect<SavedAssetScan, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.scanProject(options));
}

/** Streams compact text evidence for an explicit candidate list or a header-filtered project. */
export function extractProjectText(
	options: SavedAssetExtractionOptions
): Stream.Stream<SavedAssetTextExtractionEvent, AssetReaderError, AssetReader> {
	return Stream.unwrap(Effect.map(AssetReader, (reader) => reader.extractProjectText(options)));
}

/** Streams compact Texture2D evidence for an explicit candidate list or a header-filtered project. */
export function extractProjectTextures(
	options: SavedAssetExtractionOptions
): Stream.Stream<SavedAssetTextureExtractionEvent, AssetReaderError, AssetReader> {
	return Stream.unwrap(
		Effect.map(AssetReader, (reader) => reader.extractProjectTextures(options))
	);
}

/** A user-supplied path resolved onto the project root plus the roots to enumerate beneath it. */
export interface ResolvedScanTarget {
	/** Roots to enumerate. Empty means the project's whole `Content` directory. */
	readonly paths: readonly string[];
	readonly projectRoot: string;
}

/** Carries an already-explained resolution failure out of the async resolver body. */
class ScanTargetError extends Error {}

async function projectFilesIn(directory: string): Promise<readonly string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".uproject")
			.map((entry) => join(directory, entry.name));
	} catch {
		// An unreadable ancestor is not the target's fault; keep walking toward the root.
		return [];
	}
}

/**
 * Resolves any user-supplied path onto a scan target. A project root or `.uproject` file scans the
 * whole project; a subdirectory or a single asset walks up to the owning project and scopes
 * enumeration to that path, so `/Game` object paths stay resolvable either way.
 */
export function resolveScanTarget(
	path: string
): Effect.Effect<ResolvedScanTarget, AssetReaderError> {
	return Effect.tryPromise({
		try: async (): Promise<ResolvedScanTarget> => {
			const target = resolve(path);
			const details = await stat(target).catch(() => {
				throw new ScanTargetError(`Scan target does not exist: ${target}`);
			});
			if (details.isFile() && extname(target).toLowerCase() === ".uproject") {
				return { paths: [], projectRoot: dirname(target) };
			}
			if (details.isDirectory()) {
				const projects = await projectFilesIn(target);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory contains more than one .uproject file: ${target}`
					);
				}
				if (projects.length === 1) return { paths: [], projectRoot: target };
			}
			let directory = dirname(target);
			for (;;) {
				const projects = await projectFilesIn(directory);
				if (projects.length > 1) {
					throw new ScanTargetError(
						`Project directory containing ${target} has more than one .uproject file: ${directory}`
					);
				}
				if (projects.length === 1) return { paths: [target], projectRoot: directory };
				const parent = dirname(directory);
				if (parent === directory) {
					throw new ScanTargetError(
						`No .uproject file at or above ${target}; scans resolve object paths against a project root.`
					);
				}
				directory = parent;
			}
		},
		catch: (cause) =>
			new AssetReaderError({
				kind: "discovery",
				operation: "discovery",
				message:
					cause instanceof ScanTargetError
						? cause.message
						: `Could not resolve a scan target from ${path}: ${String(cause)}`,
				path,
				retrySafe: false
			})
	}).pipe(Effect.withSpan("unreal_assets.resolve_scan_target"));
}

export function readSavedWorld(
	options: SavedWorldReadOptions
): Effect.Effect<SavedWorld, AssetReaderError, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.readSavedWorld(options));
}

export function getAssetReaderSource(): Effect.Effect<"configured" | "path", never, AssetReader> {
	return Effect.flatMap(AssetReader, (reader) => reader.source());
}
