using UnrealBuildTool;

public class UEShedCorpusGenerator : ModuleRules
{
	public UEShedCorpusGenerator(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[]
		{
			"AssetRegistry",
			"BlueprintGraph",
			"Json",
			"UMG",
			"UMGEditor",
			"UnrealEd"
		});
	}
}
