import { Effect, Schema, Tuple } from "effect";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
	identifier: "UAssetInspectionNonNegativeInt"
});
const SavedFloatingPoint = Schema.NullOr(Schema.Number);

export const SavedAssetManifestEntry = Schema.Struct({
	kind: Schema.Literals(["package", "sidecar"]),
	modifiedMs: Schema.Number,
	path: Schema.String,
	size: NonNegativeInt
}).annotate({ identifier: "SavedAssetManifestEntry" });
export type SavedAssetManifestEntry = Schema.Schema.Type<typeof SavedAssetManifestEntry>;

export type SavedPropertyValue =
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

const SavedPropertyValue: Schema.Codec<SavedPropertyValue> = Schema.suspend(
	() => SavedPropertyValueUnion
).annotate({ identifier: "SavedPropertyValue" });
const SavedProperty: Schema.Codec<SavedProperty> = Schema.suspend(() =>
	SavedPropertyValueUnion.mapMembers(
		Tuple.map(Schema.fieldsAssign({ name: Schema.String, type: Schema.String }))
	)
).annotate({ identifier: "SavedProperty" });
const SavedPropertyValueUnion = Schema.Union([
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
}).annotate({ identifier: "SavedAssetDecodeError" });
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
		summary_size: NonNegativeInt,
		total_header_size: NonNegativeInt
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
						referenced_path: Schema.optional(Schema.String),
						display_name: Schema.optional(Schema.String)
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

export const SavedTableCatalogProgress = Schema.Struct({
	cacheHits: NonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "writing_cache", "ready", "failed"]),
	processedAssets: NonNegativeInt,
	tablesFound: NonNegativeInt,
	totalAssets: NonNegativeInt
}).annotate({ identifier: "SavedTableCatalogProgress" });
export type SavedTableCatalogProgress = Schema.Schema.Type<typeof SavedTableCatalogProgress>;

export const SavedAssetHeaderExport = Schema.Struct({
	class_name: Schema.optional(Schema.String),
	class_path: Schema.optional(Schema.String),
	object_path: Schema.String
}).annotate({ identifier: "SavedAssetHeaderExport" });
export type SavedAssetHeaderExport = Schema.Schema.Type<typeof SavedAssetHeaderExport>;

export const SavedAssetHeader = Schema.Struct({
	exports: Schema.Array(SavedAssetHeaderExport).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed([]))
	),
	matched_names: Schema.optionalKey(Schema.Array(Schema.String)),
	package: Schema.Struct({ name: Schema.String }),
	path: Schema.String,
	schema_version: Schema.Literal(8)
}).annotate({ identifier: "SavedAssetHeader" });
export type SavedAssetHeader = Schema.Schema.Type<typeof SavedAssetHeader>;

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
export type SavedAssetFullScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "full" }>;
export type SavedAssetHeaderScanEntry = Extract<SavedAssetScanEntry, { readonly depth: "header" }>;

export function isFullScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetFullScanEntry {
	return entry.depth === "full";
}

export function isHeaderScanEntry(entry: SavedAssetScanEntry): entry is SavedAssetHeaderScanEntry {
	return entry.depth === "header";
}

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

export const SavedAssetScanProgress = Schema.Struct({
	cacheHits: NonNegativeInt,
	emittedAssets: NonNegativeInt,
	phase: Schema.Literals(["idle", "enumerating", "scanning", "ready", "failed"]),
	processedAssets: NonNegativeInt,
	totalAssets: NonNegativeInt
}).annotate({ identifier: "SavedAssetScanProgress" });
export type SavedAssetScanProgress = Schema.Schema.Type<typeof SavedAssetScanProgress>;

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

export const SavedAssetTextOccurrence = Schema.Struct({
	source: Schema.String,
	identity: TextExtractionIdentity,
	location: TextExtractionLocation,
	edit_capability: Schema.Literals(["source_editable", "read_only"])
}).annotate({ identifier: "SavedAssetTextOccurrence" });
export type SavedAssetTextOccurrence = Schema.Schema.Type<typeof SavedAssetTextOccurrence>;

export const SavedAssetTextCoverageGap = Schema.Struct({
	object_path: Schema.String,
	property_path: Schema.String,
	reason: Schema.Literal("unsupported_text_history")
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

export const decodeSavedAssetInspection = Schema.decodeUnknownEffect(SavedAssetInspection);
export const decodeSavedAssetCatalogInspection = Schema.decodeUnknownEffect(
	SavedAssetCatalogInspection
);
