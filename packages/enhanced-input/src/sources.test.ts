import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
	ConfigExplorer,
	ConfigExplorerError,
	ConfigFamily,
	type ConfigExplainRequest,
	type ConfigExplanation
} from "@ue-shed/config-explorer";
import {
	AssetReaderError,
	makeAssetReaderTestLayer,
	type AssetReaderTestApi,
	type BlueprintGraphRead,
	type SavedAssetInspection,
	type SavedAssetScan,
	type SavedAssetScanOptions
} from "@ue-shed/unreal-assets";
import { Effect, Layer, Stream } from "effect";
import { expect } from "vitest";
import { action, context, mapping, path, report } from "./analysis.test-support.js";
import {
	DEFAULT_MAPPING_CONTEXTS_KEY,
	discoverInputPlatforms,
	EnhancedInputAnalysis,
	EnhancedInputAnalysisLive,
	readCoActivationDocument,
	resolveDefaultContextsFromConfig,
	resolvePlatformViews,
	scanBlueprintInputActionUses
} from "./sources.js";
import { inputActionUsage } from "./usage.js";

const unexpected = (operation: string) => Effect.die(new Error(`Unexpected ${operation} call`));

function reader(overrides: Partial<AssetReaderTestApi>) {
	return makeAssetReaderTestLayer({
		configuration: () =>
			Effect.succeed({ executable: "uasset", timeoutMs: 30_000, catalogTimeoutMs: 60_000 }),
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
		readBlueprint: () => unexpected("readBlueprint"),
		readLevelSequence: () => unexpected("readLevelSequence"),
		readSavedWorld: () => unexpected("readSavedWorld"),
		extractProjectText: () => Stream.die(new Error("Unexpected extractProjectText")),
		extractProjectTextPackages: () =>
			Stream.die(new Error("Unexpected extractProjectTextPackages")),
		extractProjectTextures: () => Stream.die(new Error("Unexpected extractProjectTextures")),
		discoverAssets: () => unexpected("discoverAssets"),
		discoverTables: () => unexpected("discoverTables"),
		readAsset: () => unexpected("readAsset"),
		readTable: () => unexpected("readTable"),
		scanProject: () => unexpected("scanProject"),
		source: () => Effect.succeed("configured"),
		...overrides
	});
}

function explanation(
	request: ConfigExplainRequest,
	effectiveValue: ConfigExplanation["effectiveValue"]
): ConfigExplanation {
	return {
		schemaVersion: 1,
		status: "complete",
		project: { descriptor: "D:/Projects/Demo/Demo.uproject" },
		platform: request.platform,
		family: request.family ?? ConfigFamily.make("Input"),
		section: request.section,
		key: request.key,
		effectiveValue,
		contributions: [],
		layers: [],
		authorities: [],
		diagnostics: []
	};
}

function explorer(
	explain: (
		request: ConfigExplainRequest
	) => Effect.Effect<ConfigExplanation, ConfigExplorerError>
) {
	return Layer.succeed(
		ConfigExplorer,
		ConfigExplorer.of({ explain, compare: () => unexpected("compare") })
	);
}

const header = (name: string, matched: readonly string[]) => ({
	depth: "header" as const,
	fileBytes: 1,
	header: {
		exports: [
			{ class_name: "Blueprint", class_path: "/Script/Engine.Blueprint", object_path: name }
		],
		matched_names: matched,
		package: { name },
		path: `D:/Projects/Demo/Content/${name.split("/").at(-1)}.uasset`,
		schema_version: 8 as const
	}
});

const headerScan = (assets: SavedAssetScan["assets"]): SavedAssetScan => ({
	assets,
	failures: [],
	summary: {
		cacheHits: 0,
		depth: "header",
		diagnostics: [],
		emittedAssets: assets.length,
		failedAssets: 0,
		partialAssets: 0,
		projectRoot: "D:/Projects/Demo",
		roots: ["D:/Projects/Demo/Content"],
		scannedAssets: assets.length,
		schema_version: 8,
		skippedAssets: 0
	}
});

const scenario = report({
	actions: [action("IA_Jump"), action("IA_Fire")],
	contexts: [context("IMC_Gameplay", [mapping("IA_Jump", "SpaceBar")])]
});

