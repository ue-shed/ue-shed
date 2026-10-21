import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LocalizationTarget, discoverLocalizationTargets } from "@ue-shed/localization/browser";
import { localizationGathersEditorOnlyData, textGatherScope } from "./localization.js";
import { success } from "./localization.test-support.js";
import { TextOccurrence } from "./schema.js";
import type { SavedAssetTextOccurrence } from "@ue-shed/unreal-assets";
import { textOccurrenceFromExtraction } from "./corpus.js";
import {
	TEXT_AUDIENCE_POLICY,
	type TextAudienceRule,
	classifySavedTextAudience,
	classifyTextAudience,
	decodeTextAudience,
	encodeTextAudience,
	isEditorOnlyText,
	isEditorOnlyTextCode,
	lineTextAudience,
	matchTextAudiencePolicy,
	occurrenceTextAudience,
	textAudienceBit,
	textAudienceOfMask,
	textAudienceSubject
} from "./text-audience.js";

function property(
	objectPath: string,
	propertyPath: string,
	classPath = "/Script/Engine.Actor",
	namespace = "NS"
): TextOccurrence {
	const packagePath = objectPath.slice(0, objectPath.indexOf(".", objectPath.lastIndexOf("/")));
	return Schema.decodeUnknownSync(TextOccurrence)({
		id: `occurrence:${objectPath}:${propertyPath}`,
		packageFile: `Content/${packagePath.slice("/Game/".length)}.uasset`,
		source: "Text",
		identity: { status: "resolved", namespace, key: "K" },
		editCapability: "read_only",
		location: { kind: "asset_property", objectPath, classPath, propertyPath }
	});
}

function cell(objectPath: string): TextOccurrence {
	const packagePath = objectPath.slice(0, objectPath.lastIndexOf("."));
	return Schema.decodeUnknownSync(TextOccurrence)({
		id: `occurrence:${objectPath}`,
		packageFile: `Content/${packagePath.slice("/Game/".length)}.uasset`,
		source: "Sword",
		identity: { status: "resolved", namespace: "Items", key: "Sword" },
		editCapability: "source_editable",
		location: { kind: "data_table_cell", objectPath, row: "Sword", propertyPath: "Name" }
	});
}

function gatherTarget(settings: string): LocalizationTarget {
	const discovered = success(
		discoverLocalizationTargets({
			dashboardText: "",
			configs: [
				{
					relativePath: "Config/Localization/Game_Gather.ini",
					text: `[CommonSettings]\nManifestName=Game.manifest\nNativeCulture=en\nCulturesToGenerate=en\n[GatherTextStep0]\nCommandletClass=GatherTextFromAssets\nIncludePathFilters=Content/*\nExcludePathFilters=Content/Dialogue/DevTest/*\nPackageFileNameFilters=*.uasset\n${settings}`
				}
			]
		})
	).targets[0];
	return Schema.decodeUnknownSync(LocalizationTarget)(discovered);
}

