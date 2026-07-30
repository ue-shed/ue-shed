import { describe, expect, it } from "vitest";
import { buildInputAtlas, deviceOf, modifierLabel, objectName, triggerLabel } from "./atlas.js";
import { makeInputObjectPath, type EnhancedInputReport } from "./schema.js";

const available = (value: string) =>
	({ status: "available", source: "serialized", value }) as const;

const context = (options: {
	readonly name: string;
	readonly mappings: readonly {
		readonly key: string;
		readonly action: string;
		readonly triggers?: readonly string[];
	}[];
}) => ({
	objectPath: makeInputObjectPath(`/Game/Input/${options.name}.${options.name}`),
	classPath: "/Script/EnhancedInput.InputMappingContext" as const,
	packageFile: `Content/Input/${options.name}.uasset`,
	contextDescription: available(`${options.name} description`),
	mappingsProperty: "Mappings" as const,
	mappings: options.mappings.map((mapping) => ({
		action: mapping.action,
		keyName: available(mapping.key),
		triggers: (mapping.triggers ?? []).map((classPath, index) => ({
			objectPath: `/Game/Input/${options.name}.${options.name}.Trigger_${index}`,
			classPath
		})),
		modifiers: []
	})),
	exports: []
});

const report: EnhancedInputReport = {
	schemaVersion: 1,
	status: "complete",
	coverage: {
		discoveredPackages: 3,
		inspectedPackages: 3,
		partialPackages: 0,
		failedPackages: 0,
		inputActions: 2,
		mappingContexts: 2
	},
	actions: [
		{
			objectPath: makeInputObjectPath("/Game/Input/IA_Jump.IA_Jump"),
			classPath: "/Script/EnhancedInput.InputAction",
			packageFile: "Content/Input/IA_Jump.uasset",
			actionDescription: available("Jump"),
			valueType: { status: "unavailable", reason: "not_serialized" },
			consumeInput: { status: "unavailable", reason: "not_serialized" }
		},
		{
			objectPath: makeInputObjectPath("/Game/Input/IA_Handbrake.IA_Handbrake"),
			classPath: "/Script/EnhancedInput.InputAction",
			packageFile: "Content/Input/IA_Handbrake.uasset",
			actionDescription: { status: "unavailable", reason: "not_serialized" },
			valueType: { status: "unavailable", reason: "not_serialized" },
			consumeInput: { status: "unavailable", reason: "not_serialized" }
		}
	],
	mappingContexts: [
		context({
			name: "IMC_Gameplay",
			mappings: [
				{
					key: "SpaceBar",
					action: "/Game/Input/IA_Jump.IA_Jump",
					triggers: ["/Script/EnhancedInput.InputTriggerPressed"]
				},
				{ key: "W", action: "/Game/Input/IA_Jump.IA_Jump" }
			]
		}),
		context({
			name: "IMC_Vehicle",
			mappings: [
				{
					key: "SpaceBar",
					action: "/Game/Input/IA_Handbrake.IA_Handbrake",
					triggers: ["/Script/EnhancedInput.InputTriggerChordAction"]
				}
			]
		})
	],
	diagnostics: []
};

describe("input atlas derivation", () => {
	it("inverts contexts onto keys and marks the contested ones", () => {
		const atlas = buildInputAtlas(report);
		expect(atlas.keys.map((entry) => entry.key)).toEqual(["SpaceBar", "W"]);
		expect(atlas.contestedKeys).toEqual(["SpaceBar"]);
		const space = atlas.keys[0];
		expect(space?.claims.map((claim) => claim.contextName)).toEqual([
			"IMC_Gameplay",
			"IMC_Vehicle"
		]);
		expect(space?.claims[0]?.actionName).toBe("IA_Jump");
		expect(space?.claims[0]?.triggers).toEqual(["pressed"]);
		expect(space?.claims[1]?.triggers).toEqual(["chord action"]);
	});

	it("carries a serialized action description and leaves an absent one null", () => {
		const atlas = buildInputAtlas(report);
		const claims = atlas.keys[0]?.claims ?? [];
		expect(claims[0]?.actionDescription).toBe("Jump");
		expect(claims[1]?.actionDescription).toBeNull();
	});

	it("narrows to the selected contexts, which can clear a contest", () => {
		const atlas = buildInputAtlas(report, {
			contexts: ["/Game/Input/IMC_Gameplay.IMC_Gameplay"]
		});
		expect(atlas.contestedKeys).toEqual([]);
		expect(atlas.contexts.map((entry) => entry.name)).toEqual(["IMC_Gameplay"]);
		expect(atlas.keys[0]?.claims).toHaveLength(1);
	});

	it("counts mappings whose key never reached the package instead of dropping them silently", () => {
		const withUnreadable: EnhancedInputReport = {
			...report,
			mappingContexts: [
				{
					...report.mappingContexts[0]!,
					mappings: [
						{
							action: null,
							keyName: { status: "unavailable", reason: "not_serialized" },
							triggers: [],
							modifiers: []
						}
					]
				}
			]
		};
		const atlas = buildInputAtlas(withUnreadable);
		expect(atlas.unreadableMappings).toBe(1);
		expect(atlas.keys).toEqual([]);
		expect(atlas.contexts[0]?.unreadableMappings).toBe(1);
	});

	it("treats two mappings inside one context as alternatives, not a contest", () => {
		const alternatives = buildInputAtlas({
			...report,
			mappingContexts: [
				context({
					name: "IMC_Gameplay",
					mappings: [
						{ key: "SpaceBar", action: "/Game/Input/IA_Jump.IA_Jump" },
						{ key: "SpaceBar", action: "/Game/Input/IA_Jump.IA_Jump" }
					]
				})
			]
		});
		expect(alternatives.contestedKeys).toEqual([]);
		expect(alternatives.keys[0]?.claims).toHaveLength(2);
	});

	it("humanizes Enhanced Input class names and classifies devices", () => {
		expect(triggerLabel("/Script/EnhancedInput.InputTriggerHold")).toBe("hold");
		expect(triggerLabel("/Script/EnhancedInput.InputTriggerDoubleTap")).toBe("double tap");
		expect(modifierLabel("/Script/EnhancedInput.InputModifierNegate")).toBe("negate");
		// A Blueprint trigger is not under /Script/EnhancedInput; keep its own name.
		expect(triggerLabel("/Game/Input/BP_HoldLong.BP_HoldLong_C")).toBe("BP_HoldLong_C");
		expect(objectName("/Game/Fixture/Input/IMC_Fixture.IMC_Fixture")).toBe("IMC_Fixture");
		expect(deviceOf("Gamepad_FaceButton_Bottom")).toBe("gamepad");
		expect(deviceOf("LeftMouseButton")).toBe("mouse");
		expect(deviceOf("SpaceBar")).toBe("keyboard");
	});
});
