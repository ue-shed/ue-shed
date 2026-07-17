import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	AssetReader,
	assetReaderLayer,
	discoverSavedAssets,
	discoverSavedTables,
	readSavedAsset,
	readSavedTable
} from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

describe.skipIf(!executable)("saved authoring fixture", () => {
	it("discovers DataTables without requiring their paths in advance", async () => {
		const catalog = await runReader(discoverSavedTables({ projectRoot: fixtureRoot }));
		expect(catalog.tables).toHaveLength(12);
		expect(catalog.tables[0]?.objectPath).toBe(
			"/Game/Fixture/Authoring/CDT_Scalars.CDT_Scalars"
		);
		expect(catalog.tables.every((table) => table.authority.kind === "project_files")).toBe(
			true
		);
	});

	it("reads every fixture DataTable through the shared contract", async () => {
		const assets = await runReader(discoverSavedAssets(fixtureRoot));
		const tableAssets = assets.filter((assetPath) => assetPath.includes("Authoring"));
		const snapshots = await Promise.all(
			tableAssets.map((assetPath) => runReader(readSavedTable({ assetPath })))
		);
		expect(snapshots).toHaveLength(12);
		expect(snapshots.map((snapshot) => snapshot.table.kind)).toContain("composite_data_table");
		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.table.objectPath === "/Game/Fixture/Authoring/DT_Opaque.DT_Opaque"
			)
		).toBe(true);

		const byObjectPath = new Map(
			snapshots.map((snapshot) => [snapshot.table.objectPath, snapshot] as const)
		);
		const largeTable = byObjectPath.get(
			"/Game/Fixture/Authoring/DT_LargeScalars.DT_LargeScalars"
		)?.table;
		expect(largeTable?.rows).toHaveLength(10000);
		expect(largeTable?.rows[0]?.name).toBe("Load_00000");
		expect(largeTable?.rows.at(-1)?.name).toBe("Load_09999");
		expect(
			byObjectPath.get("/Game/Fixture/Authoring/DT_Scalars.DT_Scalars")?.table.rows[0]
		).toMatchObject({
			name: "Scalar_Alpha",
			fields: [
				{ name: "Enabled", value: { kind: "bool", value: true } },
				{ name: "Count", value: { kind: "int", value: "7" } },
				{ name: "Ratio", value: { kind: "float", value: 0.25 } },
				{ name: "Key", value: { kind: "name", value: "Alpha" } },
				{
					name: "Notes",
					value: { kind: "string", value: "First deterministic scalar row." }
				}
			]
		});
		expect(
			byObjectPath.get("/Game/Fixture/Authoring/DT_Structs.DT_Structs")?.table.rows[0]
		).toMatchObject({
			name: "Struct_One",
			fields: [
				{
					name: "Nested",
					value: {
						kind: "struct",
						fields: [
							{ name: "Count", value: { kind: "int", value: "3" } },
							{ name: "Label", value: { kind: "string", value: "One" } },
							{
								name: "Offset",
								value: { kind: "vector", x: 10, y: 20, z: 30 }
							}
						]
					}
				},
				{
					name: "Label",
					value: { kind: "string", value: "First nested row" }
				}
			]
		});
		expect(
			byObjectPath.get("/Game/Fixture/Authoring/DT_Containers.DT_Containers")?.table.rows[0]
		).toMatchObject({
			name: "Container_Mixed",
			fields: [
				{
					name: "Sequence",
					value: {
						kind: "array",
						values: [
							{ kind: "int", value: "1" },
							{ kind: "int", value: "2" },
							{ kind: "int", value: "3" }
						]
					}
				},
				{
					name: "Labels",
					value: {
						kind: "set",
						values: [
							{ kind: "name", value: "North" },
							{ kind: "name", value: "South" }
						]
					}
				},
				{
					name: "Weights",
					value: {
						kind: "map",
						entries: [
							{
								key: { kind: "name", value: "Light" },
								value: { kind: "int", value: "1" }
							},
							{
								key: { kind: "name", value: "Heavy" },
								value: { kind: "int", value: "10" }
							}
						]
					}
				}
			]
		});
		expect(
			byObjectPath.get("/Game/Fixture/Authoring/DT_LeftReferences.DT_LeftReferences")?.table
				.rows[0]
		).toMatchObject({
			name: "Left_Alpha",
			fields: [
				{
					name: "Target",
					value: {
						kind: "row_reference",
						rowName: "Right_Alpha",
						tableObjectPath:
							"/Game/Fixture/Authoring/DT_RightReferences.DT_RightReferences"
					}
				}
			]
		});
		expect(
			byObjectPath.get("/Game/Fixture/Authoring/DT_Opaque.DT_Opaque")?.table.rows[0]
		).toMatchObject({
			fields: [
				{
					name: "OpaqueValue",
					value: {
						kind: "struct",
						fields: [
							{ name: "X", value: { kind: "int", value: "17" } },
							{ name: "Y", value: { kind: "int", value: "29" } }
						]
					}
				}
			]
		});
	});

	it("inspects all fixture textures with serialized source dimensions", async () => {
		const assets = (await runReader(discoverSavedAssets(fixtureRoot))).filter(
			(path) => path.includes("Audits\\Textures") || path.includes("Audits/Textures")
		);
		const inspections = await Promise.all(
			assets.map((assetPath) => runReader(readSavedAsset({ assetPath })))
		);
		expect(inspections).toHaveLength(5);
		for (const inspection of inspections) {
			expect(inspection.schema_version).toBe(7);
			const texture = inspection.assets.find(
				(asset) =>
					asset.kind === "UObject" && asset.class_path === "/Script/Engine.Texture2D"
			);
			expect(texture).toBeDefined();
			const source =
				texture?.kind === "UObject"
					? texture.properties.find(
							(property) =>
								property.name === "Source" && property.value_kind === "struct"
						)
					: undefined;
			expect(source?.value_kind).toBe("struct");
			if (source?.value_kind === "struct") {
				expect(
					source.properties.some(
						(property) => property.name === "SizeX" && property.value_kind === "int"
					)
				).toBe(true);
				expect(
					source.properties.some(
						(property) => property.name === "SizeY" && property.value_kind === "int"
					)
				).toBe(true);
			}
		}
	});
});
