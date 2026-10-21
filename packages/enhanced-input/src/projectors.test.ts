import type { SavedAssetInspection, SavedProperty } from "@ue-shed/unreal-assets";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { buildInputAtlas, inputActionEdges } from "./atlas.js";
import {
	buildEnhancedInputReport,
	inputActionFromInspection,
	mappingContextFromInspection,
	playerMappableConfigFromInspection
} from "./projectors.js";
import { EnhancedInputReport } from "./schema.js";

const version = { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 };

function inspection(name: string, assets: SavedAssetInspection["assets"]): SavedAssetInspection {
	return {
		schema_version: 8,
		status: "ok",
		path: `Content/Input/${name}.uasset`,
		package: {
			name: `/Game/Input/${name}`,
			version,
			package_flags: 0,
			summary_size: 1,
			total_header_size: 1
		},
		assets,
		decode_errors: []
	};
}

const objectRef = (name: string, value: string | null): SavedProperty => ({
	name,
	type: "ObjectProperty",
	value_kind: "object_ref",
	value
});
const bool = (name: string, value: boolean): SavedProperty => ({
	name,
	type: "BoolProperty",
	value_kind: "bool",
	value
});
const float = (name: string, value: number): SavedProperty => ({
	name,
	type: "FloatProperty",
	value_kind: "float",
	value
});
const enumValue = (name: string, value: string): SavedProperty => ({
	name,
	type: "EnumProperty",
	value_kind: "enum",
	value
});
const text = (name: string, value: string): SavedProperty => ({
	name,
	type: "TextProperty",
	value_kind: "text",
	value,
	history: "none"
});
const keyStruct = (key: string): SavedProperty => ({
	name: "Key",
	type: "StructProperty",
	value_kind: "struct",
	properties: [{ name: "KeyName", type: "NameProperty", value_kind: "name", value: key }]
});

const fire = "/Game/Input/IA_Fire.IA_Fire";
const aim = "/Game/Input/IA_Aim.IA_Aim";
const context = "/Game/Input/IMC_Combat.IMC_Combat";

const actionInspection = inspection("IA_Fire", [
	{
		kind: "UObject",
		object_path: fire,
		class_path: "/Script/EnhancedInput.InputAction",
		properties: [
			text("ActionDescription", "Fire weapon"),
			bool("bTriggerWhenPaused", true),
			bool("bReserveAllMappings", true),
			{
				name: "TriggerEventsThatConsumeLegacyKeys",
				type: "IntProperty",
				value_kind: "int",
				value: 2
			},
			enumValue("AccumulationBehavior", "EInputActionAccumulationBehavior::Cumulative"),
			{
				name: "Triggers",
				type: "ArrayProperty",
				value_kind: "array",
				values: [{ value_kind: "object_ref", value: `${fire}.InputTriggerPulse_0` }]
			},
			objectRef("PlayerMappableKeySettings", `${fire}.PlayerMappableKeySettings_0`)
		]
	},
	{
		kind: "UObject",
		object_path: `${fire}.InputTriggerPulse_0`,
		class_path: "/Script/EnhancedInput.InputTriggerPulse",
		properties: [float("Interval", 0.25)]
	},
	{
		kind: "UObject",
		object_path: `${fire}.PlayerMappableKeySettings_0`,
		class_path: "/Script/EnhancedInput.PlayerMappableKeySettings",
		properties: [
			{ name: "Name", type: "NameProperty", value_kind: "name", value: "Fire" },
			text("DisplayName", "Fire"),
			{
				name: "SupportedKeyProfileIds",
				type: "ArrayProperty",
				value_kind: "array",
				values: [{ value_kind: "string", value: "Default" }]
			}
		]
	}
]);

const mapping = (
	action: string,
	key: string,
	triggers: readonly string[],
	extra: readonly SavedProperty[] = []
) => ({
	value_kind: "struct" as const,
	properties: [
		{
			name: "Triggers",
			type: "ArrayProperty",
			value_kind: "array" as const,
			values: triggers.map((path) => ({ value_kind: "object_ref" as const, value: path }))
		},
		objectRef("Action", action),
		keyStruct(key),
		...extra
	]
});

