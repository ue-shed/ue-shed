import { describe, expect, it } from "vitest";
import { decodeSavedAssetCatalogInspection, savedTableDescriptorsFromInspection } from "./index.js";

describe("saved DataTable catalog", () => {
	it("classifies table exports without treating unrelated assets as failures", () => {
		const inspection = decodeSavedAssetCatalogInspection({
			assets: [
				{
					kind: "DataTable",
					object_path: "/Game/Data/DT_Items.DT_Items",
					row_struct: "/Script/Game.ItemRow"
				},
				{
					kind: "CompositeDataTable",
					object_path: "/Game/Data/CDT_Items.CDT_Items",
					parent_tables: ["/Game/Data/DT_Items.DT_Items"],
					row_struct: "/Script/Game.ItemRow"
				},
				{
					kind: "UObject",
					object_path: "/Game/Data/T_Icon.T_Icon"
				}
			],
			package: { name: "/Game/Data/DT_Items" },
			path: "C:/Project/Content/Data/DT_Items.uasset",
			schema_version: 7,
			status: "ok"
		});

		const descriptors = savedTableDescriptorsFromInspection(inspection);
		expect(descriptors).toHaveLength(2);
		expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
			"data_table",
			"composite_data_table"
		]);
		expect(descriptors[1]?.parentTables).toEqual(["/Game/Data/DT_Items.DT_Items"]);
		expect(descriptors[0]?.schema.status).toBe("unavailable");
	});

	it("retains partial authority evidence and missing row-structure evidence", () => {
		const inspection = decodeSavedAssetCatalogInspection({
			assets: [{ kind: "DataTable", object_path: "/Game/Data/DT_Partial.DT_Partial" }],
			decode_errors: [{ message: "unsupported field", object_path: "/Game/Data/DT_Partial" }],
			package: { name: "/Game/Data/DT_Partial" },
			path: "C:/Project/Content/Data/DT_Partial.uasset",
			schema_version: 7,
			status: "partial"
		});

		expect(savedTableDescriptorsFromInspection(inspection)[0]).toMatchObject({
			completeness: "partial",
			rowStruct: ""
		});
	});
});
