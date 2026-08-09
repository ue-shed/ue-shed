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
import { textureAuditQuery } from "./query.js";
import { AuditRuleId, TextureObjectPath, type TextureAuditReport } from "./schema.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

const available = <Value>(value: Value) => ({
	status: "available" as const,
	source: "serialized" as const,
	value
});

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

it("indexes compact records once and returns stable bounded audit pages", () => {
	const first = TextureObjectPath.make("/Game/Textures/T_First.T_First");
	const second = TextureObjectPath.make("/Game/Textures/T_Second.T_Second");
	const report: TextureAuditReport = {
		coverage: {
			discoveredPackages: 2,
			failedPackages: 0,
			inspectedPackages: 2,
			partialPackages: 0,
			textureAssets: 2
		},
		diagnostics: [],
		distributions: {
			compression: [],
			maximumDimension: [],
			sRGB: [],
			textureGroup: []
		},
		findings: [
			{
				actual: [],
				expected: [],
				explanation: "First texture is intentionally flagged.",
				objectPath: first,
				ruleId: AuditRuleId.make("power-of-two"),
				severity: "warning"
			}
		],
		records: [first, second].map((objectPath, index) => ({
			compression: available("TC_Default"),
			dimensions: available({ height: 256, width: 256 }),
			filePath: `Content/Textures/T_${index}.uasset`,
			mipGeneration: available("TMGS_FromTextureGroup"),
			objectPath,
			packageFileBytes: { source: "file" as const, status: "available" as const, value: 128 },
			sRGB: available(true),
			sourceFormat: available("TSF_BGRA8"),
			sourceMips: available(1),
			textureGroup: available("TEXTUREGROUP_World")
		})),
		ruleSetName: "test",
		schemaVersion: 1,
		status: "complete"
	};

	const query = textureAuditQuery(report);
	const page = query.search({ findingsOnly: true, pageSize: 1, query: "" });
	expect(page.total).toBe(1);
	expect(page.records.map((record) => record.objectPath)).toEqual([first]);
	expect(query.record(first)?.findings).toHaveLength(1);
	expect(query.record(first)?.defaultComparison).toBe("project");
	expect(query.record(first)?.comparisons).toEqual([
		expect.objectContaining({
			kind: "texture_group",
			maximumDimension: expect.objectContaining({
				median: 256,
				percentile: 100,
				selected: 256,
				status: "available"
			}),
			memberCount: 2,
			peers: [expect.objectContaining({ objectPath: second })]
		}),
		expect.objectContaining({ kind: "folder", memberCount: 2 }),
		expect.objectContaining({ kind: "project", memberCount: 2 })
	]);
	expect(query.summary().findingCount).toBe(1);
});

it("compares a selected texture with bounded project, folder, and texture-group cohorts", () => {
	const selectedPath = TextureObjectPath.make("/Game/UI/T_2048.T_2048");
	const paths = [
		TextureObjectPath.make("/Game/UI/T_128.T_128"),
		TextureObjectPath.make("/Game/UI/T_512.T_512"),
		TextureObjectPath.make("/Game/UI/T_1024.T_1024"),
		selectedPath,
		TextureObjectPath.make("/Game/World/T_World.T_World")
	];
	const dimensions = [128, 512, 1024, 2048, 256];
	const report: TextureAuditReport = {
		coverage: {
			discoveredPackages: paths.length,
			failedPackages: 0,
			inspectedPackages: paths.length,
			partialPackages: 0,
			textureAssets: paths.length
		},
		diagnostics: [],
		distributions: { compression: [], maximumDimension: [], sRGB: [], textureGroup: [] },
		findings: [
			{
				actual: [{ label: "Largest axis", value: "2048px" }],
				expected: [{ label: "Maximum axis", value: "512px" }],
				explanation: "UI texture exceeds its source limit.",
				objectPath: selectedPath,
				ruleId: AuditRuleId.make("ui-max"),
				severity: "warning"
			}
		],
		records: paths.map((objectPath, index) => {
			const dimension = dimensions[index];
			if (dimension === undefined) throw new Error("Missing test texture dimension");
			return {
				compression: available(index === 4 ? "TC_Default" : "TC_EditorIcon"),
				dimensions: available({ height: dimension, width: dimension }),
				filePath: `Content/${shortNameForTest(objectPath)}.uasset`,
				mipGeneration: available(index === 4 ? "TMGS_FromTextureGroup" : "TMGS_NoMipmaps"),
				objectPath,
				packageFileBytes: available(dimension * 10),
				sRGB: available(true),
				sourceFormat: available("TSF_BGRA8"),
				sourceMips: available(1),
				textureGroup: available(index === 4 ? "TEXTUREGROUP_World" : "TEXTUREGROUP_UI")
			};
		}),
		ruleSetName: "test",
		schemaVersion: 1,
		status: "complete"
	};

	const selected = textureAuditQuery(report).record(selectedPath);
	expect(selected?.defaultComparison).toBe("texture_group");
	expect(selected?.comparisons.find((comparison) => comparison.kind === "texture_group")).toEqual(
		expect.objectContaining({
			findingCount: 1,
			label: "UI",
			maximumDimension: expect.objectContaining({
				median: 768,
				percentile: 100,
				selected: 2048
			}),
			memberCount: 4
		})
	);
	expect(
		selected?.comparisons.find((comparison) => comparison.kind === "folder")?.memberCount
	).toBe(4);
	expect(
		selected?.comparisons.find((comparison) => comparison.kind === "project")?.memberCount
	).toBe(5);
	expect(selected?.comparisons.every((comparison) => comparison.peers.length <= 5)).toBe(true);
});

function shortNameForTest(objectPath: string): string {
	return objectPath.slice(objectPath.lastIndexOf("/") + 1).split(".")[0] ?? objectPath;
}

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

		const [report, progress] = yield* Effect.gen(function* () {
			const service = yield* TextureAudit;
			const report = yield* service.scanFromProjectIndex(index, {
				projectRoot: "C:/Fixture",
				ruleFile: "fixtures/unreal-project/FixtureSource/Audits/texture-rules.json"
			});
			return [report, yield* service.progress()] as const;
		}).pipe(Effect.provide(TextureAuditLive), Effect.provide(reader));

		expect(report.coverage.discoveredPackages).toBe(30);
		expect(report.coverage.inspectedPackages).toBe(0);
		expect(progress).toEqual({ phase: "ready", processedAssets: 0, totalAssets: 0 });
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