describe("text audience policy table", () => {
	it("gives every row a unique id, a documented reason and at least one match", () => {
		const ids = TEXT_AUDIENCE_POLICY.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const rule of TEXT_AUDIENCE_POLICY) {
			expect(rule.when.length).toBeGreaterThan(0);
			expect(rule.why.length).toBeGreaterThan(10);
		}
	});

	it("lists editor rows before player rows, so editor evidence wins", () => {
		const firstPlayer = TEXT_AUDIENCE_POLICY.findIndex((rule) => rule.audience === "player");
		expect(
			TEXT_AUDIENCE_POLICY.slice(firstPlayer).every((rule) => rule.audience === "player")
		).toBe(true);
	});

	it.each([
		[
			"blueprint variable tooltip",
			property(
				"/Game/BP/BP_Hero.BP_Hero",
				"NewVariables[3].MetaDataArray[0].PropertyTooltip",
				"/Script/Engine.Blueprint"
			),
			"property_tooltip"
		],
		[
			"blueprint category",
			property(
				"/Game/BP/BP_Hero.BP_Hero",
				"NewVariables[1].Category",
				"/Script/Engine.Blueprint"
			),
			"category"
		],
		[
			"SCS category name",
			property(
				"/Game/BP/BP_Hero.BP_Hero:SimpleConstructionScript_0.SCS_Node_4",
				"CategoryName",
				"/Script/Engine.SCS_Node"
			),
			"scs_node"
		],
		[
			"K2 node pin tooltip",
			property(
				"/Game/BP/BP_Hero.BP_Hero:EventGraph.K2Node_CallFunction_12",
				"Pins[2].PinToolTip",
				"/Script/BlueprintGraph.K2Node_CallFunction"
			),
			"k2_node"
		],
		[
			"anim graph node",
			property(
				"/Game/Anim/ABP_Hero.ABP_Hero:AnimGraph.AnimGraphNode_Slot_0",
				"Node.SlotName",
				"/Script/AnimGraph.AnimGraphNode_Slot"
			),
			"anim_graph_node"
		],
		[
			"niagara node",
			property(
				"/Game/FX/NS_Fire.NS_Fire:NiagaraScriptSource_0.NiagaraGraph_0.NiagaraNodeFunctionCall_3",
				"Signature.Description",
				"/Script/NiagaraEditor.NiagaraNodeFunctionCall"
			),
			"niagara_node"
		],
		[
			"niagara signature description outside a node",
			property(
				"/Game/FX/NS_Fire.NS_Fire:NiagaraScript_0",
				"Signature.Description",
				"/Script/Niagara.NiagaraScript"
			),
			"niagara_signature_description"
		],
		[
			"material expression",
			property(
				"/Game/M/M_Hero.M_Hero:MaterialExpressionScalarParameter_0",
				"Desc",
				"/Script/Engine.MaterialExpressionScalarParameter"
			),
			"material_expression"
		],
		[
			"editor module class",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu:WidgetBlueprintGeneratedClass_0",
				"Label",
				"/Script/UMGEditor.WidgetBlueprintThing"
			),
			"editor_module"
		],
		[
			"widget animation display names",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu:HoverAnim.MovieScene_0",
				"ObjectsToDisplayNames{0}.value",
				"/Script/MovieScene.MovieScene"
			),
			"objects_to_display_names"
		],
		[
			"sequencer track name",
			property(
				"/Game/Seq/LS_Intro.LS_Intro:MovieScene_0.MovieScene3DTransformTrack_2",
				"DisplayName",
				"/Script/MovieSceneTracks.MovieScene3DTransformTrack"
			),
			"movie_scene_tracks_display_name"
		],
		[
			"reflection tooltip namespace",
			property(
				"/Game/BP/BP_Hero.BP_Hero",
				"Text",
				"/Script/Engine.Blueprint",
				"UObjectToolTips"
			),
			"uobject_tooltips"
		],
		["developers folder", cell("/Game/Developers/alex/DT_Test.DT_Test"), "developers_folder"],
		["dev folder", cell("/Game/Dev/DT_Test.DT_Test"), "dev_folder"],
		[
			"widget palette category",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu:WidgetTree.Button_Play",
				"PaletteCategory",
				"/Script/UMG.Button"
			),
			"palette_category"
		],
		[
			"blank Niagara script version metadata",
			property(
				"/Game/FX/NS_Fire.NS_Fire:NiagaraScript_2",
				"VersionData[0].VersionChangeDescription",
				"/Script/Niagara.NiagaraScript"
			),
			"niagara_version_data"
		],
		[
			"cached Niagara script data",
			property(
				"/Game/FX/NS_Fire.NS_Fire:NiagaraScript_2",
				"CachedScriptVM.DataInterfaceInfo[0].Name",
				"/Script/Niagara.NiagaraScript"
			),
			"niagara_cached_script_vm"
		],
		[
			"K2 node inside a widget graph stays editor",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu:WidgetTree.EventGraph.K2Node_Event_0",
				"NodeComment"
			),
			"k2_node"
		]
	])("classifies %s as editor", (_name, occurrence, rule) => {
		expect(classifyTextAudience(occurrence)).toMatchObject({ audience: "editor", rule });
	});

	it.each([
		["DataTable cell", cell("/Game/Data/DT_Items.DT_Items"), "data_table"],
		[
			"widget tree label",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu:WidgetTree.TextBlock_Title",
				"Text",
				"/Script/UMG.TextBlock"
			),
			"widget_tree"
		],
		[
			"user defined enum display name",
			property(
				"/Game/Data/E_Rarity.E_Rarity",
				"DisplayNameMap{0}.value",
				"/Script/Engine.UserDefinedEnum"
			),
			"user_defined_enum_display_name"
		],
		[
			"generated class widget tree copy",
			property(
				"/Game/UI/WBP_Menu.WBP_Menu_C:WidgetTree.TextBlock_Title",
				"Text",
				"/Script/UMG.TextBlock"
			),
			"widget_tree"
		],
		[
			"compiled Blueprint literal",
			property(
				"/Game/Props/BP_Sign.BP_Sign_C.ExecuteUbergraph_BP_Sign",
				"ScriptBytecode",
				"/Script/CoreUObject.Function"
			),
			"script_bytecode"
		]
	])("classifies %s as player", (_name, occurrence, rule) => {
		expect(classifyTextAudience(occurrence)).toMatchObject({ audience: "player", rule });
	});

	it("leaves text with no evidence unknown", () => {
		expect(
			classifyTextAudience(
				property("/Game/Maps/L_Town.L_Town:PersistentLevel.Sign_3", "Message")
			)
		).toEqual({ audience: "unknown", reason: "no_evidence" });
	});

	it("matches names, modules and property elements without regard to case or indexes", () => {
		const subject = textAudienceSubject(
			property(
				"/Game/BP/BP_Hero.BP_Hero:SimpleConstructionScript_0.SCS_Node_4",
				'Map("x").Values[2].categoryname',
				"/Script/Engine.SCS_Node"
			)
		);
		expect(subject).toMatchObject({
			packagePath: "/Game/BP/BP_Hero",
			objects: ["BP_Hero", "SimpleConstructionScript_0", "SCS_Node_4"],
			className: "SCS_Node",
			module: "Engine"
		});
		expect(
			classifyTextAudience(
				property("/Game/A/B.B", 'Map("x").Values[2].categoryname', "/Script/Engine.Thing")
			)
		).toMatchObject({ audience: "editor", rule: "category_name" });
	});

	it("does not mistake a property that merely contains a policy word", () => {
		expect(
			classifyTextAudience(property("/Game/A/B.B", "ItemCategoryLabel", "/Script/Game.Item"))
		).toMatchObject({ audience: "unknown" });
		expect(
			classifyTextAudience(property("/Game/Developer/B.B", "Label", "/Script/Game.Item"))
		).toMatchObject({ audience: "unknown" });
	});
});

