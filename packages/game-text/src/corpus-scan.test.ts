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
