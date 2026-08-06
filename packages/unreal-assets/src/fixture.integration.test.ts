import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
	AssetReader,
	assetReaderLayer,
	discoverSavedAssets,
	discoverSavedTables,
	extractProjectText,
	extractProjectTextures,
	isFullScanEntry,
	isHeaderScanEntry,
	type AssetReaderError,
	type SavedAssetScan,
	readSavedAsset,
	readSavedTable,
	scanSavedProject
} from "./index.js";

const executable = process.env.UE_SHED_UASSET_EXECUTABLE;
const fixtureRoot = fileURLToPath(new URL("../../../fixtures/unreal-project", import.meta.url));
const runReader = <A, E>(effect: Effect.Effect<A, E, AssetReader>) =>
	Effect.runPromise(effect.pipe(Effect.provide(assetReaderLayer({ executable: executable! }))));

describe.skipIf(!executable)("batched project scan", () => {
	it("inspects every fixture package in one reader process", async () => {
		const scan = await runReader(scanSavedProject({ projectRoot: fixtureRoot }));
		// 50 `.uasset` packages (including six World Partition external actors and the 25-asset
		// Enhanced Input surface) plus the three maps. Levels use the same classic package
		// container, so enumeration selects them too.
		expect(scan.summary.scannedAssets).toBe(53);
		expect(scan.summary.emittedAssets).toBe(53);
		expect(scan.summary.skippedAssets).toBe(0);
		expect(scan.failures).toEqual([]);
		expect(scan.assets).toHaveLength(53);
		expect(scan.assets.every((entry) => entry.fileBytes > 0)).toBe(true);
	}, 15_000);

	it("emits the same payload as a single-package inspect", async () => {
		const assetPath = join(fixtureRoot, "Content/Fixture/Input/IMC_Fixture.uasset");
		const [scan, direct] = await Promise.all([
			runReader(scanSavedProject({ paths: [assetPath], projectRoot: fixtureRoot })),
			runReader(readSavedAsset({ assetPath }))
		]);
		expect(scan.assets).toHaveLength(1);
		const entry = scan.assets[0];
		expect(entry && isFullScanEntry(entry) ? entry.inspection : undefined).toEqual(direct);
	});

	it("decodes only packages a header filter selects", async () => {
		const scan = await runReader(
			scanSavedProject({ classes: ["Texture2D"], projectRoot: fixtureRoot })
		);
		expect(scan.summary.scannedAssets).toBe(53);
		expect(scan.summary.emittedAssets).toBe(5);
		// The levels, saved World Partition actor packages, and every Enhanced Input asset carry
		// no Texture2D export, so they are ruled out before any decode.
		expect(scan.summary.skippedAssets).toBe(48);
		expect(
			scan.assets
				.filter(isFullScanEntry)
				.every((entry) =>
					entry.inspection.assets.some(
						(asset) =>
							asset.kind === "UObject" &&
							asset.class_path === "/Script/Engine.Texture2D"
					)
				)
		).toBe(true);
	});

	it("selects text-bearing packages by class or name-table entry", async () => {
		const scan = await runReader(
			scanSavedProject({
				classes: ["/Script/Engine.StringTable"],
				names: ["TextProperty"],
				projectRoot: fixtureRoot
			})
		);
		// Every InputAction and InputMappingContext names TextProperty for its description.
		expect(scan.summary.emittedAssets).toBe(28);
		expect(
			scan.assets
				.filter(isFullScanEntry)
				.some((entry) =>
					entry.inspection.assets.some((asset) => asset.kind === "StringTable")
				)
		).toBe(true);
	});

	it("streams compact text occurrences rather than generic inspections", async () => {
		const events = Array.from(
			await runReader(Stream.runCollect(extractProjectText({ projectRoot: fixtureRoot })))
		);
		const occurrences = events.filter((event) => event.event === "text_occurrence");
		expect(occurrences.length).toBeGreaterThan(0);
		expect(occurrences.every((event) => "occurrence" in event)).toBe(true);
		expect(events.some((event) => event.event === "text_summary")).toBe(true);
	});

	it("streams compact Texture2D records for explicit index candidates", async () => {
		const assetPath = join(
			fixtureRoot,
			"Content/Fixture/Audits/Textures/T_Audit_NonPowerOfTwo_300x180.uasset"
		);
		const events = Array.from(
			await runReader(
				Stream.runCollect(
					extractProjectTextures({ paths: [assetPath], projectRoot: fixtureRoot })
				)
			)
		);
		const records = events.filter((event) => event.event === "texture_record");
		expect(records).toHaveLength(1);
		expect(records[0]?.record.object_path).toContain("T_Audit_NonPowerOfTwo_300x180");
		expect(events.some((event) => event.event === "texture_summary")).toBe(true);
	});

	it("does not fall back to Content for an explicit empty compact candidate list", async () => {
		const events = Array.from(
			await runReader(
				Stream.runCollect(extractProjectText({ paths: [], projectRoot: fixtureRoot }))
			)
		);
		expect(events).toEqual([]);
	});

	it("narrows enumeration to a requested subdirectory", async () => {
		const scan = await runReader(
			scanSavedProject({ paths: ["Content/Fixture/Input"], projectRoot: fixtureRoot })
		);
		expect(scan.summary.scannedAssets).toBe(25);
		expect(
			scan.assets
				.filter(isFullScanEntry)
				.every((entry) => entry.inspection.path.includes("Input"))
		).toBe(true);
	});

	it("passes a large explicit package list without expanding the process command line", async () => {
		const assetPath = join(fixtureRoot, "Content/Fixture/Input/IMC_Fixture.uasset");
		const paths = Array.from({ length: 512 }, () => assetPath);
		const scan = await runReader(
			scanSavedProject({ maximumAssets: 1, paths, projectRoot: fixtureRoot })
		);
		// Repeated roots are deduplicated after the path list is read, so one package is decoded.
		expect(scan.summary.scannedAssets).toBe(1);
		expect(scan.summary.roots).toHaveLength(paths.length);
	});

	it("refuses a scan above the requested asset limit before decoding", async () => {
		const error = await Effect.runPromise(
			scanSavedProject({ maximumAssets: 2, projectRoot: fixtureRoot }).pipe(
				Effect.flip,
				Effect.provide(assetReaderLayer({ executable: executable! }))
			)
		);
		expect(error.kind).toBe("resource_limit");
		expect(error.message).toContain("above the limit of 2");
	});

	it("reports a missing project root as a discovery failure", async () => {
		const error = await Effect.runPromise(
			scanSavedProject({ projectRoot: join(fixtureRoot, "Missing") }).pipe(
				Effect.flip,
				Effect.provide(assetReaderLayer({ executable: executable! }))
			)
		);
		expect(error.kind).toBe("discovery");
		expect(error.retrySafe).toBe(true);
	});

	it("reports export class identity at header depth without decoding rows", async () => {
		const scan = await runReader(
			scanSavedProject({
				classes: ["/Script/Engine.DataTable", "/Script/Engine.CompositeDataTable"],
				depth: "header",
				projectRoot: fixtureRoot
			})
		);
		expect(scan.summary.depth).toBe("header");
		expect(scan.summary.scannedAssets).toBe(53);
		// The twelve authoring packages, each exporting exactly one table.
		expect(scan.summary.emittedAssets).toBe(12);
		const headers = scan.assets.filter(isHeaderScanEntry);
		expect(headers).toHaveLength(12);
		// Only the exports the filter selected are emitted, so the AssetImportData export that
		// accompanies every imported table is absent.
		expect(headers.flatMap((entry) => entry.header.exports)).toHaveLength(12);
		expect(
			headers.every((entry) =>
				entry.header.exports.every(
					(exported) =>
						exported.class_name === "DataTable" ||
						exported.class_name === "CompositeDataTable"
				)
			)
		).toBe(true);
	});

	it("emits a complete package-and-sidecar inventory from the same header scan", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "ue-shed-inventory-"));
		try {
			const content = join(projectRoot, "Content");
			await mkdir(content);
			await copyFile(
				join(fixtureRoot, "Content/Fixture/Authoring/DT_Scalars.uasset"),
				join(content, "DT_Scalars.uasset")
			);
			await writeFile(join(content, "DT_Scalars.UEXP"), "sidecar evidence");

			const scan = await runReader(
				scanSavedProject({ depth: "header", inventory: true, projectRoot })
			);
			expect(scan.summary.inventoryComplete).toBe(true);
			expect(scan.summary.inventoryFiles).toBe(2);
			expect(scan.inventory).toHaveLength(2);
			expect(scan.inventory?.find((entry) => entry.kind === "sidecar")).toMatchObject({
				kind: "sidecar",
				path: join(content, "DT_Scalars.UEXP"),
				size: 16
			});
			expect(scan.inventory?.find((entry) => entry.kind === "package")).toMatchObject({
				kind: "package",
				path: join(content, "DT_Scalars.uasset"),
				size: scan.assets[0]?.fileBytes
			});
		} finally {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("answers an unchanged project from the header cache", async () => {
		const cacheDirectory = await mkdtemp(join(tmpdir(), "ue-shed-scan-cache-"));
		try {
			const cachePath = join(cacheDirectory, "index.json");
			const options = {
				classes: ["/Script/Engine.DataTable"],
				cachePath,
				depth: "header" as const,
				projectRoot: fixtureRoot
			};

			// Workers emit concurrently, so line order is unspecified; compare by path.
			const byPath = (scan: SavedAssetScan) =>
				scan.assets
					.filter(isHeaderScanEntry)
					.map((entry) => entry.header)
					.sort((left, right) => left.path.localeCompare(right.path));

			const cold = await runReader(scanSavedProject(options));
			expect(cold.summary.cacheHits).toBe(0);

			const warm = await runReader(scanSavedProject(options));
			expect(warm.summary.cacheHits).toBe(warm.summary.scannedAssets);
			expect(warm.summary.emittedAssets).toBe(cold.summary.emittedAssets);
			expect(byPath(warm)).toEqual(byPath(cold));
		} finally {
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	});

	it("ignores a cache written for a different filter set", async () => {
		const cacheDirectory = await mkdtemp(join(tmpdir(), "ue-shed-scan-cache-"));
		try {
			const cachePath = join(cacheDirectory, "index.json");
			await runReader(
				scanSavedProject({
					classes: ["/Script/Engine.DataTable"],
					cachePath,
					depth: "header",
					projectRoot: fixtureRoot
				})
			);
			// A cache holds only the exports its filters selected, so reusing it for wider filters
			// would silently under-report. The fingerprint must force a fresh read.
			const wider = await runReader(
				scanSavedProject({
					classes: ["/Script/Engine.DataTable", "/Script/Engine.CompositeDataTable"],
					cachePath,
					depth: "header",
					projectRoot: fixtureRoot
				})
			);
			expect(wider.summary.cacheHits).toBe(0);
			expect(wider.summary.emittedAssets).toBe(12);
		} finally {
			await rm(cacheDirectory, { force: true, recursive: true });
		}
	});

	it("refuses a cache at full depth and projects matching names at header depth", async () => {
		const usage = <A>(effect: Effect.Effect<A, AssetReaderError, AssetReader>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.flip,
					Effect.provide(assetReaderLayer({ executable: executable! }))
				)
			);
		expect(
			(await usage(scanSavedProject({ cachePath: "index.json", projectRoot: fixtureRoot })))
				.kind
		).toBe("process");
		const header = await runReader(
			scanSavedProject({
				depth: "header",
				names: ["TextProperty"],
				projectRoot: fixtureRoot
			})
		);
		expect(header.summary.depth).toBe("header");
		expect(
			header.assets
				.filter(isHeaderScanEntry)
				.every((entry) => entry.header.matched_names?.includes("TextProperty") === true)
		).toBe(true);
	});
});

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
		// Count 7 is authored in FixtureSource/Authoring/DT_Scalars.json and must match the
		// engine-regenerated uasset (pnpm fixture:generate / fixture:evidence), not a live edit.
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
			expect(inspection.schema_version).toBe(8);
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
