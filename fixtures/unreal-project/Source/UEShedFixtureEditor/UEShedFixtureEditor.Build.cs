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
				"Engine",
				"EnhancedInput",
				"InputCore",
				"Json",
				"LevelSequence",
				"MovieScene",
				"MovieSceneTracks",
				"UEShedFixture",
				"UnrealEd"
			}
		);
	}
}
