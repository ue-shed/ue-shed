import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { discoverSavedAssets, readSavedAsset, readSavedTable } from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));

describe.skipIf(!executable)("saved authoring fixture", () => {
	it("reads every fixture DataTable through the shared contract", async () => {
		const assets = await Effect.runPromise(discoverSavedAssets(fixtureRoot));
		const tableAssets = assets.filter((assetPath) => assetPath.includes("Authoring"));
		const snapshots = await Promise.all(
			tableAssets.map((assetPath) =>
				Effect.runPromise(readSavedTable({ assetPath, executable: executable! }))
			)
		);
		expect(snapshots).toHaveLength(11);
		expect(snapshots.map((snapshot) => snapshot.table.kind)).toContain("composite_data_table");
		expect(
			snapshots.some(
				(snapshot) =>
					snapshot.table.objectPath === "/Game/Fixture/Authoring/DT_Opaque.DT_Opaque"
			)
		).toBe(true);
	});

	it("inspects all fixture textures with serialized source dimensions", async () => {
		const assets = (await Effect.runPromise(discoverSavedAssets(fixtureRoot))).filter(
			(path) => path.includes("Audits\\Textures") || path.includes("Audits/Textures")
		);
		const inspections = await Promise.all(
			assets.map((assetPath) =>
				Effect.runPromise(readSavedAsset({ assetPath, executable: executable! }))
			)
		);
		expect(inspections).toHaveLength(5);
		for (const inspection of inspections) {
			expect(inspection.schema_version).toBe(6);
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
