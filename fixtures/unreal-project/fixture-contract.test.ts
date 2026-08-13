import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type DataTableContractBase = {
	readonly kind: "data-table";
	readonly assetPath: string;
	readonly rowStruct: string;
	readonly fieldFamilies: readonly string[];
};

type SourceDataTableContract = DataTableContractBase & {
	readonly source: string;
	readonly rows: readonly string[];
};

type GeneratedDataTableContract = DataTableContractBase & {
	readonly generatedRows: {
		readonly generator: "scalar-load-v1";
		readonly count: number;
		readonly namePrefix: string;
	};
};

type DataTableContract = SourceDataTableContract | GeneratedDataTableContract;

type CompositeTableContract = {
	readonly kind: "composite-data-table";
	readonly assetPath: string;
	readonly rowStruct: string;
	readonly parents: readonly string[];
	readonly rows: readonly string[];
	readonly fieldFamilies: readonly string[];
};

type FixtureContract = {
	readonly schemaVersion: number;
	readonly fixtureVersion: string;
	readonly engine: { readonly major: number; readonly minor: number };
	readonly contentRoot: string;
	readonly levelSequence: {
		readonly assetPath: string;
		readonly nestedAssetPath: string;
		readonly tickResolution: { readonly numerator: number; readonly denominator: number };
		readonly displayRate: { readonly numerator: number; readonly denominator: number };
		readonly playbackRange: { readonly start: number; readonly end: number };
		readonly subSequenceRange: { readonly start: number; readonly end: number };
		readonly cinematicShotRange: { readonly start: number; readonly end: number };
		readonly shotDisplayName: string;
		readonly textKeyFrames: readonly number[];
		readonly textKeys: readonly string[];
	};
	readonly gameText: {
		readonly contentRoot: string;
		readonly stringTable: {
			readonly assetPath: string;
			readonly namespace: string;
			readonly entries: readonly string[];
		};
		readonly occurrenceAsset: {
			readonly assetPath: string;
			readonly sharedIdentity: {
				readonly namespace: string;
				readonly key: string;
				readonly occurrences: number;
			};
			readonly equalSourceDistinctKeys: readonly string[];
			readonly stringTableReference: string;
		};
	};
	readonly enhancedInput: {
		readonly contentRoot: string;
		readonly actions: readonly {
			readonly assetPath: string;
			readonly valueType: string;
			readonly consumeInput: boolean;
			readonly actionDescription: string;
		}[];
		readonly mappingContexts: readonly {
			readonly assetPath: string;
			readonly contextDescription: string;
			readonly mappingsProperty: string;
			readonly mappings: readonly {
				readonly action: string;
				readonly keyName: string;
				readonly triggerClasses?: readonly string[];
				readonly modifierCount: number;
				readonly modifierClasses?: readonly string[];
			}[];
		}[];
		/** Keys more than one context claims, which is what the Input Atlas exists to surface. */
		readonly contestedKeys: readonly string[];
	};
	readonly scenarioStudio: {
		readonly map: string;
		readonly relativeMapPath: string;
		readonly timePolicy: "game_time";
		readonly inputLayer: "pre_evaluation";
		readonly actions: readonly {
			readonly id: "Move" | "Jump" | "Interact";
			readonly publicPath: string;
			readonly objectPath: string;
			readonly valueType: "boolean" | "axis2d";
		}[];
		readonly conditions: readonly string[];
		readonly maxEvidence: number;
	};
	readonly cameraLoad: {
		readonly map: string;
		readonly movingActors: number;
		readonly cameraSources: number;
		readonly actorFamilies: {
			readonly stationary: {
				readonly className: string;
				readonly count: number;
				readonly shape: string;
				readonly materialColor: string;
				readonly behavior: string;
			};
			readonly flying: {
				readonly className: string;
				readonly count: number;
				readonly shape: string;
				readonly materialColor: string;
				readonly behavior: string;
			};
			readonly intermittent: {
				readonly className: string;
				readonly count: number;
				readonly shape: string;
				readonly materialColor: string;
				readonly behavior: string;
			};
		};
		readonly environment: {
			readonly skyAtmosphere: boolean;
			readonly skyLightRealtimeCapture: boolean;
			readonly exponentialHeightFog: boolean;
		};
		readonly capture: {
			readonly width: number;
			readonly height: number;
			readonly pixelFormat: string;
		};
	};
	readonly mapReview: {
		readonly map: string;
		readonly reviewSet: string;
		readonly subject: string;
		readonly views: readonly string[];
	};
	readonly offlineWorld: {
		readonly map: string;
		readonly relativeMapPath: string;
		readonly externalActors: number;
		readonly labels: readonly string[];
	};
	readonly textureAudit: {
		readonly contentRoot: string;
		readonly source: string;
		readonly rules: string;
		readonly textures: readonly TextureContract[];
	};
	readonly tables: readonly (DataTableContract | CompositeTableContract)[];
};

