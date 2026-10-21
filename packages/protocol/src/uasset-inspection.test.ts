import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeSavedAssetInspection,
	SavedProperty,
	SavedAssetTextOccurrence
} from "./uasset-inspection.js";

describe("saved asset inspection wire contract", () => {
	it("accepts the null display names and paths the native saved inspection writes", async () => {
		const inspection = await Effect.runPromise(
			decodeSavedAssetInspection({
				assets: [
					{
						kind: "Enum",
						object_path: "/Game/E_Item.E_Item",
						class_path: "/Script/Engine.UserDefinedEnum",
						enum_cpp_form: "Namespaced",
						enum_entries: [
							{ name: "E_Item::Common", value: 0, display_name: "Common Item" },
							{ name: "E_Item::E_MAX", value: 1, display_name: null }
						],
						row_count: 2
					},
					{
						kind: "Struct",
						object_path: "/Game/S_Item.S_Item",
						class_path: "/Script/Engine.UserDefinedStruct",
						struct_flags: 0,
						struct_fields: [
							{
								name: "Count",
								type: "IntProperty",
								referenced_path: null,
								display_name: null
							}
						],
						row_count: 1
					}
				],
				decode_errors: [],
				package: {
					name: "/Game/E_Item",
					package_flags: 0,
					summary_size: 64,
					total_header_size: 128,
					version: {
						legacy_file: 0,
						legacy_ue3: 0,
						ue4: 1,
						ue5: 0,
						licensee: 0
					}
				},
				path: "Content/E_Item.uasset",
				schema_version: 8,
				status: "ok"
			})
		);
		const [enumAsset, structAsset] = inspection.assets;
		expect(enumAsset?.kind === "Enum" && enumAsset.enum_entries[1]?.display_name).toBeNull();
		expect(
			structAsset?.kind === "Struct" && structAsset.struct_fields[0]?.referenced_path
		).toBe(null);
	});

	it("rejects an inspection with an unknown asset kind", async () => {
		const result = await Effect.runPromise(
			Effect.result(
				decodeSavedAssetInspection({
					assets: [{ kind: "Unknown", object_path: "/Game/Example" }],
					decode_errors: [],
					package: {
						name: "/Game/Example",
						package_flags: 0,
						summary_size: 64,
						total_header_size: 128,
						version: {
							legacy_file: 0,
							legacy_ue3: 0,
							ue4: 1,
							ue5: 0,
							licensee: 0
						}
					},
					path: "Content/Example.uasset",
					schema_version: 8,
					status: "ok"
				})
			)
		);
		expect(result._tag).toBe("Failure");
	});
});

it("retains keyed-text translator notes without requiring them in older inspection JSON", () => {
	const property = {
		name: "Label",
		type: "TextProperty",
		value_kind: "text",
		value: "Hello",
		history: "base",
		namespace: "Fixture",
		key: "Greeting"
	};
	const decode = Schema.decodeUnknownSync(SavedProperty);
	expect(decode({ ...property, dev_notes: "Use a friendly tone" })).toEqual({
		...property,
		dev_notes: "Use a friendly tone"
	});
	expect(decode({ ...property, dev_notes: "" })).toEqual({ ...property, dev_notes: "" });
	expect(decode(property)).toEqual(property);
	expect(() => decode({ ...property, dev_notes: 42 })).toThrow();
});

it("defaults translator notes in legacy compact text events", () => {
	const occurrence = {
		source: "Hello",
		identity: { status: "resolved", namespace: "Fixture", key: "Greeting" },
		location: {
			kind: "string_table_entry",
			object_path: "/Game/Fixture/ST_Notes.ST_Notes",
			entry_key: "Greeting"
		},
		edit_capability: "source_editable"
	};
	const decode = Schema.decodeUnknownSync(SavedAssetTextOccurrence);
	expect(decode(occurrence).dev_notes).toBe("");
	expect(decode({ ...occurrence, dev_notes: "Use a friendly tone" }).dev_notes).toBe(
		"Use a friendly tone"
	);
});