const contextInspection = inspection("IMC_Combat", [
	{
		kind: "UObject",
		object_path: context,
		class_path: "/Script/EnhancedInput.InputMappingContext",
		properties: [
			{
				name: "DefaultKeyMappings",
				type: "StructProperty",
				value_kind: "struct",
				properties: [
					{
						name: "Mappings",
						type: "ArrayProperty",
						value_kind: "array",
						values: [
							mapping(
								fire,
								"LeftMouseButton",
								[`${context}.InputTriggerChordAction_0`],
								[
									enumValue(
										"SettingBehavior",
										"EPlayerMappableKeySettingBehaviors::IgnoreSettings"
									)
								]
							),
							mapping(aim, "RightMouseButton", [`${context}.InputTriggerHold_1`])
						]
					}
				]
			},
			{
				name: "MappingProfileOverrides",
				type: "MapProperty",
				value_kind: "map",
				entries: [
					{
						key: { value_kind: "string", value: "LeftHanded" },
						value: {
							value_kind: "struct",
							properties: [
								{
									name: "Mappings",
									type: "ArrayProperty",
									value_kind: "array",
									values: [mapping(fire, "RightMouseButton", [])]
								}
							]
						}
					}
				]
			},
			enumValue(
				"InputModeFilterOptions",
				"EMappingContextInputModeFilterOptions::UseCustomQuery"
			),
			{
				name: "InputModeQueryOverride",
				type: "StructProperty",
				value_kind: "struct",
				properties: [
					{
						name: "TagDictionary",
						type: "ArrayProperty",
						value_kind: "array",
						values: [
							{
								value_kind: "struct",
								properties: [
									{
										name: "TagName",
										type: "NameProperty",
										value_kind: "name",
										value: "InputMode.Combat"
									}
								]
							}
						]
					},
					{
						name: "UserDescription",
						type: "StrProperty",
						value_kind: "string",
						value: "Combat only"
					}
				]
			},
			enumValue(
				"RegistrationTrackingMode",
				"EMappingContextRegistrationTrackingMode::CountRegistrations"
			)
		]
	},
	{
		kind: "UObject",
		object_path: `${context}.InputTriggerChordAction_0`,
		class_path: "/Script/EnhancedInput.InputTriggerChordAction",
		properties: [objectRef("ChordAction", aim), float("ActuationThreshold", 0.3)]
	},
	{
		kind: "UObject",
		object_path: `${context}.InputTriggerHold_1`,
		class_path: "/Script/EnhancedInput.InputTriggerHold",
		properties: [float("HoldTimeThreshold", 0.4), bool("bIsOneShot", true)]
	}
]);

const configInspection = inspection("PMI_Default", [
	{
		kind: "UObject",
		object_path: "/Game/Input/PMI_Default.PMI_Default",
		class_path: "/Script/EnhancedInput.PlayerMappableInputConfig",
		properties: [
			{ name: "ConfigName", type: "NameProperty", value_kind: "name", value: "Default" },
			text("ConfigDisplayName", "Default controls"),
			{
				name: "Contexts",
				type: "MapProperty",
				value_kind: "map",
				entries: [
					{
						key: { value_kind: "object_ref", value: context },
						value: { value_kind: "int", value: 2 }
					}
				]
			}
		]
	}
]);

