import { it } from "@effect/vitest";
import {
	AssetReaderError,
	makeAssetReaderTestLayer,
	type SavedAssetInspection,
	type SavedAssetScan,
	type SavedAssetScanOptions
} from "@ue-shed/unreal-assets";
import { Effect, Ref } from "effect";
import { expect } from "vitest";
import {
	STRING_TABLE_CLASS,
	TEXT_PROPERTY_NAME,
	TextCorpusScanError,
	TextCorpusService,
	TextCorpusServiceLive
} from "./corpus.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

const stringTableInspection: SavedAssetInspection = {
	assets: [
		{
			kind: "StringTable",
			object_path: "/Game/Text.ST_Game",
			string_table_entries: [{ key: "GREETING", source: "Hello" }],
			string_table_namespace: "Fixture"
		}
	],
	decode_errors: [],
	package: {
		name: "/Game/Text/ST_Game",
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1,
		version: { legacy_file: -9, legacy_ue3: 0, licensee: 0, ue4: 522, ue5: 1018 }
	},
	path: "C:/Fixture/Content/Text/ST_Game.uasset",
	schema_version: 8,
	status: "ok"
};

const readerOffering = (
	scanProject: (options: SavedAssetScanOptions) => Effect.Effect<SavedAssetScan, AssetReaderError>
) =>
	makeAssetReaderTestLayer({
		discoverAssets: () => unexpected("discoverAssets"),
		discoverTables: () => unexpected("discoverTables"),
		readAsset: () => unexpected("readAsset"),
		readTable: () => unexpected("readTable"),
		scanProject,
		source: () => Effect.succeed("configured")
	});

it.effect("selects text-bearing packages by StringTable class and TextProperty name", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetScanOptions[]>([]);
		const reader = readerOffering(
			Effect.fn("AssetReader.Test.scanProject")(function* (options) {
				yield* Ref.update(seen, (current) => [...current, options]);
				return {
					assets: [
						{
							depth: "full" as const,
							fileBytes: 1510,
							inspection: stringTableInspection
						}
					],
					failures: [
						{
							code: "asset_malformed_data",
							message: "Saved asset could not be inspected (asset_malformed_data)",
							path: "C:/Fixture/Content/Text/Broken.uasset",
							retrySafe: false
						}
					],
					summary: {
						cacheHits: 0,
						depth: "full" as const,
						diagnostics: [],
						emittedAssets: 1,
						failedAssets: 1,
						partialAssets: 0,
						projectRoot: "C:/Fixture",
						roots: ["C:/Fixture/Content"],
						scannedAssets: 30,
						schema_version: 8 as const,
						skippedAssets: 28
					}
				};
			})
		);

		const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scan({ projectRoot: "C:/Fixture" })
		).pipe(Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		const [options] = yield* Ref.get(seen);
		expect(options?.classes).toEqual([STRING_TABLE_CLASS]);
		expect(options?.names).toEqual([TEXT_PROPERTY_NAME]);
		// Packages the reader ruled out from their header still count as discovered and inspected.
		expect(corpus.coverage.discoveredPackages).toBe(30);
		expect(corpus.coverage.inspectedPackages).toBe(29);
		expect(corpus.coverage.failedPackages).toBe(1);
		expect(corpus.coverage.textOccurrences).toBe(1);
		expect(corpus.status).toBe("partial");
		expect(corpus.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"package_inspection_failed"
		);
	})
);

it.effect("decodes only candidates from an existing project header index", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetScanOptions[]>([]);
		const reader = readerOffering(
			Effect.fn("AssetReader.Test.scanProject")(function* (options) {
				yield* Ref.update(seen, (current) => [...current, options]);
				return {
					assets: [
						{
							depth: "full" as const,
							fileBytes: 1510,
							inspection: stringTableInspection
						}
					],
					failures: [],
					summary: {
						cacheHits: 0,
						depth: "full" as const,
						diagnostics: [],
						emittedAssets: 1,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot: "C:/Fixture",
						roots: ["C:/Fixture/Content/Text/ST_Game.uasset"],
						scannedAssets: 1,
						schema_version: 8 as const,
						skippedAssets: 0
					}
				};
			})
		);
		const index: SavedAssetScan = {
			assets: [
				{
					depth: "header",
					fileBytes: 1510,
					header: {
						exports: [],
						matched_names: [TEXT_PROPERTY_NAME],
						package: { name: "/Game/Text/ST_Game" },
						path: "C:/Fixture/Content/Text/ST_Game.uasset",
						schema_version: 8
					}
				}
			],
			failures: [],
			summary: {
				cacheHits: 0,
				depth: "header",
				diagnostics: [],
				emittedAssets: 1,
				failedAssets: 0,
				partialAssets: 0,
				projectRoot: "C:/Fixture",
				roots: ["C:/Fixture/Content"],
				scannedAssets: 30,
				schema_version: 8,
				skippedAssets: 29
			}
		};

		const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scanFromProjectIndex(index, { projectRoot: "C:/Fixture" })
		).pipe(Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		const [options] = yield* Ref.get(seen);
		expect(options?.paths).toEqual(["C:/Fixture/Content/Text/ST_Game.uasset"]);
		expect(options?.classes).toBeUndefined();
		expect(options?.names).toBeUndefined();
		expect(corpus.coverage.discoveredPackages).toBe(30);
		expect(corpus.coverage.inspectedPackages).toBe(1);
	})
);

it.effect("does not scan Content when the existing project index has no text candidates", () =>
	Effect.gen(function* () {
		const reader = readerOffering(() => unexpected("scanProject"));
		const index: SavedAssetScan = {
			assets: [],
			failures: [],
			summary: {
				cacheHits: 0,
				depth: "header",
				diagnostics: [],
				emittedAssets: 0,
				failedAssets: 0,
				partialAssets: 0,
				projectRoot: "C:/Fixture",
				roots: ["C:/Fixture/Content"],
				scannedAssets: 30,
				schema_version: 8,
				skippedAssets: 30
			}
		};

		const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scanFromProjectIndex(index, { projectRoot: "C:/Fixture" })
		).pipe(Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		expect(corpus.coverage.discoveredPackages).toBe(30);
		expect(corpus.coverage.inspectedPackages).toBe(0);
	})
);

it.effect("maps a reader asset limit onto scan_limit_exceeded", () =>
	Effect.gen(function* () {
		const reader = readerOffering((options) =>
			Effect.fail(
				new AssetReaderError({
					kind: "resource_limit",
					operation: "scan",
					message: "Scan found 30 packages, above the limit of 2.",
					path: options.projectRoot,
					retrySafe: false
				})
			)
		);

		const error = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scan({ maximumAssets: 2, projectRoot: "C:/Fixture" })
		).pipe(Effect.flip, Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		expect(error).toBeInstanceOf(TextCorpusScanError);
		expect(error.code).toBe("scan_limit_exceeded");
		expect(error.retrySafe).toBe(false);
	})
);
