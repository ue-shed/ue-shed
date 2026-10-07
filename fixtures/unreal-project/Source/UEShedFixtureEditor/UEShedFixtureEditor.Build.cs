using UnrealBuildTool;

public class UEShedFixtureEditor : ModuleRules
{
	public UEShedFixtureEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"AnimationDataController",
				"AssetRegistry",
				"BlueprintGraph",
				"Core",
				"CoreUObject",
				"DataLayerEditor",
				"Engine",
				"GameplayTags",
				"EnhancedInput",
				"InputCore",
				"Json",
				"LevelSequence",
				"Localization",
				"MovieScene",
				"MovieSceneTracks",
				"UEShedFixture",
				"UnrealEd"
			}
		);
	}
}
