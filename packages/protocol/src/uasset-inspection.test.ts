import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	decodeSavedAssetInspection,
	SavedProperty,
	SavedAssetTextOccurrence
} from "./uasset-inspection.js";

describe("saved asset inspection wire contract", () => {
	it("decodes a complete empty inspection", async () => {
		const inspection = await Effect.runPromise(
			decodeSavedAssetInspection({
				assets: [],
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
		);
		expect(inspection.status).toBe("ok");
		expect(inspection.assets).toHaveLength(0);
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
