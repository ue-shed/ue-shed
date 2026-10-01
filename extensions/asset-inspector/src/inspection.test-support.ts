import { Schema } from "effect";
import { AssetInspection, type ReadyAssetInspection } from "./contract.js";

export const packageHeader = {
	name: "/Game/Fixture/Test",
	version: { legacy_file: -9, legacy_ue3: null, ue4: 522, ue5: 1018, licensee: 0 },
	package_flags: 0,
	summary_size: 200,
	total_header_size: 500,
	names: { count: 12, offset: 200 },
	imports: { count: 3, offset: 300 },
	exports: { count: 1, offset: 400 },
	soft_object_paths: { count: 0, offset: 0, parsed_count: 0 }
};

export const stringTable = {
	kind: "StringTable",
	object_path: "/Game/Fixture/Test.Test",
	class_path: "/Script/Engine.StringTable",
	properties: [],
	row_count: 0,
	rows: [],
	string_table_namespace: "Fixture.Text",
	string_table_entries: [{ key: "Greeting", source: "Hello fixture" }]
};

export const dataTable = {
	kind: "DataTable",
	object_path: "/Game/Fixture/Table.Table",
	row_struct: "/Script/Fixture.ScalarRow",
	properties: [],
	row_count: 2,
	rows: [
		{
			name: "Alpha",
			properties: [{ name: "Count", type: "IntProperty", value_kind: "int", value: 7 }]
		},
		{
			name: "Beta",
			properties: [{ name: "Ratio", type: "FloatProperty", value_kind: "float", value: 0.5 }]
		}
	]
};

export const skeleton = {
	kind: "Skeleton",
	object_path: "/Game/Fixture/Rig.Rig",
	class_path: "/Script/Engine.Skeleton",
	properties: [],
	row_count: 0,
	rows: [],
	bones: [
		{ name: "Root", parent_index: -1 },
		{ name: "Spine", parent_index: 0 }
	]
};

export const generic = {
	kind: "UObject",
	object_path: "/Game/Fixture/Object.Object",
	class_path: "/Script/Engine.Object",
	row_count: 0,
	rows: [],
	properties: [
		{ name: "Enabled", type: "BoolProperty", value_kind: "bool", value: true },
		{
			name: "Label",
			type: "TextProperty",
			value_kind: "text",
			value: "Saved title",
			history: "base",
			namespace: "Fixture",
			key: "Title"
		},
		{
			name: "Owner",
			type: "ObjectProperty",
			value_kind: "object_ref",
			value: "/Game/Owner.Owner"
		},
		{
			name: "Settings",
			type: "StructProperty",
			value_kind: "struct",
			properties: [
				{
					name: "Items",
					type: "ArrayProperty",
					value_kind: "array",
					values: [{ value_kind: "name", value: "NestedName" }]
				}
			]
		},
		{
			name: "Lookup",
			type: "MapProperty",
			value_kind: "map",
			entries: [
				{
					key: { value_kind: "string", value: "MapKey" },
					value: { value_kind: "int", value: 42 }
				}
			]
		},
		{
			name: "Tags",
			type: "SetProperty",
			value_kind: "set",
			values: [{ value_kind: "string", value: "TagA" }]
		},
		{
			name: "Opaque",
			type: "StructProperty",
			value_kind: "raw",
			size: 12,
			reason: "unsupported native layout"
		}
	],
	native_data: {
		value_kind: "native_struct",
		fields: [
			{
				name: "Record",
				value: {
					value_kind: "instanced_struct",
					struct_type: "/Script/Fixture.Record",
					size: 4,
					value: { value_kind: "int", value: 5 }
				}
			}
		]
	},
	tail_bytes: 8
};

export function cannedOutput(assets = [stringTable]) {
	return { schema_version: 8, status: "ok", path: "Test.uasset", package: packageHeader, assets };
}

export function readyInspection<Asset>(assets: readonly Asset[]): ReadyAssetInspection {
	return {
		status: "ready",
		fileName: "Test.uasset",
		fileBytes: 1024,
		inspection: Schema.decodeUnknownSync(AssetInspection)({ ...cannedOutput(), assets })
	};
}
