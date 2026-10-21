import type { SavedAssetInspection, SavedAssetScan } from "@ue-shed/unreal-assets";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	action,
	config,
	context,
	mapping,
	path,
	report,
	trigger
} from "./analysis.test-support.js";
import {
	coActivationForPlatform,
	coActivationFromConfigAssets,
	coActivationFromDefaultContexts,
	coActivationFromDocument,
	contextIdentity,
	decodeCoActivationDocument,
	parseDefaultContextSettings
} from "./coactivation.js";
import { classifyInputConflicts } from "./conflicts.js";
import {
	inputControlSheet,
	inputControlSheetCsv,
	inputControlSheetMarkdown
} from "./control-sheet.js";
import {
	defaultInputDeviceSets,
	inputDeviceCoverage,
	inputKeyProfiles,
	parsePlatformInputData,
	platformContextPaths,
	platformDataRedirectsFromInspection,
	platformSettingsSection,
	redirectCoActivationSets,
	reportForKeyProfile
} from "./platforms.js";
import {
	blueprintInputActionUses,
	blueprintInputCandidatePaths,
	inputActionPackageNames,
	inputActionUsage
} from "./usage.js";

const scenario = report({
	actions: [
		action("IA_Jump", { consumeInput: true }),
		action("IA_Fire"),
		action("IA_Aim"),
		action("IA_Handbrake"),
		action("IA_Photo", { consumeInput: false }),
		action("IA_Back"),
		action("IA_Chorded"),
		action("IA_Unused")
	],
	contexts: [
		context("IMC_Gameplay", [
			mapping("IA_Jump", "SpaceBar"),
			mapping("IA_Fire", "LeftMouseButton"),
			mapping("IA_Aim", "RightMouseButton", [trigger("InputTriggerHold")]),
			mapping("IA_Fire", "F", [
				trigger("InputTriggerChordAction", [
					{ name: "ChordAction", kind: "object", value: path("IA_Chorded") }
				])
			]),
			mapping(null, "G"),
			mapping("IA_Missing", null)
		]),
		context("IMC_Vehicle", [mapping("IA_Handbrake", "SpaceBar")]),
		context("IMC_Photo", [
			mapping("IA_Photo", "LeftMouseButton", [trigger("InputTriggerPressed")]),
			mapping("IA_Photo", "SpaceBar")
		]),
		context("IMC_Menu", [mapping("IA_Back", "RightMouseButton", [trigger("InputTriggerHold")])])
	],
	configs: [
		config("PMI_Driving", [
			{ context: "IMC_Gameplay", priority: 1 },
			{ context: "IMC_Vehicle", priority: 1 }
		])
	]
});

const document = Effect.runSync(
	decodeCoActivationDocument({
		schemaVersion: 1,
		kind: "enhanced_input_co_activation",
		sets: [
			{
				id: "on_foot",
				contexts: [
					{ context: "/Game/Input/IMC_Gameplay", priority: 0 },
					{ context: path("IMC_Photo"), priority: 1 }
				]
			},
			{
				id: "driving",
				label: "Driving",
				platforms: ["Windows"],
				contexts: [
					{ context: path("IMC_Gameplay"), priority: 0 },
					{ context: path("IMC_Vehicle"), priority: 5 }
				]
			}
		]
	})
);