type TextureContract = {
	readonly objectPath: string;
	readonly width: number;
	readonly height: number;
	readonly sourceFormat: string;
	readonly textureGroup: string;
	readonly compression: string;
	readonly sRGB: boolean;
	readonly mipGeneration: string;
	readonly expectedFindingIds: readonly string[];
};

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const parserTargetFiles = [
	"FixtureExpected/parser-targets/enhanced-input.json",
	"FixtureExpected/parser-targets/level-sequence.json",
	"FixtureExpected/parser-targets/string-table.json",
	"FixtureExpected/parser-targets/text-data-asset.json",
	"FixtureExpected/parser-targets/texture2d.json"
] as const;

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readContract(): FixtureContract {
	const value = readJson(join(fixtureRoot, "fixture-contract.json"));
	if (
		!isRecord(value) ||
		typeof value.schemaVersion !== "number" ||
		typeof value.fixtureVersion !== "string" ||
		!isRecord(value.engine) ||
		!isRecord(value.cameraLoad) ||
		!isRecord(value.mapReview) ||
		!isRecord(value.offlineWorld) ||
		!isRecord(value.gameText) ||
		!isRecord(value.levelSequence) ||
		!isRecord(value.enhancedInput) ||
		!isRecord(value.scenarioStudio) ||
		!isRecord(value.textureAudit) ||
		typeof value.engine.major !== "number" ||
		typeof value.engine.minor !== "number" ||
		typeof value.contentRoot !== "string" ||
		!Array.isArray(value.tables) ||
		!Array.isArray(value.enhancedInput.actions) ||
		!Array.isArray(value.offlineWorld.labels) ||
		!Array.isArray(value.enhancedInput.mappingContexts) ||
		!Array.isArray(value.enhancedInput.contestedKeys) ||
		!Array.isArray(value.scenarioStudio.actions) ||
		!Array.isArray(value.scenarioStudio.conditions) ||
		!Array.isArray(value.textureAudit.textures)
	) {
		throw new Error("fixture-contract.json does not match the fixture contract envelope");
	}
	return value as FixtureContract;
}

function sourceRowNames(sourcePath: string): readonly string[] {
	const value = readJson(resolve(fixtureRoot, sourcePath));
	if (!Array.isArray(value)) {
		throw new Error(`${sourcePath} must contain an array of rows`);
	}
	return value.map((row, index) => {
		if (!isRecord(row) || typeof row.Name !== "string" || row.Name.length === 0) {
			throw new Error(`${sourcePath} row ${index} must have a non-empty Name`);
		}
		return row.Name;
	});
}

function generatedAssetPath(assetPath: string): string {
	const packagePath = assetPath.slice("/Game/".length).split(".")[0];
	return join(fixtureRoot, "Content", `${packagePath}.uasset`);
}

