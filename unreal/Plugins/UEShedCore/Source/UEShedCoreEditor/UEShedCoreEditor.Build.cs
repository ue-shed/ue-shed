using UnrealBuildTool;

public class UEShedCoreEditor : ModuleRules
{
	public UEShedCoreEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"AssetRegistry",
			"ContentBrowser",
			"Json",
			"LevelEditor",
			"Slate",
			"SlateCore",
			"UnrealEd"
		});
	}
}
