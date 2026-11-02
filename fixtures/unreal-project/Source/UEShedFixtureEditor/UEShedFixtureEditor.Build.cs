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
				"AssetTools",
				"BlueprintGraph",
				"Core",
				"CoreUObject",
				"DataLayerEditor",
				"Engine",
				"Landscape",
				"PhysicsCore",
				"GameplayTags",
				"EnhancedInput",
				"InputCore",
				"Json",
				"LevelSequence",
				"Localization",
				"MovieScene",
				"MovieSceneTracks",
				"Niagara",
				"UniversalObjectLocator",
				"UEShedFixture",
				"UMG",
				"UMGEditor",
				"UnrealEd"
			}
		);
	}
}
