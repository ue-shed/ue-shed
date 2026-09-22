using UnrealBuildTool;

public class UEShedWorldEditor : ModuleRules
{
	public UEShedWorldEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json" });
		PrivateDependencyModuleNames.AddRange(new[] { "UnrealEd", "DataLayerEditor" });
	}
}