function externalActorPackageCount(root: string): number {
	return readdirSync(root, { recursive: true }).filter(
		(entry) => typeof entry === "string" && entry.endsWith(".uasset")
	).length;
}

describe("generic Unreal fixture contract", () => {
	const contract = readContract();

	it("declares an inspectable version and stock engine baseline", () => {
		expect(contract.schemaVersion).toBe(1);
		expect(contract.fixtureVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(contract.engine).toEqual({ major: 5, minor: 7 });
		expect(contract.contentRoot).toBe("/Game/Fixture/Authoring");
	});

	it("declares one portable live Scenario Studio fixture", () => {
		expect(contract.scenarioStudio).toEqual({
			map: "/Game/Fixture/Scenarios/L_MovementGym",
			relativeMapPath: "Content/Fixture/Scenarios/L_MovementGym.umap",
			timePolicy: "game_time",
			inputLayer: "pre_evaluation",
			actions: [
				{
					id: "Move",
					publicPath: "/Game/Fixture/Input/IA_Move",
					objectPath: "/Game/Fixture/Input/IA_Move.IA_Move",
					valueType: "axis2d"
				},
				{
					id: "Jump",
					publicPath: "/Game/Fixture/Input/IA_Jump",
					objectPath: "/Game/Fixture/Input/IA_Jump.IA_Jump",
					valueType: "boolean"
				},
				{
					id: "Interact",
					publicPath: "/Game/Fixture/Input/IA_Interact",
					objectPath: "/Game/Fixture/Input/IA_Interact.IA_Interact",
					valueType: "boolean"
				}
			],
			conditions: ["landing_ready", "cache_open"],
			maxEvidence: 8
		});
		expect(existsSync(join(fixtureRoot, contract.scenarioStudio.relativeMapPath))).toBe(true);
	});

	it("keeps table identities and row identities unique", () => {
		const assetPaths = contract.tables.map((table) => table.assetPath);
		expect(new Set(assetPaths).size).toBe(assetPaths.length);
		for (const table of contract.tables) {
			expect(table.assetPath.startsWith(`${contract.contentRoot}/`)).toBe(true);
			expect(table.rowStruct.startsWith("/Script/UEShedFixture.")).toBe(true);
			if ("rows" in table) {
				expect(new Set(table.rows).size).toBe(table.rows.length);
			}
		}
	});

	it("declares the reproducible multi-camera load map", () => {
		expect(contract.cameraLoad).toEqual({
			map: "/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad",
			movingActors: 4096,
			cameraSources: 32,
			actorFamilies: {
				stationary: {
					className: "UEShedFixtureStationary",
					count: 3278,
					shape: "cube",
					materialColor: "slate",
					behavior: "fixed-pose"
				},
				flying: {
					className: "UEShedFixtureFlying",
					count: 409,
					shape: "sphere",
					materialColor: "cyan",
					behavior: "airborne-orbit"
				},
				intermittent: {
					className: "UEShedFixtureIntermittent",
					count: 409,
					shape: "cylinder",
					materialColor: "amber",
					behavior: "visibility-cycle"
				}
			},
			environment: {
				skyAtmosphere: true,
				skyLightRealtimeCapture: true,
				exponentialHeightFog: true
			},
			capture: { width: 320, height: 180, pixelFormat: "BGRA8" }
		});
		expect(existsSync(join(fixtureRoot, "Content/Fixture/Cameras/L_CameraLoad.umap"))).toBe(
			true
		);
	});

	it("declares a portable durable-loop Review Set and stable subject", () => {
		expect(contract.mapReview).toEqual({
			map: "/Game/Fixture/Cameras/L_CameraLoad",
			occluder:
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewOccluder",
			reviewSet: ".ue-shed/review/sets/fixture-structure.json",
			subject:
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewSubject",
			translucentSubject:
				"/Game/Fixture/Cameras/L_CameraLoad.L_CameraLoad:PersistentLevel.ReviewTranslucentSubject",
			views: ["structure-context"]
		});
		expect(existsSync(join(fixtureRoot, contract.mapReview.reviewSet))).toBe(true);
	});

	it("declares a saved World Partition map for offline Map Review", () => {
		expect(contract.offlineWorld).toEqual({
			map: "/Game/Fixture/Offline/L_OfflineWorld.L_OfflineWorld",
			relativeMapPath: "Content/Fixture/Offline/L_OfflineWorld.umap",
			externalActors: 6,
			labels: [
				"Offline Hub",
				"Hub Attachment",
				"East Marker",
				"North Marker",
				"South Marker",
				"West Marker"
			]
		});
		expect(existsSync(join(fixtureRoot, contract.offlineWorld.relativeMapPath))).toBe(true);
		expect(
			externalActorPackageCount(
				join(fixtureRoot, "Content/__ExternalActors__/Fixture/Offline/L_OfflineWorld")
			)
		).toBe(contract.offlineWorld.externalActors);
	});

	it("declares identity-focused game text evidence", () => {
		expect(contract.gameText.contentRoot).toBe("/Game/Fixture/Text");
		expect(contract.gameText.stringTable).toEqual({
			assetPath: "/Game/Fixture/Text/ST_Game.ST_Game",
			namespace: "Fixture.StringTable",
			entries: ["PromptContinue", "StatusSaving", "PromptHold"]
		});
		expect(contract.gameText.occurrenceAsset.sharedIdentity.occurrences).toBe(2);
		expect(new Set(contract.gameText.occurrenceAsset.equalSourceDistinctKeys).size).toBe(2);
		for (const assetPath of [
			contract.gameText.stringTable.assetPath,
			contract.gameText.occurrenceAsset.assetPath
		]) {
			expect(assetPath.startsWith(`${contract.gameText.contentRoot}/`)).toBe(true);
			expect(existsSync(generatedAssetPath(assetPath)), assetPath).toBe(true);
		}
	});

	it("declares a timed localized-text Level Sequence", () => {
		expect(contract.levelSequence).toEqual({
			assetPath: "/Game/Fixture/Sequences/LS_TextTimeline.LS_TextTimeline",
			nestedAssetPath: "/Game/Fixture/Sequences/LS_NestedTimeline.LS_NestedTimeline",
			tickResolution: { numerator: 24000, denominator: 1 },
			displayRate: { numerator: 24, denominator: 1 },
			playbackRange: { start: 0, end: 120000 },
			subSequenceRange: { start: 0, end: 60000 },
			cinematicShotRange: { start: 60000, end: 120000 },
			shotDisplayName: "Text timeline reprise",
			textKeyFrames: [0, 48000, 96000],
			textKeys: ["Opening", "Warning", "Exit"]
		});
		expect(existsSync(generatedAssetPath(contract.levelSequence.assetPath))).toBe(true);
		expect(existsSync(generatedAssetPath(contract.levelSequence.nestedAssetPath))).toBe(true);
	});

	it("declares the original Enhanced Input fixture unchanged", () => {
		const input = contract.enhancedInput;
		expect(input.contentRoot).toBe("/Game/Fixture/Input");
		// IMC_Fixture and its two actions are the fixture's oldest Enhanced Input evidence.
		// They stay pinned literally so growing the surface around them cannot quietly move them.
		expect(
			input.actions.filter(
				(action) =>
					action.assetPath.includes("IA_Jump.") || action.assetPath.includes("IA_Move.")
			)
		).toEqual([
			{
				assetPath: "/Game/Fixture/Input/IA_Jump.IA_Jump",
				valueType: "EInputActionValueType::Boolean",
				consumeInput: false,
				actionDescription: "Fixture jump action"
			},
			{
				assetPath: "/Game/Fixture/Input/IA_Move.IA_Move",
				valueType: "EInputActionValueType::Axis2D",
				consumeInput: true,
				actionDescription: "Fixture move action"
			}
		]);
		expect(
			input.mappingContexts.find(
				(context) => context.assetPath === "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture"
			)
		).toEqual({
			assetPath: "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture",
			contextDescription: "Fixture mapping context",
			mappingsProperty: "DefaultKeyMappings",
			mappings: [
				{
					action: "/Game/Fixture/Input/IA_Jump.IA_Jump",
					keyName: "SpaceBar",
					modifierCount: 0
				},
				{
					action: "/Game/Fixture/Input/IA_Move.IA_Move",
					keyName: "A",
					modifierCount: 1,
					modifierClasses: ["/Script/EnhancedInput.InputModifierNegate"]
				}
			]
		});
	});

	it("declares an Enhanced Input surface the size of a small real project", () => {
		const input = contract.enhancedInput;
		// Downstream tools are only exercised by a surface with real breadth: enough actions to
		// need naming, several contexts, and keys that more than one of them claims.
		expect(input.actions.length).toBeGreaterThanOrEqual(20);
		expect(input.mappingContexts.length).toBeGreaterThanOrEqual(5);
		expect(
			input.mappingContexts.flatMap((context) => context.mappings).length
		).toBeGreaterThanOrEqual(50);

		const declaredActions = new Set(input.actions.map((action) => action.assetPath));
		expect(declaredActions.size).toBe(input.actions.length);
		for (const context of input.mappingContexts) {
			expect(context.mappingsProperty).toBe("DefaultKeyMappings");
			expect(context.contextDescription.length).toBeGreaterThan(0);
			for (const mapping of context.mappings) {
				expect(declaredActions.has(mapping.action), mapping.action).toBe(true);
				expect(mapping.keyName.length).toBeGreaterThan(0);
				expect(mapping.modifierCount).toBe(mapping.modifierClasses?.length ?? 0);
			}
		}
	});

	it("declares the contested keys its own mappings produce", () => {
		const input = contract.enhancedInput;
		const claims = new Map<string, Set<string>>();
		for (const context of input.mappingContexts) {
			for (const mapping of context.mappings) {
				const owners = claims.get(mapping.keyName) ?? new Set<string>();
				owners.add(context.assetPath);
				claims.set(mapping.keyName, owners);
			}
		}
		const contested = [...claims.entries()]
			.filter(([, owners]) => owners.size > 1)
			.map(([key]) => key)
			.sort();
		expect(input.contestedKeys).toEqual(contested);
		expect(contested.length).toBeGreaterThanOrEqual(10);
	});

	it("carries serialized trigger and modifier variety, not just bare key mappings", () => {
		const mappings = contract.enhancedInput.mappingContexts.flatMap(
			(context) => context.mappings
		);
		const triggers = new Set(mappings.flatMap((mapping) => mapping.triggerClasses ?? []));
		const modifiers = new Set(mappings.flatMap((mapping) => mapping.modifierClasses ?? []));
		expect(triggers.size).toBeGreaterThanOrEqual(4);
		expect(modifiers.size).toBeGreaterThanOrEqual(3);
		for (const classPath of [...triggers, ...modifiers]) {
			expect(classPath.startsWith("/Script/EnhancedInput.")).toBe(true);
		}
		// Some mappings must carry no trigger at all: absent evidence is a case tools must render.
		expect(mappings.some((mapping) => mapping.triggerClasses === undefined)).toBe(true);
	});

	it("generates every declared Enhanced Input asset", () => {
		const input = contract.enhancedInput;
		for (const assetPath of [
			...input.actions.map((action) => action.assetPath),
			...input.mappingContexts.map((context) => context.assetPath)
		]) {
			expect(assetPath.startsWith(`${input.contentRoot}/`)).toBe(true);
			expect(existsSync(generatedAssetPath(assetPath)), assetPath).toBe(true);
		}
	});

	it("keeps every ordinary table reproducible from reviewable source", () => {
		for (const table of contract.tables) {
			if (table.kind !== "data-table" || !("source" in table)) {
				continue;
			}
			expect(sourceRowNames(table.source)).toEqual(table.rows);
		}
	});

	it("declares a deterministic large table for editing-load exercises", () => {
		const table = contract.tables.find(
			(candidate) =>
				candidate.assetPath === "/Game/Fixture/Authoring/DT_LargeScalars.DT_LargeScalars"
		);
		expect(table).toMatchObject({
			fieldFamilies: ["large-table", "editing-load"],
			generatedRows: {
				count: 10000,
				generator: "scalar-load-v1",
				namePrefix: "Load_"
			}
		});
	});

	it("commits every generated asset declared by the contract", () => {
		for (const table of contract.tables) {
			expect(existsSync(generatedAssetPath(table.assetPath)), table.assetPath).toBe(true);
		}
	});

	it("declares a portable, reproducible texture audit corpus", () => {
		const audit = contract.textureAudit;
		expect(audit.contentRoot).toBe("/Game/Fixture/Audits/Textures");
		expect(audit.textures).toHaveLength(17);
		const source = readJson(resolve(fixtureRoot, audit.source));
		expect(Array.isArray(source)).toBe(true);
		expect(source).toEqual(
			expect.arrayContaining(
				audit.textures.map(({ expectedFindingIds: _, ...texture }) =>
					expect.objectContaining(texture)
				)
			)
		);
		const objectPaths = audit.textures.map((texture) => texture.objectPath);
		expect(new Set(objectPaths).size).toBe(objectPaths.length);
		for (const texture of audit.textures) {
			expect(texture.objectPath.startsWith(`${audit.contentRoot}/`)).toBe(true);
			expect(texture.width).toBeGreaterThan(0);
			expect(texture.height).toBeGreaterThan(0);
			expect(texture.width).toBeLessThanOrEqual(4096);
			expect(texture.height).toBeLessThanOrEqual(4096);
			expect(texture.sourceFormat).toBe("TSF_BGRA8");
			expect(existsSync(generatedAssetPath(texture.objectPath)), texture.objectPath).toBe(
				true
			);
		}
		const findings = audit.textures.flatMap((texture) => texture.expectedFindingIds);
		expect(findings.sort()).toEqual([
			"dimensions.power_of_two",
			"dimensions.ui_max_512",
			"dimensions.ui_max_512"
		]);
		const rules = readJson(resolve(fixtureRoot, audit.rules));
		expect(rules).toEqual(
			expect.objectContaining({
				schemaVersion: 1,
				rules: expect.arrayContaining([
					expect.objectContaining({ id: "dimensions.power_of_two" }),
					expect.objectContaining({ id: "dimensions.ui_max_512" })
				])
			})
		);
	});

	it("defines composite parent precedence without mixed row structures", () => {
		const tablesByPath = new Map(contract.tables.map((table) => [table.assetPath, table]));
		for (const table of contract.tables) {
			if (table.kind !== "composite-data-table") {
				continue;
			}
			const parents = table.parents.map((parentPath) => tablesByPath.get(parentPath));
			expect(parents.every((parent) => parent?.kind === "data-table")).toBe(true);
			expect(parents.every((parent) => parent?.rowStruct === table.rowStruct)).toBe(true);
			const composedRows = [...new Set(parents.flatMap((parent) => parent?.rows ?? []))];
			expect(composedRows).toEqual(table.rows);
		}
	});

	it("covers the field families required before public API design", () => {
		const families = new Set(contract.tables.flatMap((table) => table.fieldFamilies));
		for (const family of [
			"boolean",
			"integer",
			"float",
			"enum",
			"localized-text",
			"nested-struct",
			"soft-object-reference",
			"data-table-row-handle",
			"array",
			"set",
			"map",
			"opaque-structured-value",
			"composite-table"
		]) {
			expect(families.has(family), family).toBe(true);
		}
	});

	it("contains no machine-specific paths in its portable inputs", () => {
		const portableFiles = [
			"fixture-contract.json",
			"UEShedFixture.uproject",
			...parserTargetFiles,
			"FixtureExpected/level-decode-gaps.json",
			contract.textureAudit.source,
			contract.textureAudit.rules,
			...contract.tables.flatMap((table) =>
				table.kind === "data-table" && "source" in table ? [table.source] : []
			)
		];
		for (const relativePath of portableFiles) {
			const contents = readFileSync(resolve(fixtureRoot, relativePath), "utf8");
			expect(contents, relativePath).not.toMatch(/\b[A-Za-z]:[\\/]/);
			expect(contents, relativePath).not.toMatch(/\/(?:Users|home|mnt)\//);
		}
	});

	it("publishes real-Unreal target shapes for the next parser asset types", () => {
		const targets = parserTargetFiles.map((path) => readJson(resolve(fixtureRoot, path)));
		expect(targets.map((target) => (isRecord(target) ? target.assetType : undefined))).toEqual([
			"enhanced_input",
			"level_sequence",
			"string_table",
			"text_data_asset",
			"texture2d"
		]);
		for (const target of targets) {
			expect(target).toEqual(
				expect.objectContaining({
					contract: {
						name: "ue-shed-unreal-asset-evidence",
						version: { major: 1, minor: 0 }
					}
				})
			);
		}
		const enhancedInput = targets[0];
		const levelSequence = targets[1];
		const stringTable = targets[2];
		const textAsset = targets[3];
		const textures = targets[4];
		expect(isRecord(enhancedInput) && Array.isArray(enhancedInput.actions)).toBe(true);
		expect(isRecord(levelSequence) && levelSequence.objectPath).toBe(
			contract.levelSequence.assetPath
		);
		expect(isRecord(stringTable) && stringTable.objectPath).toBe(
			contract.gameText.stringTable.assetPath
		);
		expect(isRecord(textAsset) && textAsset.objectPath).toBe(
			contract.gameText.occurrenceAsset.assetPath
		);
		expect(
			isRecord(textures) && Array.isArray(textures.assets) ? textures.assets : []
		).toHaveLength(contract.textureAudit.textures.length);
	});
});

describe("fixture project", () => {
	it("keeps UE Shed plugins out of the portable project descriptor", () => {
		const project = readJson(join(fixtureRoot, "UEShedFixture.uproject"));
		if (!isRecord(project) || !Array.isArray(project.Plugins)) {
			throw new Error("UEShedFixture.uproject has no plugin list");
		}
		expect(project).not.toHaveProperty("AdditionalPluginDirectories");
		const pluginNames = project.Plugins.flatMap((plugin) =>
			isRecord(plugin) && typeof plugin.Name === "string" ? [plugin.Name] : []
		);
		expect(pluginNames).toEqual(["EnhancedInput", "RemoteControl"]);
	});

	it("builds fixture modules without UE Shed plugin dependencies", () => {
		const buildRules = [
			"Source/UEShedFixture/UEShedFixture.Build.cs",
			"Source/UEShedFixtureEditor/UEShedFixtureEditor.Build.cs"
		]
			.map((path) => readFileSync(join(fixtureRoot, path), "utf8"))
			.join("\n");
		expect(buildRules).not.toMatch(
			/"UEShed(?:AssetAudits|Authoring|Cameras|Core|Observatory|Scenarios)"/
		);
	});

	it("saves stock camera actors instead of plugin-owned classes", () => {
		const cameraMap = readFileSync(
			join(fixtureRoot, "Content/Fixture/Cameras/L_CameraLoad.umap")
		).toString("latin1");
		expect(cameraMap).not.toContain("/Script/UEShedCameras");
	});
});
