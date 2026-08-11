using UnrealBuildTool;

public class UEShedScenariosEditor : ModuleRules
{
	public UEShedScenariosEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"EnhancedInput",
			"InputCore",
			"Json",
			"Slate",
			"SlateCore",
			"UEShedCoreEditor",
			"UEShedScenarios",
			"UnrealEd"
		});
	}
}
