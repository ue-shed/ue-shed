using UnrealBuildTool;
public class UEShedCameraAuthoringBridge : ModuleRules
{
	public UEShedCameraAuthoringBridge(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "Json" });
		PrivateDependencyModuleNames.AddRange(new[] { "UnrealEd", "UEShedCamerasEditor", "RenderCore", "RHI", "ImageCore" });
	}
}