it.effect("resolves default contexts through config and reports what it could not read", () =>
	Effect.gen(function* () {
		const resolved = yield* resolveDefaultContextsFromConfig({
			project: "D:/Projects/Demo",
			platform: "Windows"
		}).pipe(
			Effect.provide(
				explorer((request) => {
					expect(request.key).toBe(DEFAULT_MAPPING_CONTEXTS_KEY);
					expect(request.family).toBe("Input");
					return Effect.succeed(
						explanation(request, {
							kind: "array",
							values: [
								'(InputMappingContext="/Game/Input/IMC_Gameplay.IMC_Gameplay",Priority=1)'
							]
						})
					);
				})
			)
		);
		expect(resolved.status).toMatchObject({ status: "resolved", sets: 1 });
		expect(resolved.sets[0]?.contexts).toEqual([
			{ context: "/Game/Input/IMC_Gameplay", priority: 1 }
		]);

		const absent = yield* resolveDefaultContextsFromConfig({
			project: "D:/Projects/Demo",
			platform: "Windows"
		}).pipe(
			Effect.provide(
				explorer((request) => Effect.succeed(explanation(request, { kind: "missing" })))
			)
		);
		expect(absent).toMatchObject({ sets: [], status: { status: "absent" } });

		const unavailable = yield* resolveDefaultContextsFromConfig({
			project: "D:/Projects/Demo",
			platform: "Windows"
		}).pipe(
			Effect.provide(
				explorer(() =>
					Effect.fail(
						new ConfigExplorerError({
							code: "engine_discovery_incomplete",
							message: "No engine was found.",
							recovery: "Pass an engine root.",
							retrySafe: true,
							nextStep: "fix_input"
						})
					)
				)
			)
		);
		expect(unavailable.status).toEqual({
			source: "project_default_contexts",
			status: "unavailable",
			detail: "No engine was found.",
			recovery: "Pass an engine root."
		});
	})
);

it.effect("reads a co-activation document and rejects an invalid one", () =>
	Effect.gen(function* () {
		const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "ue-shed-input-")));
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(directory, { recursive: true, force: true }))
		);
		const valid = join(directory, "valid.json");
		const invalid = join(directory, "invalid.json");
		yield* Effect.promise(() =>
			writeFile(
				valid,
				JSON.stringify({
					schemaVersion: 1,
					kind: "enhanced_input_co_activation",
					sets: [{ id: "on_foot", contexts: [{ context: path("IMC_Gameplay") }] }]
				})
			)
		);
		yield* Effect.promise(() => writeFile(invalid, '{"schemaVersion": 2}'));
		const resolved = yield* readCoActivationDocument(valid);
		expect(resolved.sets).toEqual([
			{
				id: "host_document:on_foot",
				label: "on_foot",
				source: "host_document",
				origin: valid,
				contexts: [{ context: path("IMC_Gameplay"), priority: null }]
			}
		]);
		const failure = yield* Effect.flip(readCoActivationDocument(invalid));
		expect(failure.code).toBe("invalid_co_activation_document");
		expect(failure.nextStep).toBe("fix_input");
	}).pipe(Effect.scoped)
);

const blueprintRead = (objectPath: string, target: string): BlueprintGraphRead => ({
	blueprint: {
		schema_version: 2,
		object_path: objectPath,
		graphs: [
			{
				object_path: `${objectPath}:EventGraph`,
				name: "EventGraph",
				nodes: [
					{
						object_path: `${objectPath}:EventGraph.K2Node_EnhancedInputAction_0`,
						class_path: "/Script/InputBlueprintNodes.K2Node_EnhancedInputAction",
						kind: "other",
						title: "IA_Jump",
						position: { x: 0, y: 0 },
						properties: [
							{
								name: "InputAction",
								type: "ObjectProperty",
								value_kind: "object_ref",
								value: target
							}
						],
						pins: [],
						subclass_tail_bytes: 0
					}
				],
				links: []
			}
		],
		definition: {
			parent_class: null,
			variables: null,
			default_object: null,
			construction_script: null
		},
		coverage_gaps: []
	},
	diagnostics: [],
	outcome: "complete"
});

