import { it } from "@effect/vitest";
import {
	AssetReaderError,
	makeAssetReaderTestLayer,
	type SavedAssetScan,
	type SavedAssetExtractionOptions,
	type SavedAssetTextExtractionEvent
} from "@ue-shed/unreal-assets";
import { Effect, Ref, Stream } from "effect";
import { expect } from "vitest";
import { GameTextIndexProgressReporter, type GameTextIndexProgress } from "./index-progress.js";
import {
	TEXT_PROPERTY_NAME,
	TextCorpusScanError,
	TextCorpusScanLimit,
	TextCorpusService,
	parseTextCorpusScanOptions,
	TextCorpusServiceLive
} from "./corpus.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

const textEvents = (options: {
	readonly failed?: boolean;
	readonly path: string;
	readonly scannedAssets: number;
}): readonly SavedAssetTextExtractionEvent[] => [
	{
		event: "text_occurrence",
		schema_version: 1,
		path: options.path,
		fileBytes: 1510,
		occurrence: {
			source: "Hello",
			dev_notes: "Friendly greeting",
			identity: { status: "resolved", namespace: "Fixture", key: "GREETING" },
			location: {
				kind: "string_table_entry",
				object_path: "/Game/Text.ST_Game",
				entry_key: "GREETING"
			},
			edit_capability: "source_editable"
		}
	},
	{
		event: "text_package",
		schema_version: 1,
		path: options.path,
		fileBytes: 1510,
		status: "complete",
		occurrences: 1,
		coverage_gaps: 0,
		diagnostics: []
	},
	...(options.failed === true
		? [
				{
					event: "error" as const,
					code: "asset_malformed_data",
					message: "Saved asset could not be inspected (asset_malformed_data)",
					path: "C:/Fixture/Content/Text/Broken.uasset",
					retrySafe: false
				}
			]
		: []),
	{
		event: "text_summary",
		cacheHits: 0,
		depth: "text",
		diagnostics: [],
		emittedAssets: 1,
		failedAssets: options.failed === true ? 1 : 0,
		partialAssets: 0,
		projectRoot: "C:/Fixture",
		roots: ["C:/Fixture/Content"],
		scannedAssets: options.scannedAssets,
		schema_version: 8,
		skippedAssets: options.scannedAssets - 1 - (options.failed === true ? 1 : 0)
	}
];

const readerOffering = (
	extractProjectText: (
		options: SavedAssetExtractionOptions
	) => Stream.Stream<SavedAssetTextExtractionEvent, AssetReaderError>
) =>
	makeAssetReaderTestLayer({
		configuration: () =>
			Effect.succeed({
				executable: "uasset",
				timeoutMs: 30_000,
				catalogTimeoutMs: 50 * 60_000
			}),
		catalogProgress: () =>
			Effect.succeed({
				phase: "idle",
				cacheHits: 0,
				processedAssets: 0,
				tablesFound: 0,
				totalAssets: 0
			}),
		scanProgress: () =>
			Effect.succeed({
				phase: "idle",
				cacheHits: 0,
				emittedAssets: 0,
				processedAssets: 0,
				totalAssets: 0
			}),
		savedWorldProgress: () =>
			Effect.succeed({
				phase: "idle",
				actorsFound: 0,
				processedPackages: 0,
				totalPackages: 0
			}),
		readBlueprint: () =>
			Effect.die(new Error("Unexpected readBlueprint in this reader fixture")),
		readLevelSequence: () =>
			Effect.die(new Error("Unexpected readLevelSequence in this reader fixture")),
		readSavedWorld: () =>
			Effect.die(new Error("Unexpected readSavedWorld in this reader fixture")),
		scanProject: () => Effect.die(new Error("Unexpected scanProject in this reader fixture")),
		extractProjectTextPackages: () =>
			Stream.die(new Error("Unexpected extractProjectTextPackages in this reader fixture")),
		extractProjectTextures: () =>
			Stream.die(new Error("Unexpected extractProjectTextures in this reader fixture")),
		discoverAssets: () => unexpected("discoverAssets"),
		discoverTables: () => unexpected("discoverTables"),
		readAsset: () => unexpected("readAsset"),
		readTable: () => unexpected("readTable"),
		extractProjectText,
		source: () => Effect.succeed("configured")
	});

