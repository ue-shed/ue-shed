import { SavedAssetInspection, SavedPropertyValue } from "@ue-shed/protocol";
import { Effect, Schema } from "effect";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Table = Schema.Struct({ count: Count, offset: Count });
// Reuse the IO contract's asset pieces, but retain the generic serializer's common fields.
// Tuple order is the declared SavedAssetInspection union, not an order in foreign evidence.
const [StringTable, UObject, DataAsset, CurveTable, Skeleton, Enum, Struct, DataTable] =
	SavedAssetInspection.fields.assets.value.members;
const common = {
	object_path: UObject.fields.object_path,
	class_path: Schema.optionalKey(Schema.String),
	object_guid: Schema.optionalKey(Schema.String),
	properties: UObject.fields.properties,
	native_data: Schema.optionalKey(SavedPropertyValue),
	tail_bytes: Schema.optionalKey(Count),
	row_count: Count,
	rows: DataTable.fields.rows
};

export const InspectedAsset = Schema.Union([
	Schema.Struct({
		...StringTable.fields,
		...common,
		string_table_entries: StringTable.fields.string_table_entries.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed([]))
		)
	}),
	Schema.Struct({ ...UObject.fields, ...common }),
	Schema.Struct({ ...DataAsset.fields, ...common }),
	Schema.Struct({
		...CurveTable.fields,
		...common,
		curve_rows: CurveTable.fields.curve_rows.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed([]))
		)
	}),
	Schema.Struct({
		...Skeleton.fields,
		...common,
		bones: Skeleton.fields.bones.pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
	}),
	Schema.Struct({
		...Enum.fields,
		...common,
		enum_entries: Enum.fields.enum_entries.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed([]))
		)
	}),
	Schema.Struct({
		...Struct.fields,
		...common,
		struct_fields: Struct.fields.struct_fields.pipe(
			Schema.withDecodingDefaultKey(Effect.succeed([]))
		)
	}),
	Schema.Struct({ ...DataTable.fields, ...common })
]);
export type InspectedAsset = Schema.Schema.Type<typeof InspectedAsset>;

/** Generic inspect v8, as emitted by native and WASM Rust serializers. */
export const AssetInspection = Schema.Struct({
	...SavedAssetInspection.fields,
	package: Schema.Struct({
		...SavedAssetInspection.fields.package.fields,
		version: Schema.Struct({
			...SavedAssetInspection.fields.package.fields.version.fields,
			legacy_ue3: Schema.NullOr(Schema.Number)
		}),
		names: Table,
		imports: Table,
		exports: Table,
		soft_object_paths: Schema.optionalKey(
			Schema.Struct({ ...Table.fields, parsed_count: Count })
		)
	}),
	assets: Schema.Array(InspectedAsset)
});
export type AssetInspection = Schema.Schema.Type<typeof AssetInspection>;

export const AssetInspectionFailureReason = Schema.Literals([
	"malformed_package",
	"unsupported_asset",
	"unsupported_version",
	"unsupported_capability",
	"reader_failure"
]);
export type AssetInspectionFailureReason = Schema.Schema.Type<typeof AssetInspectionFailureReason>;

export const AssetInspectionReadResult = Schema.Union([
	Schema.Struct({
		status: Schema.Literal("ready"),
		fileName: Schema.String,
		fileBytes: Count,
		inspection: AssetInspection
	}),
	Schema.Struct({
		status: Schema.Literal("failed"),
		fileName: Schema.String,
		reason: AssetInspectionFailureReason,
		message: Schema.String,
		recovery: Schema.String
	})
]);
export type AssetInspectionReadResult = Schema.Schema.Type<typeof AssetInspectionReadResult>;
export type ReadyAssetInspection = Extract<AssetInspectionReadResult, { readonly status: "ready" }>;
