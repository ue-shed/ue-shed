import { describe, expect, it } from "vitest";
import {
	buildEnhancedInputReport,
	inputActionFromInspection,
	mappingContextFromInspection
} from "./project.js";
import type { SavedAssetInspection } from "@ue-shed/unreal-assets";

const actionInspection: SavedAssetInspection = {
	schema_version: 7,
	status: "ok",
	path: "Content/Input/IA_Move.uasset",
	package: {
		name: "/Game/Fixture/Input/IA_Move",
		version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1
	},
	assets: [
		{
			kind: "UObject",
			object_path: "/Game/Fixture/Input/IA_Move.IA_Move",
			class_path: "/Script/EnhancedInput.InputAction",
			properties: [
				{
					name: "ActionDescription",
					type: "TextProperty",
					value_kind: "text",
					value: "Fixture move action",
					history: "none"
				},
				{
					name: "ValueType",
					type: "EnumProperty",
					value_kind: "enum",
					value: "EInputActionValueType::Axis2D"
				}
			]
		}
	],
	decode_errors: []
};

const mappingInspection: SavedAssetInspection = {
	schema_version: 7,
	status: "ok",
	path: "Content/Input/IMC_Fixture.uasset",
	package: {
		name: "/Game/Fixture/Input/IMC_Fixture",
		version: { legacy_file: -9, legacy_ue3: 0, ue4: 522, ue5: 1018, licensee: 0 },
		package_flags: 0,
		summary_size: 1,
		total_header_size: 1
	},
	assets: [
		{
			kind: "UObject",
			object_path: "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture",
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
								{
									value_kind: "struct",
									properties: [
										{
											name: "Triggers",
											type: "ArrayProperty",
											value_kind: "array",
											values: []
										},
										{
											name: "Modifiers",
											type: "ArrayProperty",
											value_kind: "array",
											values: [
												{
													value_kind: "object_ref",
													value: "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture.InputModifierNegate_0"
												}
											]
										},
										{
											name: "Action",
											type: "ObjectProperty",
											value_kind: "object_ref",
											value: "/Game/Fixture/Input/IA_Move.IA_Move"
										},
										{
											name: "Key",
											type: "StructProperty",
											value_kind: "struct",
											properties: [
												{
													name: "KeyName",
													type: "NameProperty",
													value_kind: "name",
													value: "A"
												}
											]
										}
									]
								}
							]
						}
					]
				}
			]
		},
		{
			kind: "UObject",
			object_path: "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture.InputModifierNegate_0",
			class_path: "/Script/EnhancedInput.InputModifierNegate",
			properties: [
				{
					name: "bX",
					type: "BoolProperty",
					value_kind: "bool",
					value: false
				}
			]
		}
	],
	decode_errors: []
};

const legacyMappingInspection: SavedAssetInspection = {
	...mappingInspection,
	assets: [
		{
			kind: "UObject",
			object_path: "/Game/Fixture/Input/IMC_Legacy.IMC_Legacy",
			class_path: "/Script/EnhancedInput.InputMappingContext",
			properties: [
				{
					name: "Mappings",
					type: "ArrayProperty",
					value_kind: "array",
					values: [
						{
							value_kind: "struct",
							properties: [
								{
									name: "Triggers",
									type: "ArrayProperty",
									value_kind: "array",
									values: []
								},
								{
									name: "Modifiers",
									type: "ArrayProperty",
									value_kind: "array",
									values: []
								},
								{
									name: "Action",
									type: "ObjectProperty",
									value_kind: "object_ref",
									value: "/Game/Fixture/Input/IA_Jump.IA_Jump"
								},
								{
									name: "Key",
									type: "StructProperty",
									value_kind: "struct",
									properties: [
										{
											name: "KeyName",
											type: "NameProperty",
											value_kind: "name",
											value: "SpaceBar"
										}
									]
								}
							]
						}
					]
				}
			]
		}
	]
};

describe("enhanced input projection", () => {
	it("projects serialized InputAction fields and leaves defaults unavailable", () => {
		const action = inputActionFromInspection({
			inspection: actionInspection,
			packageFile: "Content/Input/IA_Move.uasset"
		});
		expect(action).toMatchObject({
			objectPath: "/Game/Fixture/Input/IA_Move.IA_Move",
			valueType: {
				status: "available",
				source: "serialized",
				value: "EInputActionValueType::Axis2D"
			},
			consumeInput: { status: "unavailable", reason: "not_serialized" }
		});
	});

	it("projects DefaultKeyMappings and package-local modifier exports", () => {
		const context = mappingContextFromInspection({
			inspection: mappingInspection,
			packageFile: "Content/Input/IMC_Fixture.uasset"
		});
		expect(context?.mappingsProperty).toBe("DefaultKeyMappings");
		expect(context?.mappings).toEqual([
			{
				action: "/Game/Fixture/Input/IA_Move.IA_Move",
				keyName: { status: "available", source: "serialized", value: "A" },
				triggers: [],
				modifiers: [
					{
						objectPath:
							"/Game/Fixture/Input/IMC_Fixture.IMC_Fixture.InputModifierNegate_0",
						classPath: "/Script/EnhancedInput.InputModifierNegate"
					}
				]
			}
		]);
		expect(context?.exports).toEqual([
			{
				objectPath: "/Game/Fixture/Input/IMC_Fixture.IMC_Fixture.InputModifierNegate_0",
				classPath: "/Script/EnhancedInput.InputModifierNegate"
			}
		]);
	});

	it("falls back to legacy Mappings when DefaultKeyMappings is absent", () => {
		const context = mappingContextFromInspection({
			inspection: legacyMappingInspection,
			packageFile: "Content/Input/IMC_Legacy.uasset"
		});
		expect(context?.mappingsProperty).toBe("Mappings");
		expect(context?.mappings[0]?.keyName).toEqual({
			status: "available",
			source: "serialized",
			value: "SpaceBar"
		});
	});

	it("builds a report from mixed package outcomes", () => {
		const report = buildEnhancedInputReport([
			{
				status: "inspected",
				packageFile: "Content/Input/IA_Move.uasset",
				inspection: actionInspection
			},
			{
				status: "inspected",
				packageFile: "Content/Input/IMC_Fixture.uasset",
				inspection: mappingInspection
			},
			{
				status: "failed",
				packageFile: "Content/Input/Broken.uasset",
				message: "boom"
			}
		]);
		expect(report.coverage.inputActions).toBe(1);
		expect(report.coverage.mappingContexts).toBe(1);
		expect(report.status).toBe("partial");
		expect(report.diagnostics.some((item) => item.code === "package_inspection_failed")).toBe(
			true
		);
	});
});