it.effect("builds a corpus from compact text extraction events", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetExtractionOptions[]>([]);
		const reader = readerOffering((options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* Ref.update(seen, (current) => [...current, options]);
					return Stream.fromIterable(
						textEvents({
							failed: true,
							path: "C:/Fixture/Content/Text/ST_Game.uasset",
							scannedAssets: 30
						})
					);
				})
			)
		);

		const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scan({ projectRoot: "C:/Fixture" })
		).pipe(Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		const [options] = yield* Ref.get(seen);
		expect(options?.paths).toBeUndefined();
		// Packages the reader ruled out from their header still count as discovered and inspected.
		expect(corpus.coverage.discoveredPackages).toBe(30);
		expect(corpus.coverage.inspectedPackages).toBe(29);
		expect(corpus.coverage.failedPackages).toBe(1);
		expect(corpus.coverage.textOccurrences).toBe(1);
		expect(corpus.units[0]?.occurrences[0]?.devNotes).toBe("Friendly greeting");
		expect(corpus.status).toBe("partial");
		expect(corpus.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			"package_inspection_failed"
		);
	})
);

it.effect("decodes only candidates from an existing project header index", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<SavedAssetExtractionOptions[]>([]);
		const reader = readerOffering((options) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* Ref.update(seen, (current) => [...current, options]);
					return Stream.fromIterable(
						textEvents({
							path: "C:/Fixture/Content/Text/ST_Game.uasset",
							scannedAssets: 1
						})
					);
				})
			)
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

		const progress: GameTextIndexProgress[] = [];
		const corpus = yield* Effect.gen(function* () {
			const service = yield* TextCorpusService;
			return yield* service.scanFromProjectIndex(index, { projectRoot: "C:/Fixture" });
		}).pipe(
			Effect.provide(TextCorpusServiceLive),
			Effect.provide(reader),
			Effect.provideService(GameTextIndexProgressReporter, (event) => progress.push(event))
		);

		const [options] = yield* Ref.get(seen);
		expect(options?.paths).toEqual(["C:/Fixture/Content/Text/ST_Game.uasset"]);
		expect(corpus.coverage.discoveredPackages).toBe(30);
		expect(corpus.coverage.inspectedPackages).toBe(1);
		expect(progress[0]).toEqual({ phase: "corpus", completed: 0, total: 1 });
		expect(progress.at(-1)).toEqual({ phase: "corpus", completed: 1, total: 1 });
	})
);

it.effect("does not scan Content when the existing project index has no text candidates", () =>
	Effect.gen(function* () {
		const reader = readerOffering(() =>
			Stream.die(new Error("Unexpected extractProjectText call"))
		);
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
			Stream.fail(
				new AssetReaderError({
					kind: "resource_limit",
					operation: "extract_text",
					message: "Scan found 30 packages, above the limit of 2.",
					path: options.projectRoot,
					retrySafe: false,
					recovery: "Test double: narrow the request.",
					nextStep: "escalate"
				})
			)
		);

		const error = yield* Effect.flatMap(TextCorpusService, (service) =>
			service.scan({ maximumAssets: TextCorpusScanLimit.make(2), projectRoot: "C:/Fixture" })
		).pipe(Effect.flip, Effect.provide(TextCorpusServiceLive), Effect.provide(reader));

		expect(error).toBeInstanceOf(TextCorpusScanError);
		expect(error.code).toBe("scan_limit_exceeded");
		expect(error.retrySafe).toBe(false);
	})
);

function* syntheticGaps(): Generator<SavedAssetTextExtractionEvent> {
	for (let packageIndex = 0; packageIndex < 5_000; packageIndex += 1) {
		const path = `C:/Fixture/Content/Text/Package${packageIndex}.uasset`;
		yield {
			event: "text_package",
			schema_version: 1,
			path,
			fileBytes: 1,
			status: packageIndex % 2 === 0 ? "partial" : "complete",
			occurrences: 0,
			coverage_gaps: 10,
			diagnostics: []
		};
		for (let propertyIndex = 0; propertyIndex < 10; propertyIndex += 1) {
			yield {
				event: "text_coverage_gap",
				schema_version: 1,
				path,
				coverage_gap: {
					object_path: `/Game/Text/Package${packageIndex}.Asset`,
					property_path: `Label${propertyIndex}`,
					reason:
						propertyIndex < 4
							? "property_decoder_rejected"
							: propertyIndex < 7
								? "feature_unavailable_for_engine_version"
								: propertyIndex < 9
									? "legacy_container_element_without_type_information"
									: "unsupported_text_history"
				}
			};
		}
	}
}

