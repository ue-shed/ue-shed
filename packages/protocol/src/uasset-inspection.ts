import { contractParser } from "./contract-parser.js";
import { Effect, Schema, Tuple } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: "UAssetInspectionNonNegativeInt"
});
const SavedFloatingPoint = Schema.NullOr(Schema.Number);

/**
 * One file in a scan's opt-in inventory: a package or one of its sidecar files. `size` is in
 * bytes and `modifiedMs` is the file's modification time in (possibly fractional) milliseconds.
 */
export const SavedAssetManifestEntry = Schema.Struct({
	kind: Schema.Literals(["package", "sidecar"]),
	modifiedMs: Schema.Number,
	path: Schema.String,
	size: NonNegativeInt
}).annotate({ identifier: "SavedAssetManifestEntry" });
export type SavedAssetManifestEntry = Schema.Schema.Type<typeof SavedAssetManifestEntry>;

export type SavedPropertyValue =
	| {
			readonly value_kind: "native_struct";
			readonly fields: readonly {
				readonly name: string;
				readonly value: SavedPropertyValue;
			}[];
	  }
	| {
			readonly value_kind: "instanced_struct";
			readonly struct_type: string | null;
			readonly size: number;
			readonly value: SavedPropertyValue | null;
	  }
	| { readonly value_kind: "bool"; readonly value: boolean }
	| { readonly value_kind: "int" | "uint"; readonly value: number }
	| { readonly value_kind: "float" | "double"; readonly value: number | null }
	| {
			readonly value_kind: "name" | "enum" | "string" | "guid" | "soft_object_path";
			readonly value: string;
	  }
	| { readonly value_kind: "text"; readonly value: string; readonly history: "none" }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "base";
			readonly dev_notes?: string;
			readonly namespace: string;
			readonly key: string;
	  }
	| {
			readonly value_kind: "text";
			readonly value: string;
			readonly history: "string_table";
			readonly table_id: string;
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

/**
 * Recursive codec for one decoded saved property value, discriminated by `value_kind`.
 * Floating-point fields are `null` when the saved value is not finite; `raw` marks bytes the
 * decoder did not interpret, with their size and the reason.
 */
export const SavedPropertyValue: Schema.Codec<SavedPropertyValue> = Schema.suspend(
	() => SavedPropertyValueUnion
).annotate({ identifier: "SavedPropertyValue" });
/** A {@link SavedPropertyValue} plus the property's saved `name` and Unreal `type`. */
export const SavedProperty: Schema.Codec<SavedProperty> = Schema.suspend(() =>
	SavedPropertyValueUnion.mapMembers(
		Tuple.map(Schema.fieldsAssign({ name: Schema.String, type: Schema.String }))
	)
).annotate({ identifier: "SavedProperty" });
const SavedPropertyValueUnion = Schema.Union([
	Schema.Struct({
		value_kind: Schema.Literal("native_struct"),
		fields: Schema.Array(Schema.Struct({ name: Schema.String, value: SavedPropertyValue }))
	}),
	Schema.Struct({
		value_kind: Schema.Literal("instanced_struct"),
		struct_type: Schema.NullOr(Schema.String),
		size: NonNegativeInt,
		value: Schema.NullOr(SavedPropertyValue)
	}),
	Schema.Struct({ value_kind: Schema.Literal("bool"), value: Schema.Boolean }),
	Schema.Struct({ value_kind: Schema.Literals(["int", "uint"]), value: Schema.Number }),
	Schema.Struct({ value_kind: Schema.Literals(["float", "double"]), value: SavedFloatingPoint }),
	Schema.Struct({
		value_kind: Schema.Literals(["name", "enum", "string", "guid", "soft_object_path"]),
		value: Schema.String
	}),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("none")
	}),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("base"),
		dev_notes: Schema.optionalKey(Schema.String),
		namespace: Schema.String,
		key: Schema.String
	}),
	Schema.Struct({
		value_kind: Schema.Literal("text"),
		value: Schema.String,
		history: Schema.Literal("string_table"),
		table_id: Schema.String,
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
		x: SavedFloatingPoint,
		y: SavedFloatingPoint,
		z: SavedFloatingPoint
	}),
	Schema.Struct({ value_kind: Schema.Literal("int_point"), x: Schema.Number, y: Schema.Number }),
	Schema.Struct({
		value_kind: Schema.Literal("rotator"),
		pitch: SavedFloatingPoint,
		yaw: SavedFloatingPoint,
		roll: SavedFloatingPoint
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
		r: SavedFloatingPoint,
		g: SavedFloatingPoint,
		b: SavedFloatingPoint,
		a: SavedFloatingPoint
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
		size: NonNegativeInt
	})
]);

