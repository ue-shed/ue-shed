using UnrealBuildTool;

public class UEShedAssetAuditsEditor : ModuleRules
{
	public UEShedAssetAuditsEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(
			new[] { "Core", "CoreUObject", "Engine", "Json", "UEShedAssetAudits" });
	}
}