it.effect(
	"folds 50,000 gaps into bounded diagnostics for only the packages the reader marked partial",
	() =>
		Effect.gen(function* () {
			const reader = readerOffering(() => Stream.fromIterable(syntheticGaps()));
			const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
				service.scan({ projectRoot: "C:/Fixture" })
			).pipe(Effect.provide(TextCorpusServiceLive), Effect.provide(reader));
			// Every package has gaps; only the reader's partial status makes them coverage problems.
			expect(corpus.coverage.unsupportedTextProperties).toBe(2_500);
			expect(corpus.coverage.partialPackages).toBe(2_500);
			expect(corpus.status).toBe("partial");
			expect(corpus.packageCoverage).toHaveLength(5_000);
			// Keep output bounded by partial packages instead of emitting all 50,000 gaps.
			expect(corpus.diagnostics).toHaveLength(5_000);
			expect(
				corpus.packageCoverage?.filter((item) => item.status === "partial")
			).toHaveLength(2_500);
			const partial = corpus.diagnostics.filter(
				(item) => item.code === "package_partially_decoded"
			);
			expect(partial).toHaveLength(2_500);
			expect(
				partial.every((item) => /Package\d*[02468]\.uasset$/.test(item.packageFile))
			).toBe(true);
			for (const diagnostic of partial) {
				expect(diagnostic.coverageGapCounts).toEqual({
					property_decoder_rejected: 4,
					feature_unavailable_for_engine_version: 3,
					legacy_container_element_without_type_information: 2,
					unsupported_text_history: 1
				});
				expect(diagnostic.propertyPath).toBe("Label0");
				expect(diagnostic.message).toBe(
					"10 properties were not decoded: 4 rejected by their decoder, " +
						"3 unavailable for this engine version, 2 container elements without type information, " +
						"1 with unsupported text histories."
				);
			}
			const histories = corpus.diagnostics.filter(
				(item) => item.code === "unsupported_text_history"
			);
			expect(histories).toHaveLength(2_500);
			expect(histories.every((item) => item.propertyPath === "Label9")).toBe(true);
		})
);

it.effect(
	"caps history samples, explains partial packages without decode errors and keeps gaps in complete packages as detail",
	() =>
		Effect.gen(function* () {
			const path = "C:/Fixture/Content/Text/History.uasset";
			const events: SavedAssetTextExtractionEvent[] = Array.from(
				{ length: 50 },
				(_, index) => ({
					event: "text_coverage_gap",
					schema_version: 1,
					path,
					coverage_gap: {
						object_path: "/Game/Text/History.Asset",
						property_path: `Label${index}`,
						reason: "unsupported_text_history"
					}
				})
			);
			events.push(
				{
					event: "text_package",
					schema_version: 1,
					path,
					fileBytes: 1,
					status: "partial",
					occurrences: 0,
					coverage_gaps: 50,
					diagnostics: []
				},
				{
					event: "text_coverage_gap",
					schema_version: 1,
					path: "C:/Fixture/Content/Text/Complete.uasset",
					coverage_gap: {
						object_path: "/Game/Text/Complete.Asset",
						property_path: "NativeVectors",
						reason: "property_decoder_rejected"
					}
				},
				{
					event: "text_package",
					schema_version: 1,
					path: "C:/Fixture/Content/Text/Complete.uasset",
					fileBytes: 1,
					status: "complete",
					occurrences: 0,
					coverage_gaps: 1,
					diagnostics: []
				},
				{
					event: "text_package",
					schema_version: 1,
					path: "C:/Fixture/Content/Text/Partial.uasset",
					fileBytes: 1,
					status: "partial",
					occurrences: 0,
					coverage_gaps: 0,
					diagnostics: []
				}
			);
			const corpus = yield* Effect.flatMap(TextCorpusService, (service) =>
				service.scan({ projectRoot: "C:/Fixture" })
			).pipe(
				Effect.provide(TextCorpusServiceLive),
				Effect.provide(readerOffering(() => Stream.fromIterable(events)))
			);
			expect(
				corpus.diagnostics.filter((item) => item.code === "unsupported_text_history")
			).toHaveLength(3);
			expect(
				corpus.diagnostics.filter((item) => item.code === "package_partially_decoded")
			).toHaveLength(2);
			expect(corpus.diagnostics.every((item) => !item.message.includes("0 decode"))).toBe(
				true
			);
			expect(corpus.diagnostics.some((item) => item.packageFile.includes("Complete"))).toBe(
				false
			);
			expect(corpus.coverage.partialPackages).toBe(2);
		})
);

it.effect("parses untrusted scan options once, as a typed corpus failure", () =>
	Effect.gen(function* () {
		const parsed = yield* parseTextCorpusScanOptions({
			projectRoot: "C:/Fixture",
			concurrency: 4
		});
		expect(parsed).toEqual({ projectRoot: "C:/Fixture", concurrency: 4 });
		const error = yield* Effect.flip(
			parseTextCorpusScanOptions({ projectRoot: "C:/Fixture", maximumAssets: 0 })
		);
		expect(error).toBeInstanceOf(TextCorpusScanError);
		expect(error).toMatchObject({ code: "invalid_options", retrySafe: false });
		expect(error.cause).toBeDefined();
	})
);