describe("schema 2 projection", () => {
	it("projects saved action fields and leaves unsaved ones unavailable", () => {
		const action = inputActionFromInspection({
			inspection: actionInspection,
			packageFile: "Content/Input/IA_Fire.uasset"
		});
		expect(action).toMatchObject({
			triggerWhenPaused: { status: "available", value: true },
			reserveAllMappings: { status: "available", value: true },
			consumesActionAndAxisMappings: { status: "unavailable", reason: "not_serialized" },
			consumeInput: { status: "unavailable", reason: "not_serialized" },
			triggerEventsThatConsumeLegacyKeys: { status: "available", value: 2 },
			accumulationBehavior: {
				status: "available",
				value: "EInputActionAccumulationBehavior::Cumulative"
			},
			triggers: [
				{
					classPath: "/Script/EnhancedInput.InputTriggerPulse",
					parameters: [{ name: "Interval", kind: "number", value: 0.25 }]
				}
			],
			modifiers: [],
			playerMappableKeySettings: {
				status: "available",
				value: {
					name: { status: "available", value: "Fire" },
					displayName: { status: "available", value: "Fire" },
					displayCategory: { status: "unavailable", reason: "not_serialized" },
					supportedKeyProfileIds: { status: "available", value: ["Default"] }
				}
			}
		});
	});

	it("keeps a settings reference outside the package unresolved", () => {
		const action = inputActionFromInspection({
			inspection: inspection("IA_Other", [
				{
					kind: "UObject",
					object_path: "/Game/Input/IA_Other.IA_Other",
					class_path: "/Script/EnhancedInput.InputAction",
					properties: [objectRef("PlayerMappableKeySettings", "/Game/Elsewhere.Settings")]
				}
			]),
			packageFile: "Content/Input/IA_Other.uasset"
		});
		expect(action?.playerMappableKeySettings).toEqual({
			status: "unavailable",
			reason: "unresolved_reference"
		});
	});

	it("projects trigger parameters, a chord edge, profile overrides and input modes", () => {
		const record = mappingContextFromInspection({
			inspection: contextInspection,
			packageFile: "Content/Input/IMC_Combat.uasset"
		});
		expect(record?.mappings[0]).toMatchObject({
			settingBehavior: {
				status: "available",
				value: "EPlayerMappableKeySettingBehaviors::IgnoreSettings"
			},
			triggers: [
				{
					classPath: "/Script/EnhancedInput.InputTriggerChordAction",
					parameters: [
						{ name: "ChordAction", kind: "object", value: aim },
						{ name: "ActuationThreshold", kind: "number", value: 0.3 }
					]
				}
			]
		});
		expect(record?.profileOverrides).toEqual([
			{
				profileId: "LeftHanded",
				mappings: [
					expect.objectContaining({
						action: fire,
						keyName: {
							status: "available",
							source: "serialized",
							value: "RightMouseButton"
						}
					})
				]
			}
		]);
		expect(record?.inputModeFilterOptions).toMatchObject({
			value: "EMappingContextInputModeFilterOptions::UseCustomQuery"
		});
		expect(record?.inputModeQueryOverride).toEqual({
			status: "available",
			source: "serialized",
			value: { tags: ["InputMode.Combat"], userDescription: "Combat only" }
		});
		expect(record?.registrationTrackingMode).toMatchObject({
			value: "EMappingContextRegistrationTrackingMode::CountRegistrations"
		});
	});

	it("projects a config asset and no longer reports it as unsupported", () => {
		const config = playerMappableConfigFromInspection({
			inspection: configInspection,
			packageFile: "Content/Input/PMI_Default.uasset"
		});
		expect(config).toMatchObject({
			configName: { status: "available", value: "Default" },
			displayName: { status: "available", value: "Default controls" },
			deprecated: { status: "unavailable", reason: "not_serialized" },
			contexts: { status: "available", value: [{ context, priority: 2 }] }
		});

		const report = buildEnhancedInputReport([
			{ status: "inspected", packageFile: "a", inspection: actionInspection },
			{ status: "inspected", packageFile: "b", inspection: contextInspection },
			{ status: "inspected", packageFile: "c", inspection: configInspection }
		]);
		expect(report.schemaVersion).toBe(2);
		expect(report.status).toBe("complete");
		expect(report.diagnostics).toEqual([]);
		expect(report.coverage.playerMappableConfigs).toBe(1);
		expect(Schema.decodeUnknownSync(EnhancedInputReport)(report)).toEqual(report);
	});

	it("turns a chord into an action-to-action edge and shows parameters on claims", () => {
		const report = buildEnhancedInputReport([
			{ status: "inspected", packageFile: "a", inspection: actionInspection },
			{ status: "inspected", packageFile: "b", inspection: contextInspection }
		]);
		expect(inputActionEdges(report)).toEqual([
			{
				from: fire,
				to: aim,
				triggerClass: "/Script/EnhancedInput.InputTriggerChordAction",
				parameter: "ChordAction",
				contextPath: context,
				key: "LeftMouseButton"
			}
		]);
		const claim = buildInputAtlas(report).keys.find((key) => key.key === "RightMouseButton")
			?.claims[0];
		expect(claim?.triggerDetails).toEqual([
			{
				label: "hold",
				objectPath: `${context}.InputTriggerHold_1`,
				classPath: "/Script/EnhancedInput.InputTriggerHold",
				parameters: [
					{ name: "HoldTimeThreshold", kind: "number", value: 0.4 },
					{ name: "bIsOneShot", kind: "bool", value: true }
				]
			}
		]);
	});

	it("still decodes a schema 1 report", () => {
		const legacy = {
			schemaVersion: 1,
			status: "complete",
			coverage: {
				discoveredPackages: 0,
				inspectedPackages: 0,
				partialPackages: 0,
				failedPackages: 0,
				inputActions: 0,
				mappingContexts: 0
			},
			actions: [],
			mappingContexts: [],
			diagnostics: []
		};
		expect(Schema.decodeUnknownSync(EnhancedInputReport)(legacy).schemaVersion).toBe(1);
	});
});