describe("container property paths the reader writes", () => {
	// The reader writes array and set elements as `Name[N]` and map entries as `Name{N}.key` and
	// `Name{N}.value` (uasset-inspection projection.rs). The enum paths are pinned against the
	// saved fixture by `saved_enum_display_names_are_map_values` in uasset-inspection.
	const enumPath = "/Game/Fixture/Text/E_TextDisplayNames.E_TextDisplayNames";
	const enumClass = "/Script/Engine.UserDefinedEnum";

	it.each(["DisplayNameMap{0}.value", "DisplayNameMap{1}.value"])(
		"reads the saved enum display name %s as player text",
		(propertyPath) => {
			const expected = {
				audience: "player",
				reason: "player_asset",
				rule: "user_defined_enum_display_name"
			};
			expect(classifyTextAudience(property(enumPath, propertyPath, enumClass))).toEqual(
				expected
			);
			const saved: SavedAssetTextOccurrence = {
				source: "Common Item",
				dev_notes: "",
				identity: { status: "resolved", namespace: "Fixture.Enum", key: "CommonItem" },
				location: {
					kind: "asset_property",
					object_path: enumPath,
					class_path: enumClass,
					property_path: propertyPath
				},
				edit_capability: "read_only"
			};
			expect(classifySavedTextAudience(saved)).toEqual(expected);
		}
	);

	it.each(["ObjectsToDisplayNames{0}.value", "ObjectsToDisplayNames{3}.key"])(
		"reads the widget animation map entry %s as editor text",
		(propertyPath) => {
			expect(
				classifyTextAudience(
					property(
						"/Game/UI/WBP_Menu.WBP_Menu:HoverAnim.MovieScene_0",
						propertyPath,
						"/Script/MovieScene.MovieScene"
					)
				)
			).toMatchObject({ audience: "editor", rule: "objects_to_display_names" });
		}
	);

	it("matches every map path in the legacy fixture evidence as its map property", () => {
		const paths = new Set<string>();
		for (const engine of ["4.27", "5.3"]) {
			const evidence = readFileSync(
				new URL(
					`../../../fixtures/legacy-unreal-project/Generated/${engine}/evidence.json`,
					import.meta.url
				),
				"utf8"
			);
			for (const [, path] of evidence.matchAll(/"property_path": "([^"]*\{[^"]*)"/gu))
				paths.add(path!);
		}
		const expected = (path: string) =>
			path.startsWith("TextMap")
				? "TextMap"
				: path.endsWith(".Text")
					? "NestedMap.Text"
					: "NestedMap.Texts";
		expect([...paths].sort()).toEqual([
			"NestedMap{0}.value.Text",
			"NestedMap{0}.value.Texts[0]",
			"NestedMap{0}.value.Texts[1]",
			"NestedMap{1}.value.Text",
			"NestedMap{1}.value.Texts[0]",
			"NestedMap{1}.value.Texts[1]",
			"TextMap{0}.value",
			"TextMap{1}.value"
		]);
		const rule = (value: string): TextAudienceRule => ({
			id: value,
			audience: "editor",
			reason: "editor_property",
			when: [{ kind: "property", value }],
			why: "Test."
		});
		for (const path of paths) {
			const subject = textAudienceSubject(property("/Game/Legacy/DA.DA", path));
			expect(matchTextAudiencePolicy(subject, [rule(expected(path))])?.id, path).toBe(
				expected(path)
			);
			// The entry side is not a property name.
			expect(matchTextAudiencePolicy(subject, [rule("value")]), path).toBeUndefined();
		}
	});

	it("keeps a struct field named Value inside an array element", () => {
		const subject = textAudienceSubject(property("/Game/A/B.B", "Entries[0].Value"));
		const rule: TextAudienceRule = {
			id: "entries_value",
			audience: "editor",
			reason: "editor_property",
			when: [{ kind: "property", value: "Entries.Value" }],
			why: "Test."
		};
		expect(matchTextAudiencePolicy(subject, [rule])?.id).toBe("entries_value");
	});
});

describe("line audience", () => {
	it("is player if any occurrence is, then unknown, then editor", () => {
		expect(lineTextAudience(["editor", "player", "unknown"])).toBe("player");
		expect(lineTextAudience(["editor", "unknown"])).toBe("unknown");
		expect(lineTextAudience(["editor", "editor"])).toBe("editor");
		expect(lineTextAudience([])).toBe("unknown");
	});
});

describe("target gather scope", () => {
	const tooltip = property("/Game/BP/BP_Hero.BP_Hero", "NewVariables[0].PropertyTooltip");
	const label = property(
		"/Game/UI/WBP_Menu.WBP_Menu:WidgetTree.TextBlock_0",
		"Text",
		"/Script/UMG.TextBlock"
	);

	it("reads ShouldGatherFromEditorOnlyData, defaulting to false like Unreal", () => {
		expect(localizationGathersEditorOnlyData(gatherTarget(""))).toBe(false);
		expect(
			localizationGathersEditorOnlyData(gatherTarget("ShouldGatherFromEditorOnlyData=true\n"))
		).toBe(true);
	});

	it("flips editor text between out of scope and in scope with the target's setting", () => {
		const off = gatherTarget("ShouldGatherFromEditorOnlyData=false\n");
		const on = gatherTarget("ShouldGatherFromEditorOnlyData=true\n");
		expect(textGatherScope(off, tooltip, classifyTextAudience(tooltip))).toEqual({
			status: "out_of_scope",
			reason: "editor_only_data_not_gathered"
		});
		expect(textGatherScope(on, tooltip, classifyTextAudience(tooltip))).toEqual({
			status: "in_scope"
		});
		expect(textGatherScope(off, label, classifyTextAudience(label))).toEqual({
			status: "in_scope"
		});
	});

	it("puts text in excluded folders out of scope, and reports no target without one", () => {
		const target = gatherTarget("");
		const devTest = property(
			"/Game/Dialogue/DevTest/WBP_Test.WBP_Test:WidgetTree.TextBlock_0",
			"Text",
			"/Script/UMG.TextBlock"
		);
		expect(textGatherScope(target, devTest, classifyTextAudience(devTest))).toEqual({
			status: "out_of_scope",
			reason: "outside_gather_paths"
		});
		expect(textGatherScope(undefined, devTest, classifyTextAudience(devTest))).toEqual({
			status: "no_target"
		});
	});
});

describe("saved occurrences", () => {
	const saved = (
		location: SavedAssetTextOccurrence["location"],
		gather?: boolean
	): SavedAssetTextOccurrence => ({
		source: "Text",
		dev_notes: "",
		identity: { status: "resolved", namespace: "NS", key: "K" },
		location,
		edit_capability: "read_only",
		...(gather === undefined ? undefined : { gather_editor_only: gather })
	});
	const samples = [
		saved({
			kind: "asset_property",
			object_path: "/Game/BP/BP_Hero.BP_Hero:EventGraph.K2Node_Event_0",
			class_path: "/Script/BlueprintGraph.K2Node_Event",
			property_path: "NodeComment"
		}),
		saved({
			kind: "data_table_cell",
			object_path: "/Game/D/DT.DT",
			row: "R",
			property_path: "N"
		}),
		saved({ kind: "string_table_entry", object_path: "/Game/S/ST.ST", entry_key: "K" }),
		saved({
			kind: "asset_property",
			object_path: "/Game/Dev/L_Test.L_Test:PersistentLevel.Sign",
			class_path: "/Script/Engine.TextRenderComponent",
			property_path: "Text"
		}),
		saved(
			{
				kind: "asset_property",
				object_path: "/Game/UI/W.W",
				class_path: "/Script/UMG.TextBlock",
				property_path: "ToolTip"
			},
			false
		),
		saved(
			{
				kind: "asset_property",
				object_path: "/Game/UI/W.W:WidgetTree.TextBlock_0",
				class_path: "/Script/UMG.TextBlock",
				property_path: "Text"
			},
			true
		)
	];

	it("classifies a reader record exactly as the corpus occurrence built from it", () => {
		for (const occurrence of samples) {
			const built = textOccurrenceFromExtraction({
				occurrence,
				packageFile: "Content/X.uasset"
			});
			const classification = classifySavedTextAudience(occurrence);
			expect(occurrenceTextAudience(built)).toEqual(classification);
			expect(
				classifyTextAudience(
					built,
					occurrence.gather_editor_only === undefined
						? {}
						: { gatherTableEditorOnly: occurrence.gather_editor_only }
				)
			).toEqual(classification);
		}
		// Unreal's bit outranks the policy table both ways.
		expect(classifySavedTextAudience(samples[4]!)).toEqual({
			audience: "player",
			reason: "gather_table_runtime"
		});
		expect(classifySavedTextAudience(samples[5]!)).toEqual({
			audience: "editor",
			reason: "gather_table_editor_only"
		});
	});

	it("round-trips every policy row and evidence through the index encoding", () => {
		const classifications = [
			...samples.map(classifySavedTextAudience),
			{ audience: "unknown", reason: "no_evidence" } as const,
			...TEXT_AUDIENCE_POLICY.map((rule) => ({
				audience: rule.audience,
				reason: rule.reason,
				rule: rule.id
			}))
		];
		for (const classification of classifications) {
			const code = encodeTextAudience(classification);
			expect(decodeTextAudience(code)).toEqual(classification);
			expect(isEditorOnlyTextCode(code)).toBe(isEditorOnlyText(classification));
		}
		expect(() => decodeTextAudience(3)).toThrow();
	});

	it("rolls a mask of audiences up like the line rule", () => {
		const mask = (...audiences: ("player" | "editor" | "unknown")[]) =>
			audiences.reduce(
				(bits, audience) =>
					bits | textAudienceBit(encodeTextAudience({ audience, reason: "no_evidence" })),
				0
			);
		for (const audiences of [
			[],
			["editor"],
			["unknown"],
			["player"],
			["editor", "unknown"],
			["editor", "player"],
			["unknown", "player"],
			["editor", "unknown", "player"]
		] as const)
			expect(textAudienceOfMask(mask(...audiences))).toBe(lineTextAudience(audiences));
	});
});