it.effect("decodes only name-probed Blueprints, within the bound, and keeps failures", () =>
	Effect.gen(function* () {
		const requests: SavedAssetScanOptions[] = [];
		const scan = yield* scanBlueprintInputActionUses(scenario, {
			projectRoot: "D:/Projects/Demo",
			maximumBlueprints: 2
		}).pipe(
			Effect.provide(
				reader({
					scanProject: (options) => {
						requests.push(options);
						return Effect.succeed(
							headerScan([
								header("/Game/BP_Hero", ["/Game/Input/IA_Jump"]),
								header("/Game/BP_Broken", ["/Game/Input/IA_Fire"]),
								header("/Game/BP_Door", []),
								header("/Game/BP_Zed", ["/Game/Input/IA_Fire"])
							])
						);
					},
					readBlueprint: (assetPath) =>
						assetPath.endsWith("BP_Hero.uasset")
							? Effect.succeed(
									blueprintRead("/Game/BP_Hero.BP_Hero", path("IA_Jump"))
								)
							: Effect.fail(
									new AssetReaderError({
										code: "malformed_package",
										kind: "process",
										operation: "blueprint",
										message: "Truncated package.",
										recovery: "Resave it.",
										retrySafe: false,
										nextStep: "fix_input"
									})
								)
				})
			)
		);
		expect(requests[0]).toMatchObject({
			depth: "header",
			classNameSuffixes: ["Blueprint"],
			names: ["/Game/Input/IA_Fire", "/Game/Input/IA_Jump"]
		});
		expect(scan.uses).toEqual([
			{
				action: path("IA_Jump"),
				blueprint: "/Game/BP_Hero.BP_Hero",
				ownerPath: "/Game/BP_Hero.BP_Hero:EventGraph.K2Node_EnhancedInputAction_0",
				propertyPath: "InputAction",
				kind: "event_node"
			}
		]);
		expect(scan.coverage).toEqual({
			status: "scanned",
			complete: false,
			blueprints: 4,
			matched: 3,
			decoded: 1,
			skipped: 1,
			failed: [{ path: join("Content", "BP_Broken.uasset"), message: "Truncated package." }],
			partial: [],
			headerFailures: []
		});
	})
);

it.effect(
	"keeps partial Blueprint reads and unreadable headers in the coverage beside no known use",
	() =>
		Effect.gen(function* () {
			const partialRead: BlueprintGraphRead = {
				blueprint: {
					schema_version: 2,
					object_path: "/Game/BP_Hero.BP_Hero",
					graphs: [],
					definition: {
						parent_class: null,
						variables: null,
						default_object: null,
						construction_script: null
					},
					coverage_gaps: [
						{
							object_path: "/Game/BP_Hero.BP_Hero:EventGraph",
							reason: "missing_node_reference",
							detail: "The graph's node export was not decoded."
						}
					]
				},
				diagnostics: [
					{
						code: "graph_partial",
						message: "One graph was not decoded.",
						severity: "warning"
					}
				],
				outcome: "partial"
			};
			const index: SavedAssetScan = {
				...headerScan([header("/Game/BP_Hero", ["/Game/Input/IA_Jump"])]),
				failures: [
					{
						code: "malformed_package",
						message: "Header truncated.",
						path: "D:/Projects/Demo/Content/BP_Broken.uasset",
						retrySafe: false
					}
				]
			};
			const scan = yield* scanBlueprintInputActionUses(scenario, {
				projectRoot: "D:/Projects/Demo",
				maximumBlueprints: 10
			}).pipe(
				Effect.provide(
					reader({
						scanProject: () => Effect.succeed(index),
						readBlueprint: () => Effect.succeed(partialRead)
					})
				)
			);
			expect(scan.uses).toEqual([]);
			expect(scan.coverage).toEqual({
				status: "scanned",
				complete: false,
				blueprints: 1,
				matched: 1,
				decoded: 1,
				skipped: 0,
				failed: [],
				partial: [
					{
						path: join("Content", "BP_Hero.uasset"),
						blueprint: "/Game/BP_Hero.BP_Hero",
						diagnostics: [
							{ code: "graph_partial", message: "One graph was not decoded." }
						],
						coverageGaps: [
							{
								objectPath: "/Game/BP_Hero.BP_Hero:EventGraph",
								reason: "missing_node_reference",
								detail: "The graph's node export was not decoded."
							}
						]
					}
				],
				headerFailures: [
					{ path: join("Content", "BP_Broken.uasset"), message: "Header truncated." }
				]
			});
			const usage = inputActionUsage(scenario, {
				blueprintUses: scan.uses,
				blueprintCoverage: scan.coverage
			});
			// IA_Fire has no known use, and the coverage beside it says the search was incomplete.
			expect(usage.noKnownUse).toEqual([path("IA_Fire")]);
			expect(usage.blueprintCoverage).toMatchObject({ status: "scanned", complete: false });
		})
);

