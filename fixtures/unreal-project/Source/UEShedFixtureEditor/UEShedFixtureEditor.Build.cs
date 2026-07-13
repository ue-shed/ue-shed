using UnrealBuildTool;

public class UEShedFixtureEditor : ModuleRules
{
	public UEShedFixtureEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PrivateDependencyModuleNames.AddRange(
			new string[]
			{
				"AssetRegistry",
				"Core",
				"CoreUObject",
				"Engine",
				"Json",
				"UEShedFixture",
				"UnrealEd"
			}
		);
	}
}