/**
 * An export the inspector could not decode. Any decode error makes the inspection `partial`
 * while the package's other exports are still reported.
 */
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
	message: Schema.String,
	/** The logical field being read when decoding failed, such as `Exports[3].Properties.Name`. */
	field: Schema.optional(Schema.String),
	/** The absolute byte offset in the package where decoding failed. */
	offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
}).annotate({ identifier: "SavedAssetDecodeError" });
export type SavedAssetDecodeError = Schema.Schema.Type<typeof SavedAssetDecodeError>;

/**
 * Schema-8 generic inspection of one saved package. `status` is `partial` exactly when
 * `decode_errors` is non-empty; header sizes are in bytes, and a missing `decode_errors` or
 * `properties` decodes as an empty array.
 */
export const SavedAssetInspection = Schema.Struct({
	metadata: Schema.optionalKey(
		Schema.Struct({
			root: Schema.Record(Schema.String, Schema.String),
			objects: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))
		})
	),
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
		summary_size: NonNegativeInt,
		total_header_size: NonNegativeInt
	}),
	assets: Schema.Array(
		Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("StringTable"),
				object_path: Schema.String,
				string_table_namespace: Schema.String,
				string_table_metadata: Schema.optionalKey(
					Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))
				),
				string_table_entries: Schema.Array(
					Schema.Struct({
						key: Schema.String,
						source: Schema.String,
						dev_notes: Schema.String.pipe(
							Schema.withDecodingDefaultKey(Effect.succeed(""))
						)
					})
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("UObject"),
				object_guid: Schema.optionalKey(Schema.String),
				object_path: Schema.String,
				class_path: Schema.String,
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				native_data: Schema.optionalKey(SavedPropertyValue),
				tail_bytes: Schema.optional(NonNegativeInt)
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
				row_count: NonNegativeInt,
				curve_rows: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						keys: Schema.Array(
							Schema.Struct({ time: SavedFloatingPoint, value: SavedFloatingPoint })
						)
					})
				)
			}),
			Schema.Struct({
				kind: Schema.Literal("Skeleton"),
				reference_pose: Schema.optionalKey(SavedPropertyValue),
				tail_bytes: Schema.optionalKey(NonNegativeInt),
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
						// The saved inspection writes null; generic inspection omits the key.
						display_name: Schema.optionalKey(Schema.NullOr(Schema.String))
					})
				),
				row_count: NonNegativeInt
			}),
			Schema.Struct({
				kind: Schema.Literal("Struct"),
				object_path: Schema.String,
				class_path: Schema.String,
				struct_flags: NonNegativeInt,
				struct_fields: Schema.Array(
					Schema.Struct({
						name: Schema.String,
						type: Schema.String,
						referenced_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
						display_name: Schema.optionalKey(Schema.NullOr(Schema.String))
					})
				),
				properties: Schema.Array(SavedProperty).pipe(
					Schema.withDecodingDefaultKey(Effect.succeed([]))
				),
				row_count: NonNegativeInt
			}),
			Schema.Struct({
				kind: Schema.Literals(["DataTable", "CompositeDataTable"]),
				object_path: Schema.String,
				row_struct: Schema.optional(Schema.String),
				parent_tables: Schema.optional(Schema.Array(Schema.String)),
				row_count: NonNegativeInt,
				rows: Schema.Array(
					Schema.Struct({ name: Schema.String, properties: Schema.Array(SavedProperty) })
				)
			})
		])
	),
	decode_errors: Schema.Array(SavedAssetDecodeError).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	)
}).annotate({ identifier: "SavedAssetInspection" });
export type SavedAssetInspection = Schema.Schema.Type<typeof SavedAssetInspection>;