const platformInspection: SavedAssetInspection = {
	schema_version: 8,
	status: "ok",
	path: "D:/Projects/Demo/Content/BP_SwitchData.uasset",
	package: {
		name: "/Game/BP_SwitchData",
		version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1
	},
	assets: [
		{
			kind: "UObject",
			object_path: "/Game/BP_SwitchData.Default__BP_SwitchData_C",
			class_path: "/Game/BP_SwitchData.BP_SwitchData_C",
			properties: [
				{
					name: "MappingContextRedirects",
					type: "MapProperty",
					value_kind: "map",
					entries: [
						{
							key: { value_kind: "object_ref", value: path("IMC_Gameplay") },
							value: { value_kind: "object_ref", value: path("IMC_Handheld") }
						}
					]
				}
			]
		}
	],
	decode_errors: []
};

it.effect("resolves platform views from config, header inventory and class defaults", () =>
	Effect.gen(function* () {
		const views = yield* resolvePlatformViews({
			project: "D:/Projects/Demo",
			projectRoot: "D:/Projects/Demo",
			platforms: ["Switch", "Windows", "Android"]
		}).pipe(
			Effect.provide(
				explorer((request) => {
					if (request.platform === "Android") {
						return Effect.fail(
							new ConfigExplorerError({
								code: "invalid_platform",
								message: "Unknown platform Android.",
								recovery: "Choose a platform the engine knows.",
								retrySafe: false,
								nextStep: "fix_input"
							})
						);
					}
					expect(request.section).toBe(
						`EnhancedInputPlatformSettings_${request.platform} EnhancedInputPlatformSettings`
					);
					return Effect.succeed(
						explanation(
							request,
							request.platform === "Switch"
								? {
										kind: "array",
										values: [
											"/Script/Engine.BlueprintGeneratedClass'/Game/BP_SwitchData.BP_SwitchData_C'",
											"/Game/BP_Missing.BP_Missing_C"
										]
									}
								: { kind: "missing" }
						)
					);
				})
			),
			Effect.provide(
				reader({
					scanProject: () =>
						Effect.succeed(headerScan([header("/Game/BP_SwitchData", [])])),
					readAsset: () => Effect.succeed(platformInspection)
				})
			)
		);
		expect(views).toEqual([
			{
				platform: "Switch",
				status: "partial",
				inputData: ["/Game/BP_SwitchData.BP_SwitchData_C", "/Game/BP_Missing.BP_Missing_C"],
				redirects: [
					{
						from: path("IMC_Gameplay"),
						to: path("IMC_Handheld"),
						inputData: "/Game/BP_SwitchData.BP_SwitchData_C"
					}
				],
				diagnostics: [
					"No saved Blueprint package was found for /Game/BP_Missing.BP_Missing_C; a native class saves no redirects here."
				]
			},
			{
				platform: "Windows",
				status: "resolved",
				inputData: [],
				redirects: [],
				diagnostics: []
			},
			{
				platform: "Android",
				status: "unavailable",
				inputData: [],
				redirects: [],
				diagnostics: ["Unknown platform Android. Choose a platform the engine knows."]
			}
		]);
	})
);

it.effect("lists platforms that have a project platform Input config", () =>
	Effect.gen(function* () {
		const directory = yield* Effect.promise(() =>
			mkdtemp(join(tmpdir(), "ue-shed-platforms-"))
		);
		yield* Effect.addFinalizer(() =>
			Effect.promise(() => rm(directory, { recursive: true, force: true }))
		);
		const { mkdir } = yield* Effect.promise(() => import("node:fs/promises"));
		yield* Effect.promise(async () => {
			await mkdir(join(directory, "Config", "Windows"), { recursive: true });
			await writeFile(join(directory, "Config", "Windows", "WindowsInput.ini"), "");
			await mkdir(join(directory, "Config", "Localization"), { recursive: true });
			await mkdir(join(directory, "Platforms", "Switch", "Config"), { recursive: true });
			await writeFile(
				join(directory, "Platforms", "Switch", "Config", "SwitchInput.ini"),
				""
			);
		});
		expect(yield* discoverInputPlatforms(directory)).toEqual(["Switch", "Windows"]);
	}).pipe(Effect.scoped)
);

it.effect("composes the requested co-activation sources through one service", () =>
	Effect.gen(function* () {
		const analysis = yield* EnhancedInputAnalysis;
		const result = yield* analysis.coActivation({
			project: { project: "D:/Projects/Demo", platform: "Windows" }
		});
		expect(result.sources.map((source) => [source.source, source.status])).toEqual([
			["config_asset", "absent"],
			["project_default_contexts", "absent"]
		]);
	}).pipe(
		Effect.provide(EnhancedInputAnalysisLive),
		Effect.provide(
			explorer((request) => Effect.succeed(explanation(request, { kind: "missing" })))
		),
		Effect.provide(reader({}))
	)
);