describe("co-activation sources", () => {
	it("parses default context config text without inventing missing fields", () => {
		const settings = parseDefaultContextSettings([
			'(InputMappingContext="/Game/Input/IMC_Gameplay.IMC_Gameplay",Priority=2,bAddImmediately=True)',
			"(InputMappingContext=/Script/EnhancedInput.InputMappingContext'/Game/Input/IMC_Menu.IMC_Menu',bAddImmediately=False)",
			'(InputMappingContext="/Game/Input/IMC_Photo.IMC_Photo")',
			"not struct text"
		]);
		expect(settings.map(({ text: _text, ...setting }) => setting)).toEqual([
			{
				context: "/Game/Input/IMC_Gameplay",
				priority: 2,
				addImmediately: true,
				registerWithUserSettings: null
			},
			{
				context: "/Game/Input/IMC_Menu",
				priority: null,
				addImmediately: false,
				registerWithUserSettings: null
			},
			{
				context: "/Game/Input/IMC_Photo",
				priority: null,
				addImmediately: null,
				registerWithUserSettings: null
			}
		]);
		const [set] = coActivationFromDefaultContexts(settings, {
			origin: "DefaultInput.ini",
			platform: "Windows"
		});
		expect(set).toMatchObject({
			source: "project_default_contexts",
			platforms: ["Windows"],
			contexts: [
				{ context: "/Game/Input/IMC_Gameplay", priority: 2 },
				{ context: "/Game/Input/IMC_Photo", priority: null }
			]
		});
	});

	it("reads config assets and host documents, and filters by platform", () => {
		expect(coActivationFromConfigAssets(scenario)).toEqual([
			{
				id: `config_asset:${path("PMI_Driving")}`,
				label: "PMI_Driving",
				source: "config_asset",
				origin: path("PMI_Driving"),
				contexts: [
					{ context: path("IMC_Gameplay"), priority: 1 },
					{ context: path("IMC_Vehicle"), priority: 1 }
				]
			}
		]);
		const sets = coActivationFromDocument(document, "coactivation.json");
		expect(sets.map((set) => set.id)).toEqual([
			"host_document:on_foot",
			"host_document:driving"
		]);
		expect(coActivationForPlatform(sets, "Linux").map((set) => set.id)).toEqual([
			"host_document:on_foot"
		]);
		expect(contextIdentity("Class'/Game/Input/IMC_A.IMC_A'")).toBe("/Game/Input/IMC_A");
	});

	it("rejects a document without contexts", () => {
		const result = Effect.runSyncExit(
			decodeCoActivationDocument({
				schemaVersion: 1,
				kind: "enhanced_input_co_activation",
				sets: [{ id: "empty", contexts: [] }]
			})
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("conflict classes", () => {
	it("claims only contested keys without a co-activation source", () => {
		const analysis = classifyInputConflicts(scenario, []);
		expect(analysis.classified).toBe(false);
		expect(analysis.keys.map((key) => key.key)).toEqual([
			"LeftMouseButton",
			"RightMouseButton",
			"SpaceBar"
		]);
		expect(analysis.keys.every((key) => key.classes.length === 0)).toBe(true);
		expect(analysis.counts).toEqual({
			contested: 3,
			shadowed: 0,
			may_shadow: 0,
			both_fire: 0,
			ambiguous_priority: 0,
			qualified: 0,
			cross_context: 0
		});
	});

	it("classifies may-shadow, both-fire, ambiguous, qualified and cross-context pairs", () => {
		const sets = [
			...coActivationFromDocument(document, "coactivation.json"),
			...coActivationFromConfigAssets(scenario)
		];
		const analysis = classifyInputConflicts(scenario, sets);
		const byKey = new Map(analysis.keys.map((key) => [key.key, key]));

		const space = byKey.get("SpaceBar");
		// IA_Handbrake does not save bConsumeInput, so the higher vehicle mapping only may hide jump.
		const mayShadow = space?.conflicts.find(
			(conflict) => conflict.setId === "host_document:driving"
		);
		expect(mayShadow).toMatchObject({
			classification: "may_shadow",
			priorities: [5, 0],
			consumption: "not_serialized"
		});
		expect(mayShadow?.claims[0].contextName).toBe("IMC_Vehicle");
		expect(mayShadow?.reason).not.toContain("and hides");
		expect(mayShadow?.reason).toContain("only if its action consumes input");
		expect(
			space?.conflicts.find(
				(conflict) => conflict.setId === `config_asset:${path("PMI_Driving")}`
			)?.classification
		).toBe("ambiguous_priority");
		// Gameplay's jump and photo mode's capture share the on-foot set, photo has priority and
		// passes input through, so both fire.
		expect(
			space?.conflicts.find(
				(conflict) =>
					conflict.setId === "host_document:on_foot" &&
					conflict.claims.some((claim) => claim.contextName === "IMC_Photo")
			)
		).toMatchObject({ classification: "both_fire", consumption: "passes_through" });
		// Vehicle and photo mode are never in one set.
		expect(
			space?.conflicts.some(
				(conflict) =>
					conflict.classification === "cross_context" &&
					conflict.claims.every((claim) => claim.contextName !== "IMC_Gameplay")
			)
		).toBe(true);

		expect(byKey.get("LeftMouseButton")?.classes).toEqual(["qualified"]);
		expect(byKey.get("RightMouseButton")?.classes).toEqual(["cross_context"]);
		expect(analysis.counts).toMatchObject({
			contested: 3,
			shadowed: 0,
			may_shadow: 1,
			both_fire: 1,
			ambiguous_priority: 1
		});
	});

	/** One key, a higher context (priority 2) and a lower Pressed mapping (priority 1). */
	const ordered = (consumeInput: boolean | undefined, higherTrigger: string) =>
		classifyInputConflicts(
			report({
				actions: [
					action("IA_High", consumeInput === undefined ? undefined : { consumeInput }),
					action("IA_Low")
				],
				contexts: [
					context("IMC_High", [mapping("IA_High", "E", [trigger(higherTrigger)])]),
					context("IMC_Low", [mapping("IA_Low", "E", [trigger("InputTriggerPressed")])])
				]
			}),
			[
				{
					id: "both",
					label: "both",
					source: "host_document",
					origin: "test",
					contexts: [
						{ context: path("IMC_High"), priority: 2 },
						{ context: path("IMC_Low"), priority: 1 }
					]
				}
			]
		).keys[0]?.conflicts[0];

	it("shadows a lower mapping when the higher action consumes, whatever the triggers", () => {
		const conflict = ordered(true, "InputTriggerHold");
		expect(conflict).toMatchObject({
			classification: "shadowed",
			consumption: "consumes",
			priorities: [2, 1]
		});
		expect(conflict?.claims[0].contextName).toBe("IMC_High");
	});

	it("keeps a chorded higher mapping qualified, since Unreal never lets a chord consume", () => {
		expect(ordered(true, "InputTriggerChordAction")).toMatchObject({
			classification: "qualified",
			consumption: "consumes"
		});
	});

	it("qualifies different triggers only when the higher action passes input through", () => {
		expect(ordered(false, "InputTriggerHold")).toMatchObject({
			classification: "qualified",
			consumption: "passes_through"
		});
		expect(ordered(undefined, "InputTriggerHold")).toMatchObject({
			classification: "may_shadow",
			consumption: "not_serialized"
		});
	});
});

describe("usage", () => {
	it("reports no known use, unbound mappings and unresolved targets", () => {
		const usage = inputActionUsage(scenario);
		expect(usage.noKnownUse).toEqual([path("IA_Unused")]);
		const chorded = usage.actions.find((entry) => entry.name === "IA_Chorded");
		expect(chorded).toMatchObject({ status: "used", contexts: [] });
		expect(chorded?.referencedBy[0]).toMatchObject({
			from: path("IA_Fire"),
			parameter: "ChordAction"
		});
		expect(usage.actions.find((entry) => entry.name === "IA_Jump")?.configs).toEqual([
			path("PMI_Driving")
		]);
		expect(usage.unboundMappings).toEqual([
			{
				context: path("IMC_Gameplay"),
				profileId: null,
				index: 4,
				action: null,
				reason: "no_action"
			},
			{
				context: path("IMC_Gameplay"),
				profileId: null,
				index: 5,
				action: path("IA_Missing"),
				reason: "key_not_serialized"
			}
		]);
		expect(usage.unresolvedActionTargets).toEqual([
			{ context: path("IMC_Gameplay"), profileId: null, action: path("IA_Missing") }
		]);
		expect(usage.blueprintCoverage).toEqual({ status: "not_scanned" });
	});

	it("counts an action mapped only in a key-profile override, and its trigger edges", () => {
		const profiled = report({
			actions: [action("IA_ProfileOnly"), action("IA_ChordTarget"), action("IA_Unused")],
			contexts: [
				context("IMC_Gamepad", [], {
					profileOverrides: [
						{
							profileId: "Gamepad",
							mappings: [
								mapping("IA_ProfileOnly", "Gamepad_FaceButton_Bottom", [
									trigger("InputTriggerChordAction", [
										{
											name: "ChordAction",
											kind: "object",
											value: path("IA_ChordTarget")
										}
									])
								]),
								mapping("IA_Missing", null)
							]
						}
					]
				})
			]
		});
		const usage = inputActionUsage(profiled);
		expect(usage.noKnownUse).toEqual([path("IA_Unused")]);
		expect(usage.actions.find((entry) => entry.name === "IA_ProfileOnly")).toMatchObject({
			status: "used",
			contexts: [],
			profiles: [{ context: path("IMC_Gamepad"), profileId: "Gamepad" }]
		});
		expect(
			usage.actions.find((entry) => entry.name === "IA_ChordTarget")?.referencedBy
		).toEqual([
			{
				from: path("IA_ProfileOnly"),
				to: path("IA_ChordTarget"),
				triggerClass: "/Script/EnhancedInput.InputTriggerChordAction",
				parameter: "ChordAction",
				contextPath: path("IMC_Gamepad"),
				key: "Gamepad_FaceButton_Bottom",
				profileId: "Gamepad"
			}
		]);
		expect(usage.unboundMappings).toEqual([
			{
				context: path("IMC_Gamepad"),
				profileId: "Gamepad",
				index: 1,
				action: path("IA_Missing"),
				reason: "key_not_serialized"
			}
		]);
	});

	it("finds Blueprint event, value and plain references to actions", () => {
		const uses = blueprintInputActionUses(
			"/Game/BP_Hero.BP_Hero",
			[
				{
					ownerPath: "/Game/BP_Hero.BP_Hero:EventGraph.K2Node_EnhancedInputAction_0",
					propertyPath: "class",
					targetPath: "/Script/InputBlueprintNodes.K2Node_EnhancedInputAction"
				},
				{
					ownerPath: "/Game/BP_Hero.BP_Hero:EventGraph.K2Node_EnhancedInputAction_0",
					propertyPath: "InputAction",
					targetPath: path("IA_Unused")
				},
				{
					ownerPath: "/Game/BP_Hero.BP_Hero:EventGraph.K2Node_GetInputActionValue_0",
					propertyPath: "class",
					targetPath: "/Script/InputBlueprintNodes.K2Node_GetInputActionValue"
				},
				{
					ownerPath: "/Game/BP_Hero.BP_Hero:EventGraph.K2Node_GetInputActionValue_0",
					propertyPath: "InputAction",
					targetPath: path("IA_Aim")
				},
				{
					ownerPath: "/Game/BP_Hero.BP_Hero",
					propertyPath: "variables.Action.value",
					targetPath: "/Game/Input/IA_Jump"
				},
				{
					ownerPath: "/Game/BP_Hero.BP_Hero",
					propertyPath: "x",
					targetPath: "/Game/Other.Other"
				}
			],
			new Set(scenario.actions.map((entry) => String(entry.objectPath)))
		);
		expect(uses.map((use) => [use.action, use.kind])).toEqual([
			[path("IA_Unused"), "event_node"],
			[path("IA_Aim"), "value_node"],
			[path("IA_Jump"), "reference"]
		]);
		const usage = inputActionUsage(scenario, {
			blueprintUses: uses,
			blueprintCoverage: {
				status: "scanned",
				complete: true,
				blueprints: 3,
				matched: 1,
				decoded: 1,
				skipped: 0,
				failed: [],
				partial: [],
				headerFailures: []
			}
		});
		expect(usage.noKnownUse).toEqual([]);
	});

	it("selects Blueprint candidates by name probe within an explicit bound", () => {
		const header = (name: string, className: string, matched: readonly string[]) => ({
			depth: "header" as const,
			fileBytes: 1,
			header: {
				exports: [
					{
						class_name: className,
						class_path: `/Script/Engine.${className}`,
						object_path: name
					}
				],
				matched_names: matched,
				package: { name },
				path: `Content/${name}.uasset`,
				schema_version: 8 as const
			}
		});
		const index = {
			assets: [
				header("BP_C", "Blueprint", ["/Game/Input/IA_Jump"]),
				header("BP_A", "WidgetBlueprint", ["/Game/Input/IA_Fire"]),
				header("BP_B", "Blueprint", []),
				header("DT_Data", "DataTable", ["/Game/Input/IA_Jump"])
			],
			failures: [],
			summary: {
				cacheHits: 0,
				depth: "header",
				diagnostics: [],
				emittedAssets: 4,
				failedAssets: 0,
				partialAssets: 0,
				projectRoot: "D:/Projects/Demo",
				roots: [],
				scannedAssets: 4,
				schema_version: 8,
				skippedAssets: 0
			}
		} satisfies SavedAssetScan;
		expect(
			blueprintInputCandidatePaths(index, { maximumBlueprints: 1, nameProbe: true })
		).toEqual({
			paths: ["Content/BP_A.uasset"],
			blueprints: 3,
			matched: 2,
			skipped: 1,
			headerFailures: []
		});
		expect(
			blueprintInputCandidatePaths(index, { maximumBlueprints: 10, nameProbe: false }).paths
		).toHaveLength(3);
		expect(inputActionPackageNames(scenario)).toContain("/Game/Input/IA_Jump");
	});
});

describe("platform views", () => {
	const redirectInspection: SavedAssetInspection = {
		schema_version: 8,
		status: "ok",
		path: "Content/Input/BP_SwitchData.uasset",
		package: {
			name: "/Game/Input/BP_SwitchData",
			version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
			package_flags: 0,
			summary_size: 1,
			total_header_size: 1
		},
		assets: [
			{
				kind: "UObject",
				object_path: "/Game/Input/BP_SwitchData.Default__BP_SwitchData_C",
				class_path: "/Game/Input/BP_SwitchData.BP_SwitchData_C",
				properties: [
					{
						name: "MappingContextRedirects",
						type: "MapProperty",
						value_kind: "map",
						entries: [
							{
								key: { value_kind: "object_ref", value: path("IMC_Menu") },
								value: { value_kind: "object_ref", value: path("IMC_Photo") }
							}
						]
					}
				]
			}
		],
		decode_errors: []
	};

	it("reads redirects from a platform data class default and applies them", () => {
		const redirects = platformDataRedirectsFromInspection(
			redirectInspection,
			"/Game/Input/BP_SwitchData.BP_SwitchData_C"
		);
		expect(redirects).toEqual([
			{
				from: path("IMC_Menu"),
				to: path("IMC_Photo"),
				inputData: "/Game/Input/BP_SwitchData.BP_SwitchData_C"
			}
		]);
		expect(platformContextPaths(scenario, redirects)).toEqual([
			path("IMC_Gameplay"),
			path("IMC_Vehicle"),
			path("IMC_Photo")
		]);
		const [set] = redirectCoActivationSets(
			[
				{
					id: "menu",
					label: "menu",
					source: "host_document",
					origin: "x",
					contexts: [{ context: path("IMC_Menu"), priority: 3 }]
				}
			],
			redirects
		);
		expect(set?.contexts).toEqual([{ context: path("IMC_Photo"), priority: 3 }]);
		expect(
			parsePlatformInputData([
				"/Script/Engine.BlueprintGeneratedClass'/Game/Input/BP_SwitchData.BP_SwitchData_C'",
				'"/Game/Input/BP_Other.BP_Other_C"',
				"None"
			])
		).toEqual(["/Game/Input/BP_SwitchData.BP_SwitchData_C", "/Game/Input/BP_Other.BP_Other_C"]);
		expect(platformSettingsSection("Switch")).toBe(
			"EnhancedInputPlatformSettings_Switch EnhancedInputPlatformSettings"
		);
	});

	it("swaps in key profile overrides and reports device coverage", () => {
		const profiled = report({
			actions: [action("IA_Fire")],
			contexts: [
				context("IMC_Gameplay", [mapping("IA_Fire", "LeftMouseButton")], {
					profileOverrides: [
						{
							profileId: "LeftHanded",
							mappings: [mapping("IA_Fire", "RightMouseButton")]
						}
					]
				})
			]
		});
		expect(inputKeyProfiles(profiled)).toEqual(["LeftHanded"]);
		expect(
			reportForKeyProfile(profiled, "LeftHanded").mappingContexts[0]?.mappings[0]?.keyName
		).toMatchObject({ value: "RightMouseButton" });
		expect(
			inputDeviceCoverage(scenario, defaultInputDeviceSets).find(
				(entry) => entry.name === "IA_Jump"
			)
		).toEqual({
			action: path("IA_Jump"),
			name: "IA_Jump",
			sets: [
				{ id: "keyboard_mouse", keys: ["SpaceBar"], covered: true },
				{ id: "gamepad", keys: [], covered: false }
			]
		});
	});
});

describe("control sheet", () => {
	const source = {
		projectRoot: "D:/Projects/Demo",
		generation: null,
		authority: "project_files" as const
	};

	it("writes CSV with a metadata row and Markdown per context", () => {
		const conflicts = classifyInputConflicts(scenario, coActivationFromConfigAssets(scenario));
		const sheet = inputControlSheet(scenario, source, { conflicts });
		expect(sheet.rows).toHaveLength(10);
		expect(sheet.rows[0]).toMatchObject({
			action: path("IA_Jump"),
			key: "SpaceBar",
			device: "keyboard",
			contested: true,
			conflictClasses: ["ambiguous_priority", "cross_context"]
		});
		const csv = inputControlSheetCsv(sheet);
		expect(csv.split("\r\n")[0]).toBe(
			'"record_type","metadata_json","context","action","display_name","action_description","key","device","triggers","modifiers","contested","conflict_classes"'
		);
		expect(csv).toContain(
			'"record","","IMC_Gameplay","IA_Fire","","IA_Fire","F","keyboard","chord action (ChordAction IA_Chorded)"'
		);
		const markdown = inputControlSheetMarkdown(sheet);
		expect(markdown).toContain("## IMC_Vehicle");
		expect(markdown).toContain(
			"| IA_Aim (IA_Aim) | RightMouseButton | mouse | hold |  | contested, cross context |"
		);
		expect(markdown).toContain("| No action | G | keyboard |");
	});
});