/**
 * Narrow view of the same schema-8 inspection JSON that keeps only each asset's kind, object path
 * and table parentage, so catalogs can list tables without decoding properties. Any asset kind
 * string is accepted.
 */
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
}).annotate({ identifier: "SavedAssetCatalogInspection" });
export type SavedAssetCatalogInspection = Schema.Schema.Type<typeof SavedAssetCatalogInspection>;

/**
 * A DataTable or CompositeDataTable found in the project's saved files. `completeness` is
 * `partial` when its package decoded partially, and `schema` is always `unavailable` with a
 * reason because the row struct's schema is not resolved here.
 */
export const SavedTableDescriptor = Schema.Struct({
	assetPath: Schema.String,
	authority: Schema.Struct({ kind: Schema.Literal("project_files"), packageName: Schema.String }),
	completeness: Schema.Literals(["complete", "partial"]),
	kind: Schema.Literals(["data_table", "composite_data_table"]),
	objectPath: Schema.String,
	parentTables: Schema.Array(Schema.String),
	rowStruct: Schema.String,
	schema: Schema.Struct({ reason: Schema.String, status: Schema.Literal("unavailable") })
}).annotate({ identifier: "SavedTableDescriptor" });
export type SavedTableDescriptor = Schema.Schema.Type<typeof SavedTableDescriptor>;

/**
 * The tables found by one project scan, with per-path scan diagnostics. `retrySafe` says whether
 * repeating the scan may succeed for that path.
 */
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
	scannedAssets: NonNegativeInt,
	tables: Schema.Array(SavedTableDescriptor)
}).annotate({ identifier: "SavedTableCatalog" });
export type SavedTableCatalog = Schema.Schema.Type<typeof SavedTableCatalog>;

/**
 * Polling snapshot of a table catalog build. Counts are packages; `tablesFound` advances once per
 * emitted package, not per table, so it drives progress rather than a result count.
 */
export const SavedTableCatalogProgress = Schema.Struct({
	cacheHits: NonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "writing_cache", "ready", "failed"]),
	processedAssets: NonNegativeInt,
	tablesFound: NonNegativeInt,
	totalAssets: NonNegativeInt
}).annotate({ identifier: "SavedTableCatalogProgress" });
export type SavedTableCatalogProgress = Schema.Schema.Type<typeof SavedTableCatalogProgress>;

/**
 * One export from a package's export table. `class_path` is absent when the export's class could
 * not be resolved; `class_name` is the segment of `class_path` after its last `.`.
 */
export const SavedAssetHeaderExport = Schema.Struct({
	class_name: Schema.optional(Schema.String),
	class_path: Schema.optional(Schema.String),
	object_path: Schema.String
}).annotate({ identifier: "SavedAssetHeaderExport" });
export type SavedAssetHeaderExport = Schema.Schema.Type<typeof SavedAssetHeaderExport>;

/**
 * v1.9 package-summary evidence read without decoding payloads: the raw package flag bits, the
 * gatherable text table's entry count and byte offset (both 0 when the summary has no table),
 * and whether the complete name map contains `TextProperty`.
 */
export const PackageHeaderData = Schema.Struct({
	packageFlags: NonNegativeInt,
	gatherableTextDataCount: NonNegativeInt,
	gatherableTextDataOffset: NonNegativeInt,
	hasTextProperty: Schema.Boolean
}).annotate({ identifier: "PackageHeaderData" });
export type PackageHeaderData = typeof PackageHeaderData.Type;

