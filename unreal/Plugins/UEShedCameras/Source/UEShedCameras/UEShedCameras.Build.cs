using UnrealBuildTool;

public class UEShedCameras : ModuleRules
{
	public UEShedCameras(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new[] { "Json", "RenderCore", "RHI" });
	}
}
