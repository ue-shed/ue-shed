using UnrealBuildTool;

public class UEShedLegacyFixtureEditor : ModuleRules
{
	public UEShedLegacyFixtureEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"BlueprintGraph", "Core", "CoreUObject", "Engine", "Json", "UEShedLegacyFixture", "UnrealEd"
		});
	}
}