/**
 * Header-depth scan evidence for one package. `matched_names` lists the requested name filters
 * found in its name map; `package.header_data` needs v1.9 and the scan's opt-in, and a missing
 * `exports` decodes as an empty array.
 */
export const SavedAssetHeader = Schema.Struct({
	exports: Schema.Array(SavedAssetHeaderExport).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	),
	matched_names: Schema.optionalKey(Schema.Array(Schema.String)),
	package: Schema.Struct({
		name: Schema.String,
		header_data: Schema.optionalKey(PackageHeaderData)
	}),
	path: Schema.String,
	schema_version: Schema.Literal(8)
}).annotate({ identifier: "SavedAssetHeader" });
export type SavedAssetHeader = Schema.Schema.Type<typeof SavedAssetHeader>;

/**
 * One package a scan emitted, shaped by the requested `depth`: a full inspection or header
 * evidence. `fileBytes` is the package file's size in bytes.
 */
export const SavedAssetScanEntry = Schema.Union([
	Schema.Struct({
		depth: Schema.Literal("full"),
		fileBytes: NonNegativeInt,
		inspection: SavedAssetInspection
	}),
	Schema.Struct({
		depth: Schema.Literal("header"),
		fileBytes: NonNegativeInt,
		header: SavedAssetHeader
	})
]).annotate({ identifier: "SavedAssetScanEntry" });
export type SavedAssetScanEntry = Schema.Schema.Type<typeof SavedAssetScanEntry>;
/** A scan entry from a `full` depth scan, carrying the complete inspection. */
export type SavedAssetFullScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "full" }>;
/** A scan entry from a `header` depth scan, carrying header evidence only. */
export type SavedAssetHeaderScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "header" }>;

/** Narrows a scan entry to a full inspection by its `depth`. */
export function isFullScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetFullScanEntry {
	return entry.depth === "full";
}

/** Narrows a scan entry to header evidence by its `depth`. */
export function isHeaderScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetHeaderScanEntry {
	return entry.depth === "header";
}

/**
 * A package a scan could not read; the scan continues with the others. `retrySafe` says whether
 * repeating the scan may succeed for that path.
 */
export const SavedAssetScanFailure = Schema.Struct({
	code: Schema.String,
	message: Schema.String,
	path: Schema.String,
	retrySafe: Schema.Boolean
}).annotate({ identifier: "SavedAssetScanFailure" });
export type SavedAssetScanFailure = Schema.Schema.Type<typeof SavedAssetScanFailure>;

const ScanDiagnostics = Schema.Array(
	Schema.Struct({
		code: Schema.String,
		message: Schema.String,
		path: Schema.String,
		retrySafe: Schema.Boolean
	})
);

/**
 * Totals for one scan. `scannedAssets` counts discovered packages and `emittedAssets` the entries
 * sent; skipped packages, such as those not matching the filters, are counted separately.
 * `inventoryComplete` is false when some inventory file's metadata could not be read.
 */
export const SavedAssetScanSummary = Schema.Struct({
	cacheHits: NonNegativeInt,
	depth: Schema.Literals(["header", "full"]),
	diagnostics: ScanDiagnostics,
	emittedAssets: NonNegativeInt,
	failedAssets: NonNegativeInt,
	inventoryComplete: Schema.optionalKey(Schema.Boolean),
	inventoryFiles: Schema.optionalKey(NonNegativeInt),
	partialAssets: NonNegativeInt,
	projectRoot: Schema.String,
	roots: Schema.Array(Schema.String),
	scannedAssets: NonNegativeInt,
	schema_version: Schema.Literal(8),
	skippedAssets: NonNegativeInt
}).annotate({ identifier: "SavedAssetScanSummary" });
export type SavedAssetScanSummary = Schema.Schema.Type<typeof SavedAssetScanSummary>;

