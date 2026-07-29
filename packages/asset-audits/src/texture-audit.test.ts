import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { expect } from "vitest";
import { makeAssetReaderTestLayer, type SavedAssetScan } from "@ue-shed/unreal-assets";
import {
	TextureAudit,
	TextureAuditLive,
	TextureAuditScanError,
	makeTextureAuditTestLayer,
	texturePackagePathsFromProjectIndex
} from "./texture.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

it("selects only Texture2D packages from the shared header index", () => {
	const index: SavedAssetScan = {
		assets: [
			{
				depth: "header",
				fileBytes: 128,
				header: {
					exports: [
						{
							class_path: "/Script/Engine.Texture2D",
							object_path: "/Game/Textures/T_One.T_One"
						}
					],
					package: { name: "/Game/Textures/T_One" },
					path: "C:/Fixture/Content/Textures/T_One.uasset",
					schema_version: 8
				}
			},
			{
				depth: "header",
				fileBytes: 128,
				header: {
					exports: [
						{
							class_path: "/Script/Engine.DataTable",
							object_path: "/Game/Tables/DT_One.DT_One"
						}
					],
					package: { name: "/Game/Tables/DT_One" },
					path: "C:/Fixture/Content/Tables/DT_One.uasset",
					schema_version: 8
				}
			}
		],
		failures: [],
		summary: {
			cacheHits: 0,
			depth: "header",
			diagnostics: [],
			emittedAssets: 2,
			failedAssets: 0,
			partialAssets: 0,
			projectRoot: "C:/Fixture",
			roots: ["C:/Fixture/Content"],
			scannedAssets: 2,
			schema_version: 8,
			skippedAssets: 0
		}
	};

	expect(texturePackagePathsFromProjectIndex(index)).toEqual([
		"C:/Fixture/Content/Textures/T_One.uasset"
	]);
});

it.effect("does not scan Content when the shared index has no texture candidates", () =>
	Effect.gen(function* () {
		const reader = makeAssetReaderTestLayer({
			discoverAssets: () => unexpected("discoverAssets"),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			scanProject: () => unexpected("scanProject"),
			source: () => Effect.succeed("configured")
		});
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

		const report = yield* Effect.flatMap(TextureAudit, (service) =>
			service.scanFromProjectIndex(index, {
				projectRoot: "C:/Fixture",
				ruleFile: "fixtures/unreal-project/FixtureSource/Audits/texture-rules.json"
			})
		).pipe(Effect.provide(TextureAuditLive), Effect.provide(reader));

		expect(report.coverage.discoveredPackages).toBe(30);
		expect(report.coverage.inspectedPackages).toBe(0);
	})
);

it.effect("routes texture scans through the TextureAudit service", () =>
	Effect.gen(function* () {
		const scanned = yield* Ref.make(false);
		const layer = makeTextureAuditTestLayer({
			scan: Effect.fn("TextureAudit.Test.scan")(function* () {
				yield* Ref.set(scanned, true);
				return {
					coverage: {
						discoveredPackages: 0,
						failedPackages: 0,
						inspectedPackages: 0,
						partialPackages: 0,
						textureAssets: 0
					},
					diagnostics: [],
					distributions: {
						compression: [],
						maximumDimension: [],
						sRGB: [],
						textureGroup: []
					},
					findings: [],
					records: [],
					ruleSetName: "test",
					schemaVersion: 1 as const,
					status: "complete" as const
				};
			})
		});

		yield* Effect.flatMap(TextureAudit, (service) =>
			service.scan({
				projectRoot: "C:/Fixture",
				ruleFile: "C:/rules.json"
			})
		).pipe(Effect.provide(layer));

		expect(yield* Ref.get(scanned)).toBe(true);
	})
);

it.effect("TextureAuditLive obtains AssetReader from context", () =>
	Effect.gen(function* () {
		const roots = yield* Ref.make<readonly string[]>([]);
		const reader = makeAssetReaderTestLayer({
			discoverAssets: Effect.fn("AssetReader.Test.discoverAssets")(function* (projectRoot) {
				yield* Ref.update(roots, (current) => [...current, projectRoot]);
				return [];
			}),
			discoverTables: () => unexpected("discoverTables"),
			readAsset: () => unexpected("readAsset"),
			readTable: () => unexpected("readTable"),
			source: () => Effect.succeed("configured")
		});

		const error = yield* Effect.flatMap(TextureAudit, (service) =>
			service.scan({
				projectRoot: "C:/Fixture",
				ruleFile: "C:/missing-rules.json"
			})
		).pipe(Effect.flip, Effect.provide(TextureAuditLive), Effect.provide(reader));

		expect(error).toBeInstanceOf(TextureAuditScanError);
		expect(error.code).toBe("invalid_rules");
		expect(yield* Ref.get(roots)).toEqual([]);
	})
);
