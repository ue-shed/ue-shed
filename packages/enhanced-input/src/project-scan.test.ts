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
	ENHANCED_INPUT_CLASS_PREFIX,
	EnhancedInputScanError,
	EnhancedInputService,
	EnhancedInputServiceLive,
	INPUT_ACTION_CLASS
} from "./project.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

const actionInspection: SavedAssetInspection = {
	assets: [
		{
			class_path: INPUT_ACTION_CLASS,
			kind: "UObject",
			object_path: "/Game/Input/IA_Move.IA_Move",
			properties: [
				{
					name: "ValueType",
					type: "EnumProperty",
					value: "EInputActionValueType::Axis2D",
					value_kind: "enum"
				}
			]
		}
	],
	decode_errors: [],
	package: {
		name: "/Game/Input/IA_Move",
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1,
		version: { legacy_file: -9, legacy_ue3: 0, licensee: 0, ue4: 522, ue5: 1018 }
	},
	path: "C:/Fixture/Content/Input/IA_Move.uasset",
	schema_version: 7,
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

it.effect("selects Enhanced Input packages by class prefix in one batched pass", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetScanOptions[]>([]);
		const reader = readerOffering(
			Effect.fn("AssetReader.Test.scanProject")(function* (options) {
				yield* Ref.update(seen, (current) => [...current, options]);
				return {
					assets: [{ fileBytes: 1441, inspection: actionInspection }],
					failures: [],
					summary: {
						diagnostics: [],
						emittedAssets: 1,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot: "C:/Fixture",
						roots: ["C:/Fixture/Content"],
						scannedAssets: 22,
						schema_version: 7 as const,
						skippedAssets: 21
					}
				};
			})
		);

		const report = yield* Effect.flatMap(EnhancedInputService, (service) =>
			service.scan({ projectRoot: "C:/Fixture" })
		).pipe(Effect.provide(EnhancedInputServiceLive), Effect.provide(reader));

		const [options] = yield* Ref.get(seen);
		expect(options?.classPrefixes).toEqual([ENHANCED_INPUT_CLASS_PREFIX]);
		expect(report.coverage.discoveredPackages).toBe(22);
		expect(report.coverage.inspectedPackages).toBe(22);
		expect(report.coverage.inputActions).toBe(1);
		// Packages the reader ruled out never reach the report, so a project full of unrelated
		// assets no longer produces an unsupported_asset diagnostic for each one.
		expect(report.diagnostics).toEqual([]);
		expect(report.status).toBe("complete");
	})
);

it.effect("forwards scoped roots to the reader, and omits them when unscoped", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetScanOptions[]>([]);
		const reader = readerOffering(
			Effect.fn("AssetReader.Test.scanProject")(function* (options) {
				yield* Ref.update(seen, (current) => [...current, options]);
				return {
					assets: [],
					failures: [],
					summary: {
						diagnostics: [],
						emittedAssets: 0,
						failedAssets: 0,
						partialAssets: 0,
						projectRoot: options.projectRoot,
						roots: [...(options.paths ?? ["C:/Fixture/Content"])],
						scannedAssets: 0,
						schema_version: 7 as const,
						skippedAssets: 0
					}
				};
			})
		);

		yield* Effect.gen(function* () {
			const service = yield* EnhancedInputService;
			yield* service.scan({
				paths: ["C:/Fixture/Content/Input"],
				projectRoot: "C:/Fixture"
			});
			yield* service.scan({ projectRoot: "C:/Fixture" });
		}).pipe(Effect.provide(EnhancedInputServiceLive), Effect.provide(reader));

		const [scoped, unscoped] = yield* Ref.get(seen);
		expect(scoped?.paths).toEqual(["C:/Fixture/Content/Input"]);
		expect(scoped?.classPrefixes).toEqual([ENHANCED_INPUT_CLASS_PREFIX]);
		// Absent rather than empty, so the reader keeps its own `Content` default.
		expect(unscoped && "paths" in unscoped).toBe(false);
	})
);

it.effect("maps a reader asset limit onto scan_limit_exceeded", () =>
	Effect.gen(function* () {
		const reader = readerOffering((options) =>
			Effect.fail(
				new AssetReaderError({
					kind: "resource_limit",
					operation: "scan",
					message: "Scan found 22 packages, above the limit of 2.",
					path: options.projectRoot,
					retrySafe: false
				})
			)
		);

		const error = yield* Effect.flatMap(EnhancedInputService, (service) =>
			service.scan({ maximumAssets: 2, projectRoot: "C:/Fixture" })
		).pipe(Effect.flip, Effect.provide(EnhancedInputServiceLive), Effect.provide(reader));

		expect(error).toBeInstanceOf(EnhancedInputScanError);
		expect(error.code).toBe("scan_limit_exceeded");
	})
);