/** Polling snapshot of a running scan; all counts are packages. */
export const SavedAssetScanProgress = Schema.Struct({
	cacheHits: NonNegativeInt,
	emittedAssets: NonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "ready", "failed"]),
	processedAssets: NonNegativeInt,
	totalAssets: NonNegativeInt
}).annotate({ identifier: "SavedAssetScanProgress" });
export type SavedAssetScanProgress = Schema.Schema.Type<typeof SavedAssetScanProgress>;

/**
 * A completed scan gathered from the result stream: emitted entries, per-package failures, and the
 * summary. `inventory` is present only when the scan requested it.
 */
export const SavedAssetScan = Schema.Struct({
	assets: Schema.Array(SavedAssetScanEntry),
	failures: Schema.Array(SavedAssetScanFailure),
	inventory: Schema.optionalKey(Schema.Array(SavedAssetManifestEntry)),
	summary: SavedAssetScanSummary
}).annotate({ identifier: "SavedAssetScan" });
export type SavedAssetScan = Schema.Schema.Type<typeof SavedAssetScan>;

const TextExtractionIdentity = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("resolved"),
		namespace: Schema.String,
		key: Schema.String
	}),
	Schema.Struct({
		status: Schema.Literal("string_table"),
		table_id: Schema.String,
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

/**
 * One saved text value and where it lives. `identity` is its namespace and key, its String Table
 * reference, or why it has none; `dev_notes` from older producers decodes as `""`.
 */
export const SavedAssetTextOccurrence = Schema.Struct({
	source: Schema.String,
	dev_notes: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
	identity: TextExtractionIdentity,
	location: TextExtractionLocation,
	edit_capability: Schema.Literals(["source_editable", "read_only"]),
	/**
	 * v1.11 package text records: Unreal's editor-only bit for this text from the package's
	 * gather table, when the table was read and lists the text's namespace, key and source. Absent
	 * means no gather-table evidence, not runtime text.
	 */
	gather_editor_only: Schema.optionalKey(Schema.Boolean)
}).annotate({ identifier: "SavedAssetTextOccurrence" });
export type SavedAssetTextOccurrence = Schema.Schema.Type<typeof SavedAssetTextOccurrence>;

/** Undecoded saved data. v1.18 classifies whether it may hold text; absent means unknown. */
export const SavedAssetTextCoverageGap = Schema.Struct({
	may_contain_text: Schema.optionalKey(Schema.Boolean),
	object_path: Schema.String,
	property_path: Schema.String,
	reason: Schema.Literals([
		"unsupported_text_history",
		"legacy_container_element_without_type_information",
		"feature_unavailable_for_engine_version",
		"property_decoder_rejected"
	])
}).annotate({ identifier: "SavedAssetTextCoverageGap" });
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
const SavedAssetProjectionPackageFields = {
	fileBytes: NonNegativeInt,
	path: Schema.String,
	schema_version: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	diagnostics: Schema.Array(SavedAssetProjectionDiagnostic)
};
const ScanFailureLine = Schema.Struct({
	code: Schema.String,
	event: Schema.Literal("error"),
	message: Schema.String,
	path: Schema.String,
	retrySafe: Schema.Boolean
});

/**
 * One `extract_text` stream event, discriminated by `event`: an occurrence, a coverage gap, a
 * per-package total, the closing `text_summary`, or an `error` line for a package that failed.
 */
export const SavedAssetTextExtractionEvent = Schema.Union([
	Schema.Struct({
		event: Schema.Literal("text_occurrence"),
		schema_version: Schema.Literal(1),
		path: Schema.String,
		fileBytes: NonNegativeInt,
		occurrence: SavedAssetTextOccurrence
	}),
	Schema.Struct({
		event: Schema.Literal("text_coverage_gap"),
		schema_version: Schema.Literal(1),
		path: Schema.String,
		coverage_gap: SavedAssetTextCoverageGap
	}),
	Schema.Struct({
		event: Schema.Literal("text_package"),
		...SavedAssetProjectionPackageFields,
		occurrences: NonNegativeInt,
		coverage_gaps: NonNegativeInt
	}),
	Schema.Struct({
		event: Schema.Literal("text_summary"),
		...SavedAssetScanSummary.fields,
		depth: Schema.Literal("text")
	}),
	ScanFailureLine
]).annotate({ identifier: "SavedAssetTextExtractionEvent" });
export type SavedAssetTextExtractionEvent = Schema.Schema.Type<
	typeof SavedAssetTextExtractionEvent
>;

/**
 * v1.10: a runtime entry in the package's gatherable text table that no decoded occurrence
 * matched by namespace and key. `site` is Unreal's description of where the text is used.
 */
export const SavedAssetMissingGatherableText = Schema.Struct({
	namespace: Schema.String,
	key: Schema.String,
	source: Schema.String,
	site: Schema.String
}).annotate({ identifier: "SavedAssetMissingGatherableText" });
export type SavedAssetMissingGatherableText = typeof SavedAssetMissingGatherableText.Type;

/** v1.10: decoded text checked against the package's own gatherable text table. */
export const SavedAssetGatherCoverage = Schema.Struct({
	runtimeSites: NonNegativeInt,
	missing: NonNegativeInt,
	missingSamples: Schema.Array(SavedAssetMissingGatherableText).check(Schema.isMaxLength(3))
}).annotate({ identifier: "SavedAssetGatherCoverage" });
export type SavedAssetGatherCoverage = typeof SavedAssetGatherCoverage.Type;

/**
 * v1.12: one Blueprint in a package and the exports its compile saved beside it, from the export
 * table and the Blueprint's saved `GeneratedClass`: the generated class, its default object
 * (`RF_ClassDefaultObject`), and a saved skeleton class and its default object. Text under these
 * is a representation copy of the Blueprint's authored text.
 */
export const SavedAssetBlueprintClasses = Schema.Struct({
	blueprint: Schema.String,
	generatedClass: Schema.String,
	classDefault: Schema.optionalKey(Schema.String),
	skeletonClass: Schema.optionalKey(Schema.String),
	skeletonClassDefault: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "SavedAssetBlueprintClasses" });
export type SavedAssetBlueprintClasses = typeof SavedAssetBlueprintClasses.Type;

const SavedAssetTextGapCounts = Schema.Struct({
	unsupported_text_history: NonNegativeInt,
	legacy_container_element_without_type_information: NonNegativeInt,
	feature_unavailable_for_engine_version: NonNegativeInt,
	property_decoder_rejected: NonNegativeInt
});

/**
 * v1.8 opt-in package evidence. Sampling matches the legacy corpus fold exactly. From v1.10,
 * `gatherCoverage` is present when the package's gather table was read; status then reflects
 * missing runtime gatherable text rather than decoder gaps. From v1.17, `packageName` is the name
 * the package summary serializes, which its object paths are built from. A file moved or copied
 * outside Unreal keeps its old name there, while Unreal names the package from the file's location.
 * `assetClass` is the class of the package's main asset, chosen as Unreal's loader does; an actor
 * saved in its own package reports its world's class.
 * v1.18 textGapCounts counts gaps that may contain text; every gap sample carries
 * may_contain_text. Older producers omit both fields (unknown means text-capable).
 */
export const SavedAssetPackageTextRecord = Schema.Struct({
	event: Schema.Literal("text_package_record"),
	fileBytes: NonNegativeInt,
	path: Schema.String,
	packageName: Schema.optionalKey(Schema.String),
	assetClass: Schema.optionalKey(Schema.String),
	schema_version: Schema.Literal(1),
	status: Schema.Literals(["complete", "partial"]),
	decodeErrors: NonNegativeInt,
	occurrences: Schema.Array(SavedAssetTextOccurrence),
	gapCounts: SavedAssetTextGapCounts,
	textGapCounts: Schema.optionalKey(SavedAssetTextGapCounts),
	gapSamples: Schema.Array(SavedAssetTextCoverageGap).check(Schema.isMaxLength(3)),
	gatherCoverage: Schema.optionalKey(SavedAssetGatherCoverage),
	blueprintClasses: Schema.optionalKey(Schema.Array(SavedAssetBlueprintClasses))
}).annotate({ identifier: "SavedAssetPackageTextRecord" });
export type SavedAssetPackageTextRecord = typeof SavedAssetPackageTextRecord.Type;

/**
 * One v1.8 `extract_text_packages` stream event: a package text record, the closing
 * `text_summary`, or an `error` line for a package that failed.
 */
export const SavedAssetPackageTextEvent = Schema.Union([
	SavedAssetPackageTextRecord,
	Schema.Struct({
		event: Schema.Literal("text_summary"),
		...SavedAssetScanSummary.fields,
		depth: Schema.Literal("text")
	}),
	ScanFailureLine
]).annotate({ identifier: "SavedAssetPackageTextEvent" });
export type SavedAssetPackageTextEvent = typeof SavedAssetPackageTextEvent.Type;

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
const TextureExtractionDimensions = Schema.Struct({
	width: NonNegativeInt,
	height: NonNegativeInt
});

/**
 * Saved evidence for one texture. Each field is either `available` with its source (`serialized`
 * or `file`) or `unavailable` with a reason; sizes are in bytes and dimensions in pixels.
 */
export const SavedAssetTextureRecord = Schema.Struct({
	object_path: Schema.String,
	package_file_bytes: TextureExtractionEvidence(NonNegativeInt),
	dimensions: TextureExtractionEvidence(TextureExtractionDimensions),
	source_format: TextureExtractionEvidence(Schema.String),
	source_mips: TextureExtractionEvidence(NonNegativeInt),
	compression: TextureExtractionEvidence(Schema.String),
	s_rgb: TextureExtractionEvidence(Schema.Boolean),
	texture_group: TextureExtractionEvidence(Schema.String),
	mip_generation: TextureExtractionEvidence(Schema.String)
}).annotate({ identifier: "SavedAssetTextureRecord" });
export type SavedAssetTextureRecord = Schema.Schema.Type<typeof SavedAssetTextureRecord>;

/**
 * One `extract_texture` stream event: a texture record, a per-package total, the closing
 * `texture_summary`, or an `error` line for a package that failed.
 */
export const SavedAssetTextureExtractionEvent = Schema.Union([
	Schema.Struct({
		event: Schema.Literal("texture_record"),
		schema_version: Schema.Literal(1),
		path: Schema.String,
		record: SavedAssetTextureRecord
	}),
	Schema.Struct({
		event: Schema.Literal("texture_package"),
		...SavedAssetProjectionPackageFields,
		records: NonNegativeInt
	}),
	Schema.Struct({
		event: Schema.Literal("texture_summary"),
		...SavedAssetScanSummary.fields,
		depth: Schema.Literal("texture")
	}),
	ScanFailureLine
]).annotate({ identifier: "SavedAssetTextureExtractionEvent" });
export type SavedAssetTextureExtractionEvent = Schema.Schema.Type<
	typeof SavedAssetTextureExtractionEvent
>;

/**
 * Decodes untrusted inspection JSON. Fails with a `ContractParseError` when the shape does not match or
 * `schema_version` is not 8.
 */
export const decodeSavedAssetInspection = contractParser(
	SavedAssetInspection,
	"SavedAssetInspection"
);
/**
 * Decodes untrusted inspection JSON into the narrow catalog view. Fails with a `ContractParseError` when
 * the retained fields do not match or `schema_version` is not 8.
 */
export const decodeSavedAssetCatalogInspection = contractParser(
	SavedAssetCatalogInspection,
	"SavedAssetCatalogInspection"
);
